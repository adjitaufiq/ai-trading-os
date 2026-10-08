// Operator-style multi-timeframe analysis (policy operator-v2). Pure, deterministic, CLOSED bars only.
// Encodes the operator's discretionary style as explicit, versioned rules:
//   H4 = primary direction · H1 = context relative to H4 (aligned / pullback / returning / reversal)
//   S/R = ATR-clustered zones of confirmed causal swings · EMA21/50 = pullback confluence
//   RSI14 H1 = direction gate, M15/M5 RSI = supporting evidence only · CLOSED M5/M15 candle trigger.
// All numeric parameters live in OPERATOR_PARAMS (operator-defined, NOT backtested ⇒ RESEARCH_REQUIRED).
// Output is EVIDENCE + an analysis label. It never transmits anything and has no execution capability.
import type { Timeframe } from "../contracts";
import {
  atrWilder, ema, engulfing, geometry, rsiWilder, structureOf,
  type Indicator, type LabelledSwing, type Structure, type TechBar,
} from "./indicators";

export const OPERATOR_POLICY_VERSION = "operator-v2.3-mtf-classification";
export const PATTERN_DEFINITION_VERSION = "candle-patterns-v1";
export const ZONE_DEFINITION_VERSION = "sr-zone-swing-cluster-atr-v1";

export const OPERATOR_PARAMS = Object.freeze({
  /** Trend EMAs. EMA5 is kept only as fast timing evidence (pullback / return), never as the trend itself. */
  trend_ema_fast: 21,
  trend_ema_slow: 50,
  timing_ema: 5,
  atr_period: 14,
  /** Swings of one timeframe join a zone while (swing.price − zone.low) ≤ k × ATR14(same TF). */
  zone_cluster_tolerance_atr: 0.5,
  /** Price is "at" a zone when its distance to the zone edge ≤ k × ATR14(M15). */
  zone_proximity_atr_m15: 0.5,
  /** Price is "near" an EMA when |price − EMA| ≤ k × ATR14(same TF). */
  ema_near_atr: 0.25,
  /** RANGE requires a support zone and a resistance zone each touched at least this many times (H1). */
  range_min_touches: 2,
  pattern: Object.freeze({
    pin_wick_to_body_min: 2,
    pin_opposite_wick_max_range: 0.25,
    rejection_wick_min_range: 0.5,
    star_first_body_min_range: 0.5,
    star_middle_body_max_first_body: 0.3,
  }),
  status: "OPERATOR_DEFINED_UNVALIDATED_RESEARCH_REQUIRED",
});
const P = OPERATOR_PARAMS;

export const OPERATOR_RULES = Object.freeze({
  trend: "Per TF: UP = EMA21 > EMA50 AND confirmed structure HH_HL; DOWN = EMA21 < EMA50 AND LH_LL; any disagreement = MIXED; EMA50 or structure missing = INSUFFICIENT",
  h1_context: "Only when H4 is UP/DOWN: H1 trend = H4 ⇒ ALIGNED; H1 trend = opposite ⇒ REVERSAL_CANDIDATE; H1 EMA5 vs EMA21 against H4 ⇒ PULLBACK_AGAINST_H4; EMA5 vs EMA21 with H4 AND latest confirmed H1 swing label with H4 (HH/HL up, LH/LL down) ⇒ RETURNING_TO_H4; otherwise MIXED",
  structure_break: "BREAK_UP/DOWN_CANDIDATE = last CLOSED bar closes beyond the latest swing confirmed before that bar opened. Not BOS/CHOCH",
  zones: "Confirmed swings (H4/H1/M15) sorted by price, greedy clusters with width ≤ 0.5×ATR14(TF); role by price vs zone center; confluence = overlap with another TF zone",
  ema_zone: "BAND = price inside [EMA21, EMA50]; else NEAR_EMA21 / NEAR_EMA50 within 0.25×ATR14(TF); else NOT_NEAR",
  location: "AT_SUPPORT / AT_RESISTANCE = within 0.5×ATR14(M15) of a support / resistance zone edge (inside counts); both ⇒ AMBIGUOUS; neither ⇒ MID",
  regime: "TREND = H4 UP/DOWN; RANGE = H4 not directional AND H1 has a support zone and a resistance zone each with ≥2 touches; otherwise CHOPPY",
  trend_setup: "P0.5: primaryBias = H4 structure+EMA (UP⇒BUY, DOWN⇒SELL, else NONE) — the ONLY direction source. M5/M15 momentum is timing evidence only, never picks BUY/SELL. TREND regime: side = primaryBias; location = S/R zone on the side's entry edge OR M5/M15 EMA21/50 local confluence; retained H1 RSI14 gate (until P0.8); CLOSED M5/M15 trigger in side. Local momentum opposing primaryBias ⇒ counterTrendCondition warning + LOCAL_MOMENTUM_CONFLICT diagnostic, never a side flip. Legacy vetoes: H4 INSUFFICIENT, CHOPPY, H1 REVERSAL_CANDIDATE/INSUFFICIENT ⇒ HOLD",
  scalp_momentum: "Per M5/M15 (CLOSED): slope = (EMA_now − EMA_3barsAgo)/ATR14_now; gap = |EMA5−EMA21|/ATR14_now; gap_delta = gap − gap_3barsAgo. Sign comparisons only. Timing/pullback evidence only — never a direction source",
  alignment: "WITH_MACRO = side matches H4 direction; COUNTER_MACRO = opposes clear H4; NEUTRAL_MACRO = H4 MIXED; NOT_APPLICABLE = no side or H4 INSUFFICIENT. Since side = primaryBias (H4), COUNTER_MACRO is structurally unreachable for candidates; kept for audit of legacy payloads",
  range_setup: "Momentum side required; BUY needs AT_SUPPORT + bullish CLOSED trigger, SELL AT_RESISTANCE + bearish; MID/AMBIGUOUS ⇒ HOLD. RSI gate not applied in range (RESEARCH_REQUIRED)",
  rsi_support: "M15/M5 RSI14 > 50 bullish, < 50 bearish — supporting evidence only; overbought/oversold thresholds RESEARCH_REQUIRED (not used)",
  patterns: "See candle-patterns-v1: engulfing (strict body), hammer-like, shooting-star-like, rejection wick, morning/evening-star-like on the last 3 CLOSED bars",
});

const TFS: readonly Timeframe[] = ["M5", "M15", "H1", "H4"];

// ---------------- candle patterns (CLOSED bars only) ----------------

export type PatternName = "BULLISH_ENGULFING" | "BEARISH_ENGULFING" | "HAMMER_LIKE" | "SHOOTING_STAR_LIKE"
  | "BULLISH_REJECTION_WICK" | "BEARISH_REJECTION_WICK" | "MORNING_STAR_LIKE" | "EVENING_STAR_LIKE";

/** Hammer-like: body > 0, lower wick ≥ 2×body, upper wick ≤ 0.25×range. Colour-agnostic. */
export function hammerLike(b: TechBar): boolean {
  const g = geometry(b);
  return g.range > 0 && g.body > 0 && g.lower_wick >= P.pattern.pin_wick_to_body_min * g.body && g.upper_wick <= P.pattern.pin_opposite_wick_max_range * g.range;
}
/** Shooting-star-like: mirror of hammer-like. */
export function shootingStarLike(b: TechBar): boolean {
  const g = geometry(b);
  return g.range > 0 && g.body > 0 && g.upper_wick >= P.pattern.pin_wick_to_body_min * g.body && g.lower_wick <= P.pattern.pin_opposite_wick_max_range * g.range;
}
/** Rejection wick: one wick ≥ 0.5×range and strictly longer than the other wick. */
export function rejectionWick(b: TechBar): { bullish: boolean; bearish: boolean } {
  const g = geometry(b);
  if (g.range <= 0) return { bullish: false, bearish: false };
  const min = P.pattern.rejection_wick_min_range * g.range;
  return { bullish: g.lower_wick >= min && g.lower_wick > g.upper_wick, bearish: g.upper_wick >= min && g.upper_wick > g.lower_wick };
}
/**
 * Morning-star-like (a, b, c): a bearish with body ≥ 0.5×range(a); b body ≤ 0.3×body(a); c bullish and closes above
 * the midpoint of a's body. Evening-star-like is the exact mirror. No gap requirement (24h CFD feeds rarely gap).
 */
export function morningStarLike(a: TechBar, b: TechBar, c: TechBar): boolean {
  const ga = geometry(a), gb = geometry(b);
  return ga.direction === "BEARISH" && ga.range > 0 && ga.body >= P.pattern.star_first_body_min_range * ga.range
    && gb.body <= P.pattern.star_middle_body_max_first_body * ga.body
    && c.close > c.open && c.close > (a.open + a.close) / 2;
}
export function eveningStarLike(a: TechBar, b: TechBar, c: TechBar): boolean {
  const ga = geometry(a), gb = geometry(b);
  return ga.direction === "BULLISH" && ga.range > 0 && ga.body >= P.pattern.star_first_body_min_range * ga.range
    && gb.body <= P.pattern.star_middle_body_max_first_body * ga.body
    && c.close < c.open && c.close < (a.open + a.close) / 2;
}

export type TriggerDirection = "BULLISH" | "BEARISH" | "CONFLICT" | "NONE" | "INSUFFICIENT";
export interface PatternRead {
  readonly timeframe: Timeframe;
  readonly definition: typeof PATTERN_DEFINITION_VERSION;
  /** The CLOSED bar that completes the pattern(s); patterns are evaluated on it and its predecessors only. */
  readonly bar_open_time: number | null;
  readonly bar_available_at: number | null;
  readonly bullish: readonly PatternName[];
  readonly bearish: readonly PatternName[];
  readonly direction: TriggerDirection;
}

/** Reads patterns completing on the latest CLOSED bar of `bars` (inputs are CLOSED only, so FORMING can never trigger). */
export function readPatterns(bars: readonly TechBar[], tf: Timeframe): PatternRead {
  const c = bars[bars.length - 1];
  if (!c) return { timeframe: tf, definition: PATTERN_DEFINITION_VERSION, bar_open_time: null, bar_available_at: null, bullish: [], bearish: [], direction: "INSUFFICIENT" };
  const bull: PatternName[] = [], bear: PatternName[] = [];
  const b = bars[bars.length - 2], a = bars[bars.length - 3];
  if (b) { const e = engulfing(b, c); if (e.bullish) bull.push("BULLISH_ENGULFING"); if (e.bearish) bear.push("BEARISH_ENGULFING"); }
  if (hammerLike(c)) bull.push("HAMMER_LIKE");
  if (shootingStarLike(c)) bear.push("SHOOTING_STAR_LIKE");
  const r = rejectionWick(c);
  if (r.bullish) bull.push("BULLISH_REJECTION_WICK");
  if (r.bearish) bear.push("BEARISH_REJECTION_WICK");
  if (a && b) { if (morningStarLike(a, b, c)) bull.push("MORNING_STAR_LIKE"); if (eveningStarLike(a, b, c)) bear.push("EVENING_STAR_LIKE"); }
  const direction: TriggerDirection = bull.length && bear.length ? "CONFLICT" : bull.length ? "BULLISH" : bear.length ? "BEARISH" : "NONE";
  return { timeframe: tf, definition: PATTERN_DEFINITION_VERSION, bar_open_time: c.open_time, bar_available_at: c.available_at, bullish: bull, bearish: bear, direction };
}

// ---------------- trend & structure ----------------

export type TrendState = "UP" | "DOWN" | "MIXED" | "INSUFFICIENT";
export function trendState(e21: Indicator, e50: Indicator, structure: Structure["summary"]): TrendState {
  if (e21.status !== "OK" || e50.status !== "OK" || structure === "INSUFFICIENT_HISTORY") return "INSUFFICIENT";
  if (e21.value > e50.value && structure === "HH_HL") return "UP";
  if (e21.value < e50.value && structure === "LH_LL") return "DOWN";
  return "MIXED";
}

export type H1Context = "ALIGNED" | "PULLBACK_AGAINST_H4" | "RETURNING_TO_H4" | "REVERSAL_CANDIDATE" | "MIXED" | "NO_PRIMARY_DIRECTION" | "INSUFFICIENT";
type Fast = "UP" | "DOWN" | "FLAT" | "INSUFFICIENT";
const fastRel = (e5: Indicator, e21: Indicator): Fast => e5.status !== "OK" || e21.status !== "OK" ? "INSUFFICIENT" : e5.value > e21.value ? "UP" : e5.value < e21.value ? "DOWN" : "FLAT";
const latestLabelled = (s: Structure) => [...s.swings].reverse().find((w) => w.label !== "FIRST") ?? null;
const swingDir = (w: LabelledSwing | null): "UP" | "DOWN" | null => !w ? null : w.label === "HH" || w.label === "HL" ? "UP" : w.label === "LH" || w.label === "LL" ? "DOWN" : null;

export function h1Context(h4: TrendState, h1: TrendState, h1Fast: Fast, h1Latest: LabelledSwing | null): H1Context {
  if (h4 === "INSUFFICIENT") return "INSUFFICIENT";
  if (h4 === "MIXED") return "NO_PRIMARY_DIRECTION";
  const opp = h4 === "UP" ? "DOWN" : "UP";
  if (h1 === "INSUFFICIENT" || h1Fast === "INSUFFICIENT") return "INSUFFICIENT";
  if (h1 === h4) return "ALIGNED";
  if (h1 === opp) return "REVERSAL_CANDIDATE";
  if (h1Fast === opp) return "PULLBACK_AGAINST_H4";
  if (h1Fast === h4 && swingDir(h1Latest) === h4) return "RETURNING_TO_H4";
  return "MIXED";
}

export interface StructureEvents {
  readonly last_hh: LabelledSwing | null;
  readonly last_hl: LabelledSwing | null;
  readonly last_lh: LabelledSwing | null;
  readonly last_ll: LabelledSwing | null;
  /** Latest six labelled confirmed swings (for chart / read model). */
  readonly recent: readonly LabelledSwing[];
  readonly break_candidate: "BREAK_UP_CANDIDATE" | "BREAK_DOWN_CANDIDATE" | "NONE";
}
export function structureEvents(s: Structure, bars: readonly TechBar[]): StructureEvents {
  const find = (l: string) => [...s.swings].reverse().find((w) => w.label === l) ?? null;
  const last = bars[bars.length - 1];
  let br: StructureEvents["break_candidate"] = "NONE";
  if (last) {
    const prior = s.swings.filter((w) => w.confirmed_at <= last.open_time);
    const hi = [...prior].reverse().find((w) => w.kind === "HIGH"), lo = [...prior].reverse().find((w) => w.kind === "LOW");
    if (hi && last.close > hi.price) br = "BREAK_UP_CANDIDATE";
    else if (lo && last.close < lo.price) br = "BREAK_DOWN_CANDIDATE";
  }
  return { last_hh: find("HH"), last_hl: find("HL"), last_lh: find("LH"), last_ll: find("LL"), recent: s.swings.slice(-6), break_candidate: br };
}

// ---------------- S/R zones ----------------

export interface SrZone {
  readonly source_tf: Timeframe;
  readonly definition: typeof ZONE_DEFINITION_VERSION;
  readonly low: number;
  readonly high: number;
  readonly center: number;
  readonly touches: number;
  readonly swing_highs: number;
  readonly swing_lows: number;
  readonly latest_touch_at: number;
  readonly role: "SUPPORT" | "RESISTANCE";
  /** 0 when price is inside the zone, else distance to the nearest edge. */
  readonly distance: number;
  readonly confluence_tfs: readonly Timeframe[];
}

export function buildZones(swings: readonly LabelledSwing[], tf: Timeframe, atr: Indicator, price: number): SrZone[] {
  if (atr.status !== "OK" || !(atr.value > 0) || !swings.length) return [];
  const tol = P.zone_cluster_tolerance_atr * atr.value;
  const sorted = [...swings].sort((a, b) => a.price - b.price || a.pivot_time - b.pivot_time);
  const groups: LabelledSwing[][] = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    if (g && s.price - g[0]!.price <= tol) g.push(s); else groups.push([s]);
  }
  return groups.map((g) => {
    const low = g[0]!.price, high = g[g.length - 1]!.price, center = (low + high) / 2;
    const distance = price < low ? low - price : price > high ? price - high : 0;
    return {
      source_tf: tf, definition: ZONE_DEFINITION_VERSION, low, high, center, touches: g.length,
      swing_highs: g.filter((s) => s.kind === "HIGH").length, swing_lows: g.filter((s) => s.kind === "LOW").length,
      latest_touch_at: Math.max(...g.map((s) => s.available_at)), role: center <= price ? "SUPPORT" : "RESISTANCE", distance, confluence_tfs: [],
    } satisfies SrZone;
  });
}

export function withConfluence(byTf: Partial<Record<Timeframe, SrZone[]>>): Partial<Record<Timeframe, SrZone[]>> {
  const out: Partial<Record<Timeframe, SrZone[]>> = {};
  for (const tf of Object.keys(byTf) as Timeframe[]) {
    out[tf] = byTf[tf]!.map((z) => ({
      ...z,
      confluence_tfs: (Object.keys(byTf) as Timeframe[]).filter((o) => o !== tf && byTf[o]!.some((x) => x.low <= z.high && z.low <= x.high)),
    }));
  }
  return out;
}

const nearest = (zones: readonly SrZone[], role: SrZone["role"]) =>
  zones.filter((z) => z.role === role).sort((a, b) => a.distance - b.distance || b.touches - a.touches)[0] ?? null;

// ---------------- EMA confluence / RSI support ----------------

export type EmaZone = "BAND" | "NEAR_EMA21" | "NEAR_EMA50" | "NOT_NEAR" | "INSUFFICIENT";
export function emaZone(price: number, e21: Indicator, e50: Indicator, atr: Indicator): EmaZone {
  if (e21.status !== "OK" || e50.status !== "OK" || atr.status !== "OK" || !(atr.value > 0)) return "INSUFFICIENT";
  const lo = Math.min(e21.value, e50.value), hi = Math.max(e21.value, e50.value), k = P.ema_near_atr * atr.value;
  if (price >= lo && price <= hi) return "BAND";
  if (Math.abs(price - e21.value) <= k) return "NEAR_EMA21";
  if (Math.abs(price - e50.value) <= k) return "NEAR_EMA50";
  return "NOT_NEAR";
}

export type RsiSupport = "BULLISH" | "BEARISH" | "NEUTRAL" | "INSUFFICIENT";
export const rsiSupport = (r: Indicator): RsiSupport => r.status !== "OK" ? "INSUFFICIENT" : r.value > 50 ? "BULLISH" : r.value < 50 ? "BEARISH" : "NEUTRAL";

export function rsiDirectionGate(side: "BUY" | "SELL", rsi: Indicator): { readonly pass: boolean; readonly reason: string } {
  if (rsi.status !== "OK") return { pass: false, reason: "H1_RSI14_INSUFFICIENT_HISTORY" };
  if (rsi.value === 50) return { pass: false, reason: "H1_RSI14_NEUTRAL_50" };
  const pass = side === "BUY" ? rsi.value > 50 : rsi.value < 50;
  return { pass, reason: pass ? `H1_RSI14_SUPPORTS_${side}` : `H1_RSI14_CONFLICTS_${side}` };
}

// ---------------- full analysis ----------------

export type Regime = "TREND" | "RANGE" | "CHOPPY" | "INSUFFICIENT";
export type Location = "AT_SUPPORT" | "AT_RESISTANCE" | "AMBIGUOUS" | "MID" | "UNKNOWN";
export type OperatorStatus = "CARI_BUY" | "CARI_SELL" | "HOLD";

export interface OperatorTf {
  readonly timeframe: Timeframe;
  readonly ema5: Indicator;
  readonly ema21: Indicator;
  readonly ema50: Indicator;
  readonly atr14: Indicator;
  readonly rsi14: Indicator;
  readonly trend: TrendState;
  readonly fast: Fast;
  readonly ema_zone: EmaZone;
  readonly rsi_support: RsiSupport;
  readonly events: StructureEvents;
}

/** ARENA v0.5 — H4 structure is the single direction source (primaryBias); M15/M5 = entry timing only. */
export const ARCHITECTURE_VERSION = "arena-architecture-v0.5-h4-primary-bias";
/** Single source of trade direction. null = no tradeable direction (H4 MIXED/INSUFFICIENT). */
export type PrimaryBias = "BUY" | "SELL" | null;
/** Counter-trend risk information only — never enters signal state, plans, or execution. */
export type CounterTrendCondition = "NONE" | "BULLISH_PULLBACK" | "BEARISH_PULLBACK";
export type MacroDirection = "BULLISH" | "BEARISH" | "NEUTRAL_OR_MIXED" | "INSUFFICIENT";
export type MacroAlignment = "WITH_MACRO" | "COUNTER_MACRO" | "NEUTRAL_MACRO" | "NOT_APPLICABLE";
export interface MacroContext {
  readonly h4_primary: TrendState;
  readonly h1_context: H1Context;
  readonly h4_structure: StructureEvents;
  readonly h1_structure: StructureEvents;
  /** Major walls from the existing zone engine. Safety/location evidence; no veto thresholds in P0.1. */
  readonly major_zones: { readonly H4: readonly SrZone[]; readonly H1: readonly SrZone[] };
  readonly macro_direction: MacroDirection;
  /** MTF classification (MTF_POLICY_VERSION): descriptive only, never picks BUY/SELL or executes. */
  readonly mtf: MtfClassification;
}

export const MTF_POLICY_VERSION = "mtf-classification-v1";
export type MtfMarketClass = "BULLISH" | "BEARISH" | "SIDEWAYS" | "TRANSITION";
export type MtfH1State = "ALIGNED" | "PULLBACK" | "COUNTER_TREND_REBOUND" | "COUNTER_TREND_DECLINE" | "RESUMING" | "MIXED" | "NO_PRIMARY_DIRECTION" | "INSUFFICIENT";
export type MtfActionContext = "FOLLOW_TREND" | "WAIT_CONFIRMATION" | "RANGE_ONLY" | "STAND_ASIDE" | "NOT_EVALUABLE";
export interface MtfClassification {
  readonly policy_version: typeof MTF_POLICY_VERSION;
  readonly classification: MtfMarketClass;
  readonly h4_bias: "BULLISH" | "BEARISH" | "SIDEWAYS" | "INSUFFICIENT";
  readonly h1_state: MtfH1State;
  readonly action_context: MtfActionContext;
  /** Deterministic 0–100 agreement score from MTF_CONFIDENCE_PARAMS; descriptive, never a gate. */
  readonly confidence: number;
  readonly reasons: readonly string[];
}
/** Explicit, versioned confidence weights (agreement of H4/H1/M15/M5). Sum of positive weights = 100. */
export const MTF_CONFIDENCE_PARAMS = { H4_CLEAR: 40, H1_ALIGNED: 30, H1_RESUMING: 20, H1_PULLBACK: 10, M15_WITH_H4: 15, M5_WITH_H4: 15 } as const;

export function classifyMtf(h4: TrendState, ctx: H1Context, m15Fast: string, m5Fast: string, bounded: boolean): MtfClassification {
  const P2 = MTF_CONFIDENCE_PARAMS;
  const h4_bias = h4 === "UP" ? "BULLISH" : h4 === "DOWN" ? "BEARISH" : h4 === "MIXED" ? "SIDEWAYS" : "INSUFFICIENT";
  const reasons: string[] = [];
  const mk = (classification: MtfMarketClass, h1_state: MtfH1State, action_context: MtfActionContext, confidence: number): MtfClassification =>
    Object.freeze({ policy_version: MTF_POLICY_VERSION, classification, h4_bias, h1_state, action_context, confidence: Math.max(0, Math.min(100, confidence)), reasons: Object.freeze(reasons) });
  if (h4 === "INSUFFICIENT") { reasons.push("H4 history insufficient"); return mk("TRANSITION", "INSUFFICIENT", "NOT_EVALUABLE", 0); }
  if (h4 === "MIXED") {
    reasons.push("H4 EMA21/50 and structure disagree → no primary bias");
    reasons.push(bounded ? "H1 has bounded S/R (≥ min touches) → range scalping only" : "No clear H1 bounds → choppy");
    return mk("SIDEWAYS", "NO_PRIMARY_DIRECTION", bounded ? "RANGE_ONLY" : "STAND_ASIDE", bounded ? 40 : 20);
  }
  const dir = h4 as "UP" | "DOWN";
  const cls: MtfMarketClass = dir === "UP" ? "BULLISH" : "BEARISH";
  let conf: number = P2.H4_CLEAR;
  reasons.push(`H4 ${cls} (EMA21 vs EMA50 + ${dir === "UP" ? "HH/HL" : "LH/LL"})`);
  const lower = (m15Fast === dir ? P2.M15_WITH_H4 : 0) + (m5Fast === dir ? P2.M5_WITH_H4 : 0);
  if (m15Fast === dir) reasons.push("M15 EMA5>EMA21 searah H4"); if (m5Fast === dir) reasons.push("M5 EMA5/21 searah H4");
  if (ctx === "INSUFFICIENT") { reasons.push("H1 history insufficient"); return mk(cls, "INSUFFICIENT", "NOT_EVALUABLE", conf); }
  if (ctx === "ALIGNED") { reasons.push("H1 trend searah H4"); return mk(cls, "ALIGNED", "FOLLOW_TREND", conf + P2.H1_ALIGNED + lower); }
  if (ctx === "RETURNING_TO_H4") { reasons.push("H1 EMA5 kembali searah H4 + swing terakhir searah"); return mk(cls, "RESUMING", "FOLLOW_TREND", conf + P2.H1_RESUMING + lower); }
  if (ctx === "PULLBACK_AGAINST_H4") { reasons.push("H1 EMA5 melawan H4 → pullback, tunggu konfirmasi M15/M5"); return mk(cls, "PULLBACK", "WAIT_CONFIRMATION", conf + P2.H1_PULLBACK + lower); }
  if (ctx === "REVERSAL_CANDIDATE") {
    const st: MtfH1State = dir === "DOWN" ? "COUNTER_TREND_REBOUND" : "COUNTER_TREND_DECLINE";
    reasons.push(`H1 trend berlawanan H4 → ${st}; bias H4 dipertahankan, tunggu konfirmasi`);
    return mk("TRANSITION", st, "WAIT_CONFIRMATION", conf - 10 + lower);
  }
  reasons.push("H1 campuran"); return mk("TRANSITION", "MIXED", "WAIT_CONFIRMATION", conf + lower);
}
export interface ScalpTf {
  readonly ema5: Indicator; readonly ema21: Indicator; readonly ema50: Indicator;
  readonly atr14: Indicator; readonly rsi14: Indicator; readonly trend: TrendState; readonly structure: StructureEvents;
  readonly momentum: MomentumTf;
  readonly ema_location: EmaZone;
  readonly ema_reaction: readonly EmaReaction[];
}
/** Structured read model only (no slope/gap rules in P0.1). */
export interface ScalpContext {
  readonly M15: ScalpTf;
  readonly M5: ScalpTf;
  readonly local_zones: readonly SrZone[];
  readonly location: Location;
  readonly nearest_support: SrZone | null;
  readonly nearest_resistance: SrZone | null;
  readonly ema_confluence: { readonly timeframe: Timeframe | null; readonly zone: EmaZone };
  readonly patterns: { readonly M5: PatternRead; readonly M15: PatternRead };
  readonly trigger: TriggerDirection;
  readonly momentum_policy_version: typeof SCALP_MOMENTUM_POLICY_VERSION;
  readonly combined_momentum: CombinedMomentum;
  readonly momentum_side: "BUY" | "SELL" | null;
}

export interface OperatorAnalysis {
  readonly policy_version: typeof OPERATOR_POLICY_VERSION;
  readonly architecture_version: typeof ARCHITECTURE_VERSION;
  readonly macro: MacroContext;
  readonly scalp: ScalpContext;
  readonly alignment: MacroAlignment;
  /** v0.5: single direction source (H4 structure+EMA). All downstream layers consume this; none may override. */
  readonly primary_bias: PrimaryBias;
  /** v0.5: counter-trend risk info only. Never enters signal state, plans, or execution. */
  readonly counter_trend_condition: CounterTrendCondition;
  /** v0.5: diagnostic when local M5/M15 momentum opposes primaryBias. Recorded, never changes direction. */
  readonly momentum_conflict: boolean;
  // ---- LEGACY/COMPAT fields below (pre-P0.1 flat read model; still used by UI/tests) ----
  readonly price: number;
  readonly per_tf: Readonly<Record<Timeframe, OperatorTf>>;
  readonly h4_primary: TrendState;
  readonly h1_context: H1Context;
  readonly zones: Readonly<Partial<Record<Timeframe, readonly SrZone[]>>>;
  readonly nearest_support: SrZone | null;
  readonly nearest_resistance: SrZone | null;
  readonly location: Location;
  readonly ema_confluence: { readonly timeframe: Timeframe | null; readonly zone: EmaZone };
  readonly patterns: { readonly M5: PatternRead; readonly M15: PatternRead };
  readonly trigger: TriggerDirection;
  readonly regime: Regime;
  readonly status: OperatorStatus;
  readonly candidate: "BUY" | "SELL" | null;
  readonly checks: { readonly context: boolean; readonly location: boolean; readonly rsi: boolean | null; readonly trigger: boolean };
  /** True when everything except the CLOSED trigger is satisfied (setup ACTIVE). */
  readonly setup_ready: boolean;
  readonly reason: string;
  readonly trigger_bar: { readonly timeframe: Timeframe; readonly open_time: number; readonly available_at: number; readonly patterns: readonly PatternName[] } | null;
}

function combinedTrigger(m5: PatternRead, m15: PatternRead): TriggerDirection {
  const ds = [m5.direction, m15.direction];
  if (ds.every((d) => d === "INSUFFICIENT")) return "INSUFFICIENT";
  const bull = ds.some((d) => d === "BULLISH" || d === "CONFLICT"), bear = ds.some((d) => d === "BEARISH" || d === "CONFLICT");
  return bull && bear ? "CONFLICT" : bull ? "BULLISH" : bear ? "BEARISH" : "NONE";
}

/** `closed` must already be CLOSED bars with available_at ≤ as_of, ascending. */
export function operatorAnalysis(closed: Readonly<Record<Timeframe, readonly TechBar[]>>, price: number): OperatorAnalysis {
  const structures = {} as Record<Timeframe, Structure>;
  const per = {} as Record<Timeframe, OperatorTf>;
  for (const tf of TFS) {
    const bars = closed[tf], s = structureOf(bars);
    const e5 = ema(bars, P.timing_ema), e21 = ema(bars, P.trend_ema_fast), e50 = ema(bars, P.trend_ema_slow), atr = atrWilder(bars, P.atr_period), rsi = rsiWilder(bars);
    structures[tf] = s;
    per[tf] = { timeframe: tf, ema5: e5, ema21: e21, ema50: e50, atr14: atr, rsi14: rsi, trend: trendState(e21, e50, s.summary), fast: fastRel(e5, e21),
      ema_zone: emaZone(price, e21, e50, atr), rsi_support: rsiSupport(rsi), events: structureEvents(s, bars) };
  }
  const h4 = per.H4.trend;
  const ctx = h1Context(h4, per.H1.trend, per.H1.fast, latestLabelled(structures.H1));
  const zones = withConfluence({
    H4: buildZones(structures.H4.swings, "H4", per.H4.atr14, price),
    H1: buildZones(structures.H1.swings, "H1", per.H1.atr14, price),
    M15: buildZones(structures.M15.swings, "M15", per.M15.atr14, price),
  });
  const all = [...(zones.H4 ?? []), ...(zones.H1 ?? []), ...(zones.M15 ?? [])];
  const ns = nearest(all, "SUPPORT"), nr = nearest(all, "RESISTANCE");
  const m15Atr = per.M15.atr14;
  let location: Location = "UNKNOWN";
  if (m15Atr.status === "OK" && m15Atr.value > 0 && all.length) {
    const k = P.zone_proximity_atr_m15 * m15Atr.value;
    const atS = !!ns && ns.distance <= k, atR = !!nr && nr.distance <= k;
    location = atS && atR ? "AMBIGUOUS" : atS ? "AT_SUPPORT" : atR ? "AT_RESISTANCE" : "MID";
  }
  // P0.2: EMA21/50 local dynamic S/R is read on the scalp TFs only (M5 first = most relevant, then M15).
  const emaTf = (["M5", "M15"] as const).find((tf) => emaNear(per[tf].ema_zone)) ?? null;
  const emaConf = { timeframe: emaTf, zone: emaTf ? per[emaTf].ema_zone : per.M5.ema_zone === "INSUFFICIENT" && per.M15.ema_zone === "INSUFFICIENT" ? "INSUFFICIENT" as const : "NOT_NEAR" as const };
  const patterns = { M5: readPatterns(closed.M5, "M5"), M15: readPatterns(closed.M15, "M15") };
  const trigger = combinedTrigger(patterns.M5, patterns.M15);
  const sM5 = scalpTf(per.M5, closed.M5, price), sM15 = scalpTf(per.M15, closed.M15, price);
  const combined = combineMomentum(sM5.momentum.state, sM15.momentum.state);
  const mSide = momentumSide(combined);

  const h1Zones = zones.H1 ?? [];
  const bounded = h1Zones.some((z) => z.role === "SUPPORT" && z.touches >= P.range_min_touches) && h1Zones.some((z) => z.role === "RESISTANCE" && z.touches >= P.range_min_touches);
  const regime: Regime = h4 === "INSUFFICIENT" ? "INSUFFICIENT" : h4 === "UP" || h4 === "DOWN" ? "TREND" : bounded ? "RANGE" : "CHOPPY";

  // v0.5: primaryBias is the ONLY direction source (H4 structure + EMA, CLOSED H4 bars only).
  // M5/M15 momentum is timing/pullback evidence; an opposing local momentum is recorded as a
  // counter-trend warning + LOCAL_MOMENTUM_CONFLICT diagnostic, never a side flip.
  const primaryBias: PrimaryBias = h4 === "UP" ? "BUY" : h4 === "DOWN" ? "SELL" : null;
  const momentumConflict = primaryBias !== null && mSide !== null && mSide !== primaryBias;
  const counterTrend: CounterTrendCondition = !momentumConflict ? "NONE"
    : primaryBias === "SELL" ? "BULLISH_PULLBACK" : "BEARISH_PULLBACK";

  let status: OperatorStatus = "HOLD", candidateSide: "BUY" | "SELL" | null = null;
  let checks: OperatorAnalysis["checks"] = { context: false, location: false, rsi: null, trigger: false };
  let reason: string;
  // Legacy veto (documented P0.x blocker): regime INSUFFICIENT / CHOPPY still ⇒ HOLD. They veto, never pick a side.
  if (regime === "INSUFFICIENT") reason = "H4_TREND_INSUFFICIENT_HISTORY";
  else if (regime === "CHOPPY") reason = "REGIME_CHOPPY_NO_CLEAR_BOUNDS";
  else if (!primaryBias) reason = "NO_PRIMARY_BIAS_H4_MIXED";
  else {
    // v0.5: side = primaryBias (H4). Local momentum never picks or flips the side.
    const side = primaryBias;
    const zoneOk = side === "BUY" ? location === "AT_SUPPORT" : location === "AT_RESISTANCE";
    const trig = trigger === (side === "BUY" ? "BULLISH" : "BEARISH");
    const dirTag = side === "BUY" ? "BULLISH" : "BEARISH";
    if (regime === "TREND") {
      const d = h4 as "UP" | "DOWN";
      const context = ctx === "ALIGNED" || ctx === "RETURNING_TO_H4" || (ctx === "PULLBACK_AGAINST_H4" && per.M15.fast === d);
      const loc = zoneOk || emaTf !== null;
      const rsi = rsiDirectionGate(side, per.H1.rsi14); // retained H1 RSI hard gate until P0.8
      checks = { context, location: loc, rsi: rsi.pass, trigger: trig };
      // mtf-classification-v1: H1 INSUFFICIENT still vetoes. H1 counter-trend (REVERSAL_CANDIDATE) no longer forces HOLD:
      // the side stays searchable (CARI_*) but is never promoted to a candidate → WAIT_CONFIRMATION.
      if (ctx === "INSUFFICIENT") reason = `H1_${ctx}`;
      else if (ctx === "REVERSAL_CANDIDATE") { status = side === "BUY" ? "CARI_BUY" : "CARI_SELL"; reason = "H1_COUNTER_TREND_WAIT_CONFIRMATION"; }
      else {
        status = side === "BUY" ? "CARI_BUY" : "CARI_SELL";
        if (!loc) reason = "NOT_AT_SR_OR_EMA_CONFLUENCE";
        else if (!rsi.pass) reason = rsi.reason;
        else if (!trig) reason = `NO_CLOSED_${dirTag}_TRIGGER`;
        else { candidateSide = side; reason = `SCALP_${side}_${combined}_${zoneOk ? "SR_ZONE" : `EMA_${emaConf.zone}_${emaTf}`}_RSI_TRIGGER`; }
      }
    } else {
      // RANGE (H4 MIXED ⇒ primaryBias NONE): no primary direction ⇒ no side. Range scalping against
      // a macro direction is disabled in v0.5; bounded S/R stays evidence only.
      reason = bounded ? "RANGE_NO_PRIMARY_BIAS_STAND_ASIDE" : "RANGE_MIDDLE";
    }
  }
  const setupReady = status !== "HOLD" && checks.location && checks.rsi !== false && reason !== "H1_COUNTER_TREND_WAIT_CONFIRMATION";
  let triggerBar: OperatorAnalysis["trigger_bar"] = null;
  if (candidateSide) {
    const want = candidateSide === "BUY" ? "BULLISH" : "BEARISH";
    const src = [patterns.M5, patterns.M15].find((p) => p.direction === want)!;
    triggerBar = { timeframe: src.timeframe, open_time: src.bar_open_time!, available_at: src.bar_available_at!, patterns: want === "BULLISH" ? src.bullish : src.bearish };
  }
  const macro: MacroContext = {
    h4_primary: h4, h1_context: ctx, h4_structure: per.H4.events, h1_structure: per.H1.events,
    major_zones: { H4: zones.H4 ?? [], H1: zones.H1 ?? [] }, macro_direction: macroDirectionOf(h4),
    mtf: classifyMtf(h4, ctx, per.M15.fast, per.M5.fast, bounded),
  };
  const scalp: ScalpContext = {
    M15: sM15, M5: sM5, local_zones: zones.M15 ?? [], location, nearest_support: ns, nearest_resistance: nr,
    ema_confluence: emaConf, patterns, trigger,
    momentum_policy_version: SCALP_MOMENTUM_POLICY_VERSION, combined_momentum: combined, momentum_side: mSide,
  };
  // Alignment derived AFTER the local side exists.
  const searchSide = candidateSide ?? (status === "CARI_BUY" ? "BUY" : status === "CARI_SELL" ? "SELL" : mSide);
  return {
    policy_version: OPERATOR_POLICY_VERSION, architecture_version: ARCHITECTURE_VERSION, macro, scalp, alignment: macroAlignment(searchSide, macro.macro_direction),
    price, per_tf: per, h4_primary: h4, h1_context: ctx, zones, nearest_support: ns, nearest_resistance: nr,
    location, ema_confluence: emaConf, patterns, trigger, regime, status, candidate: candidateSide, checks, setup_ready: setupReady, reason, trigger_bar: triggerBar,
  };
}

const scalpTf = (t: OperatorTf, bars: readonly TechBar[], price: number): ScalpTf => ({
  ema5: t.ema5, ema21: t.ema21, ema50: t.ema50, atr14: t.atr14, rsi14: t.rsi14, trend: t.trend, structure: t.events,
  momentum: scalpMomentumTf(bars), ema_location: emaZone(price, t.ema21, t.ema50, t.atr14), ema_reaction: emaReaction(bars),
});

// ---------------- P0.2 scalp momentum (EMA5/21 slope + gap) & EMA21/50 local dynamic S/R ----------------

export const SCALP_MOMENTUM_POLICY_VERSION = "scalp-momentum-v0.4-p0.2-ema-slope-gap";
export const SCALP_MOMENTUM_PARAMS = Object.freeze({
  slope_lookback_bars: 3,
  gap_lookback_bars: 3,
  /** Only sign comparisons; no magnitude thresholds. */
  status: "OPERATOR_DEFINED_NOT_OPTIMIZED_RESEARCH_REQUIRED",
});
export type MomentumState = "BULLISH_EXPANDING" | "BULLISH" | "BEARISH_EXPANDING" | "BEARISH" | "CROSS_UP" | "CROSS_DOWN" | "FLAT_OR_WEAK" | "INSUFFICIENT";
export type CombinedMomentum = "STRONG_BUY" | "BUY" | "STRONG_SELL" | "SELL" | "CONFLICT" | "HOLD";
export interface MomentumTf {
  readonly state: MomentumState;
  /** Cross evidence kept separate so a cross never overrides a stronger directional state. */
  readonly cross: "UP" | "DOWN" | null;
  readonly slope5_norm: number | null;
  readonly slope21_norm: number | null;
  readonly gap_norm: number | null;
  readonly prior_gap_norm: number | null;
  readonly gap_delta: number | null;
}
const NO_MOMENTUM: MomentumTf = { state: "INSUFFICIENT", cross: null, slope5_norm: null, slope21_norm: null, gap_norm: null, prior_gap_norm: null, gap_delta: null };

/** CLOSED bars only. Lookback EMAs are computed on the causal prefix ending N bars ago. */
export function scalpMomentumTf(bars: readonly TechBar[]): MomentumTf {
  const n = SCALP_MOMENTUM_PARAMS.slope_lookback_bars, g = SCALP_MOMENTUM_PARAMS.gap_lookback_bars;
  const e5 = ema(bars, P.timing_ema), e21 = ema(bars, P.trend_ema_fast), atr = atrWilder(bars, P.atr_period);
  const s5 = ema(bars.slice(0, bars.length - n), P.timing_ema), s21 = ema(bars.slice(0, bars.length - n), P.trend_ema_fast);
  const g5 = ema(bars.slice(0, bars.length - g), P.timing_ema), g21 = ema(bars.slice(0, bars.length - g), P.trend_ema_fast);
  if (bars.length <= Math.max(n, g) || [e5, e21, atr, s5, s21, g5, g21].some((x) => x.status !== "OK")) return NO_MOMENTUM;
  const v = (x: Indicator) => (x as { value: number }).value;
  const a = v(atr);
  if (!(a > 0)) return NO_MOMENTUM;
  const slope5 = (v(e5) - v(s5)) / a, slope21 = (v(e21) - v(s21)) / a;
  const gap = Math.abs(v(e5) - v(e21)) / a, prior = Math.abs(v(g5) - v(g21)) / a, delta = gap - prior;
  const above = v(e5) > v(e21), below = v(e5) < v(e21);
  const cross = v(s5) <= v(s21) && above ? "UP" : v(s5) >= v(s21) && below ? "DOWN" : null;
  let state: MomentumState;
  if (above && slope5 > 0 && slope21 >= 0 && delta > 0) state = "BULLISH_EXPANDING";
  else if (above && slope5 > 0) state = "BULLISH";
  else if (below && slope5 < 0 && slope21 <= 0 && delta > 0) state = "BEARISH_EXPANDING";
  else if (below && slope5 < 0) state = "BEARISH";
  else if (cross === "UP") state = "CROSS_UP";
  else if (cross === "DOWN") state = "CROSS_DOWN";
  else state = "FLAT_OR_WEAK";
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return { state, cross, slope5_norm: r(slope5), slope21_norm: r(slope21), gap_norm: r(gap), prior_gap_norm: r(prior), gap_delta: r(delta) };
}

const bullFam = (s: MomentumState) => s === "BULLISH" || s === "BULLISH_EXPANDING" || s === "CROSS_UP";
const bearFam = (s: MomentumState) => s === "BEARISH" || s === "BEARISH_EXPANDING" || s === "CROSS_DOWN";
/** M5 = fast driver, M15 confirms or conflicts. H4/H1 never participate. */
export function combineMomentum(m5: MomentumState, m15: MomentumState): CombinedMomentum {
  if ((bullFam(m5) && bearFam(m15)) || (bearFam(m5) && bullFam(m15))) return "CONFLICT";
  if (bullFam(m5)) return bullFam(m15) ? "STRONG_BUY" : "BUY";
  if (bearFam(m5)) return bearFam(m15) ? "STRONG_SELL" : "SELL";
  return "HOLD";
}
export const momentumSide = (c: CombinedMomentum): "BUY" | "SELL" | null => c === "STRONG_BUY" || c === "BUY" ? "BUY" : c === "STRONG_SELL" || c === "SELL" ? "SELL" : null;

export type EmaReactionKind = "REJECTED_UP" | "REJECTED_DOWN" | "BROKE_ABOVE" | "BROKE_BELOW" | "TOUCHED";
export interface EmaReaction { readonly ema: 21 | 50; readonly kind: EmaReactionKind }
/** Latest CLOSED bar vs EMA21/EMA50 at that bar (EMA including it); prior side from the previous CLOSED bar and its EMA. */
export function emaReaction(bars: readonly TechBar[]): readonly EmaReaction[] {
  if (bars.length < 2) return [];
  const last = bars[bars.length - 1]!, prev = bars[bars.length - 2]!, out: EmaReaction[] = [];
  for (const n of [21, 50] as const) {
    const now = ema(bars, n), before = ema(bars.slice(0, -1), n);
    if (now.status !== "OK") continue;
    const e = now.value, touched = last.low <= e && last.high >= e;
    const prevSide = before.status === "OK" ? Math.sign(prev.close - before.value) : 0;
    let kind: EmaReactionKind | null = null;
    if (prevSide < 0 && last.close > e) kind = "BROKE_ABOVE";
    else if (prevSide > 0 && last.close < e) kind = "BROKE_BELOW";
    else if (touched && last.close > e && last.close > last.open) kind = "REJECTED_UP";
    else if (touched && last.close < e && last.close < last.open) kind = "REJECTED_DOWN";
    else if (touched) kind = "TOUCHED";
    if (kind) out.push({ ema: n, kind });
  }
  return out;
}
const emaNear = (z: EmaZone) => z === "BAND" || z === "NEAR_EMA21" || z === "NEAR_EMA50";

export function macroDirectionOf(h4: TrendState): MacroDirection {
  return h4 === "UP" ? "BULLISH" : h4 === "DOWN" ? "BEARISH" : h4 === "MIXED" ? "NEUTRAL_OR_MIXED" : "INSUFFICIENT";
}

/** Candidate/search side vs macro direction. Classification only — never a gate in P0.1. */
export function macroAlignment(side: "BUY" | "SELL" | null, macro: MacroDirection): MacroAlignment {
  if (!side || macro === "INSUFFICIENT") return "NOT_APPLICABLE";
  if (macro === "NEUTRAL_OR_MIXED") return "NEUTRAL_MACRO";
  return (side === "BUY") === (macro === "BULLISH") ? "WITH_MACRO" : "COUNTER_MACRO";
}
