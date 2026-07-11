import { Router, type IRouter } from "express";
import healthRouter from "./health";
import keysRouter from "./keys";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(keysRouter);
router.use(authRouter);

export default router;
