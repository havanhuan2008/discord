import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db, keysTable, devicesTable, notificationsTable, notificationReadsTable } from "../db";
import { logger } from "../lib/logger";
import https from "https";
import http from "http";

const router: IRouter = Router();

const ADMIN_SECRET      = process.env.ADMIN_SECRET_KEY ?? "";
const LINK4M_API_TOKEN = process.env.LINK4M_API_TOKEN ?? "";
const API_BASE_URL      = process.env.API_BASE_URL ?? "https://aujunpeak-api.onrender.com";

function requireAdmin(req: any, res: any, next: any): void {
  const secret = req.headers["x-admin-secret"];
  if (!ADMIN_SECRET || !secret || secret !== ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function generateKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function generateToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 48 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ── In-memory claim token store (TTL = 1 hour) ────────────────────────────
interface ClaimRecord {
  deviceId: string;
  deviceName: string;
  createdAt: number;
  used: boolean;
}
const claimTokens = new Map<string, ClaimRecord>();

// Dọn dẹp token hết hạn mỗi 10 phút
setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of claimTokens) {
    if (now - rec.createdAt > 60 * 60 * 1000) claimTokens.delete(token);
  }
}, 10 * 60 * 1000);

// ── Link4m helper ────────────────────────────────────────────────────────
function createLink4mUrl(targetUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
  if (!LINK4M_API_TOKEN) {
    return Promise.reject(new Error("LINK4M_API_TOKEN không được cấu hình. Vui lòng thêm biến môi trường."));
  }
    const encoded = encodeURIComponent(targetUrl);
    const apiUrl  = `https://link4m.com/api?api=${LINK4M_API_TOKEN}&url=${encoded}&format=json`;

    const mod = apiUrl.startsWith("https") ? https : http;
    const req = mod.get(apiUrl, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.status === "success" && json.shortenedUrl) {
            resolve(json.shortenedUrl as string);
          } else {
            reject(new Error(`Link4m error: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Link4m timeout")); });
  });
}

// ── Lấy thông báo chưa đọc ───────────────────────────────────────────────
async function getPendingNotifications(deviceId: string) {
  const allNotifs = await db.select().from(notificationsTable).orderBy(notificationsTable.createdAt);
  const activeIds = allNotifs.map(n => n.id);
  if (allNotifs.length === 0) return { pending: [] as { id: number; title: string; body: string }[], activeIds };

  const reads = await db.select().from(notificationReadsTable)
    .where(and(eq(notificationReadsTable.deviceId, deviceId), inArray(notificationReadsTable.notificationId, activeIds)));

  const readIds = new Set(reads.map(r => r.notificationId));
  const pending = allNotifs.filter(n => !readIds.has(n.id)).map(n => ({
    id: n.id, title: n.title, body: n.body,
  }));
  return { pending, activeIds };
}

// ═════════════════════════════════════════════════════════════════════════════
// GENERATE FREE LINK — App gọi để nhận URL Link4m
// POST /api/keys/generate-free-link
// Body: { deviceId: string, deviceName: string }
// Returns: { link4mUrl: string } | { error: string }
// ═════════════════════════════════════════════════════════════════════════════
router.post("/keys/generate-free-link", async (req, res): Promise<void> => {
  const { deviceId, deviceName } = req.body ?? {};

  if (!deviceId || typeof deviceId !== "string") {
    res.status(400).json({ error: "Thiếu deviceId" });
    return;
  }

  // Tạo claim token
  const token = generateToken();
  claimTokens.set(token, {
    deviceId,
    deviceName: deviceName ?? "Unknown Device",
    createdAt: Date.now(),
    used: false,
  });

  // Build claim URL (đích mà Link4m redirect đến sau khi bypass)
  const claimUrl =
    `${API_BASE_URL}/api/keys/claim-free` +
    `?deviceId=${encodeURIComponent(deviceId)}` +
    `&deviceName=${encodeURIComponent(deviceName ?? "Unknown")}` +
    `&token=${encodeURIComponent(token)}`;

  try {
    const link4mUrl = await createLink4mUrl(claimUrl);
    logger.info(`[FREE-LINK] Generated Link4m URL for device ${deviceId}`);
    res.json({ link4mUrl });
  } catch (err) {
    logger.warn(`[FREE-LINK] Link4m failed: ${err}. Returning direct claim URL.`);
    // Fallback: trả về trực tiếp claim URL nếu Link4m lỗi
    res.json({ link4mUrl: claimUrl, fallback: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FREE KEY — TRANG XÁC THỰC THIẾT BỊ (mở trong trình duyệt)
// GET /api/keys/get-free-page?deviceId=XXX&deviceName=XXX
// ═════════════════════════════════════════════════════════════════════════════
router.get("/keys/get-free-page", async (req, res): Promise<void> => {
  const deviceId   = (req.query.deviceId   as string) ?? "";
  const deviceName = (req.query.deviceName as string) ?? "Unknown Device";

  if (!deviceId) {
    res.status(400).send("Thiếu deviceId");
    return;
  }

  // Kiểm tra thiết bị này có key free còn hạn không (tránh spam)
  const allKeys = await db.select().from(keysTable).where(
    and(eq(keysTable.tier, "free"), eq(keysTable.isActive, true))
  );
  for (const k of allKeys) {
    const devs = await db.select().from(devicesTable).where(eq(devicesTable.keyId, k.id));
    const thisdev = devs.find(d => d.deviceId === deviceId);
    if (thisdev && k.expiresAt && new Date() < k.expiresAt) {
      // Thiết bị còn key free đang hoạt động → redirect thẳng đến trang thành công
      const remaining = Math.ceil((k.expiresAt.getTime() - Date.now()) / 60000);
      res.redirect(`${API_BASE_URL}/api/keys/free-success?key=${encodeURIComponent(k.key)}&deviceName=${encodeURIComponent(deviceName)}&remaining=${remaining}`);
      return;
    }
  }

  // Tạo claim token mới
  const token = generateToken();
  claimTokens.set(token, { deviceId, deviceName, createdAt: Date.now(), used: false });

  // Tạo link4m bọc claim URL
  const claimUrl = `${API_BASE_URL}/api/keys/claim-free?deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName)}&token=${encodeURIComponent(token)}`;
  let link4mUrl  = claimUrl; // fallback
  try {
    link4mUrl = await createLink4mUrl(claimUrl);
  } catch (e) {
    logger.error({ err: e }, "Link4m API error — dùng direct link thay thế");
  }

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Aujunpeak — Lấy Key Miễn Phí</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;background:radial-gradient(ellipse at top,#1a0010 0%,#0a0008 60%,#000 100%);font-family:'Inter',sans-serif;color:#fff;overflow-x:hidden}
    .particles{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
    .particle{position:absolute;border-radius:50%;animation:floatUp linear infinite;opacity:0}
    @keyframes floatUp{0%{transform:translateY(100vh) scale(0);opacity:0}10%{opacity:.7}90%{opacity:.4}100%{transform:translateY(-20vh) scale(1.2);opacity:0}}
    .container{position:relative;z-index:1;max-width:480px;margin:0 auto;padding:24px 16px 48px}
    .logo-wrap{text-align:center;margin-bottom:32px;padding-top:16px}
    .logo-circle{width:90px;height:90px;border-radius:50%;background:linear-gradient(135deg,#ff1744,#8b0000);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 40px rgba(255,23,68,.5),0 0 80px rgba(255,23,68,.2);animation:pulse 2.4s ease-in-out infinite}
    @keyframes pulse{0%,100%{box-shadow:0 0 40px rgba(255,23,68,.5),0 0 80px rgba(255,23,68,.2)}50%{box-shadow:0 0 60px rgba(255,23,68,.8),0 0 120px rgba(255,23,68,.4)}}
    .logo-circle svg{width:48px;height:48px}
    .brand{font-size:28px;font-weight:900;letter-spacing:.08em;background:linear-gradient(90deg,#ff1744,#ff8a80,#ff1744);background-size:200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 3s linear infinite}
    @keyframes shimmer{0%{background-position:0%}100%{background-position:200%}}
    .tagline{color:#77ffffff;font-size:13px;margin-top:6px;letter-spacing:.04em}

    .card{background:linear-gradient(145deg,rgba(255,23,68,.12),rgba(139,0,0,.08));border:1px solid rgba(255,23,68,.25);border-radius:20px;padding:20px;margin-bottom:16px;backdrop-filter:blur(12px);position:relative;overflow:hidden}
    .card::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,23,68,.04),transparent);animation:scanline 4s linear infinite}
    @keyframes scanline{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
    .card-title{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#ff6666;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .card-title::before{content:'';width:20px;height:2px;background:#ff1744;border-radius:2px}

    .device-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
    .device-row:last-child{border-bottom:none;padding-bottom:0}
    .device-icon{width:32px;height:32px;border-radius:10px;background:rgba(255,23,68,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .device-icon svg{width:18px;height:18px;fill:none;stroke:#ff6666;stroke-width:1.8}
    .device-label{font-size:11px;color:#88aacc;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
    .device-value{font-size:13px;color:#fff;font-weight:600;word-break:break-all}
    .device-value.mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:#ff9999}

    .verify-status{display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:12px;background:rgba(0,200,83,.1);border:1px solid rgba(0,200,83,.25);margin-top:4px}
    .verify-dot{width:10px;height:10px;border-radius:50%;background:#00c853;box-shadow:0 0 12px rgba(0,200,83,.6);animation:blink 1.5s ease-in-out infinite;flex-shrink:0}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
    .verify-text{font-size:12px;color:#66ffb2;font-weight:600}

    .steps{display:flex;flex-direction:column;gap:10px;margin-bottom:4px}
    .step{display:flex;align-items:flex-start;gap:12px}
    .step-num{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#ff1744,#8b0000);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;flex-shrink:0;margin-top:1px}
    .step-text{font-size:12px;color:#aaccdd;line-height:1.6}
    .step-text strong{color:#fff}

    .link-box{background:rgba(0,0,0,.4);border:1px solid rgba(255,23,68,.3);border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px;margin-top:12px}
    .link-url{flex:1;font-family:'JetBrains Mono',monospace;font-size:11px;color:#ff9999;word-break:break-all;line-height:1.4}
    .btn-copy{flex-shrink:0;padding:8px 14px;border-radius:8px;background:linear-gradient(135deg,#ff1744,#cc0022);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;white-space:nowrap}
    .btn-copy:active{transform:scale(.96)}
    .btn-copy.copied{background:linear-gradient(135deg,#00c853,#00963f)}

    .btn-open{display:block;width:100%;padding:16px;border-radius:14px;background:linear-gradient(135deg,#ff1744,#8b0000);border:none;color:#fff;font-size:15px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .25s;text-align:center;text-decoration:none;margin-top:4px;box-shadow:0 8px 32px rgba(255,23,68,.35)}
    .btn-open:active{transform:scale(.98)}
    .btn-open:hover{box-shadow:0 12px 40px rgba(255,23,68,.5)}

    .timer-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;background:rgba(255,152,0,.12);border:1px solid rgba(255,152,0,.3);font-size:11px;color:#ffcc80;font-weight:600;margin-top:8px}
    .footer{text-align:center;color:#334455;font-size:11px;margin-top:32px}

    @keyframes fadeSlideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
    .card{animation:fadeSlideUp .5s ease forwards}
    .card:nth-child(2){animation-delay:.1s;opacity:0}
    .card:nth-child(3){animation-delay:.2s;opacity:0}
    .btn-open{animation:fadeSlideUp .5s ease .3s forwards;opacity:0}
  </style>
</head>
<body>
<div class="particles" id="particles"></div>
<div class="container">
  <div class="logo-wrap">
    <div class="logo-circle">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 8L8 16V28C8 36.8 15.6 45.2 24 47C32.4 45.2 40 36.8 40 28V16L24 8Z" fill="rgba(255,255,255,.15)" stroke="#ff6666" stroke-width="1.5"/>
        <path d="M18 24H30M24 18V30" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="brand">AUJUNPEAK</div>
    <div class="tagline">Hệ thống kích hoạt key miễn phí</div>
  </div>

  <!-- CARD 1: THÔNG TIN THIẾT BỊ -->
  <div class="card">
    <div class="card-title">Xác thực thiết bị</div>
    <div class="device-row">
      <div class="device-icon">
        <svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="1"/></svg>
      </div>
      <div>
        <div class="device-label">Tên thiết bị</div>
        <div class="device-value">${escapeHtml(deviceName)}</div>
      </div>
    </div>
    <div class="device-row">
      <div class="device-icon">
        <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      </div>
      <div>
        <div class="device-label">Device ID</div>
        <div class="device-value mono">${escapeHtml(deviceId.substring(0, 8))}****${escapeHtml(deviceId.slice(-4))}</div>
      </div>
    </div>
    <div style="margin-top:12px">
      <div class="verify-status">
        <div class="verify-dot"></div>
        <div class="verify-text">✓ Xác thực thiết bị thành công — Thiết bị hợp lệ</div>
      </div>
    </div>
    <div class="timer-badge">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      Key Free có hiệu lực 30 phút · Chỉ dùng được trên thiết bị này
    </div>
  </div>

  <!-- CARD 2: HƯỚNG DẪN -->
  <div class="card">
    <div class="card-title">Hướng dẫn lấy key</div>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">Nhấn nút <strong>Mở Link Vượt</strong> hoặc nhấn <strong>Sao chép</strong> rồi mở link trong trình duyệt</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">Hoàn thành các bước xác minh trên trang Link4m <strong>(thường mất 10–30 giây)</strong></div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">Hệ thống sẽ tự động tạo key và hiển thị trên trang mới</div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text">Sao chép key và dán vào ứng dụng Aujunpeak để kích hoạt</div>
      </div>
    </div>

    <!-- Link4m URL -->
    <div class="link-box" id="linkBox">
      <div class="link-url" id="linkUrl">${escapeHtml(link4mUrl)}</div>
      <button class="btn-copy" id="btnCopy" onclick="copyLink()">Sao chép</button>
    </div>
  </div>

  <!-- NÚT MỞ LINK -->
  <a class="btn-open" href="${escapeHtml(link4mUrl)}" target="_blank" rel="noopener">
    🚀 &nbsp; Mở Link Vượt — Nhận Key Ngay
  </a>

  <div class="footer">Aujunpeak · Key free giới hạn 30 phút · 1 thiết bị · Miễn phí hoàn toàn</div>
</div>

<script>
  // Particles
  const c = document.getElementById('particles');
  const COLORS = ['#ff1744','#ff5252','#ff8a80','#ff6666','#cc0022'];
  for(let i=0;i<28;i++){
    const p=document.createElement('div');
    p.className='particle';
    const size=Math.random()*5+2;
    p.style.cssText='width:'+size+'px;height:'+size+'px;left:'+Math.random()*100+'%;background:'+COLORS[Math.floor(Math.random()*COLORS.length)]+';animation-duration:'+(Math.random()*12+8)+'s;animation-delay:-'+(Math.random()*12)+'s';
    c.appendChild(p);
  }

  // Copy link
  function copyLink(){
    const url=document.getElementById('linkUrl').textContent;
    navigator.clipboard.writeText(url).then(()=>{
      const btn=document.getElementById('btnCopy');
      btn.textContent='✓ Đã copy!';
      btn.classList.add('copied');
      setTimeout(()=>{btn.textContent='Sao chép';btn.classList.remove('copied');},2500);
    }).catch(()=>{
      const ta=document.createElement('textarea');
      ta.value=url;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.focus();ta.select();
      document.execCommand('copy');document.body.removeChild(ta);
      const btn=document.getElementById('btnCopy');
      btn.textContent='✓ Đã copy!';btn.classList.add('copied');
      setTimeout(()=>{btn.textContent='Sao chép';btn.classList.remove('copied');},2500);
    });
  }
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ═════════════════════════════════════════════════════════════════════════════
// FREE KEY — TRANG THÀNH CÔNG SAU KHI VƯỢT LINK4M
// GET /api/keys/claim-free?deviceId=XXX&deviceName=XXX&token=YYY
// ═════════════════════════════════════════════════════════════════════════════
router.get("/keys/claim-free", async (req, res): Promise<void> => {
  const deviceId   = (req.query.deviceId   as string) ?? "";
  const deviceName = decodeURIComponent((req.query.deviceName as string) ?? "Unknown Device");
  const token      = (req.query.token      as string) ?? "";

  const errorPage = (msg: string) => `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lỗi — Aujunpeak</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@700;900&display=swap" rel="stylesheet"/>
<style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:#0a0008;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;color:#fff;padding:24px}
.box{text-align:center;max-width:360px}.icon{font-size:56px;margin-bottom:20px}.title{font-size:20px;font-weight:900;color:#ff4466;margin-bottom:12px}.msg{color:#88aacc;font-size:14px;line-height:1.6}
.btn{display:inline-block;margin-top:24px;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#ff1744,#8b0000);color:#fff;font-weight:700;text-decoration:none;font-size:14px}</style>
</head><body><div class="box"><div class="icon">⚠️</div><div class="title">Có lỗi xảy ra</div>
<div class="msg">${msg}</div>
<a class="btn" href="javascript:history.back()">← Quay lại</a></div></body></html>`;

  if (!deviceId || !token) {
    res.status(400).send(errorPage("Thiếu thông tin xác thực. Vui lòng thử lại."));
    return;
  }

  const record = claimTokens.get(token);
  if (!record) {
    res.status(400).send(errorPage("Link đã hết hạn hoặc không hợp lệ. Vui lòng lấy link mới."));
    return;
  }
  if (record.deviceId !== deviceId) {
    res.status(403).send(errorPage("Token không khớp với thiết bị. Vui lòng thử lại."));
    return;
  }
  if (record.used) {
    // Nếu đã dùng — tìm key đã tạo và hiển thị lại
    const allKeys = await db.select().from(keysTable).where(
      and(eq(keysTable.tier, "free"), eq(keysTable.isActive, true))
    );
    for (const k of allKeys) {
      const devs = await db.select().from(devicesTable).where(eq(devicesTable.keyId, k.id));
      if (devs.find(d => d.deviceId === deviceId) && k.expiresAt && new Date() < k.expiresAt) {
        const remaining = Math.ceil((k.expiresAt.getTime() - Date.now()) / 60000);
        res.redirect(`${API_BASE_URL}/api/keys/free-success?key=${encodeURIComponent(k.key)}&deviceName=${encodeURIComponent(deviceName)}&remaining=${remaining}`);
        return;
      }
    }
    res.status(400).send(errorPage("Key free này đã được sử dụng. Key có thể đã hết hạn. Vui lòng lấy key mới."));
    return;
  }

  // Đánh dấu token đã dùng
  record.used = true;
  claimTokens.set(token, record);

  // Tạo key free mới cho thiết bị này
  const newKey = generateKey();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 phút

  const [keyRow] = await db.insert(keysTable).values({
    key: newKey,
    label: `Free · ${escapeHtml(deviceName)}`,
    isActive: true,
    maxDevices: 1,
    expiresAt,
    tier: "free",
    note: "Key miễn phí 30 phút — tự động tạo qua Link4m",
    discordUserId: "",
  }).returning();

  await db.insert(devicesTable).values({
    keyId: keyRow.id,
    deviceId,
    deviceName,
    lastSeen: new Date(),
  });

  req.log.info({ key: newKey, deviceId }, "Free key created via Link4m");

  res.redirect(`${API_BASE_URL}/api/keys/free-success?key=${encodeURIComponent(newKey)}&deviceName=${encodeURIComponent(deviceName)}&remaining=30`);
});

// ═════════════════════════════════════════════════════════════════════════════
// TRANG HIỂN THỊ KEY ĐÃ TẠO (đẹp mắt)
// GET /api/keys/free-success?key=XXX&deviceName=XXX&remaining=30
// ═════════════════════════════════════════════════════════════════════════════
router.get("/keys/free-success", async (req, res): Promise<void> => {
  const key        = (req.query.key        as string) ?? "";
  const deviceName = decodeURIComponent((req.query.deviceName as string) ?? "Thiết bị của bạn");
  const remaining  = parseInt((req.query.remaining as string) ?? "30", 10) || 30;

  if (!key) { res.status(400).send("Thiếu key"); return; }

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Key Của Bạn — Aujunpeak</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;background:radial-gradient(ellipse at top,#001a0f 0%,#000a05 60%,#000 100%);font-family:'Inter',sans-serif;color:#fff;overflow-x:hidden}
    .particles{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
    .particle{position:absolute;border-radius:50%;animation:floatUp linear infinite;opacity:0}
    @keyframes floatUp{0%{transform:translateY(100vh) scale(0);opacity:0}10%{opacity:.6}90%{opacity:.3}100%{transform:translateY(-20vh) scale(1.2);opacity:0}}
    .container{position:relative;z-index:1;max-width:480px;margin:0 auto;padding:24px 16px 48px}
    .success-header{text-align:center;margin-bottom:32px;padding-top:24px}
    .check-circle{width:100px;height:100px;border-radius:50%;background:linear-gradient(135deg,#00e676,#00c853);margin:0 auto 20px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 50px rgba(0,200,83,.5),0 0 100px rgba(0,200,83,.2);animation:successPop .6s cubic-bezier(.34,1.56,.64,1) forwards, glow 2.5s ease-in-out 1s infinite}
    @keyframes successPop{0%{transform:scale(0) rotate(-45deg);opacity:0}80%{transform:scale(1.15) rotate(5deg)}100%{transform:scale(1) rotate(0deg);opacity:1}}
    @keyframes glow{0%,100%{box-shadow:0 0 50px rgba(0,200,83,.5),0 0 100px rgba(0,200,83,.2)}50%{box-shadow:0 0 70px rgba(0,230,118,.7),0 0 130px rgba(0,230,118,.35)}}
    .check-circle svg{width:52px;height:52px}
    .success-title{font-size:26px;font-weight:900;color:#fff;margin-bottom:8px;letter-spacing:-.01em}
    .success-sub{color:#66cc99;font-size:14px;font-weight:600}

    .card{background:linear-gradient(145deg,rgba(0,230,118,.08),rgba(0,100,50,.05));border:1px solid rgba(0,230,118,.2);border-radius:20px;padding:20px;margin-bottom:16px;backdrop-filter:blur(12px);animation:slideUp .5s ease forwards;opacity:0}
    .card:nth-child(1){animation-delay:.2s}
    .card:nth-child(2){animation-delay:.35s}
    .card:nth-child(3){animation-delay:.5s}
    @keyframes slideUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    .card-title{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#66cc99;margin-bottom:16px;display:flex;align-items:center;gap:8px}
    .card-title::before{content:'';width:20px;height:2px;background:#00c853;border-radius:2px}

    .key-display{background:rgba(0,0,0,.5);border:2px solid rgba(0,230,118,.35);border-radius:14px;padding:18px;text-align:center;margin-bottom:12px;position:relative;overflow:hidden}
    .key-display::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(0,230,118,.06),transparent);animation:scan 3s linear infinite}
    @keyframes scan{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
    .key-text{font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:700;color:#fff;letter-spacing:.15em;word-break:break-all;line-height:1.4}
    .key-text .dash{color:rgba(0,230,118,.5);margin:0 2px}

    .btn-copy-key{width:100%;padding:14px;border-radius:12px;background:linear-gradient(135deg,#00c853,#009639);border:none;color:#fff;font-size:14px;font-weight:800;letter-spacing:.04em;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
    .btn-copy-key:active{transform:scale(.98)}
    .btn-copy-key.copied{background:linear-gradient(135deg,#667eea,#764ba2)}

    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .info-item{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;text-align:center}
    .info-item-label{font-size:10px;color:#779988;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
    .info-item-value{font-size:15px;font-weight:900;color:#fff}
    .info-item-value.highlight{color:#00e676}
    .info-item-value.warn{color:#ffcc02}

    .timer-section{display:flex;align-items:center;gap:12px;padding:14px;background:rgba(255,204,0,.06);border:1px solid rgba(255,204,0,.2);border-radius:12px}
    .timer-icon{font-size:28px}
    .timer-label{font-size:11px;color:#cc9900;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
    .timer-display{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:900;color:#ffcc02}

    .steps-use{display:flex;flex-direction:column;gap:10px}
    .step-use{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#aabbcc;line-height:1.5}
    .step-use strong{color:#fff}
    .step-badge{width:24px;height:24px;border-radius:50%;background:rgba(0,200,83,.15);border:1px solid rgba(0,200,83,.3);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#00c853;flex-shrink:0;margin-top:1px}

    .footer{text-align:center;color:#334455;font-size:11px;margin-top:32px;line-height:1.8}
  </style>
</head>
<body>
<div class="particles" id="particles"></div>
<div class="container">

  <div class="success-header">
    <div class="check-circle">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 27L22 35L38 17" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="success-title">Key Đã Được Tạo! 🎉</div>
    <div class="success-sub">Sao chép key và kích hoạt ngay trong ứng dụng</div>
  </div>

  <!-- CARD 1: KEY -->
  <div class="card">
    <div class="card-title">Key Kích Hoạt Của Bạn</div>
    <div class="key-display">
      <div class="key-text" id="keyText">${escapeHtml(key)}</div>
    </div>
    <button class="btn-copy-key" id="btnCopyKey" onclick="copyKey()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
      </svg>
      Sao Chép Key
    </button>
  </div>

  <!-- CARD 2: THÔNG TIN KEY -->
  <div class="card">
    <div class="card-title">Thông tin key</div>
    <div class="info-grid">
      <div class="info-item">
        <div class="info-item-label">Loại Key</div>
        <div class="info-item-value highlight">FREE</div>
      </div>
      <div class="info-item">
        <div class="info-item-label">Số thiết bị</div>
        <div class="info-item-value">1 / 1</div>
      </div>
      <div class="info-item">
        <div class="info-item-label">Hiệu lực</div>
        <div class="info-item-value warn">${remaining} phút</div>
      </div>
      <div class="info-item">
        <div class="info-item-label">Thiết bị</div>
        <div class="info-item-value" style="font-size:11px;padding-top:4px">${escapeHtml(deviceName.length > 14 ? deviceName.substring(0,13)+"…" : deviceName)}</div>
      </div>
    </div>

    <div class="timer-section" style="margin-top:14px">
      <div class="timer-icon">⏱</div>
      <div>
        <div class="timer-label">Thời gian còn lại</div>
        <div class="timer-display" id="timerDisplay">--:--</div>
      </div>
    </div>
  </div>

  <!-- CARD 3: HƯỚNG DẪN SỬ DỤNG -->
  <div class="card">
    <div class="card-title">Cách sử dụng</div>
    <div class="steps-use">
      <div class="step-use"><div class="step-badge">1</div>Nhấn <strong>Sao chép key</strong> bên trên</div>
      <div class="step-use"><div class="step-badge">2</div>Mở ứng dụng <strong>Aujunpeak</strong> trên điện thoại</div>
      <div class="step-use"><div class="step-badge">3</div>Dán key vào ô <strong>Nhập key kích hoạt</strong></div>
      <div class="step-use"><div class="step-badge">4</div>Nhấn <strong>START KEY</strong> để kích hoạt</div>
    </div>
  </div>

  <div class="footer">
    Aujunpeak · Key Free · Giới hạn 30 phút · Chỉ dùng trên 1 thiết bị<br/>
    Muốn key dài hơn? Liên hệ admin để nâng cấp VIP
  </div>
</div>

<script>
  // Particles
  const c = document.getElementById('particles');
  const COLORS = ['#00e676','#00c853','#69ff47','#b9f6ca','#00e676'];
  for(let i=0;i<28;i++){
    const p=document.createElement('div');
    p.className='particle';
    const size=Math.random()*5+2;
    p.style.cssText='width:'+size+'px;height:'+size+'px;left:'+Math.random()*100+'%;background:'+COLORS[Math.floor(Math.random()*COLORS.length)]+';animation-duration:'+(Math.random()*12+8)+'s;animation-delay:-'+(Math.random()*12)+'s';
    c.appendChild(p);
  }

  // Copy key
  function copyKey(){
    const key = document.getElementById('keyText').textContent;
    navigator.clipboard.writeText(key).then(()=>{showCopied();}).catch(()=>{
      const ta=document.createElement('textarea');
      ta.value=key;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.focus();ta.select();
      document.execCommand('copy');document.body.removeChild(ta);
      showCopied();
    });
  }
  function showCopied(){
    const btn=document.getElementById('btnCopyKey');
    btn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg> ✓ Đã sao chép!';
    btn.classList.add('copied');
    setTimeout(()=>{
      btn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Sao Chép Key';
      btn.classList.remove('copied');
    },3000);
  }

  // Countdown timer
  let secs = ${remaining} * 60;
  function updateTimer(){
    const m = Math.floor(secs/60);
    const s = secs % 60;
    document.getElementById('timerDisplay').textContent =
      (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
    if(secs<=0){
      document.getElementById('timerDisplay').textContent='HẾT HẠN';
      document.getElementById('timerDisplay').style.color='#ff4466';
      return;
    }
    secs--;
    setTimeout(updateTimer, 1000);
  }
  updateTimer();
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── HTML escape helper ─────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ── Validate key ─────────────────────────────────────────────────────────────
router.post("/keys/validate", async (req, res): Promise<void> => {
  const { key, deviceId, deviceName } = req.body;
  if (!key || !deviceId) {
    res.status(400).json({ ok: false, message: "Thiếu key hoặc deviceId" });
    return;
  }

  const [record] = await db.select().from(keysTable).where(eq(keysTable.key, key));
  if (!record) {
    res.status(200).json({ ok: false, message: "Key không tồn tại. Vui lòng kiểm tra lại." });
    return;
  }
  if (!record.isActive) {
    res.status(200).json({ ok: false, message: "Key đã bị khóa. Liên hệ admin để mở khóa." });
    return;
  }
  if (record.expiresAt && new Date() > record.expiresAt) {
    res.status(200).json({ ok: false, message: "Key đã hết hạn. Liên hệ admin để gia hạn." });
    return;
  }

  const existingDevices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
  const thisDevice = existingDevices.find(d => d.deviceId === deviceId);

  if (!thisDevice) {
    if (existingDevices.length >= record.maxDevices) {
      res.status(200).json({
        ok: false,
        message: `Key đã đăng nhập trên ${existingDevices.length}/${record.maxDevices} thiết bị. Liên hệ admin.`
      });
      return;
    }
    await db.insert(devicesTable).values({
      keyId: record.id,
      deviceId,
      deviceName: deviceName ?? "Unknown",
      lastSeen: new Date(),
    });
  } else {
    await db.update(devicesTable)
      .set({ lastSeen: new Date(), deviceName: deviceName ?? thisDevice.deviceName })
      .where(eq(devicesTable.id, thisDevice.id));
  }

  const expiresAt = record.expiresAt;
  const daysLeft = expiresAt
    ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000))
    : null;

  req.log.info({ key: record.key }, "Key validated successfully");
  res.json({
    ok: true,
    key: record.key,
    label: record.label,
    note: record.note,
    tier: record.tier,
    expiresAt: expiresAt?.toISOString() ?? null,
    daysLeft,
    maxDevices: record.maxDevices,
    deviceCount: existingDevices.length + (thisDevice ? 0 : 1),
  });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────
router.post("/keys/heartbeat", async (req, res): Promise<void> => {
  const { key, deviceId } = req.body;
  if (!key || !deviceId) {
    res.status(400).json({ ok: false });
    return;
  }

  const [record] = await db.select().from(keysTable).where(eq(keysTable.key, key));
  if (!record || !record.isActive) {
    res.json({ ok: false, revoked: true });
    return;
  }
  if (record.expiresAt && new Date() > record.expiresAt) {
    res.json({ ok: false, expired: true });
    return;
  }

  await db.update(devicesTable)
    .set({ lastSeen: new Date() })
    .where(and(eq(devicesTable.keyId, record.id), eq(devicesTable.deviceId, deviceId)));

  // Lấy thông báo chưa đọc + danh sách id còn tồn tại (để client dọn thông báo đã bị xoá)
  const { pending, activeIds } = await getPendingNotifications(deviceId);
  const deviceCount = await db.select({ count: sql<number>`count(*)` })
    .from(devicesTable)
    .where(eq(devicesTable.keyId, record.id));

  res.json({
    ok: true,
    tier: record.tier,
    note: record.note,
    maxDevices: record.maxDevices,
    deviceCount: Number(deviceCount[0]?.count ?? 1),
    notifications: pending,
    activeNotificationIds: activeIds,
  });
});

// ── Đánh dấu thông báo đã đọc ───────────────────────────────────────────────
router.post("/keys/notifications/read", async (req, res): Promise<void> => {
  const { deviceId, ids } = req.body;
  if (!deviceId || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ ok: false });
    return;
  }

  // Chỉ insert những cái chưa có
  const existing = await db.select().from(notificationReadsTable)
    .where(and(eq(notificationReadsTable.deviceId, deviceId), inArray(notificationReadsTable.notificationId, ids)));
  const existingIds = new Set(existing.map(r => r.notificationId));
  const toInsert = ids.filter((id: number) => !existingIds.has(id));

  if (toInsert.length > 0) {
    await db.insert(notificationReadsTable).values(
      toInsert.map((id: number) => ({ notificationId: id, deviceId }))
    );
  }
  res.json({ ok: true });
});

// ── Logout ───────────────────────────────────────────────────────────────────
router.post("/keys/logout", async (req, res): Promise<void> => {
  const { key, deviceId } = req.body;
  if (!key || !deviceId) {
    res.status(400).json({ ok: false });
    return;
  }

  const [record] = await db.select().from(keysTable).where(eq(keysTable.key, key));
  if (record) {
    await db.delete(devicesTable)
      .where(and(eq(devicesTable.keyId, record.id), eq(devicesTable.deviceId, deviceId)));
  }
  res.json({ ok: true });
});

// ── Admin: Gửi thông báo đến tất cả người dùng ───────────────────────────────
router.post("/admin/notify", requireAdmin, async (req, res): Promise<void> => {
  const { title, body, sentBy } = req.body;
  if (!title || !body) {
    res.status(400).json({ ok: false, error: "title và body là bắt buộc" });
    return;
  }
  const [notif] = await db.insert(notificationsTable).values({
    title,
    body,
    sentBy: sentBy ?? "admin",
  }).returning();
  req.log.info({ notifId: notif.id }, "Notification sent");
  res.json({ ok: true, id: notif.id, title, body });
});

// ── Admin: CRUD keys (hỗ trợ phân trang, không giới hạn 20) ──────────────────
router.get("/admin/keys", requireAdmin, async (req, res): Promise<void> => {
  const keys = await db.select().from(keysTable).orderBy(keysTable.createdAt);

  const page = req.query.page !== undefined ? parseInt(req.query.page as string, 10) : undefined;
  const pageSize = req.query.pageSize !== undefined ? parseInt(req.query.pageSize as string, 10) : undefined;

  if (page !== undefined && pageSize !== undefined && !isNaN(page) && !isNaN(pageSize) && pageSize > 0) {
    const start = page * pageSize;
    const paged = keys.slice(start, start + pageSize);
    res.json({
      ok: true,
      keys: paged,
      total: keys.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(keys.length / pageSize)),
    });
    return;
  }

  // Không truyền page/pageSize -> trả về TOÀN BỘ key, không giới hạn số lượng
  res.json({ ok: true, keys, total: keys.length });
});

router.post("/admin/keys", requireAdmin, async (req, res): Promise<void> => {
  const { days, maxDevices, label, note, discordUserId, tier, key: customKey } = req.body;

  if (tier !== undefined && !["free", "vip"].includes(tier)) {
    res.status(400).json({ ok: false, error: "tier phải là 'free' hoặc 'vip'" });
    return;
  }
  if (maxDevices !== undefined && (!Number.isInteger(Number(maxDevices)) || Number(maxDevices) < 1)) {
    res.status(400).json({ ok: false, error: "maxDevices phải là số nguyên >= 1" });
    return;
  }
  if (days !== undefined && isNaN(Number(days))) {
    res.status(400).json({ ok: false, error: "days phải là số" });
    return;
  }

  let key: string;
  if (customKey && String(customKey).trim().length > 0) {
    key = String(customKey).trim().toUpperCase().replace(/\s+/g, "-");
    if (key.length < 4) {
      res.status(400).json({ ok: false, error: "Key tùy chỉnh phải có ít nhất 4 ký tự" });
      return;
    }
    const [existing] = await db.select().from(keysTable).where(eq(keysTable.key, key));
    if (existing) {
      res.status(409).json({ ok: false, error: "Key đã tồn tại" });
      return;
    }
  } else {
    key = generateKey();
  }

  const expiresAt = days && Number(days) > 0
    ? new Date(Date.now() + Number(days) * 86400000)
    : null;

  try {
    const [record] = await db.insert(keysTable).values({
      key,
      label: label ?? "",
      note: note ?? "",
      maxDevices: maxDevices ?? 1,
      expiresAt,
      discordUserId: discordUserId ?? "",
      tier: tier ?? "free",
    }).returning();
    res.json({ ok: true, key: record });
  } catch (err: any) {
    // Race condition: 2 request cùng lúc tạo trùng key tùy chỉnh -> unique constraint violation (Postgres code 23505)
    if (err?.code === "23505") {
      res.status(409).json({ ok: false, error: "Key đã tồn tại" });
      return;
    }
    logger.error({ err }, "Failed to create key");
    res.status(500).json({ ok: false, error: "Không thể tạo key" });
  }
});

router.patch("/admin/keys/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ ok: false, error: "id không hợp lệ" }); return; }

  const { label, note, maxDevices } = req.body;
  if (maxDevices !== undefined && (!Number.isInteger(Number(maxDevices)) || Number(maxDevices) < 1)) {
    res.status(400).json({ ok: false, error: "maxDevices phải là số nguyên >= 1" });
    return;
  }

  const patch: Record<string, unknown> = {};
  if (label !== undefined) patch.label = label;
  if (note !== undefined) patch.note = note;
  if (maxDevices !== undefined) patch.maxDevices = maxDevices;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: "Không có trường nào để cập nhật" });
    return;
  }

  const [record] = await db.update(keysTable).set(patch).where(eq(keysTable.id, id)).returning();
  if (!record) { res.status(404).json({ ok: false }); return; }
  res.json({ ok: true, key: record });
});

router.patch("/admin/keys/:id/deactivate", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [record] = await db.update(keysTable).set({ isActive: false }).where(eq(keysTable.id, id)).returning();
  if (!record) { res.status(404).json({ ok: false }); return; }
  res.json({ ok: true, isActive: false });
});

router.patch("/admin/keys/:id/activate", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [record] = await db.update(keysTable).set({ isActive: true }).where(eq(keysTable.id, id)).returning();
  if (!record) { res.status(404).json({ ok: false }); return; }
  res.json({ ok: true, isActive: true });
});

router.patch("/admin/keys/:id/tier", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { tier } = req.body;
  if (!tier || !["free", "vip"].includes(tier)) {
    res.status(400).json({ ok: false, error: "tier phải là 'free' hoặc 'vip'" });
    return;
  }
  const [record] = await db.update(keysTable).set({ tier }).where(eq(keysTable.id, id)).returning();
  if (!record) { res.status(404).json({ ok: false }); return; }
  res.json({ ok: true, tier: record.tier });
});

router.patch("/admin/keys/:id/extend", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { days } = req.body;
  if (!days || isNaN(Number(days))) {
    res.status(400).json({ ok: false, error: "days required" });
    return;
  }

  const [existing] = await db.select().from(keysTable).where(eq(keysTable.id, id));
  if (!existing) { res.status(404).json({ ok: false }); return; }

  const base = existing.expiresAt && existing.expiresAt > new Date() ? existing.expiresAt : new Date();
  const newExpiry = new Date(base.getTime() + Number(days) * 86400000);
  const [record] = await db.update(keysTable).set({ expiresAt: newExpiry }).where(eq(keysTable.id, id)).returning();
  res.json({ ok: true, expiresAt: record.expiresAt });
});

router.delete("/admin/keys/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  await db.delete(keysTable).where(eq(keysTable.id, id));
  res.json({ ok: true });
});

router.delete("/admin/keys/:id/devices/:deviceId", requireAdmin, async (req, res): Promise<void> => {
  const keyId = parseInt(req.params.id as string, 10);
  const devId = parseInt(req.params.deviceId as string, 10);
  await db.delete(devicesTable).where(and(eq(devicesTable.keyId, keyId), eq(devicesTable.id, devId)));
  res.json({ ok: true });
});

// ── Admin: Quản lý thông báo (danh sách + xóa) ───────────────────────────────
router.get("/admin/notifications", requireAdmin, async (req, res): Promise<void> => {
  const notifs = await db.select().from(notificationsTable).orderBy(sql`${notificationsTable.createdAt} DESC`);

  const page = req.query.page !== undefined ? parseInt(req.query.page as string, 10) : undefined;
  const pageSize = req.query.pageSize !== undefined ? parseInt(req.query.pageSize as string, 10) : undefined;

  if (page !== undefined && pageSize !== undefined && !isNaN(page) && !isNaN(pageSize) && pageSize > 0) {
    const start = page * pageSize;
    const paged = notifs.slice(start, start + pageSize);
    res.json({
      ok: true,
      notifications: paged,
      total: notifs.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(notifs.length / pageSize)),
    });
    return;
  }

  res.json({ ok: true, notifications: notifs, total: notifs.length });
});

router.delete("/admin/notifications/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [existing] = await db.select().from(notificationsTable).where(eq(notificationsTable.id, id));
  if (!existing) { res.status(404).json({ ok: false }); return; }

  await db.delete(notificationsTable).where(eq(notificationsTable.id, id));
  await db.delete(notificationReadsTable).where(eq(notificationReadsTable.notificationId, id));
  res.json({ ok: true });
});

router.delete("/admin/notifications", requireAdmin, async (req, res): Promise<void> => {
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(notificationsTable);
  await db.delete(notificationReadsTable);
  await db.delete(notificationsTable);
  res.json({ ok: true, deleted: Number(count) });
});

router.get("/admin/stats", requireAdmin, async (req, res): Promise<void> => {
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(keysTable);
  const [{ active }] = await db.select({ active: sql<number>`count(*)` }).from(keysTable).where(eq(keysTable.isActive, true));
  const [{ devices }] = await db.select({ devices: sql<number>`count(*)` }).from(devicesTable);
  const [{ vip }] = await db.select({ vip: sql<number>`count(*)` }).from(keysTable).where(and(eq(keysTable.isActive, true), eq(keysTable.tier, "vip")));

  const now = new Date();
  const expired = await db.select().from(keysTable).where(
    and(eq(keysTable.isActive, true), sql`${keysTable.expiresAt} < ${now}`)
  );

  res.json({ ok: true, total: Number(total), active: Number(active), devices: Number(devices), expired: expired.length, vip: Number(vip) });
});

export default router;
