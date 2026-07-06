import { Router } from "express";
import coins from "./coins.routes";
import signals from "./signals.routes";
import positions from "./positions.routes";
import trades from "./trades.routes";
import settings from "./settings.routes";
import overview from "./overview.routes";
import backtest from "./backtest.routes";
import ema from "./ema.routes";

const router = Router();

router.get("/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

router.use("/coins", coins);
router.use("/signals", signals);
router.use("/positions", positions);
router.use("/trades", trades);
router.use("/settings", settings);
router.use("/overview", overview);
router.use("/backtest", backtest);
router.use("/ema", ema);

export default router;
