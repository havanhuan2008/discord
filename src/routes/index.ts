import { Router, type IRouter } from "express";
import healthRouter from "./health";
import keysRouter from "./keys";
import feedbackRouter from "./feedback";
import pushRouter from "./push";

const router: IRouter = Router();

router.use(healthRouter);
router.use(keysRouter);
router.use(feedbackRouter);
router.use(pushRouter);

export default router;
