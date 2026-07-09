import { Router, type IRouter } from "express";
import healthRouter from "./health";
import keysRouter from "./keys";

const router: IRouter = Router();

router.use(healthRouter);
router.use(keysRouter);

export default router;
