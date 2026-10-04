// Stage 3 — Real broker observability audit helpers (UI-only diagnostics).
// Pure functions. They NEVER mutate broker data, never create candles,
// never interpolate, never fill gaps. Output is audit metadata only.
import { TIMEFRAME_MS, type Timeframe } from "../../contracts";
import type { BridgeBar } from "../gateway/types";

export type BarDiagnosticKind = "FIRST" | "CONTIGUOUS" | "INTERVAL_GAP" | "DUPLICATE_TIMESTAMP" | "OUT_OF_ORDER";

export interface BarDiagnostic {
  readonly index: number;
  readonly raw_time_s: number;
  readonly expected_delta_s: number;
  /** raw_time_s − previous raw_time_s (in response order). null for first. */
  readonly actual_delta_s: number | null;
  /** Missing whole intervals for INTERVAL_GAP; not a claim of broker failure. */
  readonly missing_intervals: number | null;
  readonly kind: BarDiagnosticKind;
}

export interface BarAuditSummary {
  readonly timeframe: Timeframe;
  readonly expected_delta_s: number;
  readonly count: number;
  readonly contiguous: number;
  readonly gaps: number;
  readonly duplicates: number;
  readonly out_of_order: number;
  readonly diagnostics: readonly BarDiagnostic[];
}

/** Classify adjacent bars in the exact order returned. Input is not copied, sorted or modified. */
export function auditBars(bars: readonly BridgeBar[], timeframe: Timeframe): BarAuditSummary {
  const expected = TIMEFRAME_MS[timeframe] / 1000;
  const diagnostics: BarDiagnostic[] = bars.map((b, i) => {
    if (i === 0) return { index: 0, raw_time_s: b.raw_time_s, expected_delta_s: expected, actual_delta_s: null, missing_intervals: null, kind: "FIRST" };
    const d = b.raw_time_s - bars[i - 1]!.raw_time_s;
    const kind: BarDiagnosticKind = d === 0 ? "DUPLICATE_TIMESTAMP" : d < 0 ? "OUT_OF_ORDER" : d === expected ? "CONTIGUOUS" : "INTERVAL_GAP";
    return {
      index: i, raw_time_s: b.raw_time_s, expected_delta_s: expected, actual_delta_s: d,
      missing_intervals: kind === "INTERVAL_GAP" ? d / expected - 1 : null, kind,
    };
  });
  const n = (k: BarDiagnosticKind) => diagnostics.filter((x) => x.kind === k).length;
  return {
    timeframe, expected_delta_s: expected, count: bars.length,
    contiguous: n("CONTIGUOUS"), gaps: n("INTERVAL_GAP"), duplicates: n("DUPLICATE_TIMESTAMP"), out_of_order: n("OUT_OF_ORDER"),
    diagnostics,
  };
}

/** UI-only derived spread in PRICE units. No pip/point conversion. */
export const spreadPrice = (bid: number, ask: number): number => ask - bid;

export type AuditFreshness = "FRESH" | "STALE" | "UNKNOWN";
export interface TickAge {
  readonly status: AuditFreshness;
  /** now − event_at. May be negative under clock skew; never clamped. */
  readonly age_ms: number | null;
}
/**
 * Age from the broker event timestamp. FRESH/STALE only with an explicit
 * threshold; without one the status is UNKNOWN. delivery=LIVE is not an input.
 */
export function tickAge(eventAtMs: number | null, nowMs: number, staleAfterMs: number | null): TickAge {
  if (eventAtMs == null || !Number.isFinite(eventAtMs)) return { status: "UNKNOWN", age_ms: null };
  const age = nowMs - eventAtMs;
  if (staleAfterMs == null || !(staleAfterMs > 0)) return { status: "UNKNOWN", age_ms: age };
  return { status: age > staleAfterMs ? "STALE" : "FRESH", age_ms: age };
}

/** Human-readable UTC; raw value is always shown alongside by the UI. */
export function utc(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "INVALID" : d.toISOString().replace("T", " ").replace("Z", " UTC");
}
