import type { MarketBiasState } from "../core/bias/types";
import type { EMAContext } from "../core/ema/types";
import type { PriceContext } from "../core/location/types";
import type { ReactionResult } from "../core/reaction/types";
import type { StructureShiftType } from "../core/swing/types";
import { SIGNAL_PARAMS as P, type DecisionCheck, type NoSetupReason, type SetupEvaluation } from "./types";

export interface EvaluatorInput {
  bias: MarketBiasState;
  priceContext: PriceContext;
  emaContext: EMAContext;
  /** M1B.7 output for the latest CLOSED M5 bar, or null if none. */
  reaction: ReactionResult | null;
  m15Atr: number;
  m15StructureShift: StructureShiftType;
  m15StructureValid: boolean;
  m5CandleClosed: boolean;
  dataStale: boolean;
  now: number;
}

export const biasContextLabel = (b: MarketBiasState) => `H4_${b.h4.bias}_H1_${b.h1.phase}`;

export function biasAcceptable(dir: "BUY" | "SELL", b: MarketBiasState): boolean {
  return dir === "BUY" ? b.overallBias !== "BEARISH" : b.overallBias !== "BULLISH";
}

export function emaAcceptable(dir: "BUY" | "SELL", e: EMAContext): boolean {
  if (dir === "BUY") return e.pricePosition !== "BELOW_ALL" && !e.actions.some((a) => a === "EMA21_REJECT_DOWN" || a === "EMA50_RESISTANCE");
  return e.pricePosition !== "ABOVE_ALL" && !e.actions.some((a) => a === "EMA21_REJECT_UP" || a === "EMA50_SUPPORT");
}

export function evaluateSetup(i: EvaluatorInput): SetupEvaluation {
  const checks: DecisionCheck[] = [];
  const no = (reason: NoSetupReason): SetupEvaluation => ({ kind: "NO_SETUP", reason, trace: { state: "NO_SETUP", checks, at: i.now } });

  const fresh = !i.dataStale;
  checks.push({ name: "Data Fresh", result: fresh ? "PASS" : "FAIL" });
  if (!fresh) return no("DATA_STALE");
  checks.push({ name: "M5 Closed", result: i.m5CandleClosed ? "PASS" : "FAIL" });
  if (!i.m5CandleClosed) return no("CANDLE_NOT_CLOSED");
  checks.push({ name: "M15 Structure", result: i.m15StructureValid ? "PASS" : "FAIL" });
  if (!i.m15StructureValid) return no("STRUCTURE_INVALID");

  const loc = i.priceContext;
  const dir: "BUY" | "SELL" | null = loc.nearestLevelType === "SUPPORT" ? "BUY" : loc.nearestLevelType === "RESISTANCE" ? "SELL" : null;
  const atLevel = loc.priceLocation === "AT_SUPPORT" || loc.priceLocation === "AT_RESISTANCE";

  if (!atLevel) {
    if (loc.priceLocation === "MID_RANGE" && dir && Number.isFinite(i.m15Atr) && i.m15Atr > 0 && loc.distanceToLevel <= i.m15Atr * P.RADAR_ATR_MULT) {
      checks.push({ name: "M15 Location", result: "SKIP", detail: `approaching ${loc.nearestLevelType} ${loc.keyLevelPrice}` });
      return { kind: "CANDIDATE", direction: dir, state: "RADAR_AREA", trace: { state: "RADAR_AREA", checks, at: i.now } };
    }
    checks.push({ name: "M15 Location", result: "FAIL", detail: loc.priceLocation });
    return no(loc.priceLocation === "MID_RANGE" ? "MID_RANGE" : "WRONG_LOCATION");
  }
  const d = loc.priceLocation === "AT_SUPPORT" ? "BUY" : "SELL";
  checks.push({ name: "M15 Location", result: "PASS", detail: loc.priceLocation });

  const want = d === "BUY" ? "BULLISH" : "BEARISH";
  const r = i.reaction;
  const reactionOk = !!r && r.isValid && r.direction === want && r.locationConfirmed;
  checks.push({ name: "M5 Reaction", result: reactionOk ? "PASS" : "FAIL", detail: r ? `${r.pattern}/${r.quality}` : "NO_TRIGGER" });
  if (!reactionOk) return { kind: "CANDIDATE", direction: d, state: "WAITING_REACTION", trace: { state: "WAITING_REACTION", checks, at: i.now } };

  const biasOk = biasAcceptable(d, i.bias);
  const emaOk = emaAcceptable(d, i.emaContext);
  checks.unshift({ name: "H4 Bias", result: biasOk ? "PASS" : "FAIL", detail: biasContextLabel(i.bias) });
  checks.push({ name: "EMA Context", result: emaOk ? "PASS" : "FAIL", detail: i.emaContext.actions.join(",") });
  const state = biasOk && emaOk ? "READY" : "REACTION_CONFIRMED";
  return { kind: "CANDIDATE", direction: d, state, trace: { state, checks, at: i.now } };
}
