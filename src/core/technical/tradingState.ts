// Four orthogonal trading-state domains + availability + deterministic analyzer + bounded transition trail.
// MONITOR_ONLY. ExecutionState describes guard/environment state; it NEVER transmits anything.
import { EXECUTION_ENABLED, OPERATING_MODE, type Timeframe } from "../contracts";
import {
  ENGULFING_DEFINITION, TECHNICAL_ENGINE_VERSION, atrWilder, ema, emaRelation, engulfing, geometry, nearestLevels, rsiWilder, structureOf,
  type CandleGeometry, type Indicator, type NearestLevels, type Relation, type Structure, type TechBar,
} from "./indicators";
import { OPERATOR_POLICY_VERSION, OPERATOR_RULES, operatorAnalysis, rsiDirectionGate, type OperatorAnalysis, type SrZone } from "./operator";
export { rsiDirectionGate } from "./operator";

export type TechnicalAvailability = "AVAILABLE" | "STALE" | "UNAVAILABLE";
export type BiasState = "BUY" | "SELL" | "NEUTRAL" | "NOT_EVALUABLE";
export type SetupState = "ACTIVE" | "INACTIVE" | "INVALID" | "NOT_EVALUABLE";
export type SignalState = "READY" | "WAITING" | "EXPIRED" | "INVALIDATED" | "NOT_EVALUABLE";
export type EntryAnalysis = "LONG_CANDIDATE" | "SHORT_CANDIDATE" | "WAIT" | "NOT_EVALUABLE";
export type ExecutionState = "ALLOWED" | "INHIBITED" | "BLOCKED";

export const ALL_SIGNAL_STATES: readonly SignalState[] = ["READY", "WAITING", "EXPIRED", "INVALIDATED", "NOT_EVALUABLE"];

export const SETUP_POLICY_VERSION = "setup-v2-operator-mtf-sr-ema";
export const SIGNAL_POLICY_VERSION = "signal-v2-operator-closed-m5-m15-patterns";
export const REFERENCE_PLAN_POLICY_VERSION = "reference-plan-v2-swing-atr-plus-sr-context";
export const GUARD_POLICY_VERSION = "guard-v0-monitor-only";
export const POLICIES = Object.freeze({
  bias: "H4 primary trend (EMA21/EMA50 + confirmed structure): UP → BUY, DOWN → SELL, MIXED → NEUTRAL, insufficient → NOT_EVALUABLE",
  setup: `${OPERATOR_POLICY_VERSION}: ACTIVE when operator status is CARI_BUY/CARI_SELL with context + location (+ H1 RSI gate in TREND) satisfied; H1 REVERSAL_CANDIDATE → INVALID; otherwise INACTIVE`,
  signal: "Setup ACTIVE + CLOSED M5/M15 pattern trigger in the setup direction with no opposing trigger → READY (latched); otherwise WAITING; setup leaves ACTIVE → INVALIDATED (if INVALID) else WAITING",
  reference_plan: "BUY ASK / SELL BID; SL outside latest confirmed H1 swing by 0.25×ATR14(M15); TP1=1R, TP2=2R (unchanged from v1). v2 adds structural context: invalidation = nearest S/R zone behind entry ± 0.25×ATR14(M15); target = near edge of next opposing S/R zone. Read-only analysis, never execution",
  operator: OPERATOR_RULES,
  signal_validity: "RESEARCH_REQUIRED (no TTL; EXPIRED is never produced)",
  spread: "RESEARCH_REQUIRED (telemetry only, no threshold)",
  session: "RESEARCH_REQUIRED",
  risk: "UNAVAILABLE (no account data on the read-only bridge)",
  feed_stale: "RESEARCH_REQUIRED (age measured, no threshold)",
});

export const TIMEFRAMES: readonly Timeframe[] = ["M5", "M15", "H1", "H4"];

export interface TimeframeEvidence {
  readonly timeframe: Timeframe;
  readonly closed_count: number;
  readonly last_closed_open_time: number | null;
  readonly last_closed_available_at: number | null;
  readonly ema5: Indicator;
  readonly ema21: Indicator;
  readonly ema50: Indicator;
  readonly relation: Relation;
  readonly atr14: Indicator;
  readonly rsi14: Indicator;
  readonly structure: Structure;
  readonly snr: NearestLevels | null;
}

export interface MarketObservation {
  readonly bid: number;
  readonly ask: number;
  readonly spread: number;
  readonly tick_time_ms: number;
  readonly observed_at: number;
}

export interface EvaluationInput {
  readonly symbol: string;
  /** Whether the latest attempt to establish current market state succeeded. */
  readonly market_current: boolean;
  /** Whether all technical bar histories refreshed on the latest attempt. */
  readonly bars_current: boolean;
  readonly quote: MarketObservation | null;
  /** CLOSED bars only, ascending. */
  readonly closed: Readonly<Record<Timeframe, readonly TechBar[]>>;
  readonly as_of: number;
  readonly env: { readonly operating_mode: string; readonly execution_enabled: boolean };
}

export interface WhyFact { readonly ok: boolean | null; readonly text: string }

export interface StructuralContext {
  readonly invalidation_zone: SrZone | null;
  readonly structural_sl: number | null;
  readonly target_zone: SrZone | null;
  readonly structural_target: number | null;
  readonly rr_structural: number | null;
}

export type ReferencePlan = {
  readonly status: "AVAILABLE";
  readonly policy_version: typeof REFERENCE_PLAN_POLICY_VERSION;
  readonly side: "BUY" | "SELL";
  readonly entry: number;
  readonly anchor_kind: "CONFIRMED_H1_SWING_LOW" | "CONFIRMED_H1_SWING_HIGH";
  readonly anchor_price: number;
  readonly atr14_m15: number;
  readonly atr_buffer: number;
  readonly risk: number;
  readonly sl: number;
  readonly tp1: number;
  readonly tp2: number;
  readonly rr_tp1: 1;
  readonly rr_tp2: 2;
  readonly structural: StructuralContext;
} | {
  readonly status: "NOT_AVAILABLE";
  readonly policy_version: typeof REFERENCE_PLAN_POLICY_VERSION;
  readonly reason: string;
};

export interface TradingSnapshot {
  readonly symbol: string;
  readonly as_of: number;
  readonly label: "CURRENT" | "LAST_KNOWN_STALE";
  readonly availability: TechnicalAvailability;
  readonly availability_reason: string;
  readonly quote: MarketObservation | null;
  readonly evidence: Readonly<Record<Timeframe, TimeframeEvidence>> | null;
  readonly last3_m5: readonly CandleGeometry[];
  readonly engulfing: { readonly bullish: boolean; readonly bearish: boolean; readonly definition: string; readonly bar_open_time: number | null } | null;
  readonly bias: { readonly state: BiasState; readonly reason: string };
  readonly setup: { readonly state: SetupState; readonly reason: string };
  readonly signal: { readonly state: SignalState; readonly reason: string; readonly triggered_at: number | null; readonly trigger_bar: number | null; readonly trigger_evidence: string | null; readonly validity_policy: "RESEARCH_REQUIRED" };
  readonly execution: { readonly state: ExecutionState; readonly reasons: readonly string[] };
  /** Analysis label only (MONITOR_ONLY). Never an order, never transmitted. */
  readonly entry: { readonly state: EntryAnalysis; readonly reason: string };
  /** Deterministic read-only levels. Never an order and never execution authority. */
  readonly reference_plan: ReferencePlan;
  /** Operator-style read model (trend/context/zones/EMA/patterns/regime). Evidence only. */
  readonly operator?: OperatorAnalysis | null;
  readonly why: readonly WhyFact[];
  readonly versions: { readonly technical_engine_version: string; readonly setup_policy_version: string; readonly signal_policy_version: string; readonly reference_plan_policy_version: string; readonly guard_policy_version: string };
}

function evidenceFor(tf: Timeframe, bars: readonly TechBar[], price: number | null): TimeframeEvidence {
  const e5 = ema(bars, 5), e21 = ema(bars, 21), atr = atrWilder(bars, 14), last = bars[bars.length - 1];
  const structure = structureOf(bars);
  return {
    timeframe: tf, closed_count: bars.length, last_closed_open_time: last?.open_time ?? null, last_closed_available_at: last?.available_at ?? null,
    ema5: e5, ema21: e21, ema50: ema(bars, 50), relation: emaRelation(e5, e21), atr14: atr, rsi14: rsiWilder(bars), structure,
    snr: price === null ? null : nearestLevels(structure.swings, price, atr),
  };
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(3));

function unavailablePlan(reason: string): ReferencePlan {
  return { status: "NOT_AVAILABLE", policy_version: REFERENCE_PLAN_POLICY_VERSION, reason };
}

export function deriveReferencePlan(
  entry: TradingSnapshot["entry"],
  quote: MarketObservation | null,
  evidence: Readonly<Record<Timeframe, TimeframeEvidence>> | null,
  operator: OperatorAnalysis | null = null,
): ReferencePlan {
  const side = entry.state === "LONG_CANDIDATE" ? "BUY" : entry.state === "SHORT_CANDIDATE" ? "SELL" : null;
  if (!side) return unavailablePlan(entry.reason);
  if (!quote || !evidence) return unavailablePlan("REFERENCE_PLAN_EVIDENCE_UNAVAILABLE");
  const atr = evidence.M15.atr14;
  if (atr.status !== "OK" || !Number.isFinite(atr.value) || atr.value <= 0) return unavailablePlan("ATR14_M15_UNAVAILABLE");
  const kind = side === "BUY" ? "LOW" : "HIGH";
  const anchor = [...evidence.H1.structure.swings].reverse().find((s) => s.kind === kind);
  if (!anchor || !Number.isFinite(anchor.price)) return unavailablePlan(`CONFIRMED_H1_SWING_${kind}_UNAVAILABLE`);
  const reference = side === "BUY" ? quote.ask : quote.bid;
  const atrBuffer = 0.25 * atr.value;
  const sl = side === "BUY" ? anchor.price - atrBuffer : anchor.price + atrBuffer;
  const risk = side === "BUY" ? reference - sl : sl - reference;
  if (![reference, atrBuffer, sl, risk].every(Number.isFinite) || risk <= 0) return unavailablePlan("REFERENCE_PLAN_NON_POSITIVE_RISK");
  return {
    status: "AVAILABLE", policy_version: REFERENCE_PLAN_POLICY_VERSION, side, entry: reference,
    anchor_kind: side === "BUY" ? "CONFIRMED_H1_SWING_LOW" : "CONFIRMED_H1_SWING_HIGH", anchor_price: anchor.price,
    atr14_m15: atr.value, atr_buffer: atrBuffer, risk, sl,
    tp1: side === "BUY" ? reference + risk : reference - risk,
    tp2: side === "BUY" ? reference + 2 * risk : reference - 2 * risk,
    rr_tp1: 1, rr_tp2: 2,
    structural: structuralContext(side, reference, atrBuffer, operator),
  };
}

/** Structural S/R context for a read-only plan. Missing evidence ⇒ null fields, never a substitute level. */
export function structuralContext(side: "BUY" | "SELL", entry: number, atrBuffer: number, op: OperatorAnalysis | null): StructuralContext {
  const none: StructuralContext = { invalidation_zone: null, structural_sl: null, target_zone: null, structural_target: null, rr_structural: null };
  if (!op) return none;
  const all = [...(op.zones.H4 ?? []), ...(op.zones.H1 ?? []), ...(op.zones.M15 ?? [])];
  const behind = all.filter((z) => side === "BUY" ? z.low < entry : z.high > entry)
    .sort((a, b) => side === "BUY" ? b.low - a.low : a.high - b.high)[0] ?? null;
  const ahead = all.filter((z) => side === "BUY" ? z.low > entry : z.high < entry)
    .sort((a, b) => side === "BUY" ? a.low - b.low : b.high - a.high)[0] ?? null;
  const sl = behind ? (side === "BUY" ? behind.low - atrBuffer : behind.high + atrBuffer) : null;
  const tgt = ahead ? (side === "BUY" ? ahead.low : ahead.high) : null;
  const risk = sl === null ? null : side === "BUY" ? entry - sl : sl - entry;
  const reward = tgt === null ? null : side === "BUY" ? tgt - entry : entry - tgt;
  return { invalidation_zone: behind, structural_sl: sl, target_zone: ahead, structural_target: tgt, rr_structural: risk && risk > 0 && reward !== null ? reward / risk : null };
}

/** Pure evaluation. `prevSignal` provides latching of a READY signal on its trigger bar. */
export function evaluate(i: EvaluationInput, prevSignal: TradingSnapshot["signal"] | null = null): TradingSnapshot {
  const versions = { technical_engine_version: TECHNICAL_ENGINE_VERSION, setup_policy_version: SETUP_POLICY_VERSION, signal_policy_version: SIGNAL_POLICY_VERSION, reference_plan_policy_version: REFERENCE_PLAN_POLICY_VERSION, guard_policy_version: GUARD_POLICY_VERSION };
  const capabilityReasons: string[] = [];
  if (!i.env.execution_enabled) capabilityReasons.push("CAPABILITY_UNAUTHORIZED");
  if (i.env.operating_mode !== "DEMO") capabilityReasons.push("ENV_NOT_DEMO");

  if (!i.market_current || !i.quote) {
    return {
      symbol: i.symbol, as_of: i.as_of, label: "CURRENT", availability: "UNAVAILABLE", availability_reason: "MARKET_STATE_UNAVAILABLE",
      quote: null, evidence: null, last3_m5: [], engulfing: null,
      bias: { state: "NOT_EVALUABLE", reason: "MARKET_STATE_UNAVAILABLE" },
      setup: { state: "NOT_EVALUABLE", reason: "MARKET_STATE_UNAVAILABLE" },
      signal: { state: "NOT_EVALUABLE", reason: "MARKET_STATE_UNAVAILABLE", triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" },
      execution: { state: "BLOCKED", reasons: ["MARKET_STATE_UNAVAILABLE", ...capabilityReasons] },
      entry: { state: "NOT_EVALUABLE", reason: "MARKET_STATE_UNAVAILABLE" },
      reference_plan: unavailablePlan("MARKET_STATE_UNAVAILABLE"),
      why: [{ ok: false, text: "Current market state cannot be established" }], versions,
    };
  }

  const price = (i.quote.bid + i.quote.ask) / 2;
  const evidence = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, evidenceFor(tf, i.closed[tf], price)])) as Record<Timeframe, TimeframeEvidence>;
  const availability: TechnicalAvailability = i.bars_current ? "AVAILABLE" : "STALE";
  const m5 = i.closed.M5;
  const last3 = m5.slice(-3).map(geometry);
  const eng = m5.length >= 2 ? { ...engulfing(m5[m5.length - 2]!, m5[m5.length - 1]!), definition: ENGULFING_DEFINITION, bar_open_time: m5[m5.length - 1]!.open_time } : null;

  // OPERATOR v2 (H4 primary · H1 context · S/R zones · EMA21/50 · RSI · CLOSED M5/M15 patterns)
  const op = operatorAnalysis(i.closed, price);
  const h4 = op.h4_primary;
  const bias: TradingSnapshot["bias"] = h4 === "INSUFFICIENT" ? { state: "NOT_EVALUABLE", reason: "INSUFFICIENT_HISTORY" }
    : h4 === "UP" ? { state: "BUY", reason: "H4_UP_EMA21_ABOVE_EMA50_HH_HL" }
    : h4 === "DOWN" ? { state: "SELL", reason: "H4_DOWN_EMA21_BELOW_EMA50_LH_LL" }
    : { state: "NEUTRAL", reason: `H4_MIXED_REGIME_${op.regime}` };
  const s = evidence.H1.structure.summary;
  const side = op.status === "CARI_BUY" ? "BUY" : op.status === "CARI_SELL" ? "SELL" : null;
  let setup: TradingSnapshot["setup"];
  if (op.regime === "INSUFFICIENT" || op.h1_context === "INSUFFICIENT") setup = { state: "NOT_EVALUABLE", reason: op.reason === "H4_TREND_INSUFFICIENT_HISTORY" ? "INSUFFICIENT_HISTORY" : "H1_CONTEXT_INSUFFICIENT_HISTORY" };
  else if (op.h1_context === "REVERSAL_CANDIDATE") setup = { state: "INVALID", reason: "H1_REVERSAL_CANDIDATE_AGAINST_H4" };
  else if (op.setup_ready && side) setup = { state: "ACTIVE", reason: `${op.regime}_${side}_CONTEXT_LOCATION${op.regime === "TREND" ? "_RSI" : ""}` };
  else setup = { state: "INACTIVE", reason: op.reason };

  let signal: TradingSnapshot["signal"];
  const base = { triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" as const };
  if (setup.state === "NOT_EVALUABLE") signal = { state: "NOT_EVALUABLE", reason: setup.reason, ...base };
  else if (setup.state !== "ACTIVE") signal = prevSignal?.state === "READY"
    ? { state: setup.state === "INVALID" ? "INVALIDATED" : "WAITING", reason: `SETUP_${setup.state}`, ...base }
    : { state: "WAITING", reason: "SETUP_NOT_ACTIVE", ...base };
  else if (op.candidate && op.trigger_bar) {
    const tb = op.trigger_bar;
    signal = { state: "READY", reason: `${tb.timeframe}_CLOSED_${op.candidate === "BUY" ? "BULLISH" : "BEARISH"}_${tb.patterns.join("+")}`, triggered_at: tb.available_at, trigger_bar: tb.open_time, trigger_evidence: `${tb.timeframe}:${tb.patterns.join("+")}`, validity_policy: "RESEARCH_REQUIRED" };
  } else if (prevSignal?.state === "READY") signal = prevSignal; // latched; validity policy RESEARCH_REQUIRED (no TTL)
  else signal = { state: "WAITING", reason: op.reason, ...base };

  // GUARD (no invented thresholds). In MONITOR_ONLY the capability is structurally absent → BLOCKED.
  const reasons = [...capabilityReasons];
  if (availability === "STALE") reasons.push("FEED_STALE");
  const execution: TradingSnapshot["execution"] = capabilityReasons.length ? { state: "BLOCKED", reasons } : availability === "STALE" ? { state: "INHIBITED", reasons } : { state: "ALLOWED", reasons };

  // ENTRY ANALYSIS (label only; READY requires a CLOSED M5 trigger, so forming candles can never produce it)
  const entry: TradingSnapshot["entry"] = signal.state === "NOT_EVALUABLE" ? { state: "NOT_EVALUABLE", reason: signal.reason }
    : signal.state === "READY" ? { state: side === "BUY" ? "LONG_CANDIDATE" : "SHORT_CANDIDATE", reason: `${bias.reason} + ${setup.reason} + ${signal.reason}` }
    : { state: "WAIT", reason: `${setup.state === "ACTIVE" ? signal.reason : setup.reason}` };
  const referencePlan = deriveReferencePlan(entry, i.quote, evidence, op);

  const why: WhyFact[] = [];
  const dirOk = (t: string) => (t === "INSUFFICIENT" ? null : t === "UP" || t === "DOWN");
  const v = (x: Indicator, d = 1) => (x.status === "OK" ? x.value.toFixed(d) : "INSUFFICIENT_HISTORY");
  why.push({ ok: dirOk(h4), text: `H4 trend ${h4} (EMA21 ${v(op.per_tf.H4.ema21, 2)} / EMA50 ${v(op.per_tf.H4.ema50, 2)}, structure ${evidence.H4.structure.summary}) · regime ${op.regime}` });
  why.push({ ok: op.h1_context === "ALIGNED" || op.h1_context === "RETURNING_TO_H4" ? true : op.h1_context === "INSUFFICIENT" || op.h1_context === "NO_PRIMARY_DIRECTION" ? null : false, text: `H1 context ${op.h1_context} (H1 trend ${op.per_tf.H1.trend}, structure ${s})` });
  why.push({ ok: op.location === "AT_SUPPORT" || op.location === "AT_RESISTANCE" ? true : op.location === "UNKNOWN" ? null : false, text: `Location ${op.location}: support zone ${op.nearest_support ? `${fmt(op.nearest_support.low)}–${fmt(op.nearest_support.high)} ×${op.nearest_support.touches} ${op.nearest_support.source_tf}` : "none"} · resistance zone ${op.nearest_resistance ? `${fmt(op.nearest_resistance.low)}–${fmt(op.nearest_resistance.high)} ×${op.nearest_resistance.touches} ${op.nearest_resistance.source_tf}` : "none"}` });
  why.push({ ok: op.ema_confluence.timeframe ? true : op.ema_confluence.zone === "INSUFFICIENT" ? null : false, text: `EMA21/50 confluence ${op.ema_confluence.zone}${op.ema_confluence.timeframe ? ` (${op.ema_confluence.timeframe})` : ""}` });
  why.push({ ok: op.checks.rsi, text: `RSI14 H1 ${v(evidence.H1.rsi14)} (direction gate) · M15 ${v(evidence.M15.rsi14)} · M5 ${v(evidence.M5.rsi14)} (supporting)` });
  why.push({ ok: op.trigger === "BULLISH" || op.trigger === "BEARISH" ? true : op.trigger === "INSUFFICIENT" ? null : false, text: `CLOSED trigger ${op.trigger}: M5 [${[...op.patterns.M5.bullish, ...op.patterns.M5.bearish].join(", ") || "none"}] · M15 [${[...op.patterns.M15.bullish, ...op.patterns.M15.bearish].join(", ") || "none"}]` });
  why.push({ ok: referencePlan.status === "AVAILABLE", text: referencePlan.status === "AVAILABLE" ? `Reference plan ${referencePlan.side}: confirmed H1 swing ${fmt(referencePlan.anchor_price)} ± 0.25×ATR14(M15) ${fmt(referencePlan.atr14_m15)}; TP1 1R, TP2 2R; S/R target ${referencePlan.structural.structural_target === null ? "none" : fmt(referencePlan.structural.structural_target)}` : `Reference plan unavailable: ${referencePlan.reason}` });
  why.push({ ok: entry.state === "LONG_CANDIDATE" || entry.state === "SHORT_CANDIDATE", text: `Entry analysis ${entry.state}: ${entry.reason}` });
  why.push({ ok: false, text: `Execution ${execution.state}: ${execution.reasons.join(", ") || "—"}` });

  return { symbol: i.symbol, as_of: i.as_of, label: "CURRENT", availability, availability_reason: availability === "STALE" ? "BAR_HISTORY_REFRESH_FAILED" : "OBSERVED", quote: i.quote, evidence, last3_m5: last3, engulfing: eng, bias, setup, signal, execution, entry, reference_plan: referencePlan, operator: op, why, versions };
}

/** A stored previous snapshot can never be labelled CURRENT. */
export function asLastKnown(s: TradingSnapshot): TradingSnapshot {
  return Object.freeze({ ...s, label: "LAST_KNOWN_STALE" as const });
}

// ---------------- transitions ----------------

export type Domain = "AVAILABILITY" | "BIAS" | "SETUP" | "SIGNAL" | "EXECUTION";
export interface StateTransition {
  readonly seq: number;
  readonly symbol: string;
  readonly domain: Domain;
  readonly from: string | null;
  readonly to: string;
  readonly reason_code: string;
  readonly event_at: number | null;
  readonly observed_at: number | null;
  readonly available_at: number;
  readonly trigger_bar: number | null;
  readonly technical_engine_version: string;
  readonly setup_policy_version: string;
  readonly signal_policy_version: string;
  readonly reference_plan_policy_version: string;
  readonly guard_policy_version: string;
  readonly evidence_refs: readonly string[];
}

/** Append-only, bounded. Oldest records drop from memory but the cumulative counter never resets. */
export class TransitionTrail {
  private readonly log: StateTransition[] = [];
  private seq = 0;
  evicted = 0;
  constructor(private readonly cap = 500) {}
  record(prev: TradingSnapshot | null, next: TradingSnapshot): StateTransition[] {
    const pairs: [Domain, string | null, string, string][] = [
      ["AVAILABILITY", prev?.availability ?? null, next.availability, next.availability_reason],
      ["BIAS", prev?.bias.state ?? null, next.bias.state, next.bias.reason],
      ["SETUP", prev?.setup.state ?? null, next.setup.state, next.setup.reason],
      ["SIGNAL", prev?.signal.state ?? null, next.signal.state, next.signal.reason],
      ["EXECUTION", prev?.execution.state ?? null, next.execution.state, next.execution.reasons.join("+")],
    ];
    const out: StateTransition[] = [];
    for (const [domain, from, to, reason] of pairs) {
      if (from === to) continue;
      const t: StateTransition = Object.freeze({
        seq: this.seq++, symbol: next.symbol, domain, from, to, reason_code: reason,
        event_at: next.quote?.tick_time_ms ?? null, observed_at: next.quote?.observed_at ?? null, available_at: next.as_of,
        trigger_bar: domain === "SIGNAL" ? next.signal.trigger_bar : null, ...next.versions,
        evidence_refs: next.evidence ? TIMEFRAMES.map((tf) => `${tf}@${next.evidence![tf].last_closed_open_time ?? "none"}`) : [],
      });
      this.log.push(t); out.push(t);
    }
    while (this.log.length > this.cap) { this.log.shift(); this.evicted++; }
    return out;
  }
  get entries(): readonly StateTransition[] { return this.log; }
  get total(): number { return this.seq; }
}

export const SLICE_ENV = Object.freeze({ operating_mode: OPERATING_MODE, execution_enabled: EXECUTION_ENABLED as boolean });
