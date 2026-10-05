// Four orthogonal trading-state domains + availability + deterministic analyzer + bounded transition trail.
// MONITOR_ONLY. ExecutionState describes guard/environment state; it NEVER transmits anything.
import { EXECUTION_ENABLED, OPERATING_MODE, type Timeframe } from "../contracts";
import {
  ENGULFING_DEFINITION, TECHNICAL_ENGINE_VERSION, atrWilder, ema, emaRelation, engulfing, geometry, nearestLevels, rsiWilder, structureOf,
  type CandleGeometry, type Indicator, type NearestLevels, type Relation, type Structure, type TechBar,
} from "./indicators";

export type TechnicalAvailability = "AVAILABLE" | "STALE" | "UNAVAILABLE";
export type BiasState = "BUY" | "SELL" | "NEUTRAL" | "NOT_EVALUABLE";
export type SetupState = "ACTIVE" | "INACTIVE" | "INVALID" | "NOT_EVALUABLE";
export type SignalState = "READY" | "WAITING" | "EXPIRED" | "INVALIDATED" | "NOT_EVALUABLE";
export type EntryAnalysis = "LONG_CANDIDATE" | "SHORT_CANDIDATE" | "WAIT" | "NOT_EVALUABLE";
export type ExecutionState = "ALLOWED" | "INHIBITED" | "BLOCKED";

export const ALL_SIGNAL_STATES: readonly SignalState[] = ["READY", "WAITING", "EXPIRED", "INVALIDATED", "NOT_EVALUABLE"];

export const SETUP_POLICY_VERSION = "setup-v0-baseline";
export const SIGNAL_POLICY_VERSION = "signal-v0-baseline";
export const GUARD_POLICY_VERSION = "guard-v0-monitor-only";
export const POLICIES = Object.freeze({
  bias: "H4 & H1 EMA5 vs EMA21 on CLOSED bars: both above → BUY, both below → SELL, else NEUTRAL",
  setup: "BUY bias + H1 latest HH & HL → ACTIVE; BUY bias + H1 latest LH & LL → INVALID; SELL mirror; otherwise INACTIVE. LOCATION criterion = RESEARCH_REQUIRED (not applied)",
  signal: "Setup ACTIVE + latest CLOSED M5 engulfing in bias direction → READY (latched on trigger bar); ACTIVE without trigger → WAITING; setup leaves ACTIVE → INVALIDATED (if INVALID) else WAITING",
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
  readonly why: readonly WhyFact[];
  readonly versions: { readonly technical_engine_version: string; readonly setup_policy_version: string; readonly signal_policy_version: string; readonly guard_policy_version: string };
}

function evidenceFor(tf: Timeframe, bars: readonly TechBar[], price: number | null): TimeframeEvidence {
  const e5 = ema(bars, 5), e21 = ema(bars, 21), atr = atrWilder(bars, 14), last = bars[bars.length - 1];
  const structure = structureOf(bars);
  return {
    timeframe: tf, closed_count: bars.length, last_closed_open_time: last?.open_time ?? null, last_closed_available_at: last?.available_at ?? null,
    ema5: e5, ema21: e21, relation: emaRelation(e5, e21), atr14: atr, rsi14: rsiWilder(bars), structure,
    snr: price === null ? null : nearestLevels(structure.swings, price, atr),
  };
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(3));

/** Pure evaluation. `prevSignal` provides latching of a READY signal on its trigger bar. */
export function evaluate(i: EvaluationInput, prevSignal: TradingSnapshot["signal"] | null = null): TradingSnapshot {
  const versions = { technical_engine_version: TECHNICAL_ENGINE_VERSION, setup_policy_version: SETUP_POLICY_VERSION, signal_policy_version: SIGNAL_POLICY_VERSION, guard_policy_version: GUARD_POLICY_VERSION };
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
      why: [{ ok: false, text: "Current market state cannot be established" }], versions,
    };
  }

  const price = (i.quote.bid + i.quote.ask) / 2;
  const evidence = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, evidenceFor(tf, i.closed[tf], price)])) as Record<Timeframe, TimeframeEvidence>;
  const availability: TechnicalAvailability = i.bars_current ? "AVAILABLE" : "STALE";
  const m5 = i.closed.M5;
  const last3 = m5.slice(-3).map(geometry);
  const eng = m5.length >= 2 ? { ...engulfing(m5[m5.length - 2]!, m5[m5.length - 1]!), definition: ENGULFING_DEFINITION, bar_open_time: m5[m5.length - 1]!.open_time } : null;

  // TREND
  const h4 = evidence.H4.relation, h1 = evidence.H1.relation;
  let bias: TradingSnapshot["bias"];
  if (h4 === "INSUFFICIENT_HISTORY" || h1 === "INSUFFICIENT_HISTORY") bias = { state: "NOT_EVALUABLE", reason: "INSUFFICIENT_HISTORY" };
  else if (h4 === "EMA5_ABOVE_EMA21" && h1 === "EMA5_ABOVE_EMA21") bias = { state: "BUY", reason: "H4_H1_EMA5_ABOVE_EMA21" };
  else if (h4 === "EMA5_BELOW_EMA21" && h1 === "EMA5_BELOW_EMA21") bias = { state: "SELL", reason: "H4_H1_EMA5_BELOW_EMA21" };
  else bias = { state: "NEUTRAL", reason: "H4_H1_EMA_NOT_ALIGNED" };

  // STRUCTURE (LOCATION = RESEARCH_REQUIRED, not applied)
  const s = evidence.H1.structure.summary;
  let setup: TradingSnapshot["setup"];
  if (bias.state === "NOT_EVALUABLE") setup = { state: "NOT_EVALUABLE", reason: "BIAS_NOT_EVALUABLE" };
  else if (bias.state === "NEUTRAL") setup = { state: "INACTIVE", reason: "BIAS_NEUTRAL" };
  else if (s === "INSUFFICIENT_HISTORY") setup = { state: "NOT_EVALUABLE", reason: "H1_STRUCTURE_INSUFFICIENT_HISTORY" };
  else if ((bias.state === "BUY" && s === "HH_HL") || (bias.state === "SELL" && s === "LH_LL")) setup = { state: "ACTIVE", reason: `BIAS_${bias.state}_H1_${s}` };
  else if ((bias.state === "BUY" && s === "LH_LL") || (bias.state === "SELL" && s === "HH_HL")) setup = { state: "INVALID", reason: `BIAS_${bias.state}_CONTRADICTED_BY_H1_${s}` };
  else setup = { state: "INACTIVE", reason: `H1_STRUCTURE_${s}` };

  // TRIGGER
  let signal: TradingSnapshot["signal"];
  const base = { triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" as const };
  if (setup.state === "NOT_EVALUABLE") signal = { state: "NOT_EVALUABLE", reason: setup.reason, ...base };
  else if (setup.state !== "ACTIVE") signal = prevSignal?.state === "READY"
    ? { state: setup.state === "INVALID" ? "INVALIDATED" : "WAITING", reason: `SETUP_${setup.state}`, ...base }
    : { state: "WAITING", reason: "SETUP_NOT_ACTIVE", ...base };
  else {
    const hit = eng && ((bias.state === "BUY" && eng.bullish) || (bias.state === "SELL" && eng.bearish));
    if (hit) {
      const last = m5[m5.length - 1]!;
      signal = { state: "READY", reason: `M5_CLOSED_${bias.state === "BUY" ? "BULLISH" : "BEARISH"}_ENGULFING`, triggered_at: last.available_at, trigger_bar: last.open_time, trigger_evidence: ENGULFING_DEFINITION, validity_policy: "RESEARCH_REQUIRED" };
    } else if (prevSignal?.state === "READY") signal = prevSignal; // latched; validity policy RESEARCH_REQUIRED (no TTL)
    else signal = { state: "WAITING", reason: "NO_CLOSED_M5_TRIGGER", ...base };
  }

  // GUARD (no invented thresholds). In MONITOR_ONLY the capability is structurally absent → BLOCKED.
  const reasons = [...capabilityReasons];
  if (availability === "STALE") reasons.push("FEED_STALE");
  const execution: TradingSnapshot["execution"] = capabilityReasons.length ? { state: "BLOCKED", reasons } : availability === "STALE" ? { state: "INHIBITED", reasons } : { state: "ALLOWED", reasons };

  // ENTRY ANALYSIS (label only; READY requires a CLOSED M5 trigger, so forming candles can never produce it)
  const entry: TradingSnapshot["entry"] = signal.state === "NOT_EVALUABLE" ? { state: "NOT_EVALUABLE", reason: signal.reason }
    : signal.state === "READY" ? { state: bias.state === "BUY" ? "LONG_CANDIDATE" : "SHORT_CANDIDATE", reason: `${bias.reason} + ${setup.reason} + ${signal.reason}` }
    : { state: "WAIT", reason: `${setup.state === "ACTIVE" ? signal.reason : setup.reason}` };

  const why: WhyFact[] = [];
  const rel = (tf: "H4" | "H1") => {
    const e = evidence[tf];
    return e.relation === "INSUFFICIENT_HISTORY" ? { ok: null, text: `${tf} EMA5/EMA21: INSUFFICIENT_HISTORY` }
      : { ok: bias.state === "SELL" ? e.relation === "EMA5_BELOW_EMA21" : e.relation === "EMA5_ABOVE_EMA21", text: `${tf} ${e.relation.replaceAll("_", " ")} (${fmt((e.ema5 as { value: number }).value)} vs ${fmt((e.ema21 as { value: number }).value)})` };
  };
  why.push(rel("H4"), rel("H1"));
  why.push({ ok: s === "HH_HL" || s === "LH_LL" ? true : s === "INSUFFICIENT_HISTORY" ? null : false, text: `H1 causal structure ${s} (latest high ${evidence.H1.structure.latest_high ?? "—"}, latest low ${evidence.H1.structure.latest_low ?? "—"})` });
  const sn = evidence.H1.snr;
  why.push({ ok: null, text: `H1 nearest support ${sn?.nearest_support ? fmt(sn.nearest_support.price) : "none"} · resistance ${sn?.nearest_resistance ? fmt(sn.nearest_resistance.price) : "none"} (location policy RESEARCH_REQUIRED)` });
  why.push({ ok: eng ? eng.bullish : null, text: `M5 bullish engulfing (CLOSED) = ${eng ? String(eng.bullish).toUpperCase() : "INSUFFICIENT_HISTORY"}` });
  why.push({ ok: eng ? eng.bearish : null, text: `M5 bearish engulfing (CLOSED) = ${eng ? String(eng.bearish).toUpperCase() : "INSUFFICIENT_HISTORY"}` });
  const v = (x: Indicator, d = 1) => (x.status === "OK" ? x.value.toFixed(d) : "INSUFFICIENT_HISTORY");
  why.push({ ok: null, text: `RSI14 M5 ${v(evidence.M5.rsi14)} · H1 ${v(evidence.H1.rsi14)} · ATR14 M5 ${evidence.M5.atr14.status === "OK" ? fmt(evidence.M5.atr14.value) : "INSUFFICIENT_HISTORY"} (evidence only, no threshold)` });
  why.push({ ok: entry.state === "LONG_CANDIDATE" || entry.state === "SHORT_CANDIDATE", text: `Entry analysis ${entry.state}: ${entry.reason}` });
  why.push({ ok: false, text: `Execution ${execution.state}: ${execution.reasons.join(", ") || "—"}` });

  return { symbol: i.symbol, as_of: i.as_of, label: "CURRENT", availability, availability_reason: availability === "STALE" ? "BAR_HISTORY_REFRESH_FAILED" : "OBSERVED", quote: i.quote, evidence, last3_m5: last3, engulfing: eng, bias, setup, signal, execution, entry, why, versions };
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
