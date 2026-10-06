// M1B.10 — Adaptive Trading Horizon Classifier. Pure precedence ladder, frozen output.
import {
  hasClearM15Range, intradayStructure, isDeadMarket, macroTrend, microCondition,
  scalpDirectionalAlignment, swingAligned,
} from "./compatibilityRules";
import {
  HORIZON_ALGORITHM_VERSION,
  type HoldingEnvironment, type HorizonClassifierInput, type MarketApproach,
  type TradingHorizon, type TradingStyleContext,
} from "./types";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export function classifyHorizon(input: HorizonClassifierInput): TradingStyleContext {
  const { symbol, now, regime: r, m15Structure: s } = input;
  const m5 = input.m5Momentum ?? "UNAVAILABLE";
  const evidence: string[] = [];
  const tags: string[] = [`REGIME_${r.regime}`, `VOL_${r.volatility}`];

  const fp = input.footprints && input.footprints.timestamp <= now ? input.footprints : null;
  if (fp?.sweepDetected) tags.push("FOOTPRINT_SWEEP");
  if (fp?.displacementPreceded) tags.push("FOOTPRINT_DISPLACEMENT");
  if (fp?.insideFVG) tags.push("FOOTPRINT_INSIDE_FVG");
  if (fp?.insideOrderBlock) tags.push("FOOTPRINT_INSIDE_OB");

  let rec: TradingHorizon = "NO_FIT";
  let compat: TradingHorizon[] = [];
  let approach: MarketApproach = "NO_CLEAR_EDGE";
  let hold: HoldingEnvironment = "DEFENSIVE_HOLD";

  if (r.asOf > now || r.symbol !== symbol) {
    evidence.push(r.asOf > now ? "REGIME_SNAPSHOT_FROM_FUTURE" : "REGIME_SYMBOL_MISMATCH");
  } else if (r.regime === "VOLATILITY_EXPANSION" || r.regime === "TRANSITION" || r.regime === "TREND_EXHAUSTION") {
    evidence.push("REGIME_UNSTABLE_VETO");
  } else if (isDeadMarket(r)) {
    evidence.push("DEAD_MARKET_NO_EDGE");
  } else if (r.regime === "RANGE_COMPRESSION") {
    if (hasClearM15Range(r, s, now)) {
      rec = "SCALPING"; compat = ["SCALPING", "INTRADAY"]; approach = "MEAN_REVERSION"; hold = "SHORT_HORIZON";
      evidence.push("RANGE_BOUNDARY_AVAILABLE", "ATR_SUPPORTS_MICRO_CYCLE", "MEAN_REVERSION_ENVIRONMENT");
    } else evidence.push("RANGE_BOUNDARY_UNCLEAR");
  } else if (r.regime === "TREND_CONTINUATION") {
    if (swingAligned(r)) {
      rec = "SWING"; compat = ["SWING", "INTRADAY"]; hold = "POSITION_HORIZON";
      evidence.push("HTF_DAILY_WEEKLY_ALIGNED", "H4_CONTINUATION");
    } else {
      rec = "INTRADAY"; compat = ["INTRADAY", "SWING"]; hold = "SESSION_HORIZON";
      evidence.push("H4_H1_ALIGNED_CONTINUATION");
    }
    approach = "TREND_FOLLOW";
    if (scalpDirectionalAlignment(r, s, m5, now)) {
      compat.push("SCALPING"); approach = "MOMENTUM";
      evidence.push("SCALP_DIRECTIONAL_ALIGNMENT");
    }
  }
  if (rec === "NO_FIT" && evidence.length === 0) evidence.push("NO_COMPATIBLE_HORIZON");

  return deepFreeze({
    symbol, asOf: now,
    regimeSnapshotId: `${r.symbol}:${r.asOf}:${r.regime}:${r.algorithmVersion}`,
    recommendedHorizon: rec, compatibleHorizons: compat, marketApproach: approach, holdingEnvironment: hold,
    horizonEvidence: {
      macroTrend: macroTrend(r),
      intradayStructure: intradayStructure(r, s, now),
      microCondition: microCondition(m5, s, now),
      atrPercentile: r.rangeContext.atrPercentile,
      tags,
    },
    evidence,
    algorithmVersion: HORIZON_ALGORITHM_VERSION,
  });
}
