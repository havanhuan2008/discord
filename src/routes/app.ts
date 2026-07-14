import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, appConfigTable } from "../db/index.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── GET /api/app/version-check ─────────────────────────────────────────────
// App gọi endpoint này khi khởi động để kiểm tra xem có force update không.
// Response:
//   { forceUpdate: boolean, minVersionCode: number, downloadUrl: string }
router.get("/app/version-check", async (req, res) => {
  try {
    const configs = await db.select().from(appConfigTable);
    const map: Record<string, string> = {};
    for (const c of configs) map[c.key] = c.value;

    const forceUpdate   = map["force_update_enabled"] === "true";
    const minVersionCode = parseInt(map["min_version_code"] ?? "0", 10);
    const downloadUrl   = map["download_url"] ?? "";

    res.json({ forceUpdate, minVersionCode, downloadUrl });
  } catch (err) {
    logger.error({ err }, "version-check error");
    // Nếu DB lỗi, trả về an toàn (không block user)
    res.json({ forceUpdate: false, minVersionCode: 0, downloadUrl: "" });
  }
});

export default router;
