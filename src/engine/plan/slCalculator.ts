import type { MarketStructure, SwingPoint } from "../core/swing/types";
import { PLAN_PARAMS as P, type SlCalc, type SlSource } from "./types";

const confirmed = (s: SwingPoint | null, now: number) => (s && s.timeframe === "M15" && s.confirmedAt <= now ? s : null);

export interface SlInput {
  direction: "BUY" | "SELL";
  entry: number;
  keyLevel: number;
  m15Structure: MarketStructure;
  atr: number;
  now: number;
}

/** Priority: M15 S/R invalidation → confirmed M15 swing; buffer 0.25×ATR; >2.5×ATR rejected. */
export function calculateStopLoss(i: SlInput): SlCalc {
  const buy = i.direction === "BUY";
  const valid = (a: number) => Number.isFinite(a) && (buy ? a < i.entry : a > i.entry);
  const swing = confirmed(buy ? i.m15Structure.lastConfirmedLow : i.m15Structure.lastConfirmedHigh, i.now);

  let anchor: number | null = null, source: SlSource | null = null;
  if (valid(i.keyLevel)) { anchor = i.keyLevel; source = "M15_SR_INVALIDATION"; }
  else if (swing && valid(swing.price)) { anchor = swing.price; source = "M15_CONFIRMED_SWING"; }
  if (anchor === null || source === null) return { ok: false, reason: "NO_SL_ANCHOR" };

  const sl = buy ? anchor - i.atr * P.SL_ATR_BUFFER : anchor + i.atr * P.SL_ATR_BUFFER;
  const distance = Math.abs(i.entry - sl);
  if (distance > i.atr * P.MAX_SL_ATR) return { ok: false, reason: "SL_TOO_WIDE", anchor, distance };
  return { ok: true, sl, anchor, source, distance };
}
