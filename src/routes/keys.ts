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
  const deviceName = decodeURIComponent((req.query.deviceName as string) ?? "Unknown Device");

  if (!deviceId) {
    res.status(400).send("<h2>Thiếu deviceId</h2>"); return;
  }

  // Tạo claim token + gọi Link4m server-side
  const token = generateToken();
  claimTokens.set(token, { deviceId, deviceName, createdAt: Date.now(), used: false });

  const claimUrl = `${API_BASE_URL}/api/keys/claim-free`
    + `?deviceId=${encodeURIComponent(deviceId)}`
    + `&deviceName=${encodeURIComponent(deviceName)}`
    + `&token=${encodeURIComponent(token)}`;

  let link4mUrl = claimUrl; // fallback nếu Link4m lỗi
  try { link4mUrl = await createLink4mUrl(claimUrl); } catch (_) {}

  const safeName = escapeHtml(deviceName);
  const safeId   = escapeHtml(deviceId.substring(0, 20)) + "…";
  const safeUrl  = escapeHtml(link4mUrl);

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Xác thực thiết bị · Aujunpeak</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{scroll-behavior:smooth}
body{min-height:100vh;background:#070b12;font-family:'Inter',sans-serif;color:#fff;overflow-x:hidden}

/* Background glow */
.bg-glow{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.glow-1{position:absolute;top:-20%;left:-15%;width:65%;height:65%;
  background:radial-gradient(circle,rgba(255,152,0,.14) 0%,transparent 70%);
  animation:g1 9s ease-in-out infinite alternate}
.glow-2{position:absolute;bottom:-15%;right:-10%;width:55%;height:55%;
  background:radial-gradient(circle,rgba(255,87,34,.1) 0%,transparent 70%);
  animation:g2 12s ease-in-out infinite alternate}
@keyframes g1{to{transform:translate(8%,12%) scale(1.15)}}
@keyframes g2{to{transform:translate(-7%,-8%) scale(1.2)}}

/* Floating particles */
.pts{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.pt{position:absolute;border-radius:50%;animation:ptUp linear infinite;opacity:0}
@keyframes ptUp{
  0%{transform:translateY(105vh) scale(0);opacity:0}
  8%{opacity:.55}92%{opacity:.18}
  100%{transform:translateY(-5vh) scale(1.1);opacity:0}
}

.wrap{position:relative;z-index:1;max-width:430px;margin:0 auto;padding:32px 18px 64px}

/* ── Header ── */
.hdr{text-align:center;margin-bottom:32px}
.logo-wrap{position:relative;width:80px;height:80px;margin:0 auto 18px}
.logo-bg{
  width:80px;height:80px;border-radius:50%;
  background:linear-gradient(135deg,#FF8C00,#FF5722);
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 0 0 rgba(255,140,0,.6);
  animation:pulse 2.5s ease-out infinite;
}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 rgba(255,140,0,.55)}
  70%{box-shadow:0 0 0 18px rgba(255,140,0,0)}
  100%{box-shadow:0 0 0 0 rgba(255,140,0,0)}
}
.logo-ring{
  position:absolute;inset:-6px;border-radius:50%;
  border:2px solid transparent;
  border-top:2px solid #FF9800;
  border-right:2px solid rgba(255,152,0,.25);
  animation:spin 3s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.hdr-title{font-size:24px;font-weight:900;letter-spacing:-.02em;margin-bottom:7px}
.hdr-title em{color:#FF9800;font-style:normal}
.hdr-sub{font-size:13px;color:#607080;font-weight:500;line-height:1.5}

/* ── Cards ── */
.card{
  background:linear-gradient(145deg,rgba(255,140,0,.07) 0%,rgba(12,18,28,.75) 100%);
  border:1px solid rgba(255,140,0,.16);
  border-radius:22px;padding:20px;margin-bottom:14px;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  overflow:hidden;position:relative;
}
.card-shine{
  position:absolute;top:0;left:-120%;width:60%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);
  animation:cshine 7s linear infinite;
}
@keyframes cshine{to{left:160%}}
.card-hd{font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;
  color:#FF9800;opacity:.9;margin-bottom:14px;display:flex;align-items:center;gap:7px}
.card-hd::before{content:'';width:18px;height:2px;background:#FF9800;border-radius:2px}

/* Device rows */
.dr{display:flex;align-items:center;gap:13px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.dr:last-child{border:none;padding-bottom:0}
.dr-ic{width:32px;height:32px;border-radius:10px;background:rgba(255,140,0,.11);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.dr-ic svg{width:16px;height:16px;stroke:#FF9800;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.dr-meta{flex:1;min-width:0}
.dr-lbl{font-size:10px;color:#4a6070;font-weight:700;letter-spacing:.07em;text-transform:uppercase;margin-bottom:3px}
.dr-val{font-size:13px;color:#dde8f2;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-val.mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:#FF9855;letter-spacing:.02em}

/* ── Verification steps ── */
.steps{display:flex;flex-direction:column;gap:2px}
.srow{
  display:flex;align-items:center;gap:13px;
  padding:14px 4px;border-bottom:1px solid rgba(255,255,255,.04);
  opacity:0;transform:translateX(-14px);
  transition:opacity .45s ease,transform .45s ease;
}
.srow:last-child{border:none}
.srow.vis{opacity:1;transform:translateX(0)}

.s-ic{width:36px;height:36px;border-radius:50%;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;position:relative;transition:all .3s ease}
.s-ic.idle{background:rgba(255,255,255,.05);border:2px solid rgba(255,255,255,.09)}
.s-ic.spin-state{background:rgba(255,140,0,.1);border:2px solid rgba(255,140,0,.28)}
.s-ic.spin-state::after{
  content:'';position:absolute;inset:-2px;border-radius:50%;
  border:2.5px solid transparent;border-top-color:#FF9800;
  animation:spin .75s linear infinite;
}
.s-ic.ok{background:rgba(0,220,80,.12);border:2px solid rgba(0,220,80,.32)}
.s-ic svg{width:15px;height:15px;transition:all .3s ease}

.s-body{flex:1}
.s-name{font-size:13px;font-weight:700;color:#b8ccd8;margin-bottom:3px;transition:color .3s}
.s-name.ok-text{color:#5debb0}
.s-desc{font-size:11px;color:#3d5060;font-weight:400;line-height:1.5}

.s-badge{
  padding:3px 9px;border-radius:10px;font-size:10px;font-weight:700;
  letter-spacing:.07em;white-space:nowrap;
  background:rgba(0,220,80,.1);border:1px solid rgba(0,220,80,.22);
  color:#55dd90;
  opacity:0;transform:scale(.8);transition:all .3s ease;
}
.s-badge.show{opacity:1;transform:scale(1)}

/* ── Get Key button section ── */
.btn-wrap{
  margin-top:4px;
  opacity:0;transform:translateY(22px);
  transition:opacity .55s ease,transform .55s ease;
}
.btn-wrap.show{opacity:1;transform:translateY(0)}

.btn-get{
  display:flex;align-items:center;justify-content:center;gap:11px;
  width:100%;padding:18px 20px;border-radius:18px;
  background:linear-gradient(135deg,#FF6D00 0%,#FF9800 50%,#FFC107 100%);
  border:none;color:#fff;text-decoration:none;
  font-size:16px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;
  cursor:pointer;position:relative;overflow:hidden;
  box-shadow:0 10px 40px rgba(255,140,0,.4),0 2px 12px rgba(0,0,0,.4);
  animation:btnPulse 2.8s ease-in-out infinite;
  transition:transform .15s ease,box-shadow .15s ease;
}
.btn-get::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(105deg,transparent 30%,rgba(255,255,255,.18) 50%,transparent 70%);
  transform:translateX(-100%);animation:btnShine 3.5s ease 1.2s infinite;
}
@keyframes btnShine{0%{transform:translateX(-100%)}30%,100%{transform:translateX(200%)}}
@keyframes btnPulse{0%,100%{box-shadow:0 10px 40px rgba(255,140,0,.4),0 2px 12px rgba(0,0,0,.4)}50%{box-shadow:0 14px 55px rgba(255,140,0,.62),0 4px 18px rgba(0,0,0,.4)}}
.btn-get:active{transform:scale(.97);box-shadow:0 6px 24px rgba(255,140,0,.35)}

.btn-note{
  display:flex;align-items:center;justify-content:center;gap:6px;
  margin-top:11px;font-size:11px;color:#3d5266;font-weight:500;line-height:1.6;text-align:center;
}
.bn-dot{width:4px;height:4px;border-radius:50%;background:#FF9800;opacity:.5}

/* Footer */
.ft{text-align:center;color:#1e2d3a;font-size:11px;margin-top:44px;line-height:2}
</style>
</head>
<body>
<div class="bg-glow"><div class="glow-1"></div><div class="glow-2"></div></div>
<div class="pts" id="pts"></div>

<div class="wrap">

  <!-- Header -->
  <div class="hdr">
    <div class="logo-wrap">
      <div class="logo-bg">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2.5"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          <circle cx="12" cy="16.5" r="1.3" fill="#fff" stroke="none"/>
        </svg>
      </div>
      <div class="logo-ring"></div>
    </div>
    <div class="hdr-title">LẤY KEY <em>MIỄN PHÍ</em></div>
    <div class="hdr-sub">Xác thực thiết bị &amp; nhận key 30 phút không mất phí</div>
  </div>

  <!-- Device info card -->
  <div class="card">
    <div class="card-shine"></div>
    <div class="card-hd">Thông tin thiết bị</div>
    <div class="dr">
      <div class="dr-ic">
        <svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2.5"/><circle cx="12" cy="17.5" r="1" fill="#FF9800" stroke="none"/></svg>
      </div>
      <div class="dr-meta">
        <div class="dr-lbl">Tên thiết bị</div>
        <div class="dr-val">${safeName}</div>
      </div>
    </div>
    <div class="dr">
      <div class="dr-ic">
        <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </div>
      <div class="dr-meta">
        <div class="dr-lbl">Device ID</div>
        <div class="dr-val mono">${safeId}</div>
      </div>
    </div>
    <div class="dr">
      <div class="dr-ic">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      </div>
      <div class="dr-meta">
        <div class="dr-lbl">Thời hạn</div>
        <div class="dr-val">30 phút · Miễn phí · 1 thiết bị</div>
      </div>
    </div>
  </div>

  <!-- Verification card -->
  <div class="card">
    <div class="card-shine"></div>
    <div class="card-hd">Quy trình xác thực</div>
    <div class="steps">
      <div class="srow" id="sr1">
        <div class="s-ic idle" id="ic1">
          <svg viewBox="0 0 24 24" stroke="#334455" fill="none" stroke-width="2"><circle cx="12" cy="12" r="4"/></svg>
        </div>
        <div class="s-body">
          <div class="s-name" id="sn1">Kiểm tra thiết bị</div>
          <div class="s-desc">Xác minh thông tin phần cứng &amp; hệ điều hành</div>
        </div>
        <div class="s-badge" id="sb1">✓ PASS</div>
      </div>
      <div class="srow" id="sr2">
        <div class="s-ic idle" id="ic2">
          <svg viewBox="0 0 24 24" stroke="#334455" fill="none" stroke-width="2"><circle cx="12" cy="12" r="4"/></svg>
        </div>
        <div class="s-body">
          <div class="s-name" id="sn2">Xác minh kết nối</div>
          <div class="s-desc">Kiểm tra kết nối tới máy chủ bảo mật</div>
        </div>
        <div class="s-badge" id="sb2">✓ PASS</div>
      </div>
      <div class="srow" id="sr3">
        <div class="s-ic idle" id="ic3">
          <svg viewBox="0 0 24 24" stroke="#334455" fill="none" stroke-width="2"><circle cx="12" cy="12" r="4"/></svg>
        </div>
        <div class="s-body">
          <div class="s-name" id="sn3">Tạo link bảo mật</div>
          <div class="s-desc">Tạo đường dẫn xác thực dành riêng cho thiết bị</div>
        </div>
        <div class="s-badge" id="sb3">✓ PASS</div>
      </div>
    </div>
  </div>

  <!-- Get key button (ẩn cho đến khi animation xong) -->
  <div class="btn-wrap" id="btnWrap">
    <a class="btn-get" href="${safeUrl}" id="btnGet">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 2H3v16h5l4 4 4-4h5V2z"/>
        <line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="12" y2="14"/>
      </svg>
      NHẬN KEY NGAY
    </a>
    <div class="btn-note">
      <span>Miễn phí</span><div class="bn-dot"></div>
      <span>30 phút</span><div class="bn-dot"></div>
      <span>1 thiết bị</span><div class="bn-dot"></div>
      <span>Không cần đăng ký</span>
    </div>
  </div>

</div>

<div class="ft">
  Aujunpeak Security System · v2.0<br/>
  Hỗ trợ qua Zalo &amp; Facebook · Liên hệ admin để nâng cấp VIP
</div>

<script>
// Particles
(function(){
  const c=document.getElementById('pts');
  const CL=['#FF9800','#FFC107','#FF6D00','#FFD740','#FFAB40','#FF8F00'];
  for(let i=0;i<22;i++){
    const p=document.createElement('div');p.className='pt';
    const s=Math.random()*4+1.5;
    p.style.cssText='width:'+s+'px;height:'+s+'px;left:'+(Math.random()*100)+'%;'
      +'background:'+CL[Math.floor(Math.random()*CL.length)]+';'
      +'animation-duration:'+(Math.random()*14+9)+'s;'
      +'animation-delay:-'+(Math.random()*14)+'s';
    c.appendChild(p);
  }
})();

// ── Verification animation ──
function setIdle(id){
  const el=document.getElementById(id);
  el.className='s-ic idle';
  el.innerHTML='<svg viewBox="0 0 24 24" stroke="#334455" fill="none" stroke-width="2"><circle cx="12" cy="12" r="4"/></svg>';
}
function setLoading(id){
  const el=document.getElementById(id);
  el.className='s-ic spin-state';
  el.innerHTML='<svg viewBox="0 0 24 24" stroke="#FF9800" fill="none" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
}
function setDone(id,nameId,badgeId){
  const el=document.getElementById(id);
  el.className='s-ic ok';
  el.innerHTML='<svg viewBox="0 0 24 24" stroke="#00dd66" fill="none" stroke-width="2.8" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const nm=document.getElementById(nameId);
  nm.className='s-name ok-text';
  const bd=document.getElementById(badgeId);
  bd.className='s-badge show';
}

const SEQ=[
  {sr:'sr1',ic:'ic1',sn:'sn1',sb:'sb1',show:120,load:480,done:1550},
  {sr:'sr2',ic:'ic2',sn:'sn2',sb:'sb2',show:420,load:1700,done:2800},
  {sr:'sr3',ic:'ic3',sn:'sn3',sb:'sb3',show:720,load:3000,done:4200},
];
SEQ.forEach(function(s){
  setTimeout(function(){document.getElementById(s.sr).classList.add('vis');},s.show);
  setTimeout(function(){setLoading(s.ic);},s.load);
  setTimeout(function(){setDone(s.ic,s.sn,s.sb);},s.done);
});
// Show get-key button after all steps done
setTimeout(function(){document.getElementById('btnWrap').classList.add('show');},4600);

// Prevent double-click
document.getElementById('btnGet').addEventListener('click',function(){
  this.style.pointerEvents='none';
  this.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" stroke="#fff" fill="none" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>&nbsp; Đang mở...';
});
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

  if (!key) { res.status(400).send("<h2>Thiếu key</h2>"); return; }

  const safeKey  = escapeHtml(key);
  const safeName = escapeHtml(deviceName);
  const safeSecs = remaining * 60;

  // Tách key thành các đoạn để format đẹp
  const parts = safeKey.split("-");
  const keyFormatted = parts.length === 4
    ? parts.map(p => `<span class="kp">${p}</span>`).join('<span class="ksep">-</span>')
    : safeKey;

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Key của bạn · Aujunpeak</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{min-height:100vh;background:#060d0a;font-family:'Inter',sans-serif;color:#fff;overflow-x:hidden}

.bg-glow{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.glow-1{position:absolute;top:-25%;left:-10%;width:60%;height:60%;
  background:radial-gradient(circle,rgba(0,230,100,.13) 0%,transparent 70%);
  animation:g1 10s ease-in-out infinite alternate}
.glow-2{position:absolute;bottom:-20%;right:-15%;width:55%;height:55%;
  background:radial-gradient(circle,rgba(0,180,80,.09) 0%,transparent 70%);
  animation:g2 13s ease-in-out infinite alternate}
@keyframes g1{to{transform:translate(7%,10%) scale(1.1)}}
@keyframes g2{to{transform:translate(-6%,-7%) scale(1.15)}}

.pts{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.pt{position:absolute;border-radius:50%;animation:ptUp linear infinite;opacity:0}
@keyframes ptUp{0%{transform:translateY(105vh) scale(0);opacity:0}8%{opacity:.5}92%{opacity:.18}100%{transform:translateY(-5vh);opacity:0}}

.wrap{position:relative;z-index:1;max-width:430px;margin:0 auto;padding:28px 18px 64px}

/* ── Success header ── */
.shdr{text-align:center;margin-bottom:28px}
.chk-wrap{position:relative;width:96px;height:96px;margin:0 auto 18px}
.chk-circle{
  width:96px;height:96px;border-radius:50%;
  background:linear-gradient(135deg,#00e676,#00a152);
  display:flex;align-items:center;justify-content:center;
  animation:chkPop .65s cubic-bezier(.34,1.56,.64,1) forwards,chkGlow 2.8s ease-in-out 1s infinite;
  transform:scale(0);opacity:0;
}
@keyframes chkPop{
  0%{transform:scale(0) rotate(-30deg);opacity:0}
  75%{transform:scale(1.12) rotate(4deg)}
  100%{transform:scale(1) rotate(0deg);opacity:1}
}
@keyframes chkGlow{
  0%,100%{box-shadow:0 0 30px rgba(0,230,100,.45),0 0 60px rgba(0,230,100,.15)}
  50%{box-shadow:0 0 50px rgba(0,230,100,.7),0 0 100px rgba(0,230,100,.25)}
}
.chk-ring{
  position:absolute;inset:-8px;border-radius:50%;
  border:2px solid transparent;
  border-top:2px solid rgba(0,230,100,.6);
  border-right:2px solid rgba(0,230,100,.2);
  animation:spin 4s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

.shdr-title{font-size:26px;font-weight:900;letter-spacing:-.02em;margin-bottom:8px;
  animation:fadeUp .5s ease .7s both}
.shdr-title em{color:#00e676;font-style:normal}
.shdr-sub{font-size:13px;color:#4a7a5a;font-weight:500;animation:fadeUp .5s ease .85s both}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}

/* ── Cards ── */
.card{
  background:linear-gradient(145deg,rgba(0,230,100,.07),rgba(8,16,12,.75));
  border:1px solid rgba(0,230,100,.16);
  border-radius:22px;padding:20px;margin-bottom:14px;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  overflow:hidden;position:relative;
  animation:cardIn .45s ease both;
}
.card:nth-child(1){animation-delay:.3s}
.card:nth-child(2){animation-delay:.45s}
.card:nth-child(3){animation-delay:.6s}
@keyframes cardIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.card-shine{
  position:absolute;top:0;left:-120%;width:60%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);
  animation:cshine 7s linear infinite;
}
@keyframes cshine{to{left:160%}}
.card-hd{font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;
  color:#00c853;opacity:.9;margin-bottom:16px;display:flex;align-items:center;gap:7px}
.card-hd::before{content:'';width:18px;height:2px;background:#00c853;border-radius:2px}

/* Device row in success */
.drow{display:flex;align-items:center;gap:12px}
.d-ic{width:40px;height:40px;border-radius:12px;background:rgba(0,200,80,.1);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.d-ic svg{width:20px;height:20px;stroke:#00c853;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.d-lbl{font-size:10px;color:#3a5a44;font-weight:700;letter-spacing:.07em;text-transform:uppercase;margin-bottom:4px}
.d-val{font-size:14px;color:#d0eedd;font-weight:700}

/* Key display */
.key-box{
  background:rgba(0,0,0,.45);border:2px solid rgba(0,230,100,.28);
  border-radius:16px;padding:20px 16px;text-align:center;
  margin-bottom:14px;position:relative;overflow:hidden;
}
.key-box::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(0,230,100,.06),transparent);
  animation:scan 3s linear infinite;
}
@keyframes scan{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.key-lbl{font-size:10px;font-weight:700;letter-spacing:.12em;color:#3d7a52;
  text-transform:uppercase;margin-bottom:12px}
.key-text{
  font-family:'JetBrains Mono',monospace;
  font-size:22px;font-weight:700;letter-spacing:.12em;
  color:#fff;line-height:1.3;
}
.kp{color:#fff}
.ksep{color:rgba(0,230,100,.45);margin:0 1px}

.btn-copy{
  width:100%;padding:14px 20px;border-radius:14px;
  background:linear-gradient(135deg,#00c853,#008c3a);border:none;
  color:#fff;font-size:14px;font-weight:800;letter-spacing:.04em;
  cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;
  transition:all .2s ease;box-shadow:0 6px 24px rgba(0,200,80,.35);
}
.btn-copy:active{transform:scale(.97);box-shadow:0 3px 14px rgba(0,200,80,.25)}
.btn-copy.done-state{background:linear-gradient(135deg,#667eea,#764ba2);box-shadow:0 6px 24px rgba(102,126,234,.35)}

/* Timer card */
.timer-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.timer-info{flex:1}
.timer-lbl{font-size:10px;color:#3a5a44;font-weight:700;letter-spacing:.07em;text-transform:uppercase;margin-bottom:6px}
.timer-val{font-family:'JetBrains Mono',monospace;font-size:30px;font-weight:700;color:#00e676;letter-spacing:.08em;transition:color .3s}
.timer-val.warn{color:#FFC107}
.timer-val.danger{color:#FF5252;animation:timerBlink 1s ease-in-out infinite}
@keyframes timerBlink{0%,100%{opacity:1}50%{opacity:.5}}
.timer-ic{width:52px;height:52px;border-radius:50%;background:rgba(0,230,100,.1);
  border:2px solid rgba(0,230,100,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.timer-ic svg{width:26px;height:26px;stroke:#00c853;fill:none;stroke-width:2;stroke-linecap:round}
.timer-note{font-size:11px;color:#2d4a36;margin-top:8px;font-weight:500;line-height:1.6}

/* Progress bar */
.prog-wrap{margin-top:12px;height:4px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden}
.prog-bar{height:100%;background:linear-gradient(90deg,#00e676,#00c853);border-radius:4px;
  transition:width 1s linear,background .5s ease;width:100%}

/* Instructions */
.steps-use{display:flex;flex-direction:column;gap:12px}
.step-use{display:flex;align-items:flex-start;gap:13px}
.su-num{
  width:26px;height:26px;border-radius:50%;flex-shrink:0;
  background:linear-gradient(135deg,#00c853,#008c3a);
  display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:900;margin-top:1px;
}
.su-text{font-size:13px;color:#88aabb;line-height:1.55;font-weight:500}
.su-text strong{color:#b8d8cc;font-weight:700}

/* Expired overlay */
.expired-msg{display:none;text-align:center;padding:18px;background:rgba(255,50,50,.08);
  border:1px solid rgba(255,50,50,.2);border-radius:14px;margin-top:4px}
.expired-msg.show{display:block}
.expired-ic{font-size:36px;margin-bottom:8px}
.expired-t{font-size:15px;font-weight:800;color:#ff5252;margin-bottom:6px}
.expired-s{font-size:12px;color:#886666;line-height:1.5}

.ft{text-align:center;color:#1a2d24;font-size:11px;margin-top:44px;line-height:2}
</style>
</head>
<body>
<div class="bg-glow"><div class="glow-1"></div><div class="glow-2"></div></div>
<div class="pts" id="pts"></div>
<div class="wrap">

  <!-- Success header -->
  <div class="shdr">
    <div class="chk-wrap">
      <div class="chk-circle">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="chk-ring"></div>
    </div>
    <div class="shdr-title">KEY <em>ĐÃ SẴN SÀNG!</em></div>
    <div class="shdr-sub">Sao chép key và dán vào ứng dụng Aujunpeak</div>
  </div>

  <!-- Device info -->
  <div class="card">
    <div class="card-shine"></div>
    <div class="card-hd">Thiết bị được cấp key</div>
    <div class="drow">
      <div class="d-ic">
        <svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2.5"/>
          <circle cx="12" cy="17.5" r="1" fill="#00c853" stroke="none"/></svg>
      </div>
      <div>
        <div class="d-lbl">Thiết bị</div>
        <div class="d-val">${safeName}</div>
      </div>
    </div>
  </div>

  <!-- Key display -->
  <div class="card">
    <div class="card-shine"></div>
    <div class="card-hd">Key kích hoạt của bạn</div>
    <div class="key-box">
      <div class="key-lbl">🔑 Key kích hoạt · Miễn phí</div>
      <div class="key-text" id="keyText">${keyFormatted}</div>
    </div>
    <button class="btn-copy" id="btnCopy" onclick="copyKey()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Sao Chép Key
    </button>
  </div>

  <!-- Countdown timer -->
  <div class="card" id="timerCard">
    <div class="card-shine"></div>
    <div class="card-hd">Thời hạn sử dụng</div>
    <div class="timer-row">
      <div class="timer-info">
        <div class="timer-lbl">Hết hạn sau</div>
        <div class="timer-val" id="timerDisplay">30:00</div>
        <div class="timer-note">Key chỉ hoạt động trên thiết bị này · Không thể gia hạn</div>
      </div>
      <div class="timer-ic">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      </div>
    </div>
    <div class="prog-wrap"><div class="prog-bar" id="progBar"></div></div>
  </div>

  <!-- Instructions -->
  <div class="card">
    <div class="card-shine"></div>
    <div class="card-hd">Cách sử dụng key</div>
    <div class="steps-use">
      <div class="step-use">
        <div class="su-num">1</div>
        <div class="su-text">Nhấn nút <strong>Sao Chép Key</strong> bên trên</div>
      </div>
      <div class="step-use">
        <div class="su-num">2</div>
        <div class="su-text">Mở ứng dụng <strong>Aujunpeak</strong> trên điện thoại</div>
      </div>
      <div class="step-use">
        <div class="su-num">3</div>
        <div class="su-text">Dán key vào ô <strong>Nhập key kích hoạt</strong></div>
      </div>
      <div class="step-use">
        <div class="su-num">4</div>
        <div class="su-text">Nhấn nút <strong>START KEY</strong> để kích hoạt ngay</div>
      </div>
    </div>
  </div>

  <div class="expired-msg" id="expiredMsg">
    <div class="expired-ic">⏰</div>
    <div class="expired-t">Key đã hết hạn</div>
    <div class="expired-s">Nhấn GET KEY FREE trong app để lấy key mới</div>
  </div>

</div>

<div class="ft">
  Aujunpeak · Key Free · 30 phút · 1 thiết bị<br/>
  Nâng cấp VIP để dùng không giới hạn · Liên hệ admin
</div>

<script>
// Particles
(function(){
  const c=document.getElementById('pts');
  const CL=['#00e676','#00c853','#69ff47','#b9f6ca','#00e676','#1de9b6'];
  for(let i=0;i<24;i++){
    const p=document.createElement('div');p.className='pt';
    const s=Math.random()*4+1.5;
    p.style.cssText='width:'+s+'px;height:'+s+'px;left:'+(Math.random()*100)+'%;'
      +'background:'+CL[Math.floor(Math.random()*CL.length)]+';'
      +'animation-duration:'+(Math.random()*14+9)+'s;'
      +'animation-delay:-'+(Math.random()*14)+'s';
    c.appendChild(p);
  }
})();

// Copy key
function copyKey(){
  const raw='${safeKey}';
  const btn=document.getElementById('btnCopy');
  navigator.clipboard.writeText(raw).then(ok).catch(function(){
    const ta=document.createElement('textarea');
    ta.value=raw;ta.style.cssText='position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);ta.focus();ta.select();
    document.execCommand('copy');document.body.removeChild(ta);ok();
  });
  function ok(){
    btn.className='btn-copy done-state';
    btn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> ✓ Đã sao chép!';
    setTimeout(function(){
      btn.className='btn-copy';
      btn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Sao Chép Key';
    },3000);
  }
}

// Countdown timer
var total=${safeSecs}, left=${safeSecs};
var prog=document.getElementById('progBar');
var disp=document.getElementById('timerDisplay');
var expMsg=document.getElementById('expiredMsg');
var timerCard=document.getElementById('timerCard');
function tick(){
  if(left<=0){
    disp.textContent='HẾT HẠN';
    disp.className='timer-val danger';
    prog.style.width='0%';
    prog.style.background='#ff5252';
    expMsg.className='expired-msg show';
    return;
  }
  left--;
  var m=Math.floor(left/60), s=left%60;
  disp.textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
  prog.style.width=((left/total)*100).toFixed(2)+'%';
  if(left<=300){
    disp.className='timer-val danger';
    prog.style.background='#ff5252';
  } else if(left<=600){
    disp.className='timer-val warn';
    prog.style.background='#FFC107';
  }
}
setInterval(tick,1000);
</script>
</body>
</html>`;
  res.setHeader("Content-Type","text/html; charset=utf-8");
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
