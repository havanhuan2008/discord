import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db, keysTable, devicesTable, notificationsTable, notificationReadsTable } from "../db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY ?? "";

function requireAdmin(req: any, res: any, next: any): void {
  const secret = req.headers["x-admin-secret"] ?? req.query.secret;
  if (!secret || secret !== ADMIN_SECRET) {
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

// Lấy thông báo chưa đọc của một deviceId
async function getPendingNotifications(deviceId: string) {
  const allNotifs = await db.select().from(notificationsTable).orderBy(notificationsTable.createdAt);
  if (allNotifs.length === 0) return [];

  const allIds = allNotifs.map(n => n.id);
  const reads = await db.select().from(notificationReadsTable)
    .where(and(eq(notificationReadsTable.deviceId, deviceId), inArray(notificationReadsTable.notificationId, allIds)));

  const readIds = new Set(reads.map(r => r.notificationId));
  return allNotifs.filter(n => !readIds.has(n.id)).map(n => ({
    id: n.id,
    title: n.title,
    body: n.body,
  }));
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

  // Lấy thông báo chưa đọc
  const notifications = await getPendingNotifications(deviceId);

  res.json({
    ok: true,
    tier: record.tier,
    note: record.note,
    notifications,
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

// ── Admin: CRUD keys ─────────────────────────────────────────────────────────
router.get("/admin/keys", requireAdmin, async (req, res): Promise<void> => {
  const keys = await db.select().from(keysTable).orderBy(keysTable.createdAt);
  res.json({ ok: true, keys });
});

router.post("/admin/keys", requireAdmin, async (req, res): Promise<void> => {
  const { days, maxDevices, label, note, discordUserId, tier } = req.body;
  const key = generateKey();
  const expiresAt = days && Number(days) > 0
    ? new Date(Date.now() + Number(days) * 86400000)
    : null;
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
