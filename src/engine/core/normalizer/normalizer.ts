// M1B.1 — validation + normalization. Pure function; no storage side effects.
import {
  TIMEFRAME_SECONDS,
  type ArenaCandle,
  type FeedSource,
  type NormalizeResult,
  type RawGatewayPayload,
  type Timeframe,
} from "./types";

function resolveSource(raw: string | undefined): FeedSource {
  if (raw === "MT5" || raw === "CRYPTO_FEED" || raw === "MOCK") return raw;
  return "MOCK";
}

export interface NormalizeOptions {
  /** Calendar authority: true when a gap is a scheduled market closure (e.g. XAU weekend). Absent ⇒ every gap rejected. */
  isExpectedGap?: (lastTs: number, nextTs: number, timeframe: Timeframe) => boolean;
}

/**
 * Validate and normalize a raw gateway payload into an ArenaCandle.
 *
 * Rules:
 *  A — OHLC integrity: high >= max(open,close), low <= min(open,close).
 *  B — duplicate timestamp (same symbol+timeframe+timestamp as lastCandle) rejected.
 *  C — gap detection: timestamp jumps of more than one expected interval are
 *      flagged GAP_DETECTED and rejected; missing candles are NEVER fabricated.
 *  D — sequence = lastCandle.sequence + 1 (first candle = 1).
 */
export function validateAndNormalize(
  raw: RawGatewayPayload,
  timeframe: Timeframe,
  lastCandle?: ArenaCandle,
  opts?: NormalizeOptions,
): NormalizeResult {
  const open = raw.open ?? raw.o;
  const high = raw.high ?? raw.h;
  const low = raw.low ?? raw.l;
  const close = raw.close ?? raw.c;

  if (open === undefined || high === undefined || low === undefined || close === undefined) {
    return { isValid: false, errorCode: "MISSING_OHLC", errorMessage: "Payload is missing one or more OHLC fields" };
  }
  if (!Number.isFinite(raw.time) || raw.time <= 0) {
    return { isValid: false, errorCode: "INVALID_TIMESTAMP", errorMessage: `Invalid timestamp: ${raw.time}` };
  }

  // RULE A — OHLC integrity
  if (high < Math.max(open, close) || low > Math.min(open, close)) {
    return {
      isValid: false,
      errorCode: "OHLC_INTEGRITY_VIOLATION",
      errorMessage: `OHLC integrity violated: o=${open} h=${high} l=${low} c=${close}`,
    };
  }

  if (lastCandle && lastCandle.symbol === raw.symbol && lastCandle.timeframe === timeframe) {
    // RULE B — duplicate timestamp
    if (raw.time === lastCandle.timestamp) {
      return {
        isValid: false,
        errorCode: "DUPLICATE_TIMESTAMP",
        errorMessage: `Duplicate timestamp ${raw.time} for ${raw.symbol} ${timeframe}`,
      };
    }
    // RULE C — gap detection (never silently filled)
    const expected = TIMEFRAME_SECONDS[timeframe];
    const delta = raw.time - lastCandle.timestamp;
    if (delta > expected && !opts?.isExpectedGap?.(lastCandle.timestamp, raw.time, timeframe)) {
      return {
        isValid: false,
        errorCode: "GAP_DETECTED",
        errorMessage: `Gap of ${delta - expected}s detected before ${raw.time} for ${raw.symbol} ${timeframe}; backfill required`,
      };
    }
  }

  // RULE D — sequence
  const sequence = (lastCandle?.sequence ?? 0) + 1;

  const candle: ArenaCandle = Object.freeze({
    id: `${raw.symbol}_${timeframe}_${raw.time}`,
    symbol: raw.symbol,
    timeframe,
    timestamp: raw.time,
    open,
    high,
    low,
    close,
    volume: raw.volume ?? 0,
    spread: raw.spread ?? 0,
    source: resolveSource(raw.source),
    isClosed: true,
    sequence,
  });

  return { isValid: true, candle };
}
