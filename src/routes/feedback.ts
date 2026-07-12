/**
 * POST /api/feedback
 * Nhận báo lỗi / góp ý từ app → lưu DB → gửi Discord embed
 */

import { Router, type IRouter } from "express";
import { db, feedbacksTable } from "../db/index.js";
import { sendDiscordLog } from "../lib/discord-bot.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Validation helper ───────────────────────────────────────────────────────
function sanitize(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, 2000);
}

function mapTypeLabel(type: string): string {
  switch (type) {
    case "bug":      return "🐛 Báo lỗi";
    case "feedback": return "⭐ Góp ý";
    case "contact":  return "💬 Liên hệ hỗ trợ";
    default:         return "📩 Phản hồi";
  }
}

// ─── POST /api/feedback ───────────────────────────────────────────────────────
router.post("/feedback", async (req, res): Promise<void> => {
  const type      = sanitize(req.body.type)      || "bug";
  const title     = sanitize(req.body.title);
  const message   = sanitize(req.body.message);
  const contact   = sanitize(req.body.contact);
  const deviceKey = sanitize(req.body.deviceKey);
  const stars     = Math.min(5, Math.max(0, Number(req.body.stars) || 0));

  if (!title || !message) {
    res.status(400).json({ ok: false, message: "Thiếu tiêu đề hoặc nội dung" });
    return;
  }

  req.log.info({ type, deviceKey: deviceKey.slice(0, 8) + "…" }, "feedback received");

  // ── Lưu vào DB ───────────────────────────────────────────────────────────
  let savedId: number | undefined;
  try {
    const [row] = await db.insert(feedbacksTable).values({
      type,
      title,
      message,
      contact: contact || null,
      deviceKey: deviceKey || null,
      stars,
    }).returning({ id: feedbacksTable.id });
    savedId = row.id;
  } catch (err) {
    logger.error({ err }, "feedback: DB insert failed");
    // Vẫn tiếp tục gửi Discord dù lưu DB thất bại
  }

  // ── Gửi Discord embed ─────────────────────────────────────────────────────
  const starsStr = stars > 0 ? "⭐".repeat(stars) + `  (${stars}/5)` : "Chưa đánh giá";
  try {
    await sendDiscordLog({
      event:     "FEEDBACK",
      title:     `${mapTypeLabel(type)} — ${title}`,
      note:      message,
      deviceKey: deviceKey || undefined,
      contact:   contact   || undefined,
      starsStr,
      savedId,
    } as Parameters<typeof sendDiscordLog>[0]);
  } catch (err) {
    logger.warn({ err }, "feedback: discord notify failed");
  }

  res.json({ ok: true, id: savedId, message: "Cảm ơn bạn đã phản hồi!" });
});

// ─── GET /api/feedback (admin listing — simple) ───────────────────────────────
router.get("/feedback", async (_req, res): Promise<void> => {
  try {
    const rows = await db.select().from(feedbacksTable)
      .orderBy(feedbacksTable.createdAt);
    res.json({ ok: true, total: rows.length, data: rows.reverse().slice(0, 100) });
  } catch (err) {
    res.status(500).json({ ok: false, message: "DB error" });
  }
});

export default router;
