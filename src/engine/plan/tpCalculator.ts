import type { MarketStructure, SwingPoint } from "../core/swing/types";
import { PLAN_PARAMS as P, type TpCalc } from "./types";

export interface TpInput {
  direction: "BUY" | "SELL";
  entry: number;
  m15Structure: MarketStructure;
  atr: number;
  now: number;
}

/** v1: nearest confirmed M15 resistance (BUY) / support (SELL), buffer 0.1×ATR. */
export function calculateTakeProfit(i: TpInput): TpCalc {
  const buy = i.direction === "BUY";
  const s = i.m15Structure;
  const pool: (SwingPoint | null)[] = buy ? [s.lastConfirmedHigh, s.previousHigh] : [s.lastConfirmedLow, s.previousLow];
  const levels = pool
    .filter((p): p is SwingPoint => !!p && p.timeframe === "M15" && p.confirmedAt <= i.now)
    .map((p) => p.price)
    .filter((x) => (buy ? x > i.entry : x < i.entry));
  if (levels.length === 0) return { ok: false, reason: "NO_TP_TARGET" };
  const target = buy ? Math.min(...levels) : Math.max(...levels);
  const tp = buy ? target - i.atr * P.TP_ATR_BUFFER : target + i.atr * P.TP_ATR_BUFFER;
  if (buy ? tp <= i.entry : tp >= i.entry) return { ok: false, reason: "NO_TP_TARGET" };
  return { ok: true, tp, target, source: buy ? "M15_NEAREST_RESISTANCE" : "M15_NEAREST_SUPPORT" };
}
