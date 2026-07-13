/**
 * POST /api/push/send        — gửi FCM push đến tất cả thiết bị đã đăng ký (dùng admin secret)
 * POST /api/devices/register-fcm — app gửi FCM token lên để lưu
 */

import { Router, type IRouter } from "express";
import { db, fcmTokensTable, notificationsTable } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { sendFcmPush, isFcmConfigured } from "../lib/fcm.js";
import { eq, inArray } from "drizzle-orm";

const router: IRouter = Router();

function sanitize(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, 2000);
}

// ─── Đăng ký FCM token từ thiết bị ──────────────────────────────────────────
router.post("/devices/register-fcm", async (req, res): Promise<void> => {
  const fcmToken  = sanitize(req.body.fcmToken);
  const deviceKey = sanitize(req.body.deviceKey);
  const deviceId  = sanitize(req.body.deviceId);

  if (!fcmToken) {
    res.status(400).json({ ok: false, message: "Thiếu fcmToken" });
    return;
  }

  try {
    const existing = await db.select().from(fcmTokensTable)
      .where(eq(fcmTokensTable.fcmToken, fcmToken));

    if (existing.length > 0) {
      await db.update(fcmTokensTable)
        .set({ deviceKey: deviceKey || null, deviceId: deviceId || null, updatedAt: new Date() })
        .where(eq(fcmTokensTable.fcmToken, fcmToken));
    } else {
      await db.insert(fcmTokensTable).values({
        fcmToken,
        deviceKey: deviceKey || null,
        deviceId:  deviceId  || null,
      });
    }

    req.log.info({ deviceId: deviceId.slice(0, 8) }, "FCM token registered");
    res.json({ ok: true, message: "Token đã được đăng ký" });
  } catch (err) {
    logger.error({ err }, "register-fcm: DB error");
    res.status(500).json({ ok: false, message: "Lỗi server" });
  }
});

// ─── Gửi push notification đến tất cả thiết bị ───────────────────────────────
router.post("/push/send", async (req, res): Promise<void> => {
  const adminSecret    = sanitize(req.body.adminSecret);
  const expectedSecret = process.env.ADMIN_SECRET ?? "";

  if (!expectedSecret || adminSecret !== expectedSecret) {
    res.status(401).json({ ok: false, message: "Không được phép" });
    return;
  }

  const title    = sanitize(req.body.title) || "Thông báo từ Aujunpeak";
  const body     = sanitize(req.body.body)  || "";
  const imageUrl = sanitize(req.body.imageUrl) || undefined;
  const link     = sanitize(req.body.link)     || undefined;

  if (!body) {
    res.status(400).json({ ok: false, message: "Thiếu nội dung thông báo" });
    return;
  }

  if (!isFcmConfigured()) {
    res.status(503).json({ ok: false, message: "FIREBASE_SERVICE_ACCOUNT_JSON chưa được cấu hình trên server" });
    return;
  }

  // ── FIX BUG: trước đây /push/send CHỈ gửi FCM (tức thời) mà KHÔNG lưu vào
  // notifications table → thiết bị mới cài app sau khi push được gửi sẽ KHÔNG
  // BAO GIỜ thấy lại thông báo này trong lịch sử (icon chuông trong app), vì
  // bell icon chỉ đọc từ notificationsTable qua heartbeat. Giờ luôn persist
  // trước, để MỌI thiết bị (cũ và mới) đều nhận được qua đồng bộ heartbeat,
  // đồng thời vẫn gửi FCM ngay để có cảm giác tức thời.
  const [notif] = await db.insert(notificationsTable).values({
    title, body,
    sentBy: "admin-http",
    imageUrl: imageUrl ?? null,
    linkUrl: link ?? null,
  }).returning();

  let tokens: string[] = [];
  try {
    const rows = await db.select({ fcmToken: fcmTokensTable.fcmToken }).from(fcmTokensTable);
    tokens = rows.map(r => r.fcmToken);
  } catch (err) {
    logger.error({ err }, "push/send: DB error fetching tokens");
    res.status(500).json({ ok: false, message: "Lỗi server" });
    return;
  }

  if (tokens.length === 0) {
    res.json({ ok: true, id: notif.id, sent: 0, message: "Đã lưu thông báo (sẽ hiện khi mở app). Chưa có thiết bị nào đăng ký nhận push tức thời." });
    return;
  }

  const result = await sendFcmPush(tokens, title, body, { notifId: notif.id, imageUrl, link });

  // Xóa các token không còn hợp lệ khỏi DB
  if (result.invalidTokens.length > 0) {
    await db.delete(fcmTokensTable)
      .where(inArray(fcmTokensTable.fcmToken, result.invalidTokens))
      .catch(e => logger.error({ e }, "Không xóa được invalid token"));
    logger.info({ count: result.invalidTokens.length }, "Removed invalid FCM tokens");
  }

  req.log.info({ total: result.total, sent: result.sent, failed: result.failed }, "Push notification sent");
  res.json({
    ok:    true,
    id:    notif.id,
    total: result.total,
    sent:  result.sent,
    failed: result.failed,
    message: `Đã gửi ${result.sent}/${result.total} thông báo`,
    ...(result.error ? { error: result.error } : {}),
  });
});

export default router;
