import { Router } from "express";
import { eq, and, gt, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatSessionsTable, chatMessagesTable } from "../db/schema/chat.js";
import { logger } from "../lib/logger.js";
import { sendChatMessageToDiscord } from "../lib/discord-bot.js";

const router = Router();

const BOT_PENDING_MSG = "Xin chào! 👋 Vui lòng đợi admin Huan Ha chấp nhận trò chuyện và sẽ hỗ trợ bạn ngay lập tức. Cảm ơn bạn đã nhẫn nại! 🙏";

// ── POST /api/chat/session — tạo hoặc lấy session hiện tại ─────────────────
router.post("/chat/session", async (req, res) => {
  try {
    const { deviceId, email, displayName } = req.body;
    if (!deviceId || !email) {
      return res.status(400).json({ error: "deviceId và email là bắt buộc" });
    }

    // Kiểm tra session đang mở (pending hoặc accepted)
    const [existing] = await db
      .select()
      .from(chatSessionsTable)
      .where(
        and(
          eq(chatSessionsTable.deviceId, deviceId),
          eq(chatSessionsTable.status, "pending"),
        )
      )
      .limit(1);

    if (existing) {
      return res.json({ session: existing });
    }

    // Kiểm tra session accepted
    const [accepted] = await db
      .select()
      .from(chatSessionsTable)
      .where(
        and(
          eq(chatSessionsTable.deviceId, deviceId),
          eq(chatSessionsTable.status, "accepted"),
        )
      )
      .limit(1);

    if (accepted) {
      return res.json({ session: accepted });
    }

    // Tạo session mới
    const [session] = await db
      .insert(chatSessionsTable)
      .values({ deviceId, email, displayName: displayName || email })
      .returning();

    // Gửi tin nhắn bot tự động
    await db.insert(chatMessagesTable).values({
      sessionId: session.id,
      sender: "bot",
      content: BOT_PENDING_MSG,
      type: "text",
    });

    // Thông báo Discord
    await sendChatMessageToDiscord({
      sessionId: session.id,
      deviceId,
      email,
      displayName: displayName || email,
      content: "[Yêu cầu chat mới - chưa có tin nhắn]",
      isNewSession: true,
    }).catch(err => logger.warn({ err }, "Discord notify failed"));

    return res.json({ session });
  } catch (err) {
    logger.error({ err }, "POST /chat/session error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── GET /api/chat/session — lấy trạng thái session ────────────────────────
router.get("/chat/session", async (req, res) => {
  try {
    const { deviceId } = req.query as { deviceId?: string };
    if (!deviceId) return res.status(400).json({ error: "deviceId là bắt buộc" });

    // Ưu tiên: accepted → pending → closed (lấy mới nhất)
    const sessions = await db
      .select()
      .from(chatSessionsTable)
      .where(eq(chatSessionsTable.deviceId, deviceId))
      .orderBy(desc(chatSessionsTable.createdAt))
      .limit(5);

    const session =
      sessions.find(s => s.status === "accepted") ||
      sessions.find(s => s.status === "pending") ||
      sessions[0] ||
      null;

    return res.json({ session });
  } catch (err) {
    logger.error({ err }, "GET /chat/session error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── POST /api/chat/message — gửi tin nhắn từ người dùng ──────────────────
router.post("/chat/message", async (req, res) => {
  try {
    const { sessionId, deviceId, content, type, imageData } = req.body;
    if (!sessionId || !deviceId || (!content && !imageData)) {
      return res.status(400).json({ error: "Thiếu thông tin bắt buộc" });
    }

    // Kiểm tra session hợp lệ
    const [session] = await db
      .select()
      .from(chatSessionsTable)
      .where(
        and(
          eq(chatSessionsTable.id, Number(sessionId)),
          eq(chatSessionsTable.deviceId, deviceId),
        )
      )
      .limit(1);

    if (!session) return res.status(404).json({ error: "Session không tồn tại" });
    if (session.status === "closed") {
      return res.status(403).json({ error: "Phiên chat đã đóng" });
    }

    // Lưu tin nhắn
    const [msg] = await db.insert(chatMessagesTable).values({
      sessionId: Number(sessionId),
      sender: "user",
      content: content || "",
      type: type || "text",
      imageData: imageData || null,
    }).returning();

    // Cập nhật updatedAt session
    await db.update(chatSessionsTable)
      .set({ updatedAt: new Date() })
      .where(eq(chatSessionsTable.id, Number(sessionId)));

    // Gửi lên Discord
    await sendChatMessageToDiscord({
      sessionId: Number(sessionId),
      deviceId: session.deviceId,
      email: session.email,
      displayName: session.displayName,
      content: content || (type === "image" ? "[Hình ảnh]" : "[Tin nhắn]"),
      imageData: imageData || undefined,
      type: type || "text",
      isNewSession: false,
    }).catch(err => logger.warn({ err }, "Discord message failed"));

    return res.json({ message: msg });
  } catch (err) {
    logger.error({ err }, "POST /chat/message error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── GET /api/chat/messages — polling tin nhắn ─────────────────────────────
router.get("/chat/messages", async (req, res) => {
  try {
    const { sessionId, deviceId, after } = req.query as {
      sessionId?: string;
      deviceId?: string;
      after?: string;
    };

    if (!sessionId || !deviceId) {
      return res.status(400).json({ error: "sessionId và deviceId là bắt buộc" });
    }

    // Xác minh quyền truy cập
    const [session] = await db
      .select()
      .from(chatSessionsTable)
      .where(
        and(
          eq(chatSessionsTable.id, Number(sessionId)),
          eq(chatSessionsTable.deviceId, deviceId),
        )
      )
      .limit(1);

    if (!session) return res.status(404).json({ error: "Session không tồn tại" });

    // Lấy tin nhắn
    let messages;
    if (after) {
      messages = await db
        .select()
        .from(chatMessagesTable)
        .where(
          and(
            eq(chatMessagesTable.sessionId, Number(sessionId)),
            gt(chatMessagesTable.id, Number(after)),
          )
        )
        .orderBy(chatMessagesTable.id);
    } else {
      messages = await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.sessionId, Number(sessionId)))
        .orderBy(chatMessagesTable.id);
    }

    return res.json({ messages, session });
  } catch (err) {
    logger.error({ err }, "GET /chat/messages error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── Admin API: chấp nhận chat ────────────────────────────────────────────
router.post("/chat/admin/accept", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Không có quyền" });
    }
    const { sessionId, adminName, adminAvatar } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId bắt buộc" });

    const [session] = await db
      .update(chatSessionsTable)
      .set({
        status: "accepted",
        adminName: adminName || "Admin",
        adminAvatar: adminAvatar || "",
        adminOnline: true,
        updatedAt: new Date(),
      })
      .where(eq(chatSessionsTable.id, Number(sessionId)))
      .returning();

    // Tin nhắn chào của admin
    await db.insert(chatMessagesTable).values({
      sessionId: Number(sessionId),
      sender: "admin",
      content: `✅ Admin **${adminName || "Huan Ha"}** đã chấp nhận trò chuyện! Tôi sẽ hỗ trợ bạn ngay.`,
      type: "text",
    });

    return res.json({ session });
  } catch (err) {
    logger.error({ err }, "POST /chat/admin/accept error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── Admin API: gửi tin nhắn từ admin ─────────────────────────────────────
router.post("/chat/admin/reply", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Không có quyền" });
    }
    const { sessionId, content, type, imageData } = req.body;
    if (!sessionId || (!content && !imageData)) {
      return res.status(400).json({ error: "Thiếu thông tin" });
    }

    const [msg] = await db.insert(chatMessagesTable).values({
      sessionId: Number(sessionId),
      sender: "admin",
      content: content || "",
      type: type || "text",
      imageData: imageData || null,
    }).returning();

    await db.update(chatSessionsTable)
      .set({ updatedAt: new Date() })
      .where(eq(chatSessionsTable.id, Number(sessionId)));

    return res.json({ message: msg });
  } catch (err) {
    logger.error({ err }, "POST /chat/admin/reply error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── Admin API: đóng chat ──────────────────────────────────────────────────
router.post("/chat/admin/close", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Không có quyền" });
    }
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId bắt buộc" });

    await db.insert(chatMessagesTable).values({
      sessionId: Number(sessionId),
      sender: "bot",
      content: "❌ Admin đã kết thúc phiên trò chuyện. Cảm ơn bạn đã liên hệ! Nếu cần hỗ trợ thêm, hãy bắt đầu cuộc trò chuyện mới.",
      type: "text",
    });

    await db.update(chatSessionsTable)
      .set({ status: "closed", adminOnline: false, updatedAt: new Date() })
      .where(eq(chatSessionsTable.id, Number(sessionId)));

    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "POST /chat/admin/close error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

// ── GET /api/chat/admin/sessions — danh sách session (admin) ─────────────
router.get("/chat/admin/sessions", async (req, res) => {
  try {
    const adminSecret = req.headers["x-admin-secret"];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Không có quyền" });
    }
    const sessions = await db
      .select()
      .from(chatSessionsTable)
      .orderBy(desc(chatSessionsTable.updatedAt))
      .limit(50);
    return res.json({ sessions });
  } catch (err) {
    logger.error({ err }, "GET /chat/admin/sessions error");
    return res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
