// TECHNICAL VALIDATION PROBE v1d-SNR — CANDIDATE SUPPORT/RESISTANCE AS LOCATION EVIDENCE.
// DIAGNOSTIC_PROBE, authority NONE. NOT STAGE 4. No signal, entry, side, breakout/fakeout/retest, role reversal,
// strength score, zone or tolerance. Exact-price comparison only. Reuses v1d causal swings unchanged.
import { TIMEFRAME_MS, type Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import { fromInternalBars, prepareSeries } from "./inputs";
import { causalSwings } from "./swing";
import { SWING_ALGORITHM_VERSION, type ProbeBar } from "./types";

export const SNR_VERSION = "TVP-v1d-snr";
export const SNR_TIMEFRAMES: readonly Timeframe[] = Object.freeze(["H4", "H1", "M15", "M5"]);
const SWING_L = 2, SWING_R = 2;

export type SideRelation = "ABOVE" | "BELOW" | "AT";
export type SnrCandidateRole = "SUPPORT_CANDIDATE" | "RESISTANCE_CANDIDATE";

export interface SnrBarInteraction {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bar_id: string;
  readonly bar_origin: ProbeBar["origin"];
  readonly bar_open_time: number;
  readonly bar_close_time: number;
  readonly bar_closed_at: number;
  readonly bar_available_at: number;
  readonly open: number; readonly high: number; readonly low: number; readonly close: number;
  readonly open_side: SideRelation;
  readonly close_side: SideRelation;
  readonly high_side: SideRelation;
  readonly low_side: SideRelation;
  readonly range_contains_level: boolean;
  readonly body_contains_level: boolean;
  readonly body_crossed_level: boolean;
  readonly closed_beyond_original_role: boolean;
  /** Signed: close − level price. Geometry only. */
  readonly distance_close_to_level: number;
  readonly missing_interval_refs: readonly string[];
  readonly has_missing_interval_uncertainty: boolean;
}

export interface SnrFactualSummary {
  readonly interaction_count: number;
  readonly range_contains_count: number;
  readonly close_beyond_count: number;
  readonly has_post_close_beyond_range_contains: boolean;
  readonly has_post_close_beyond_close_on_original_side: boolean;
}

export interface DerivedSnrCandidate {
  readonly taxonomy: "DERIVED";
  readonly candidate_id: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly role_candidate: SnrCandidateRole;
  readonly price: number;
  readonly origin: {
    readonly swing_id: string;
    readonly swing_type: "SWING_HIGH" | "SWING_LOW";
    readonly pivot_time: number;
    readonly confirmed_at: number;
    readonly confirmation_bar_open_time: number;
    readonly confirmation_bar_close_time: number;
    readonly available_at: number;
    readonly outside_bar: boolean;
    readonly origin_missing_interval_refs: readonly string[];
    readonly window_spans_missing_interval: boolean;
    readonly swing_algorithm_version: string;
  };
  readonly available_at: number;
  readonly interactions: readonly SnrBarInteraction[];
  readonly factual_summary: SnrFactualSummary;
  readonly algorithm_version: string;
}

export interface TimeframeSnrState {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly as_of: number;
  readonly current_closed_price: number | null;
  readonly candidates: readonly DerivedSnrCandidate[];
  readonly nearest_support_below_price: number | null;
  readonly nearest_resistance_above_price: number | null;
  readonly has_support_below: boolean;
  readonly has_resistance_above: boolean;
  readonly is_bracketed_by_candidate_snr: boolean;
  readonly provenance: {
    readonly input: "MarketRuntimeReader.closedBars (CLOSED only, available_at <= as_of)";
    readonly swing_algorithm: string;
    readonly lookahead: "EXCLUDED_CAUSAL_ONLY";
    readonly missing_interval_refs_in_input: readonly string[];
  };
}

// ---------------- USER horizontal levels (integration boundary only) ----------------

export interface UserHorizontalLevel {
  readonly id: string;
  readonly taxonomy: "USER";
  readonly symbol: string;
  readonly price: number;
  readonly role: "SUPPORT" | "RESISTANCE" | "REFERENCE";
  readonly purpose: "REFERENCE" | "TARGET" | "INVALIDATION" | "ENTRY_ZONE";
  readonly created_at: number;
  readonly effective_at: number;
}

export class InvalidUserLevelError extends Error {}

export function userHorizontalLevel(l: Omit<UserHorizontalLevel, "taxonomy">): UserHorizontalLevel {
  if (!(l.effective_at >= l.created_at)) throw new InvalidUserLevelError(`effective_at ${l.effective_at} < created_at ${l.created_at}`);
  return Object.freeze({ ...l, taxonomy: "USER" as const });
}

/** A USER level whose effective_at > T does not exist for the T snapshot. */
export function userLevelsAt(levels: readonly UserHorizontalLevel[], symbol: string, asOf: number): readonly UserHorizontalLevel[] {
  return levels.filter((l) => l.symbol === symbol && l.effective_at <= asOf);
}

// ---------------- Confluence (exact price only) ----------------

export type ConfluenceClassification = "CROSS_TF_CONFLUENCE" | "USER_DERIVED_CONFLUENCE" | "MULTI_CONFLUENCE";

export interface SnrConfluenceMember {
  readonly id: string;
  readonly taxonomy: "DERIVED" | "USER";
  readonly symbol: string;
  readonly timeframe: Timeframe | null;
  readonly role: SnrCandidateRole | UserHorizontalLevel["role"];
  readonly price: number;
  readonly available_or_effective_at: number;
}

export interface SnrPriceConfluence {
  readonly confluence_id: string;
  readonly symbol: string;
  readonly price: number;
  readonly as_of: number;
  readonly available_at: number;
  readonly members: readonly SnrConfluenceMember[];
  readonly classification: ConfluenceClassification;
  /** Members are not independent votes; nothing is counted or scored. */
  readonly independence: "NOT_ASSUMED";
}

// ---------------- Research-required register ----------------

export const SNR_RESEARCH_REGISTER = Object.freeze({
  touch_definition: "RESEARCH_REQUIRED",
  reaction_definition: "RESEARCH_REQUIRED",
  rejection_definition: "RESEARCH_REQUIRED",
  breakout_classification: "RESEARCH_REQUIRED",
  fakeout_classification: "RESEARCH_REQUIRED",
  retest_classification: "RESEARCH_REQUIRED",
  role_reversal_semantics: "RESEARCH_REQUIRED",
  strength_scoring_model: "RESEARCH_REQUIRED",
  level_expiry_and_invalidation: "RESEARCH_REQUIRED",
  zone_width_and_tolerance: "RESEARCH_REQUIRED",
  proximity_tolerance: "RESEARCH_REQUIRED",
  number_of_touches_required: "RESEARCH_REQUIRED",
  snr_decay: "RESEARCH_REQUIRED",
  atr_based_snr_distance_threshold: "RESEARCH_REQUIRED",
} as const);

// ---------------- Pure geometry ----------------

export const side = (v: number, p: number): SideRelation => (v > p ? "ABOVE" : v < p ? "BELOW" : "AT");

export function interaction(bar: ProbeBar, price: number, role: SnrCandidateRole, refs: readonly string[]): SnrBarInteraction {
  const lo = Math.min(bar.open, bar.close), hi = Math.max(bar.open, bar.close);
  const r = Object.freeze([...refs]);
  return Object.freeze<SnrBarInteraction>({
    symbol: bar.symbol, timeframe: bar.timeframe, bar_id: `BAR:${bar.symbol}:${bar.timeframe}:${bar.open_time}`, bar_origin: bar.origin,
    bar_open_time: bar.open_time, bar_close_time: bar.close_time, bar_closed_at: bar.closed_at!, bar_available_at: bar.available_at!,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    open_side: side(bar.open, price), close_side: side(bar.close, price), high_side: side(bar.high, price), low_side: side(bar.low, price),
    range_contains_level: bar.low <= price && price <= bar.high,
    body_contains_level: lo <= price && price <= hi,
    body_crossed_level: (bar.open < price && bar.close > price) || (bar.open > price && bar.close < price),
    closed_beyond_original_role: role === "RESISTANCE_CANDIDATE" ? bar.close > price : bar.close < price,
    distance_close_to_level: bar.close - price,
    missing_interval_refs: r, has_missing_interval_uncertainty: r.length > 0,
  });
}

export function factualSummary(role: SnrCandidateRole, price: number, xs: readonly SnrBarInteraction[]): SnrFactualSummary {
  let sawBeyond = false, rc = false, back = false;
  for (const x of xs) {
    if (sawBeyond) {
      if (x.range_contains_level) rc = true;
      if (role === "RESISTANCE_CANDIDATE" ? x.close <= price : x.close >= price) back = true;
    }
    if (x.closed_beyond_original_role) sawBeyond = true;
  }
  return Object.freeze({
    interaction_count: xs.length,
    range_contains_count: xs.filter((x) => x.range_contains_level).length,
    close_beyond_count: xs.filter((x) => x.closed_beyond_original_role).length,
    has_post_close_beyond_range_contains: rc,
    has_post_close_beyond_close_on_original_side: back,
  });
}

const miRef = (symbol: string, tf: Timeframe, open: number) => `MI:${symbol}:${tf}:${open}`;
/** Missing interval refs strictly between two observed bar open times (no candle is created for them). */
function refsBetween(symbol: string, tf: Timeframe, afterOpen: number, beforeOpen: number, observed: ReadonlySet<number>): string[] {
  const out: string[] = [];
  for (let t = afterOpen + TIMEFRAME_MS[tf]; t < beforeOpen; t += TIMEFRAME_MS[tf]) if (!observed.has(t)) out.push(miRef(symbol, tf, t));
  return out;
}

export function nearest(candidates: readonly DerivedSnrCandidate[], price: number | null) {
  let sup: number | null = null, res: number | null = null;
  if (price !== null) for (const c of candidates) {
    if (c.role_candidate === "SUPPORT_CANDIDATE" && c.price < price && (sup === null || price - c.price < price - sup)) sup = c.price;
    if (c.role_candidate === "RESISTANCE_CANDIDATE" && c.price > price && (res === null || c.price - price < res - price)) res = c.price;
  }
  return { nearest_support_below_price: sup, nearest_resistance_above_price: res, has_support_below: sup !== null, has_resistance_above: res !== null, is_bracketed_by_candidate_snr: sup !== null && res !== null };
}

// ---------------- Runtime consumption (read-only) ----------------

export function timeframeSnrState(reader: MarketRuntimeReader, tf: Timeframe, asOf: number): TimeframeSnrState {
  const symbol = reader.symbol;
  const eligible = fromInternalBars(reader.closedBars(tf)).filter((b) => b.available_at !== null && b.closed_at !== null && b.available_at <= asOf && b.closed_at <= asOf);
  const bars = prepareSeries(eligible, symbol, tf).bars;
  const swings = causalSwings(bars, tf, SWING_L, SWING_R, asOf).swings;
  const idx = new Map(bars.map((b, i) => [b.open_time, i] as const));
  const observed = new Set(bars.map((b) => b.open_time));
  const gapRefs = (j: number) => (j > 0 ? refsBetween(symbol, tf, bars[j - 1]!.open_time, bars[j]!.open_time, observed) : []);
  const candidates = swings.map((s): DerivedSnrCandidate => {
    const i = idx.get(s.event_at)!, k = idx.get(s.confirmation_open_time)!;
    const conf = bars[k]!;
    const originRefs = Object.freeze(refsBetween(symbol, tf, bars[i - SWING_L]!.open_time, conf.open_time, observed));
    const role: SnrCandidateRole = s.type === "SWING_HIGH" ? "RESISTANCE_CANDIDATE" : "SUPPORT_CANDIDATE";
    // Structural subsequence: B.open_time >= confirmation bar close_time (excludes pivot and confirmation candles).
    const xs = Object.freeze(bars.map((b, j) => [b, j] as const).filter(([b]) => b.open_time >= conf.close_time).map(([b, j]) => interaction(b, s.price, role, gapRefs(j))));
    return Object.freeze<DerivedSnrCandidate>({
      taxonomy: "DERIVED",
      candidate_id: `SNR:${symbol}:${tf}:${role}:${s.event_at}:${SNR_VERSION}`,
      symbol, timeframe: tf, role_candidate: role, price: s.price,
      origin: Object.freeze({
        swing_id: `SW:${symbol}:${tf}:${s.type}:${s.event_at}:${s.algorithm_version}`, swing_type: s.type,
        pivot_time: s.event_at, confirmed_at: s.confirmation_closed_at,
        confirmation_bar_open_time: conf.open_time, confirmation_bar_close_time: conf.close_time,
        available_at: s.available_at, outside_bar: s.outside_bar,
        origin_missing_interval_refs: originRefs, window_spans_missing_interval: originRefs.length > 0,
        swing_algorithm_version: s.algorithm_version,
      }),
      available_at: s.available_at, interactions: xs, factual_summary: factualSummary(role, s.price, xs), algorithm_version: SNR_VERSION,
    });
  });
  const price = bars[bars.length - 1]?.close ?? null;
  const inputRefs: string[] = [];
  for (let j = 1; j < bars.length; j++) inputRefs.push(...gapRefs(j));
  return Object.freeze<TimeframeSnrState>({
    kind: "DIAGNOSTIC_PROBE", authority: "NONE", symbol, timeframe: tf, as_of: asOf, current_closed_price: price,
    candidates: Object.freeze(candidates), ...nearest(candidates, price),
    provenance: Object.freeze({ input: "MarketRuntimeReader.closedBars (CLOSED only, available_at <= as_of)", swing_algorithm: SWING_ALGORITHM_VERSION, lookahead: "EXCLUDED_CAUSAL_ONLY", missing_interval_refs_in_input: Object.freeze(inputRefs) }),
  });
}

const TF_ORDER: Record<Timeframe, number> = { H4: 0, H1: 1, M15: 2, M5: 3 };

/** Exact-price confluence: same symbol + identical price + every member available at as_of. No tolerance, no merge. */
export function exactPriceConfluences(derived: readonly DerivedSnrCandidate[], user: readonly UserHorizontalLevel[], asOf: number): readonly SnrPriceConfluence[] {
  const members: SnrConfluenceMember[] = [
    ...derived.filter((c) => c.available_at <= asOf).map((c) => ({ id: c.candidate_id, taxonomy: "DERIVED" as const, symbol: c.symbol, timeframe: c.timeframe, role: c.role_candidate, price: c.price, available_or_effective_at: c.available_at })),
    ...user.filter((u) => u.effective_at <= asOf).map((u) => ({ id: u.id, taxonomy: "USER" as const, symbol: u.symbol, timeframe: null, role: u.role, price: u.price, available_or_effective_at: u.effective_at })),
  ];
  const groups = new Map<string, SnrConfluenceMember[]>();
  for (const m of members) {
    const key = `${m.symbol}\u0000${m.price}`; // exact numeric identity, no rounding
    const g = groups.get(key) ?? [];
    g.push(m);
    groups.set(key, g);
  }
  const out: SnrPriceConfluence[] = [];
  for (const g of groups.values()) {
    const ms = [...g].sort((a, b) => (a.taxonomy === b.taxonomy ? 0 : a.taxonomy === "USER" ? -1 : 1)
      || (a.timeframe === null ? -1 : b.timeframe === null ? 1 : TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const hasUser = ms.some((m) => m.taxonomy === "USER"), hasDerived = ms.some((m) => m.taxonomy === "DERIVED");
    const tfs = new Set(ms.filter((m) => m.taxonomy === "DERIVED").map((m) => m.timeframe));
    const cross = tfs.size >= 2, ud = hasUser && hasDerived;
    if (!cross && !ud) continue; // same-TF-only or USER-only coincidences are not a contracted classification
    const available_at = Math.max(...ms.map((m) => m.available_or_effective_at));
    if (available_at > asOf) continue;
    out.push(Object.freeze<SnrPriceConfluence>({
      confluence_id: `CONF:${ms[0]!.symbol}:${ms[0]!.price}:${ms.map((m) => m.id).join("|")}`,
      symbol: ms[0]!.symbol, price: ms[0]!.price, as_of: asOf, available_at,
      members: Object.freeze(ms.map((m) => Object.freeze(m))),
      classification: cross && ud ? "MULTI_CONFLUENCE" : cross ? "CROSS_TF_CONFLUENCE" : "USER_DERIVED_CONFLUENCE",
      independence: "NOT_ASSUMED",
    }));
  }
  return Object.freeze(out.sort((a, b) => a.price - b.price || (a.confluence_id < b.confluence_id ? -1 : 1)));
}

export interface SnrReport {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly authority: "NONE";
  readonly version: string;
  readonly symbol: string;
  readonly as_of: number;
  readonly timeframes: Readonly<Record<Timeframe, TimeframeSnrState>>;
  readonly user_levels: readonly UserHorizontalLevel[];
  readonly confluences: readonly SnrPriceConfluence[];
  readonly research_register: typeof SNR_RESEARCH_REGISTER;
}

export function snrReport(reader: MarketRuntimeReader, asOf: number = reader.now(), userLevels: readonly UserHorizontalLevel[] = []): SnrReport {
  const tfs = {} as Record<Timeframe, TimeframeSnrState>;
  for (const tf of SNR_TIMEFRAMES) tfs[tf] = timeframeSnrState(reader, tf, asOf);
  const user = userLevelsAt(userLevels, reader.symbol, asOf);
  const derived = SNR_TIMEFRAMES.flatMap((tf) => tfs[tf].candidates);
  return Object.freeze({
    kind: "DIAGNOSTIC_PROBE", authority: "NONE", version: SNR_VERSION, symbol: reader.symbol, as_of: asOf,
    timeframes: Object.freeze(tfs), user_levels: Object.freeze([...user]), confluences: exactPriceConfluences(derived, user, asOf),
    research_register: SNR_RESEARCH_REGISTER,
  });
}
