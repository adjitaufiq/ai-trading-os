import type { ArenaCandle } from "../core/normalizer/types";
import { closePaperTrade, type LifecycleResult } from "./tradeLifecycle";
import type { PaperTrade } from "./types";

export type UpdateResult = LifecycleResult | { ok: true; trade: PaperTrade; event: null };

/** Evaluate one CLOSED candle against frozen SL/TP. Same-candle SL+TP ⇒ SL first. */
export function updatePosition(t: PaperTrade, c: ArenaCandle, closeTimeSec: number): UpdateResult {
  if (!c.isClosed) return { ok: false, error: "CANDLE_NOT_CLOSED", trade: t };
  if (t.state !== "OPEN" && t.state !== "PARTIAL") return { ok: false, error: "INVALID_TRANSITION", trade: t };
  if (t.openedAt !== null && c.timestamp < t.openedAt - 1e-9 && closeTimeSec <= t.openedAt) return { ok: true, trade: t, event: null };
  const { direction, stopLoss: sl, takeProfit: tp } = t.snapshot;
  const slHit = direction === "BUY" ? c.low <= sl : c.high >= sl;
  const tpHit = direction === "BUY" ? c.high >= tp : c.low <= tp;
  if (slHit) return closePaperTrade(t, "SL_HIT", sl, closeTimeSec);
  if (tpHit) return closePaperTrade(t, "TP_HIT", tp, closeTimeSec);
  return { ok: true, trade: t, event: null };
}
