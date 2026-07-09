import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, keysTable, devicesTable } from "../db";
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
    expiresAt: expiresAt?.toISOString() ?? null,
    daysLeft,
    maxDevices: record.maxDevices,
    deviceCount: existingDevices.length + (thisDevice ? 0 : 1),
  });
});

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

  res.json({ ok: true });
});

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

router.post("/admin/keys/create", requireAdmin, async (req, res): Promise<void> => {
  const { label, maxDevices, days, discordUserId, note } = req.body;
  const key = generateKey();
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86400000) : null;

  const [record] = await db.insert(keysTable).values({
    key,
    label: label ?? "",
    maxDevices: maxDevices ? Number(maxDevices) : 1,
    isActive: true,
    expiresAt: expiresAt ?? undefined,
    discordUserId: discordUserId ?? "",
    note: note ?? "",
  }).returning();

  logger.info({ key: record.key }, "Admin created key");
  res.status(201).json({ ok: true, key: record.key, id: record.id, expiresAt: record.expiresAt });
});

router.get("/admin/keys", requireAdmin, async (req, res): Promise<void> => {
  const keys = await db.select().from(keysTable).orderBy(keysTable.createdAt);
  const result = await Promise.all(keys.map(async (k) => {
    const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, k.id));
    return { ...k, deviceCount: devices.length, devices };
  }));
  res.json({ ok: true, keys: result });
});

router.get("/admin/keys/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [record] = await db.select().from(keysTable).where(eq(keysTable.id, id));
  if (!record) {
    res.status(404).json({ ok: false, error: "Key not found" });
    return;
  }
  const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
  res.json({ ok: true, key: { ...record, devices } });
});

router.patch("/admin/keys/:id/lock", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [record] = await db.update(keysTable).set({ isActive: false }).where(eq(keysTable.id, id)).returning();
  if (!record) { res.status(404).json({ ok: false }); return; }
  res.json({ ok: true, isActive: false });
});

router.patch("/admin/keys/:id/unlock", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [record] = await db.update(keysTable).set({ isActive: true }).where(eq(keysTable.id, id)).returning();
  if (!record) { res.status(404).json({ ok: false }); return; }
  res.json({ ok: true, isActive: true });
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

  const now = new Date();
  const expired = await db.select().from(keysTable).where(
    and(eq(keysTable.isActive, true), sql`${keysTable.expiresAt} < ${now}`)
  );

  res.json({ ok: true, total: Number(total), active: Number(active), devices: Number(devices), expired: expired.length });
});

export default router;
