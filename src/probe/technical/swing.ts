import type { Timeframe } from "@/core/contracts";
import { gapBefore } from "./inputs";
import { SWING_ALGORITHM_VERSION, type ProbeBar } from "./types";

export type SwingType = "SWING_HIGH" | "SWING_LOW";

/** Returns every independently-true extreme predicate. An outside bar may be BOTH (S1): neither is dropped. */
function extreme(bars: readonly ProbeBar[], i: number, L: number, R: number): SwingType[] {
  const c = bars[i]!;
  let hi = true, lo = true;
  for (let j = i - L; j <= i + R; j++) {
    if (j === i) continue;
    const b = bars[j]!;
    if (!(c.high > b.high)) hi = false; // strict: ties reject
    if (!(c.low < b.low)) lo = false;
  }
  const out: SwingType[] = [];
  if (hi) out.push("SWING_HIGH");
  if (lo) out.push("SWING_LOW");
  return out;
}

function spansGap(g: readonly boolean[], from: number, to: number): boolean {
  for (let k = from + 1; k <= to; k++) if (g[k]) return true;
  return false;
}

export interface RetrospectiveSwing {
  readonly mode: "RETROSPECTIVE_LOOKAHEAD";
  readonly trading_authority: "NONE";
  readonly live_safe: false;
  readonly type: SwingType;
  /** Where the label is attached historically. */
  readonly event_at: number;
  readonly price: number;
  /** Right-side (future relative to event_at) bars the label depends on. */
  readonly right_dependency_open_times: readonly number[];
  /** Earliest time the label could actually have been known = availability of the last right bar. */
  readonly earliest_knowable_at: number;
  readonly window_spans_missing_interval: boolean;
  /** true when the same bar is both strict highest high and strict lowest low (one record per fact). */
  readonly outside_bar: boolean;
}

/** Centered-window detector (concept of SMC swing_highs_lows). Intentionally temporally unsafe. */
export function retrospectiveSwings(bars: readonly ProbeBar[], tf: Timeframe, L = 2, R = 2): RetrospectiveSwing[] {
  const g = gapBefore(bars, tf);
  const out: RetrospectiveSwing[] = [];
  for (let i = L; i + R < bars.length; i++) {
    const ts = extreme(bars, i, L, R);
    const c = bars[i]!;
    for (const t of ts) out.push(Object.freeze<RetrospectiveSwing>({
      mode: "RETROSPECTIVE_LOOKAHEAD", trading_authority: "NONE", live_safe: false, type: t, event_at: c.open_time,
      price: t === "SWING_HIGH" ? c.high : c.low,
      right_dependency_open_times: Object.freeze(bars.slice(i + 1, i + R + 1).map((b) => b.open_time)),
      earliest_knowable_at: bars[i + R]!.available_at!, window_spans_missing_interval: spansGap(g, i - L, i + R),
      outside_bar: ts.length === 2,
    }));
  }
  return out;
}

export interface CausalSwing {
  readonly mode: "CAUSAL_CONFIRMED";
  readonly trading_authority: "NONE";
  readonly type: SwingType;
  readonly event_at: number;
  readonly price: number;
  /** = max(closed_at, available_at) of the actual Rth confirming CLOSED bar. Never T + R×TF arithmetic. */
  readonly available_at: number;
  readonly confirmation_open_time: number;
  readonly confirmation_closed_at: number;
  readonly confirmation_available_at: number;
  readonly left_window: number;
  readonly right_window: number;
  readonly algorithm_version: string;
  readonly window_spans_missing_interval: boolean;
  /** true when the same bar is both strict highest high and strict lowest low (one record per fact). */
  readonly outside_bar: boolean;
}

export interface CausalSwingResult {
  readonly status: "VALID" | "WARMUP_UNSATISFIED";
  readonly swings: readonly CausalSwing[];
}

/**
 * Causal/confirmed swing: processes CLOSED bars in order; a candidate T is evaluated only when its Rth
 * right-side CLOSED bar exists. If asOf is given, only swings whose evidence is available by asOf are exposed.
 */
export function causalSwings(bars: readonly ProbeBar[], tf: Timeframe, L = 2, R = 2, asOf?: number): CausalSwingResult {
  const usable = asOf === undefined ? bars : bars.filter((b) => b.available_at! <= asOf);
  if (usable.length < L + R + 1) return Object.freeze({ status: "WARMUP_UNSATISFIED", swings: Object.freeze([]) });
  const g = gapBefore(usable, tf);
  const out: CausalSwing[] = [];
  for (let k = L + R; k < usable.length; k++) {
    const i = k - R;
    const ts = extreme(usable, i, L, R);
    const c = usable[i]!, conf = usable[k]!;
    if (conf.lifecycle !== "CLOSED" || conf.closed_at === null || conf.available_at === null) continue; // FORMING cannot confirm
    for (const t of ts) out.push(Object.freeze<CausalSwing>({
      mode: "CAUSAL_CONFIRMED", trading_authority: "NONE", type: t, event_at: c.open_time,
      price: t === "SWING_HIGH" ? c.high : c.low,
      available_at: Math.max(conf.closed_at, conf.available_at),
      confirmation_open_time: conf.open_time, confirmation_closed_at: conf.closed_at, confirmation_available_at: conf.available_at,
      left_window: L, right_window: R, algorithm_version: SWING_ALGORITHM_VERSION, window_spans_missing_interval: spansGap(g, i - L, k),
      outside_bar: ts.length === 2,
    }));
  }
  return Object.freeze({ status: "VALID", swings: Object.freeze(out) });
}

export interface LookaheadAudit {
  readonly status: "LOOKAHEAD_DETECTED" | "NO_RETROSPECTIVE_SWINGS";
  readonly items: readonly { readonly event_at: number; readonly earliest_knowable_at: number; readonly knowledge_delay_ms: number; readonly visible_with_prefix_ending_at_event: boolean }[];
}

/** For each retrospective label at T: would the same detector see it using only bars up to T? */
export function auditLookahead(bars: readonly ProbeBar[], tf: Timeframe, L = 2, R = 2): LookaheadAudit {
  const retro = retrospectiveSwings(bars, tf, L, R);
  const items = retro.map((s) => {
    const idx = bars.findIndex((b) => b.open_time === s.event_at);
    const prefix = retrospectiveSwings(bars.slice(0, idx + 1), tf, L, R);
    return Object.freeze({
      event_at: s.event_at, earliest_knowable_at: s.earliest_knowable_at, knowledge_delay_ms: s.earliest_knowable_at - s.event_at,
      visible_with_prefix_ending_at_event: prefix.some((p) => p.event_at === s.event_at && p.type === s.type),
    });
  });
  const leak = items.some((x) => !x.visible_with_prefix_ending_at_event || x.knowledge_delay_ms > 0);
  return Object.freeze({ status: leak ? "LOOKAHEAD_DETECTED" : "NO_RETROSPECTIVE_SWINGS", items: Object.freeze(items) });
}
