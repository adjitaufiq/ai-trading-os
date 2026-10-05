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

export const OPERATOR_POLICY_VERSION = "operator-v2-mtf-sr-ema-rsi-candle";
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
  trend_setup: "Direction d = H4. Context ALIGNED or RETURNING_TO_H4, or PULLBACK_AGAINST_H4 with M15 EMA5 vs EMA21 already back with d; location = S/R zone in d's entry side (support for BUY, resistance for SELL) OR EMA21/50 confluence (H1 or M15); H1 RSI14 gate passes; CLOSED M5/M15 trigger in d with no opposing trigger",
  range_setup: "AT_SUPPORT + bullish CLOSED trigger ⇒ BUY; AT_RESISTANCE + bearish ⇒ SELL; MID/AMBIGUOUS ⇒ HOLD. RSI gate not applied in range (RESEARCH_REQUIRED)",
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

export interface OperatorAnalysis {
  readonly policy_version: typeof OPERATOR_POLICY_VERSION;
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
  const emaTf = (["H1", "M15"] as const).find((tf) => per[tf].ema_zone === "BAND" || per[tf].ema_zone === "NEAR_EMA21" || per[tf].ema_zone === "NEAR_EMA50") ?? null;
  const emaConf = { timeframe: emaTf, zone: emaTf ? per[emaTf].ema_zone : per.H1.ema_zone === "INSUFFICIENT" && per.M15.ema_zone === "INSUFFICIENT" ? "INSUFFICIENT" as const : "NOT_NEAR" as const };
  const patterns = { M5: readPatterns(closed.M5, "M5"), M15: readPatterns(closed.M15, "M15") };
  const trigger = combinedTrigger(patterns.M5, patterns.M15);

  const h1Zones = zones.H1 ?? [];
  const bounded = h1Zones.some((z) => z.role === "SUPPORT" && z.touches >= P.range_min_touches) && h1Zones.some((z) => z.role === "RESISTANCE" && z.touches >= P.range_min_touches);
  const regime: Regime = h4 === "INSUFFICIENT" ? "INSUFFICIENT" : h4 === "UP" || h4 === "DOWN" ? "TREND" : bounded ? "RANGE" : "CHOPPY";

  let status: OperatorStatus = "HOLD", candidateSide: "BUY" | "SELL" | null = null;
  let checks: OperatorAnalysis["checks"] = { context: false, location: false, rsi: null, trigger: false };
  let reason: string;
  if (regime === "INSUFFICIENT") reason = "H4_TREND_INSUFFICIENT_HISTORY";
  else if (regime === "CHOPPY") reason = "REGIME_CHOPPY_NO_CLEAR_BOUNDS";
  else if (regime === "TREND") {
    const side = h4 === "UP" ? "BUY" : "SELL";
    const d = h4 as "UP" | "DOWN";
    const context = ctx === "ALIGNED" || ctx === "RETURNING_TO_H4" || (ctx === "PULLBACK_AGAINST_H4" && per.M15.fast === d);
    const zoneOk = side === "BUY" ? location === "AT_SUPPORT" : location === "AT_RESISTANCE";
    const loc = zoneOk || emaTf !== null;
    const rsi = rsiDirectionGate(side, per.H1.rsi14);
    const trig = trigger === (side === "BUY" ? "BULLISH" : "BEARISH");
    checks = { context, location: loc, rsi: rsi.pass, trigger: trig };
    if (ctx === "REVERSAL_CANDIDATE" || ctx === "INSUFFICIENT") reason = `H1_${ctx}`;
    else {
      status = side === "BUY" ? "CARI_BUY" : "CARI_SELL";
      if (!context) reason = `H1_${ctx}_NOT_RETURNING`;
      else if (!loc) reason = "NOT_AT_SR_OR_EMA_CONFLUENCE";
      else if (!rsi.pass) reason = rsi.reason;
      else if (!trig) reason = `NO_CLOSED_${side === "BUY" ? "BULLISH" : "BEARISH"}_TRIGGER`;
      else { candidateSide = side; reason = `TREND_${side}_H4_${h4}_H1_${ctx}_${zoneOk ? "SR_ZONE" : `EMA_${emaConf.zone}`}_RSI_TRIGGER`; }
    }
  } else {
    // RANGE
    const side = location === "AT_SUPPORT" ? "BUY" : location === "AT_RESISTANCE" ? "SELL" : null;
    if (!side) reason = location === "AMBIGUOUS" ? "RANGE_LOCATION_AMBIGUOUS" : "RANGE_MIDDLE";
    else {
      status = side === "BUY" ? "CARI_BUY" : "CARI_SELL";
      const trig = trigger === (side === "BUY" ? "BULLISH" : "BEARISH");
      checks = { context: true, location: true, rsi: null, trigger: trig };
      if (trig) { candidateSide = side; reason = `RANGE_${side}_${side === "BUY" ? "SUPPORT" : "RESISTANCE"}_TRIGGER`; }
      else reason = `NO_CLOSED_${side === "BUY" ? "BULLISH" : "BEARISH"}_TRIGGER`;
    }
  }
  const setupReady = status !== "HOLD" && checks.context && checks.location && checks.rsi !== false;
  let triggerBar: OperatorAnalysis["trigger_bar"] = null;
  if (candidateSide) {
    const want = candidateSide === "BUY" ? "BULLISH" : "BEARISH";
    const src = [patterns.M5, patterns.M15].find((p) => p.direction === want)!;
    triggerBar = { timeframe: src.timeframe, open_time: src.bar_open_time!, available_at: src.bar_available_at!, patterns: want === "BULLISH" ? src.bullish : src.bearish };
  }
  return {
    policy_version: OPERATOR_POLICY_VERSION, price, per_tf: per, h4_primary: h4, h1_context: ctx, zones, nearest_support: ns, nearest_resistance: nr,
    location, ema_confluence: emaConf, patterns, trigger, regime, status, candidate: candidateSide, checks, setup_ready: setupReady, reason, trigger_bar: triggerBar,
  };
}
