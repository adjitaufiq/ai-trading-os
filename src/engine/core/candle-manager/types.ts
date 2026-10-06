// M1B.2 — Closed Candle Manager & Anti-Repaint Calculation Gate.
// This module ONLY decides WHEN downstream engines (EMA, swing, structure,
// bias, trigger, signal) are allowed to calculate. It contains no technical
// calculation itself and consumes ArenaCandle from M1B.1 only.

import type { ArenaCandle, Timeframe } from "../normalizer/types";

export type CandleStatus = "RUNNING" | "CLOSED" | "INVALID";

export type EngineProcessingState = "SYNCED" | "BACKFILLING" | "WAITING_DATA" | "ERROR";

export interface DataFreshnessTelemetry {
  symbol: string;
  timeframe: Timeframe;
  /** Epoch seconds of the last CLOSED candle tracked for this series. */
  lastClosedTimestamp: number;
  /** Epoch seconds when the series was last synchronized with the feed. */
  lastSyncTimestamp: number;
  ageSeconds: number;
  processingState: EngineProcessingState;
}

export type GateLockReason =
  | "READY"
  | "WAITING_CANDLE_CLOSE"
  | "STALE_DATA"
  | "BACKFILL_REQUIRED";

export interface GateLockResult {
  canCalculate: boolean;
  reason: GateLockReason;
  candle?: ArenaCandle;
}
