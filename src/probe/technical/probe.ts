import type { Timeframe } from "@/core/contracts";
import type { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import type { BridgeBar } from "@/core/broker/bridge/types";
import { atr, ema } from "./indicators";
import { fromBrokerBars, missingIntervalsOf, prepareSeries } from "./inputs";
import { auditLookahead, causalSwings, retrospectiveSwings } from "./swing";
import {
  ATR_ALGORITHM_VERSION, EMA_ALGORITHM_VERSION, PROBE_VERSION, RETROSPECTIVE_REFERENCE, SWING_ALGORITHM_VERSION, SWING_TIE_POLICY,
  type ProbeBar, type ProbeEnvelope, type ProbeSourceMode, type ProbeTemporalPolicy, type SeriesPoint,
} from "./types";

export const PROBE_TIMEFRAMES = Object.freeze(["M5", "M15", "H1", "H4"] as const satisfies readonly Timeframe[]);
export const PROBE_SYMBOLS = Object.freeze(["XAUUSD", "BTCUSD"] as const);

export interface SeriesProbeInput {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly source_mode: ProbeSourceMode;
  readonly temporal_policy: ProbeTemporalPolicy;
  readonly bars: readonly ProbeBar[];
  /** Injected detection time (no wall clock inside the probe). */
  readonly detected_at: number;
}

const firstLast = (pts: readonly SeriesPoint[]) => {
  const v = pts.filter((p) => p.status === "VALID");
  return { first_available_at: v[0]?.available_at ?? null, last_value: v[v.length - 1]?.value ?? null, valid_count: v.length };
};

export function runSeriesProbe(inp: SeriesProbeInput) {
  const s = prepareSeries(inp.bars, inp.symbol, inp.timeframe);
  const tf = inp.timeframe;
  const env = <R>(primitive: string, algorithm_version: string, result: R, diagnostics: Record<string, unknown> = {}): ProbeEnvelope<R> =>
    Object.freeze({ kind: "DIAGNOSTIC_PROBE", probe_version: PROBE_VERSION, authority: "NONE", symbol: inp.symbol, timeframe: tf,
      source_mode: inp.source_mode, primitive, algorithm_version, temporal_policy: inp.temporal_policy, result, diagnostics: Object.freeze(diagnostics) });
  const e5 = ema(s.bars, 5, tf), e21 = ema(s.bars, 21, tf), a14 = atr(s.bars, 14, tf);
  const retro = retrospectiveSwings(s.bars, tf), causal = causalSwings(s.bars, tf), look = auditLookahead(s.bars, tf);
  const missing = missingIntervalsOf(s, inp.symbol, tf, inp.detected_at);
  const temporal_violations: string[] = [];
  for (const c of causal.swings) {
    if (c.available_at < c.confirmation_closed_at) temporal_violations.push(`causal swing ${c.event_at} available before confirmation closed_at`);
    if (c.available_at < c.confirmation_available_at) temporal_violations.push(`causal swing ${c.event_at} available before confirmation available_at`);
    if (c.available_at <= c.event_at) temporal_violations.push(`causal swing ${c.event_at} available at/before its own event`);
  }
  const summary = Object.freeze({
    kind: "DIAGNOSTIC_PROBE" as const, authority: "NONE" as const, symbol: inp.symbol, timeframe: tf, source_mode: inp.source_mode,
    bar_count: inp.bars.length, usable_closed: s.bars.length, excluded_forming: s.excluded_forming, excluded_foreign: s.excluded_foreign,
    duplicate_open_times: s.duplicate_open_times, out_of_order: s.out_of_order,
    missing_interval_count: missing.length, gap_ranges: s.gaps,
    ema5: firstLast(e5), ema21: firstLast(e21), atr14: firstLast(a14),
    retrospective_swing_count: retro.length, causal_swing_count: causal.swings.length, causal_status: causal.status,
    lookahead: look.status, temporal_violations: Object.freeze(temporal_violations),
  });
  return Object.freeze({
    summary,
    ema5: env("EMA", EMA_ALGORITHM_VERSION, e5, { period: 5, input: "CLOSED close", seed_method: "SMA(N)", required_history: 5 }),
    ema21: env("EMA", EMA_ALGORITHM_VERSION, e21, { period: 21, input: "CLOSED close", seed_method: "SMA(N)", required_history: 21 }),
    atr14: env("ATR", ATR_ALGORITHM_VERSION, a14, { period: 14, method: "WILDER_RMA", seed_method: "SMA of TR[1..14]", required_history: 15 }),
    swingRetrospective: env("SWING", SWING_ALGORITHM_VERSION, retro, { mode: "RETROSPECTIVE_LOOKAHEAD", tie_policy: SWING_TIE_POLICY, ...RETROSPECTIVE_REFERENCE }),
    swingCausal: env("SWING", SWING_ALGORITHM_VERSION, causal, { mode: "CAUSAL_CONFIRMED", left: 2, right: 2, tie_policy: SWING_TIE_POLICY }),
    lookahead: env("SWING_LOOKAHEAD_AUDIT", SWING_ALGORITHM_VERSION, look),
    missing,
  });
}

/** Prefix / no-future-evidence check: results available at prefix k must be identical in the full run. */
export function prefixViolations(bars: readonly ProbeBar[], tf: Timeframe): string[] {
  const v: string[] = [];
  const full5 = ema(bars, 5, tf), full21 = ema(bars, 21, tf), fullA = atr(bars, 14, tf);
  const fullS = causalSwings(bars, tf).swings;
  const key = (o: unknown) => JSON.stringify(o);
  for (let k = 1; k <= bars.length; k++) {
    const p = bars.slice(0, k);
    const cmp = (name: string, a: SeriesPoint[], b: SeriesPoint[]) => a.forEach((x, i) => { if (key(x) !== key(b[i])) v.push(`${name} rewritten at prefix ${k} idx ${i}`); });
    cmp("EMA5", ema(p, 5, tf), full5); cmp("EMA21", ema(p, 21, tf), full21); cmp("ATR14", atr(p, 14, tf), fullA);
    for (const s of causalSwings(p, tf).swings) if (!fullS.some((f) => key(f) === key(s))) v.push(`causal swing ${s.event_at} rewritten by future bars after prefix ${k}`);
  }
  return v;
}

// ---------------- REAL BACKFILL (diagnostic; no mock fallback) ----------------

export interface RealSeriesCapture {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly status: "REAL" | "UNAVAILABLE";
  readonly reason: string | null;
  readonly items: readonly BridgeBar[];
  readonly provenance: { readonly source: string; readonly source_mode: string; readonly delivery: string; readonly bridge_instance_id: string; readonly connection_epoch: number; readonly request_id: string; readonly bridge_sent_at: number } | null;
}

export async function captureRealBackfill(client: BrokerGatewayClient, count: number): Promise<{ status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE"; series: RealSeriesCapture[] }> {
  const series: RealSeriesCapture[] = [];
  for (const symbol of PROBE_SYMBOLS) for (const timeframe of PROBE_TIMEFRAMES) {
    const r = await client.getBars({ symbol, timeframe, mode: "pos", start: 0, count });
    if (!r.ok) { series.push({ symbol, timeframe, status: "UNAVAILABLE", reason: `${r.error.kind}: ${r.error.message}`, items: [], provenance: null }); continue; }
    const e = r.envelope;
    const okReal = e.source === "EXNESS_MT5" && e.source_mode === "REAL" && e.delivery === "BACKFILL" && r.sequence.disposition !== "QUARANTINE"
      && r.data.items.every((b) => b.broker_symbol === symbol && b.timeframe === timeframe);
    series.push(okReal
      ? { symbol, timeframe, status: "REAL", reason: null, items: r.data.items, provenance: { source: e.source, source_mode: e.source_mode, delivery: e.delivery, bridge_instance_id: e.bridge_instance_id, connection_epoch: e.connection_epoch, request_id: e.request_id, bridge_sent_at: e.timing.bridge_sent_at } }
      : { symbol, timeframe, status: "UNAVAILABLE", reason: "response not REAL EXNESS_MT5 BACKFILL for this symbol/timeframe", items: [], provenance: null });
  }
  const real = series.filter((s) => s.status === "REAL").length;
  return { status: real === series.length ? "AVAILABLE" : real === 0 ? "UNAVAILABLE" : "PARTIAL", series };
}

export interface RecordedRealFixture {
  readonly kind: "RECORDED_REAL_BROKER_FIXTURE";
  readonly source_mode: "RECORDED_REPLAY";
  readonly series: readonly RealSeriesCapture[];
}
/** Sanitized: only bar fields + envelope provenance (no credentials exist in the contract). */
export const recordFixture = (series: readonly RealSeriesCapture[]): RecordedRealFixture =>
  Object.freeze({ kind: "RECORDED_REAL_BROKER_FIXTURE", source_mode: "RECORDED_REPLAY", series: series.filter((s) => s.status === "REAL") });

export function probeCaptured(cap: RealSeriesCapture, source_mode: "REAL_LIVE_FETCH" | "RECORDED_REPLAY", detected_at: number) {
  return runSeriesProbe({ symbol: cap.symbol, timeframe: cap.timeframe, source_mode, temporal_policy: "BROKER_HISTORY_LOWER_BOUND",
    bars: fromBrokerBars(cap.items, { newestMayBeForming: true }), detected_at });
}
