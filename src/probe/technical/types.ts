// TECHNICAL VALIDATION PROBE v1a — DIAGNOSTIC / RESEARCH ONLY. NOT STAGE 4.
// Outputs carry authority "NONE": never EvidenceState, never a decision, signal, setup or order.
// Dependency direction: probe → core contracts. Core must never import src/probe/**.
import type { Timeframe } from "@/core/contracts";

export const PROBE_VERSION = "TVP-v1a";
export const EMA_ALGORITHM_VERSION = "EMA-SMAseed-v1";
export const ATR_ALGORITHM_VERSION = "ATR-Wilder-SMAseed-v1";
export const SWING_ALGORITHM_VERSION = "SWING-strict-v1";
/** Tie policy: candidate must be STRICTLY greater (high) / lower (low) than every bar in the window. Equal → no swing. */
export const SWING_TIE_POLICY = "STRICT_EXTREME_BOTH_SIDES_TIES_REJECTED" as const;

export type ProbeSourceMode = "REAL_LIVE_FETCH" | "RECORDED_REPLAY" | "DETERMINISTIC_FIXTURE";
export type ProbeBarOrigin = "BROKER_OBSERVED" | "INTERNAL_REPLAY" | "FIXTURE";

/**
 * Temporal policy for availability:
 * - CANONICAL_CLOCK: closed_at/available_at come from the CandleAggregator's canonical clock.
 * - BROKER_HISTORY_LOWER_BOUND: broker history exposes no closed_at; availability is taken as the
 *   interval end (earliest moment the bar could have been known). Real system knowledge is the fetch time.
 */
export type ProbeTemporalPolicy = "CANONICAL_CLOCK" | "BROKER_HISTORY_LOWER_BOUND" | "FIXTURE_DECLARED";

export interface ProbeBar {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly origin: ProbeBarOrigin;
  /** [open_time, close_time) epoch ms on the series' declared time axis. */
  readonly open_time: number;
  readonly close_time: number;
  readonly lifecycle: "CLOSED" | "FORMING";
  readonly closed_at: number | null;
  readonly available_at: number | null;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export type ContinuityStatus = "CONTINUOUS" | "DISCONTINUOUS_MISSING_INTERVAL" | "WARMUP_UNSATISFIED";

export interface SeriesPoint {
  readonly open_time: number;
  readonly available_at: number;
  readonly value: number | null;
  readonly status: "VALID" | "WARMUP_UNSATISFIED";
  readonly continuity: ContinuityStatus;
}

export interface ProbeEnvelope<R> {
  readonly kind: "DIAGNOSTIC_PROBE";
  readonly probe_version: string;
  readonly authority: "NONE";
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly source_mode: ProbeSourceMode;
  readonly primitive: string;
  readonly algorithm_version: string;
  readonly temporal_policy: ProbeTemporalPolicy;
  readonly result: R;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

/** Research provenance for the retrospective comparator. Commit could not be verified from this sandbox. */
export const RETROSPECTIVE_REFERENCE = Object.freeze({
  reference_repository: "https://github.com/joshyattridge/smart-money-concepts",
  reference_commit: "UNVERIFIED",
  reference_path: "smartmoneyconcepts/smc.py (swing_highs_lows)",
  research_note:
    "Concept only (centered window, uses right-side bars). Independently implemented in TypeScript; no source copied. Upstream issue flags look-ahead bias.",
});
