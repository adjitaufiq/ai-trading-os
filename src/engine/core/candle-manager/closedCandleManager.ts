// M1B.2 — anti-repaint protection layer.
//
// Anti-repaint invariant: no technical calculation may run on unfinished
// (RUNNING) candles. A candle is CLOSED only when the clock has passed its
// full interval boundary (timestamp + interval seconds <= now), regardless
// of what a feed claims. A normalizer GAP_DETECTED blocks the whole
// calculation path until the series is backfilled and re-synchronized.

import { TIMEFRAME_SECONDS, type ArenaCandle, type Timeframe } from "../normalizer/types";
import type { CandleStatus, DataFreshnessTelemetry, EngineProcessingState, GateLockResult } from "./types";

interface SeriesSync {
  lastClosedTimestamp: number;
  lastSyncTimestamp: number;
  /** Set when a GAP_DETECTED has been reported; cleared after resolveBackfill(). */
  backfillRequired: boolean;
}

/**
 * Decide the status of a candle against the wall clock.
 *
 * - Non-finite OHLC values => INVALID (never calculable).
 * - CLOSED only when the feed marks it closed AND the clock has passed
 *   the full interval boundary (timestamp + interval <= currentTimestamp).
 * - Everything else (open flag false, or clock still inside the bar) => RUNNING.
 */
export function evaluateCandleStatus(candle: ArenaCandle, currentTimestamp: number): CandleStatus {
  const interval = TIMEFRAME_SECONDS[candle.timeframe];
  const ohlc = [candle.open, candle.high, candle.low, candle.close, candle.timestamp];
  if (ohlc.some((v) => !Number.isFinite(v))) return "INVALID";

  const boundaryReached = candle.timestamp + interval <= currentTimestamp;
  if (candle.isClosed === true && boundaryReached) return "CLOSED";
  return "RUNNING";
}

/**
 * Calculation lock gate for a single candle.
 *
 * A candle marked `isClosed === false` blocks every downstream engine
 * (swing, EMA, structure, bias, trigger, signal) with WAITING_CANDLE_CLOSE.
 * A closed candle unlocks calculation with READY. Gap/backfill protection
 * is layered on top by ClosedCandleManager (BACKFILL_REQUIRED).
 */
export function calculationLockGate(candle: ArenaCandle): GateLockResult {
  if (candle.isClosed !== true) {
    return { canCalculate: false, reason: "WAITING_CANDLE_CLOSE" };
  }
  return { canCalculate: true, reason: "READY", candle };
}

/**
 * Per-series sync tracker with backfill protection.
 * Holds the freshness telemetry and the GAP_DETECTED lock state.
 */
export class ClosedCandleManager {
  private readonly series = new Map<string, SeriesSync>();

  private key(symbol: string, timeframe: Timeframe): string {
    return `${symbol}_${timeframe}`;
  }

  private getSync(symbol: string, timeframe: Timeframe, create: boolean): SeriesSync | undefined {
    const key = this.key(symbol, timeframe);
    let sync = this.series.get(key);
    if (!sync && create) {
      sync = { lastClosedTimestamp: 0, lastSyncTimestamp: 0, backfillRequired: false };
      this.series.set(key, sync);
    }
    return sync;
  }

  /**
   * Record that a closed candle was persisted for the series.
   * Used as the freshness anchor for getFreshnessTelemetry().
   */
  recordClosedCandle(symbol: string, timeframe: Timeframe, candle: ArenaCandle): void {
    if (candle.symbol !== symbol || candle.timeframe !== timeframe) return;
    const sync = this.getSync(symbol, timeframe, true)!;
    sync.lastClosedTimestamp = Math.max(sync.lastClosedTimestamp, candle.timestamp);
    sync.lastSyncTimestamp = Math.max(sync.lastSyncTimestamp, candle.timestamp);
  }

  /**
   * Called when the normalizer reports GAP_DETECTED.
   * The whole calculation path for the series is locked (BACKFILL_REQUIRED)
   * until resolveBackfill() is called with a synchronized series.
   */
  reportGap(symbol: string, timeframe: Timeframe): void {
    const sync = this.getSync(symbol, timeframe, true)!;
    sync.backfillRequired = true;
  }

  /**
   * Called after the backfill fills the gap and the series is synchronized.
   * Re-anchors freshness to the newest closed candle of the repaired series.
   */
  resolveBackfill(symbol: string, timeframe: Timeframe, lastClosedCandle: ArenaCandle): void {
    if (lastClosedCandle.symbol !== symbol || lastClosedCandle.timeframe !== timeframe) return;
    const sync = this.getSync(symbol, timeframe, true)!;
    sync.backfillRequired = false;
    sync.lastClosedTimestamp = Math.max(sync.lastClosedTimestamp, lastClosedCandle.timestamp);
    sync.lastSyncTimestamp = Math.max(sync.lastSyncTimestamp, lastClosedCandle.timestamp);
  }

  /** True while a GAP_DETECTED remains un-repaired for this series. */
  isBackfillRequired(symbol: string, timeframe: Timeframe): boolean {
    return this.getSync(symbol, timeframe, false)?.backfillRequired ?? false;
  }

  /**
   * Freshness telemetry for a series.
   *
   * - No sync data ever recorded  => WAITING_DATA (ageSeconds = 0 sentinel).
   * - GAP_DETECTED not repaired   => BACKFILLING.
   * - ageSeconds > interval * 2   => WAITING_DATA (stale beyond two bars).
   * - otherwise                   => SYNCED.
   */
  getFreshnessTelemetry(
    symbol: string,
    timeframe: Timeframe,
    currentTimestamp: number,
  ): DataFreshnessTelemetry {
    const sync = this.getSync(symbol, timeframe, false);
    const interval = TIMEFRAME_SECONDS[timeframe];
    if (!sync) {
      return {
        symbol,
        timeframe,
        lastClosedTimestamp: 0,
        lastSyncTimestamp: 0,
        ageSeconds: 0,
        processingState: "WAITING_DATA",
      };
    }

    const ageSeconds = Math.max(0, currentTimestamp - sync.lastSyncTimestamp);
    let processingState: EngineProcessingState;
    if (sync.backfillRequired) {
      processingState = "BACKFILLING";
    } else if (ageSeconds > interval * 2) {
      processingState = "WAITING_DATA";
    } else {
      processingState = "SYNCED";
    }

    return {
      symbol,
      timeframe,
      lastClosedTimestamp: sync.lastClosedTimestamp,
      lastSyncTimestamp: sync.lastSyncTimestamp,
      ageSeconds,
      processingState,
    };
  }

  /**
   * Full gate for downstream engines: candle lock first, then gap/backfill
   * protection, then stale-data check. Never allows calculation on a
   * RUNNING candle or an out-of-sync series.
   */
  gateCalculation(
    candle: ArenaCandle,
    currentTimestamp: number,
  ): GateLockResult {
    // 1. Anti-repaint: unfinished candles never calculate.
    const lock = calculationLockGate(candle);
    if (!lock.canCalculate) return lock;

    // 2. Backfill protection: GAP_DETECTED locks the entire series.
    if (this.isBackfillRequired(candle.symbol, candle.timeframe)) {
      return { canCalculate: false, reason: "BACKFILL_REQUIRED" };
    }

    // 3. Stale data: series too far behind the wall clock.
    const telemetry = this.getFreshnessTelemetry(candle.symbol, candle.timeframe, currentTimestamp);
    if (telemetry.processingState === "WAITING_DATA") {
      return { canCalculate: false, reason: "STALE_DATA" };
    }

    return { canCalculate: true, reason: "READY", candle };
  }
}
