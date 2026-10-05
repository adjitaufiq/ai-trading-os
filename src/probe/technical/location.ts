// TECHNICAL VALIDATION PROBE v1d — CAUSAL STRUCTURE & LOCATION. DIAGNOSTIC_PROBE, authority NONE. NOT STAGE 4.
// Location policy: CLOSED_LOCATION only. No LIVE/forming/tick location stream exists in v1d (no approved policy permits it).
// Levels come ONLY from causal confirmed swings (retrospective swings never become provenance). No BOS/CHoCH: no approved
// causal contract exists. Exact price comparison: no tolerance (tick-size equality is not validated for this use).
import type { Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import { fromInternalBars, prepareSeries } from "./inputs";
import { causalSwings, type CausalSwing } from "./swing";
import { SWING_ALGORITHM_VERSION } from "./types";
import { technicalStateReport, V1C_TIMEFRAMES, type TechnicalStateReport } from "./technicalState";

export const LOCATION_VERSION = "TVP-v1d";
export const LOCATION_POLICY = "CLOSED_LOCATION_ONLY" as const;
export const EQUALITY_POLICY = "EXACT_PRICE_COMPARISON_NO_TOLERANCE" as const;

export type LocationClass =
  | "ABOVE_CONFIRMED_SWING_HIGH" | "BELOW_CONFIRMED_SWING_LOW" | "INSIDE_CONFIRMED_SWING_RANGE"
  | "AT_UPPER_BOUNDARY" | "AT_LOWER_BOUNDARY" | "INSUFFICIENT_LOCATION_DATA";
export type Progression = "HH" | "LH" | "EQUAL_HIGH" | "HL" | "LL" | "EQUAL_LOW" | null;

export interface ConfirmedLevel {
  readonly type: "SWING_HIGH" | "SWING_LOW";
  readonly timeframe: Timeframe;
  /** Pivot candle open_time. NEVER equal to availability. */
  readonly pivot_time: number;
  readonly pivot_price: number;
  readonly confirmation_open_time: number;
  readonly confirmed_at: number;
  /** Inherited from the actual confirming CLOSED candle. */
  readonly available_at: number;
  readonly outside_bar: boolean;
  readonly window_spans_missing_interval: boolean;
  readonly algorithm_version: string;
}

export interface LocationState {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly version: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly as_of: number;
  readonly location_policy: typeof LOCATION_POLICY;
  readonly equality_policy: typeof EQUALITY_POLICY;
  readonly current_closed_price: number | null;
  readonly current_closed_bar_open_time: number | null;
  readonly latest_high: ConfirmedLevel | null;
  readonly previous_high: ConfirmedLevel | null;
  readonly latest_low: ConfirmedLevel | null;
  readonly previous_low: ConfirmedLevel | null;
  readonly high_progression: Progression;
  readonly low_progression: Progression;
  /** Set when a level in the progression comes from an outside bar that is both swing high and swing low. Reported, not resolved. */
  readonly progression_ambiguity: "OUTSIDE_BAR_DUAL_SWING" | null;
  readonly range: {
    readonly status: "USABLE" | "UNAVAILABLE";
    readonly reason: "NO_HIGH" | "NO_LOW" | "HIGH_NOT_ABOVE_LOW" | "NOT_YET_AVAILABLE" | null;
    readonly high_available_at: number | null;
    readonly low_available_at: number | null;
    readonly available_at: number | null;
    readonly outside_bar_dual_swing: boolean;
    readonly spans_missing_interval: boolean;
  };
  /** (price − L)/(H − L). Geometry only; no thresholds or overbought/oversold meaning. */
  readonly range_position: number | null;
  readonly location: LocationClass;
  readonly provenance: {
    readonly input: "MarketRuntimeReader.closedBars (CLOSED only, available_at <= as_of)";
    readonly source_candle_open_times: { readonly first: number | null; readonly last: number | null; readonly count: number };
    readonly swing_algorithm: string;
    readonly lookahead: "EXCLUDED_CAUSAL_ONLY";
    readonly missing_interval_in_input: boolean;
  };
}

const level = (s: CausalSwing, tf: Timeframe): ConfirmedLevel => Object.freeze({
  type: s.type, timeframe: tf, pivot_time: s.event_at, pivot_price: s.price, confirmation_open_time: s.confirmation_open_time,
  confirmed_at: s.confirmation_closed_at, available_at: s.available_at, outside_bar: s.outside_bar,
  window_spans_missing_interval: s.window_spans_missing_interval, algorithm_version: s.algorithm_version,
});

export function progression(kind: "HIGH" | "LOW", prev: ConfirmedLevel | null, cur: ConfirmedLevel | null): Progression {
  if (!prev || !cur) return null;
  if (cur.pivot_price === prev.pivot_price) return kind === "HIGH" ? "EQUAL_HIGH" : "EQUAL_LOW";
  if (kind === "HIGH") return cur.pivot_price > prev.pivot_price ? "HH" : "LH";
  return cur.pivot_price > prev.pivot_price ? "HL" : "LL";
}

/** Range pairing: the latest high and latest low KNOWN at T; usable only if range.available_at <= T and H > L. */
export function pairRange(high: ConfirmedLevel | null, low: ConfirmedLevel | null, asOf: number): LocationState["range"] {
  const base = { high_available_at: high?.available_at ?? null, low_available_at: low?.available_at ?? null,
    outside_bar_dual_swing: !!high && !!low && high.pivot_time === low.pivot_time && high.outside_bar && low.outside_bar,
    spans_missing_interval: !!(high?.window_spans_missing_interval || low?.window_spans_missing_interval) };
  if (!high) return Object.freeze({ status: "UNAVAILABLE", reason: "NO_HIGH", available_at: null, ...base });
  if (!low) return Object.freeze({ status: "UNAVAILABLE", reason: "NO_LOW", available_at: null, ...base });
  const available_at = Math.max(high.available_at, low.available_at);
  if (available_at > asOf) return Object.freeze({ status: "UNAVAILABLE", reason: "NOT_YET_AVAILABLE", available_at, ...base });
  if (!(high.pivot_price > low.pivot_price)) return Object.freeze({ status: "UNAVAILABLE", reason: "HIGH_NOT_ABOVE_LOW", available_at, ...base });
  return Object.freeze({ status: "USABLE", reason: null, available_at, ...base });
}

export function classifyLocation(price: number | null, high: ConfirmedLevel | null, low: ConfirmedLevel | null, range: LocationState["range"]): LocationClass {
  if (price === null || !high || !low || range.status !== "USABLE") return "INSUFFICIENT_LOCATION_DATA";
  if (price > high.pivot_price) return "ABOVE_CONFIRMED_SWING_HIGH";
  if (price === high.pivot_price) return "AT_UPPER_BOUNDARY";
  if (price < low.pivot_price) return "BELOW_CONFIRMED_SWING_LOW";
  if (price === low.pivot_price) return "AT_LOWER_BOUNDARY";
  return "INSIDE_CONFIRMED_SWING_RANGE";
}

export function locationState(reader: MarketRuntimeReader, tf: Timeframe, asOf: number): LocationState {
  const eligible = fromInternalBars(reader.closedBars(tf)).filter((b) => b.available_at !== null && b.closed_at !== null && b.available_at <= asOf && b.closed_at <= asOf);
  const s = prepareSeries(eligible, reader.symbol, tf);
  const bars = s.bars;
  const swings = causalSwings(bars, tf, 2, 2, asOf).swings;
  const highs = swings.filter((x) => x.type === "SWING_HIGH").map((x) => level(x, tf));
  const lows = swings.filter((x) => x.type === "SWING_LOW").map((x) => level(x, tf));
  const latest_high = highs[highs.length - 1] ?? null, previous_high = highs[highs.length - 2] ?? null;
  const latest_low = lows[lows.length - 1] ?? null, previous_low = lows[lows.length - 2] ?? null;
  const last = bars[bars.length - 1];
  const price = last?.close ?? null;
  const range = pairRange(latest_high, latest_low, asOf);
  const ambiguous = [latest_high, previous_high, latest_low, previous_low].some((l) => l?.outside_bar === true);
  return Object.freeze<LocationState>({
    kind: "DIAGNOSTIC_PROBE", authority: "NONE", version: LOCATION_VERSION, symbol: reader.symbol, timeframe: tf, as_of: asOf,
    location_policy: LOCATION_POLICY, equality_policy: EQUALITY_POLICY,
    current_closed_price: price, current_closed_bar_open_time: last?.open_time ?? null,
    latest_high, previous_high, latest_low, previous_low,
    high_progression: progression("HIGH", previous_high, latest_high),
    low_progression: progression("LOW", previous_low, latest_low),
    progression_ambiguity: ambiguous ? "OUTSIDE_BAR_DUAL_SWING" : null,
    range,
    range_position: range.status === "USABLE" && price !== null ? (price - latest_low!.pivot_price) / (latest_high!.pivot_price - latest_low!.pivot_price) : null,
    location: classifyLocation(price, latest_high, latest_low, range),
    provenance: Object.freeze({
      input: "MarketRuntimeReader.closedBars (CLOSED only, available_at <= as_of)",
      source_candle_open_times: Object.freeze({ first: bars[0]?.open_time ?? null, last: last?.open_time ?? null, count: bars.length }),
      swing_algorithm: SWING_ALGORITHM_VERSION, lookahead: "EXCLUDED_CAUSAL_ONLY", missing_interval_in_input: s.gaps.length > 0,
    }),
  });
}

export interface StructureLocationReport {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly as_of: number;
  /** v1c state reused unchanged (trend, structure, ATR, eligibility, HTF alignment). */
  readonly technical: TechnicalStateReport;
  readonly location: Readonly<Record<Timeframe, LocationState>>;
}

export function structureLocationReport(reader: MarketRuntimeReader, asOf: number = reader.now()): StructureLocationReport {
  const loc = {} as Record<Timeframe, LocationState>;
  for (const tf of V1C_TIMEFRAMES) loc[tf] = locationState(reader, tf, asOf);
  return Object.freeze({ kind: "DIAGNOSTIC_PROBE", authority: "NONE", as_of: asOf, technical: technicalStateReport(reader, asOf), location: Object.freeze(loc) });
}

export function formatStructureLocation(r: StructureLocationReport): string {
  const f = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toFixed(2));
  const row = (tf: Timeframe) => {
    const t = r.technical.timeframes[tf], l = r.location[tf];
    return `${tf}: trend=${t.ema_relation} | structure=${l.high_progression ?? "-"}/${l.low_progression ?? "-"} ${t.structure} | location H=${f(l.latest_high?.pivot_price)} L=${f(l.latest_low?.pivot_price)} px=${f(l.current_closed_price)} pos=${l.range_position === null ? "-" : l.range_position.toFixed(3)} ${l.location} | atr=${f(t.atr14)} | eligible=${t.temporal_eligibility.eligible_for_alignment} missing=${t.missing_interval_status.count} warmup=${t.warmup.ema21}`;
  };
  return [row("H4"), row("H1"), row("M15"), row("M5"), `HTF=${r.technical.htf.alignment}`].join("\n");
}
