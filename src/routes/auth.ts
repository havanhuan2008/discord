import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, googleAccountsTable } from "../db";
import { logger } from "../lib/logger";
import { sendDiscordLog } from "../lib/discord-bot";

const router: IRouter = Router();

/**
 * POST /api/auth/google-login
 * Gọi sau khi app đăng nhập Google thành công (Google Sign-In SDK phía client).
 * Chỉ lưu/nhật ký thông tin tài khoản Google — KHÔNG cấp quyền hay kích hoạt key.
 * Body: { googleId, email, displayName?, avatarUrl?, deviceId? }
 */
router.post("/api/auth/google-login", async (req, res) => {
  try {
    const { googleId, email, displayName, avatarUrl, deviceId } = req.body ?? {};

    if (!googleId || typeof googleId !== "string" || !email || typeof email !== "string") {
      res.status(400).json({ ok: false, message: "Thiếu googleId hoặc email" });
      return;
    }

    const existing = await db
      .select()
      .from(googleAccountsTable)
      .where(eq(googleAccountsTable.googleId, googleId))
      .limit(1);

    const isNewAccount = existing.length === 0;

    if (isNewAccount) {
      await db.insert(googleAccountsTable).values({
        googleId,
        email,
        displayName: displayName ?? "",
        avatarUrl: avatarUrl ?? "",
        deviceId: deviceId ?? "",
      });
    } else {
      await db
        .update(googleAccountsTable)
        .set({
          email,
          displayName: displayName ?? existing[0].displayName,
          avatarUrl: avatarUrl ?? existing[0].avatarUrl,
          deviceId: deviceId ?? existing[0].deviceId,
          lastLoginAt: new Date(),
        })
        .where(eq(googleAccountsTable.googleId, googleId));
    }

    sendDiscordLog({
      event: "GOOGLE_LOGIN",
      googleId,
      googleEmail: email,
      googleName: displayName || undefined,
      deviceId: deviceId || undefined,
      isNewDevice: isNewAccount,
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/auth/google-login failed");
    res.status(500).json({ ok: false, message: "Lỗi máy chủ" });
  }
});

export default router;
