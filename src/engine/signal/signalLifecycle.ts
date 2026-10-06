import type { ArenaCandle } from "../core/normalizer/types";
import type { EMAContext } from "../core/ema/types";
import type { ReactionResult } from "../core/reaction/types";
import type { StructureShiftType } from "../core/swing/types";
import type { EvaluatorInput } from "./signalEvaluator";
import { biasContextLabel, emaAcceptable } from "./signalEvaluator";
import {
  SIGNAL_PARAMS as P,
  type DecisionCheck,
  type DecisionTrace,
  type InvalidationReason,
  type SetupEvaluation,
  type SignalSetup,
} from "./types";
import { captureMarketContext, type MarketContextSources } from "./context";

const TERMINAL = new Set(["INVALIDATED", "EXPIRED"]);
export const isTerminal = (s: SignalSetup) => TERMINAL.has(s.state);

/** Creates a setup only from REACTION_CONFIRMED/READY on a CLOSED M5 candle. */
export function createSetup(
  ev: SetupEvaluation, input: EvaluatorInput, reaction: ReactionResult, m5: ArenaCandle, price: number,
  context?: MarketContextSources,
): { setup: SignalSetup; trace: DecisionTrace } | null {
  if (ev.kind !== "CANDIDATE" || (ev.state !== "READY" && ev.state !== "REACTION_CONFIRMED")) return null;
  if (!m5.isClosed || m5.timeframe !== "M5" || reaction.candleTimestamp !== m5.timestamp) return null;
  const setup: SignalSetup = Object.freeze({
    id: `${m5.symbol}_${ev.direction}_${m5.timestamp}`,
    symbol: m5.symbol, direction: ev.direction, state: ev.state,
    createdAt: m5.timestamp, updatedAt: input.now,
    location: input.priceContext.priceLocation, keyLevel: input.priceContext.keyLevelPrice,
    triggerPattern: reaction.pattern, reactionQuality: reaction.quality,
    biasContext: biasContextLabel(input.bias),
    expiryTimestamp: m5.timestamp + P.SIGNAL_TTL_M5_BARS * P.M5_SECONDS,
    snapshotPrice: price,
    // Observational only: captured at the creation bar, attached AFTER all decisions.
    ...(context ? { marketContext: captureMarketContext(context, m5.timestamp) } : {}),
  });
  return { setup, trace: ev.trace };
}

export interface UpdateInput {
  /** Latest CLOSED M5 bar (running bars are ignored). */
  m5: ArenaCandle;
  /** Latest CLOSED M15 bar, optional. */
  m15?: ArenaCandle;
  price: number;
  m15Atr: number;
  m15StructureShift: StructureShiftType;
  emaContext: EMAContext;
  /** Optional fresh evaluation to promote REACTION_CONFIRMED → READY. */
  evaluation?: SetupEvaluation;
  now: number;
}

export function updateSetup(s: SignalSetup, u: UpdateInput): { setup: SignalSetup; trace: DecisionTrace } {
  const checks: DecisionCheck[] = [];
  const out = (patch: Partial<SignalSetup>) => {
    const setup = Object.freeze({ ...s, ...patch, updatedAt: u.now });
    return { setup, trace: { state: setup.state, checks, at: u.now } };
  };
  if (isTerminal(s)) return { setup: s, trace: { state: s.state, checks: [{ name: "Terminal", result: "SKIP" }], at: u.now } };
  if (!u.m5.isClosed) return { setup: s, trace: { state: s.state, checks: [{ name: "M5 Closed", result: "FAIL" }], at: u.now } };

  const buy = s.direction === "BUY";
  const invalidate = (reason: InvalidationReason) => out({ state: "INVALIDATED", invalidationReason: reason });

  const closes = [u.m5, u.m15].filter((c): c is ArenaCandle => !!c && c.isClosed).map((c) => c.close);
  const broken = closes.some((c) => (buy ? c < s.keyLevel : c > s.keyLevel));
  checks.push({ name: "Location Held", result: broken ? "FAIL" : "PASS" });
  if (broken) return invalidate("LOCATION_BROKEN");

  const shift = buy ? u.m15StructureShift === "BEARISH_MSS" : u.m15StructureShift === "BULLISH_MSS";
  checks.push({ name: "Structure", result: shift ? "FAIL" : "PASS", detail: u.m15StructureShift });
  if (shift) return invalidate("STRUCTURE_SHIFT");

  const emaOk = emaAcceptable(buy ? "BUY" : "SELL", u.emaContext);
  checks.push({ name: "EMA Context", result: emaOk ? "PASS" : "FAIL" });
  if (!emaOk) return invalidate("EMA_CONTEXT_FAILED");

  const moved = Math.abs(u.price - s.snapshotPrice);
  const chased = Number.isFinite(u.m15Atr) && u.m15Atr > 0 && moved > u.m15Atr * P.MAX_CHASE_ATR_MULT;
  checks.push({ name: "Anti Chase", result: chased ? "FAIL" : "PASS", detail: `moved ${moved}` });
  if (chased) return out({ state: "EXPIRED", invalidationReason: "TTL_EXPIRED", expiredBy: "PRICE_CHASED" });

  const ttl = u.m5.timestamp >= s.expiryTimestamp;
  checks.push({ name: "TTL", result: ttl ? "FAIL" : "PASS" });
  if (ttl) return out({ state: "EXPIRED", invalidationReason: "TTL_EXPIRED", expiredBy: "TTL" });

  const ev = u.evaluation;
  if (s.state === "REACTION_CONFIRMED" && ev?.kind === "CANDIDATE" && ev.direction === s.direction && ev.state === "READY") {
    checks.push({ name: "Promote READY", result: "PASS" });
    return out({ state: "READY" });
  }
  return out({});
}

export function cancelSetup(s: SignalSetup, now: number): SignalSetup {
  if (isTerminal(s)) return s;
  return Object.freeze({ ...s, state: "INVALIDATED", invalidationReason: "MANUAL_CANCEL", updatedAt: now });
}
