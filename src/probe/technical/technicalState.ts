// TECHNICAL VALIDATION PROBE v1c — BASE TECHNICAL STATE. DIAGNOSTIC_PROBE, authority NONE. NOT STAGE 4.
// Reads ONLY MarketRuntimeReader canonical CLOSED candles. Produces technical STATE, never a signal.
// There is intentionally no BUY/SELL/entry/stop/target/size field anywhere in this module.
import type { Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { MissingInterval } from "@/core/candles/MissingInterval";
import { atr, ema } from "./indicators";
import { fromInternalBars, gapBefore, missingIntervalsOf, prepareSeries } from "./inputs";
import { causalSwings, type CausalSwing } from "./swing";
import { ATR_ALGORITHM_VERSION, EMA_ALGORITHM_VERSION, SWING_ALGORITHM_VERSION, type ProbeBar, type SeriesPoint } from "./types";

export const TECHNICAL_STATE_VERSION = "TVP-v1c";
export const V1C_TIMEFRAMES = Object.freeze(["M5", "M15", "H1", "H4"] as const satisfies readonly Timeframe[]);
/**
 * v1c research policy (declared, not a market fact): a timeframe is eligible for HTF alignment only if no
 * missing interval lies inside the EMA21 input window (last 21 CLOSED bars). EMA itself never resets on gaps.
 */
export const ALIGNMENT_CONTINUITY_POLICY = "NO_MISSING_INTERVAL_INSIDE_EMA21_WINDOW" as const;
export const STRUCTURE_POLICY = "LAST_TWO_CONFIRMED_CAUSAL_HIGHS_AND_LOWS" as const;

export type EmaRelation = "BULLISH" | "BEARISH" | "NEUTRAL" | "INSUFFICIENT_DATA";
export type HighProgression = "HH" | "LH" | "EQUAL_HIGH" | null;
export type LowProgression = "HL" | "LL" | "EQUAL_LOW" | null;
export type StructureStatus = "BULLISH_STRUCTURE" | "BEARISH_STRUCTURE" | "MIXED_STRUCTURE" | "INSUFFICIENT_STRUCTURE";
export type TrendStructureRelation = "ALIGNED" | "CONFLICT" | "UNKNOWN";
export type HtfAlignment = "BULLISH_ALIGNED" | "BEARISH_ALIGNED" | "MIXED" | "INSUFFICIENT_DATA";
export type IneligibilityReason = "NO_CLOSED_BARS" | "EMA_WARMUP_UNSATISFIED" | "MISSING_INTERVAL_INSIDE_EMA21_WINDOW";

export interface SwingFact {
  readonly type: "SWING_HIGH" | "SWING_LOW";
  readonly event_at: number;
  readonly price: number;
  readonly available_at: number;
  readonly outside_bar: boolean;
  readonly window_spans_missing_interval: boolean;
}

export interface TimeframeTechnicalState {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly state_version: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly as_of: number;
  readonly latest_closed_bar: { readonly open_time: number; readonly close_time: number; readonly closed_at: number; readonly available_at: number; readonly close: number } | null;
  readonly history_status: { readonly status: "NO_CLOSED_BARS" | "AVAILABLE"; readonly closed_bars_used: number; readonly forming_excluded: boolean; readonly future_bars_excluded: number };
  readonly ema5: number | null;
  readonly ema21: number | null;
  readonly ema_relation: EmaRelation;
  readonly atr14: number | null;
  readonly atr_status: "VALID" | "WARMUP_UNSATISFIED";
  readonly latest_causal_swing_high: SwingFact | null;
  readonly latest_causal_swing_low: SwingFact | null;
  readonly high_progression: HighProgression;
  readonly low_progression: LowProgression;
  readonly structure: StructureStatus;
  readonly structure_uses_swing_across_missing_interval: boolean;
  readonly trend_structure_relation: TrendStructureRelation;
  readonly missing_interval_status: { readonly count: number; readonly inside_ema21_window: boolean; readonly intervals: readonly { readonly open_time: number; readonly close_time: number; readonly reason: string }[] };
  readonly warmup: { readonly ema5: "VALID" | "WARMUP_UNSATISFIED"; readonly ema21: "VALID" | "WARMUP_UNSATISFIED"; readonly atr14: "VALID" | "WARMUP_UNSATISFIED"; readonly causal_swing: "VALID" | "WARMUP_UNSATISFIED" };
  readonly temporal_eligibility: { readonly eligible_for_alignment: boolean; readonly reasons: readonly IneligibilityReason[]; readonly continuity_policy: typeof ALIGNMENT_CONTINUITY_POLICY };
  readonly provenance: {
    readonly source_mode: "APPLICATION_RUNTIME";
    readonly input: "MarketRuntimeReader.closedBars (CLOSED only, available_at <= as_of)";
    readonly first_open_time: number | null;
    readonly last_open_time: number | null;
    readonly last_available_at: number | null;
    readonly input_digest: string;
    readonly algorithm_versions: { readonly ema: string; readonly atr: string; readonly swing: string; readonly structure: string };
    readonly retrospective_lookahead_excluded: true;
  };
}

export interface HtfAlignmentState {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly as_of: number;
  readonly h4_relation: EmaRelation;
  readonly h1_relation: EmaRelation;
  readonly alignment: HtfAlignment;
  readonly insufficient_reasons: readonly string[];
}

export interface TechnicalStateReport {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly state_version: string;
  readonly symbol: string;
  readonly as_of: number;
  readonly timeframes: Readonly<Record<Timeframe, TimeframeTechnicalState>>;
  readonly htf: HtfAlignmentState;
  readonly temporal_warnings: readonly string[];
}

/** FNV-1a over the exact CLOSED input bars (deterministic provenance digest, not a security hash). */
function digest(bars: readonly ProbeBar[]): string {
  let h = 0x811c9dc5;
  const s = JSON.stringify(bars.map((b) => [b.open_time, b.closed_at, b.available_at, b.open, b.high, b.low, b.close]));
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

const last = (p: readonly SeriesPoint[]) => p[p.length - 1] ?? null;
const fact = (s: CausalSwing): SwingFact => Object.freeze({ type: s.type, event_at: s.event_at, price: s.price, available_at: s.available_at, outside_bar: s.outside_bar, window_spans_missing_interval: s.window_spans_missing_interval });

export function emaRelation(e5: number | null, e21: number | null): EmaRelation {
  if (e5 === null || e21 === null) return "INSUFFICIENT_DATA";
  return e5 > e21 ? "BULLISH" : e5 < e21 ? "BEARISH" : "NEUTRAL";
}

export function classifyStructure(hp: HighProgression, lp: LowProgression): StructureStatus {
  if (hp === null || lp === null) return "INSUFFICIENT_STRUCTURE";
  if (hp === "HH" && lp === "HL") return "BULLISH_STRUCTURE";
  if (hp === "LH" && lp === "LL") return "BEARISH_STRUCTURE";
  return "MIXED_STRUCTURE";
}

/** No vote counting: only a directional EMA relation AND a directional structure can be ALIGNED; anything else is explicit. */
export function trendStructureRelation(rel: EmaRelation, st: StructureStatus): TrendStructureRelation {
  if ((rel !== "BULLISH" && rel !== "BEARISH") || st === "INSUFFICIENT_STRUCTURE") return "UNKNOWN";
  if ((rel === "BULLISH" && st === "BULLISH_STRUCTURE") || (rel === "BEARISH" && st === "BEARISH_STRUCTURE")) return "ALIGNED";
  return "CONFLICT";
}

/** Technical state for one timeframe at system time asOf, from canonical CLOSED candles only. */
export function timeframeState(reader: MarketRuntimeReader, tf: Timeframe, asOf: number): TimeframeTechnicalState {
  const all = fromInternalBars(reader.closedBars(tf));
  const eligibleBars = all.filter((b) => b.available_at !== null && b.closed_at !== null && b.available_at <= asOf && b.closed_at <= asOf);
  const s = prepareSeries(eligibleBars, reader.symbol, tf);
  const bars = s.bars;
  const e5 = last(ema(bars, 5, tf)), e21 = last(ema(bars, 21, tf)), a14 = last(atr(bars, 14, tf));
  const ema5 = e5?.value ?? null, ema21 = e21?.value ?? null, atr14 = a14?.value ?? null;
  const rel = emaRelation(ema5, ema21);

  const cs = causalSwings(bars, tf, 2, 2, asOf);
  const highs = cs.swings.filter((x) => x.type === "SWING_HIGH");
  const lows = cs.swings.filter((x) => x.type === "SWING_LOW");
  const [h1, h0] = [highs[highs.length - 2], highs[highs.length - 1]];
  const [l1, l0] = [lows[lows.length - 2], lows[lows.length - 1]];
  const hp: HighProgression = h1 && h0 ? (h0.price > h1.price ? "HH" : h0.price < h1.price ? "LH" : "EQUAL_HIGH") : null;
  const lp: LowProgression = l1 && l0 ? (l0.price > l1.price ? "HL" : l0.price < l1.price ? "LL" : "EQUAL_LOW") : null;
  const structure = classifyStructure(hp, lp);

  const missing: readonly MissingInterval[] = missingIntervalsOf(s, reader.symbol, tf, asOf);
  const g = gapBefore(bars, tf);
  const windowStart = Math.max(1, bars.length - 21 + 1);
  let insideWindow = false;
  for (let i = windowStart; i < bars.length; i++) if (g[i]) insideWindow = true;

  const reasons: IneligibilityReason[] = [];
  if (bars.length === 0) reasons.push("NO_CLOSED_BARS");
  if (ema5 === null || ema21 === null) reasons.push("EMA_WARMUP_UNSATISFIED");
  if (insideWindow) reasons.push("MISSING_INTERVAL_INSIDE_EMA21_WINDOW");
  const lb = bars[bars.length - 1];
  const forming = reader.formingBar(tf);

  return Object.freeze<TimeframeTechnicalState>({
    kind: "DIAGNOSTIC_PROBE", authority: "NONE", state_version: TECHNICAL_STATE_VERSION, symbol: reader.symbol, timeframe: tf, as_of: asOf,
    latest_closed_bar: lb ? Object.freeze({ open_time: lb.open_time, close_time: lb.close_time, closed_at: lb.closed_at!, available_at: lb.available_at!, close: lb.close }) : null,
    history_status: Object.freeze({ status: bars.length ? "AVAILABLE" : "NO_CLOSED_BARS", closed_bars_used: bars.length,
      forming_excluded: forming !== null, future_bars_excluded: all.length - eligibleBars.length }),
    ema5, ema21, ema_relation: rel,
    atr14, atr_status: atr14 === null ? "WARMUP_UNSATISFIED" : "VALID",
    latest_causal_swing_high: h0 ? fact(h0) : null,
    latest_causal_swing_low: l0 ? fact(l0) : null,
    high_progression: hp, low_progression: lp, structure,
    structure_uses_swing_across_missing_interval: [h1, h0, l1, l0].some((x) => x?.window_spans_missing_interval === true),
    trend_structure_relation: trendStructureRelation(rel, structure),
    missing_interval_status: Object.freeze({ count: missing.length, inside_ema21_window: insideWindow,
      intervals: Object.freeze(missing.map((m) => Object.freeze({ open_time: m.open_time, close_time: m.close_time, reason: m.reason }))) }),
    warmup: Object.freeze({ ema5: ema5 === null ? "WARMUP_UNSATISFIED" : "VALID", ema21: ema21 === null ? "WARMUP_UNSATISFIED" : "VALID",
      atr14: atr14 === null ? "WARMUP_UNSATISFIED" : "VALID", causal_swing: cs.status }),
    temporal_eligibility: Object.freeze({ eligible_for_alignment: reasons.length === 0, reasons: Object.freeze(reasons), continuity_policy: ALIGNMENT_CONTINUITY_POLICY }),
    provenance: Object.freeze({
      source_mode: "APPLICATION_RUNTIME", input: "MarketRuntimeReader.closedBars (CLOSED only, available_at <= as_of)",
      first_open_time: bars[0]?.open_time ?? null, last_open_time: lb?.open_time ?? null, last_available_at: lb?.available_at ?? null,
      input_digest: digest(bars),
      algorithm_versions: Object.freeze({ ema: EMA_ALGORITHM_VERSION, atr: ATR_ALGORITHM_VERSION, swing: SWING_ALGORITHM_VERSION, structure: STRUCTURE_POLICY }),
      retrospective_lookahead_excluded: true,
    }),
  });
}

/** Uncertainty is never converted into MIXED: any ineligible required timeframe yields INSUFFICIENT_DATA. */
export function htfAlignment(h4: TimeframeTechnicalState, h1: TimeframeTechnicalState, asOf: number): HtfAlignmentState {
  const reasons: string[] = [];
  for (const s of [h4, h1]) for (const r of s.temporal_eligibility.reasons) reasons.push(`${s.timeframe}:${r}`);
  let alignment: HtfAlignment;
  if (reasons.length) alignment = "INSUFFICIENT_DATA";
  else if (h4.ema_relation === "BULLISH" && h1.ema_relation === "BULLISH") alignment = "BULLISH_ALIGNED";
  else if (h4.ema_relation === "BEARISH" && h1.ema_relation === "BEARISH") alignment = "BEARISH_ALIGNED";
  else alignment = "MIXED"; // directional disagreement, or an eligible NEUTRAL relation (not uncertainty)
  return Object.freeze({ kind: "DIAGNOSTIC_PROBE", authority: "NONE", as_of: asOf, h4_relation: h4.ema_relation, h1_relation: h1.ema_relation, alignment, insufficient_reasons: Object.freeze(reasons) });
}

export function technicalStateReport(reader: MarketRuntimeReader, asOf: number = reader.now()): TechnicalStateReport {
  const tfs = {} as Record<Timeframe, TimeframeTechnicalState>;
  for (const tf of V1C_TIMEFRAMES) tfs[tf] = timeframeState(reader, tf, asOf);
  const warnings: string[] = [];
  for (const tf of V1C_TIMEFRAMES) {
    const s = tfs[tf];
    if (s.history_status.forming_excluded) warnings.push(`${tf}: FORMING bar excluded (CLOSED_BAR policy)`);
    if (s.history_status.future_bars_excluded) warnings.push(`${tf}: ${s.history_status.future_bars_excluded} CLOSED bar(s) available after as_of excluded`);
    if (s.missing_interval_status.count) warnings.push(`${tf}: ${s.missing_interval_status.count} missing interval(s), no candle fabricated`);
    if (s.structure_uses_swing_across_missing_interval) warnings.push(`${tf}: structure uses a swing whose window spans a missing interval`);
  }
  return Object.freeze({ kind: "DIAGNOSTIC_PROBE", authority: "NONE", state_version: TECHNICAL_STATE_VERSION, symbol: reader.symbol, as_of: asOf,
    timeframes: Object.freeze(tfs), htf: htfAlignment(tfs.H4, tfs.H1, asOf), temporal_warnings: Object.freeze(warnings) });
}

/** Compact deterministic text report (no signal field exists to print). */
export function formatReport(r: TechnicalStateReport): string {
  const line = (tf: Timeframe) => {
    const s = r.timeframes[tf];
    return `${tf}: ema=${s.ema_relation} structure=${s.structure}(${s.high_progression ?? "-"}/${s.low_progression ?? "-"}) atr=${s.atr14 === null ? "WARMUP" : s.atr14.toFixed(4)} eligible=${s.temporal_eligibility.eligible_for_alignment}${s.temporal_eligibility.reasons.length ? `[${s.temporal_eligibility.reasons.join(",")}]` : ""} trend/structure=${s.trend_structure_relation}`;
  };
  return [line("H4"), line("H1"), `HTF=${r.htf.alignment}`, line("M15"), line("M5"), `warnings=${r.temporal_warnings.length}`].join("\n");
}
