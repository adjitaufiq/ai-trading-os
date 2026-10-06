// M1B.9 — Market Regime classifier. Pure, deterministic, frozen output.
import type { MarketStructure, SwingPoint } from "../../swing/types";
import {
  REGIME_ALGORITHM_VERSION, REGIME_PARAMS,
  type MarketRegimeInput, type MarketRegimeSnapshot, type MarketRegimeType,
  type StructureContextSummary, type TrendAlignment,
} from "./types";
import { atrPercentile, classifyVolatility } from "./volatilityClassifier";

function freeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) freeze(v);
  }
  return o;
}

const usable = (s: SwingPoint | null, now: number) => (s && s.confirmedAt <= now ? s : null);

function trendBias(s: MarketStructure): "BULLISH" | "BEARISH" | "RANGE" {
  return s.trend === "HH_HL" ? "BULLISH" : s.trend === "LH_LL" ? "BEARISH" : "RANGE";
}

function swingOverlapRatio(s: MarketStructure, now: number): number | null {
  const ph = usable(s.previousHigh, now), pl = usable(s.previousLow, now);
  const lh = usable(s.lastConfirmedHigh, now), ll = usable(s.lastConfirmedLow, now);
  if (!ph || !pl || !lh || !ll) return null;
  const w1 = ph.price - pl.price, w2 = lh.price - ll.price;
  const narrow = Math.min(w1, w2);
  if (!(narrow > 0)) return null;
  const overlap = Math.min(ph.price, lh.price) - Math.max(pl.price, ll.price);
  return Math.max(0, overlap) / narrow;
}

function h4Flattening(s: MarketStructure, atr: number, now: number): boolean {
  const ph = usable(s.previousHigh, now), pl = usable(s.previousLow, now);
  const lh = usable(s.lastConfirmedHigh, now), ll = usable(s.lastConfirmedLow, now);
  if (!ph || !pl || !lh || !ll || !(atr > 0)) return false;
  const lim = REGIME_PARAMS.H4_FLATTENING_ATR_MULT * atr;
  return Math.abs(lh.price - ph.price) < lim && Math.abs(ll.price - pl.price) < lim;
}

function rangeWidth(s: MarketStructure, now: number): number {
  const h = usable(s.lastConfirmedHigh, now), l = usable(s.lastConfirmedLow, now);
  return h && l ? Math.max(0, h.price - l.price) : 0;
}

export function classifyRegime(input: MarketRegimeInput): MarketRegimeSnapshot {
  const { symbol, now, h4Structure: h4s, h1Structure: h1s, m15Atr } = input;
  const evidence: string[] = [];
  const pct = atrPercentile(m15Atr, input.historicalAtrList);
  if (input.historicalAtrList.length === 0) evidence.push("ATR_HISTORY_EMPTY");
  const vol = classifyVolatility(pct);
  evidence.push(vol === "EXPANSION" ? "ATR_EXPANSION" : vol === "COMPRESSION" ? "ATR_COMPRESSION" : "ATR_NORMAL");

  const h4 = trendBias(h4s), h1 = trendBias(h1s);
  const alignment: TrendAlignment =
    h4 !== "RANGE" && h1 !== "RANGE" ? (h4 === h1 ? "ALIGNED" : "CONFLICT") : "NEUTRAL";

  let h1Summary: StructureContextSummary["h1"];
  if (h1 === "RANGE") h1Summary = "CHOP";
  else if (vol === "EXPANSION") h1Summary = "EXPANSION";
  else if (h4 !== "RANGE" && h1 !== h4) h1Summary = "PULLBACK";
  else h1Summary = h1;

  if (h4 !== "RANGE") evidence.push("H4_STRUCTURE_VALID"); else evidence.push("H4_RANGE");
  if (alignment === "ALIGNED") evidence.push("H1_ALIGNMENT");
  if (alignment === "CONFLICT") evidence.push("H4_H1_CONFLICT");
  const mss = h4s.shiftDetected || h1s.shiftDetected;
  if (mss) evidence.push("MSS_UNCONFIRMED");
  const overlap = swingOverlapRatio(h4s, now);
  const highOverlap = overlap !== null && overlap >= REGIME_PARAMS.HIGH_SWING_OVERLAP_RATIO;
  if (highOverlap) evidence.push("H4_HIGH_SWING_OVERLAP");
  const flattening = h4Flattening(h4s, m15Atr, now);
  if (flattening) evidence.push("H4_MOMENTUM_FLATTENING");

  let regime: MarketRegimeType;
  if (vol === "EXPANSION") regime = "VOLATILITY_EXPANSION";
  else if (alignment === "CONFLICT" || mss || highOverlap) regime = "TRANSITION";
  else if (alignment === "ALIGNED" && (flattening || vol === "COMPRESSION")) regime = "TREND_EXHAUSTION";
  else if (vol === "COMPRESSION" && h4 === "RANGE") regime = "RANGE_COMPRESSION";
  else if (alignment === "ALIGNED" && vol === "NORMAL") regime = "TREND_CONTINUATION";
  else { regime = "TRANSITION"; evidence.push("NO_DOMINANT_REGIME"); }

  const htf = input.higherTfContext ?? {};
  return freeze({
    symbol, asOf: now, regime, trendAlignment: alignment, volatility: vol,
    structureContext: {
      monthly: htf.monthly ?? "UNAVAILABLE", weekly: htf.weekly ?? "UNAVAILABLE",
      daily: htf.daily ?? "UNAVAILABLE", h4, h1: h1Summary,
    },
    rangeContext: { rangeWidth: rangeWidth(h4s, now), atrCurrent: m15Atr, atrPercentile: pct, atrState: vol },
    evidence: [...evidence],
    algorithmVersion: REGIME_ALGORITHM_VERSION,
  });
}
