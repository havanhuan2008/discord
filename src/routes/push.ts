/**
 * POST /api/push/send     — gửi FCM push notification đến tất cả thiết bị đã đăng ký
 * POST /api/devices/register-fcm — app gửi FCM token lên để lưu
 */

import { Router, type IRouter } from "express";
import { db, fcmTokensTable } from "../db";
import { logger } from "../lib/logger";
import { eq } from "drizzle-orm";
import { sanitize as _sanitize } from "../lib/utils";

const router: IRouter = Router();

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY ?? "";          // Legacy HTTP (v1 dùng service account)
const FCM_PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "";

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
    // Upsert theo token — nếu đã tồn tại thì cập nhật thời gian
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
// Body: { title, body, adminSecret }
router.post("/push/send", async (req, res): Promise<void> => {
  const adminSecret = sanitize(req.body.adminSecret);
  const expectedSecret = process.env.ADMIN_SECRET ?? "";

  if (!expectedSecret || adminSecret !== expectedSecret) {
    res.status(401).json({ ok: false, message: "Không được phép" });
    return;
  }

  const title = sanitize(req.body.title) || "Thông báo từ Aujunpeak";
  const body  = sanitize(req.body.body)  || "";

  if (!body) {
    res.status(400).json({ ok: false, message: "Thiếu nội dung thông báo" });
    return;
  }

  // Lấy tất cả FCM token
  let tokens: string[] = [];
  try {
    const rows = await db.select({ fcmToken: fcmTokensTable.fcmToken })
      .from(fcmTokensTable);
    tokens = rows.map(r => r.fcmToken);
  } catch (err) {
    logger.error({ err }, "push/send: DB error fetching tokens");
    res.status(500).json({ ok: false, message: "Lỗi server" });
    return;
  }

  if (tokens.length === 0) {
    res.json({ ok: true, sent: 0, message: "Không có thiết bị nào đã đăng ký token" });
    return;
  }

  req.log.info({ count: tokens.length }, "Sending push notification");

  // Gửi FCM qua Legacy HTTP API (nếu có FCM_SERVER_KEY)
  // Để dùng FCM v1 API, thay bằng Google Auth + googleapis
  let sent = 0;
  let failed = 0;

  if (FCM_SERVER_KEY) {
    // Batch gửi (max 500/request theo Legacy API)
    const BATCH = 500;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      try {
        const fcmRes = await fetch("https://fcm.googleapis.com/fcm/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `key=${FCM_SERVER_KEY}`,
          },
          body: JSON.stringify({
            registration_ids: batch,
            notification: { title, body, sound: "default" },
            priority: "high",
          }),
        });
        if (fcmRes.ok) {
          const json = await fcmRes.json() as { success?: number; failure?: number };
          sent   += json.success  ?? 0;
          failed += json.failure  ?? 0;
        } else {
          failed += batch.length;
        }
      } catch (err) {
        logger.error({ err }, "FCM batch send error");
        failed += batch.length;
      }
    }
  } else {
    // Chưa cấu hình FCM_SERVER_KEY → log warning
    logger.warn("FCM_SERVER_KEY chưa được đặt — push notification bị bỏ qua");
    failed = tokens.length;
  }

  res.json({
    ok: true,
    total: tokens.length,
    sent,
    failed,
    message: `Đã gửi ${sent}/${tokens.length} thông báo`,
  });
});

export default router;
