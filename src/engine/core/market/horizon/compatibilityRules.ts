import type { MarketStructure } from "../../swing/types";
import type { MarketRegimeSnapshot } from "../regime/types";
import { HORIZON_PARAMS as P, type HorizonEvidence, type M5MomentumObservation } from "./types";

export type Dir = "BULLISH" | "BEARISH";

export function macroTrend(r: MarketRegimeSnapshot): HorizonEvidence["macroTrend"] {
  return r.structureContext.h4 === "RANGE" ? "NEUTRAL" : r.structureContext.h4;
}

const m15Dir = (s: MarketStructure): Dir | null => (s.trend === "HH_HL" ? "BULLISH" : s.trend === "LH_LL" ? "BEARISH" : null);

export function m15Boundaries(s: MarketStructure, now: number): { high: number; low: number } | null {
  const h = s.lastConfirmedHigh, l = s.lastConfirmedLow;
  if (!h || !l || h.confirmedAt > now || l.confirmedAt > now || !(h.price > l.price)) return null;
  return { high: h.price, low: l.price };
}

/** CLEAN = M15 trend agrees with H4 macro and no unconfirmed MSS, using only swings confirmed by now. */
export function intradayStructure(r: MarketRegimeSnapshot, s: MarketStructure, now: number): HorizonEvidence["intradayStructure"] {
  const mt = macroTrend(r);
  if (mt === "NEUTRAL" || s.shiftDetected || !m15Boundaries(s, now)) return "MESSY";
  return m15Dir(s) === mt ? "CLEAN" : "MESSY";
}

export function microCondition(m5: M5MomentumObservation, s: MarketStructure, now: number): HorizonEvidence["microCondition"] {
  if (m5 === "BULLISH" || m5 === "BEARISH") return "MOMENTUM";
  return s.trend === "RANGE" && m15Boundaries(s, now) ? "RANGE" : "NOISE";
}

export function isDeadMarket(r: MarketRegimeSnapshot): boolean {
  const { atrPercentile, rangeWidth, atrCurrent } = r.rangeContext;
  return atrPercentile <= P.DEAD_ATR_PERCENTILE && rangeWidth < P.DEAD_RANGE_ATR_MULT * atrCurrent;
}

export function hasClearM15Range(r: MarketRegimeSnapshot, s: MarketStructure, now: number): boolean {
  const b = m15Boundaries(s, now);
  const atr = r.rangeContext.atrCurrent;
  return !!b && atr > 0 && b.high - b.low >= P.MIN_M15_RANGE_ATR_MULT * atr;
}

export function swingAligned(r: MarketRegimeSnapshot): boolean {
  const h4 = r.structureContext.h4;
  return h4 !== "RANGE" && r.structureContext.daily === h4 && r.structureContext.weekly === h4;
}

export function scalpDirectionalAlignment(
  r: MarketRegimeSnapshot, s: MarketStructure, m5: M5MomentumObservation, now: number,
): boolean {
  const h4 = r.structureContext.h4;
  if (h4 === "RANGE") return false;
  const d = r.structureContext.daily;
  const dailyOk = d === "UNAVAILABLE" || d === h4;
  return dailyOk && intradayStructure(r, s, now) === "CLEAN" && m5 === h4;
}
