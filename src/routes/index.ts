import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import keysRouter from "./keys.js";
import feedbackRouter from "./feedback.js";
import pushRouter from "./push.js";
import chatRouter from "./chat.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(keysRouter);
router.use(feedbackRouter);
router.use(pushRouter);
router.use(chatRouter);

export default router;
