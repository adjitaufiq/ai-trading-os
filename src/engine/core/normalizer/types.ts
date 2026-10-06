// M1B.1 — OHLC Data Normalizer & Candle Storage Boundary.
// This module ONLY receives raw candle data, validates integrity, normalizes
// format, stores candles and detects missing data. No indicators, signals,
// EMA, trend, swing or trading decisions live here.

export type Timeframe = "M5" | "M15" | "H1" | "H4";

export type FeedSource = "MT5" | "CRYPTO_FEED" | "MOCK";

/** Expected candle interval in seconds (timestamps are epoch seconds). */
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M5: 300,
  M15: 900,
  H1: 3600,
  H4: 14400,
};

/**
 * Raw payload as it may arrive from the gateway/broker feed.
 * Accepts both long-form (open/high/low/close) and short-form (o/h/l/c) OHLC.
 * `time` is epoch seconds.
 */
export interface RawGatewayPayload {
  symbol: string;
  timeframe?: string;
  time: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  volume?: number;
  spread?: number;
  source?: string;
}

export interface ArenaCandle {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  /** Epoch seconds, bar open time. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread: number;
  source: FeedSource;
  isClosed: boolean;
  sequence: number;
}

export type NormalizeErrorCode =
  | "OHLC_INTEGRITY_VIOLATION"
  | "DUPLICATE_TIMESTAMP"
  | "GAP_DETECTED"
  | "MISSING_OHLC"
  | "INVALID_TIMESTAMP";

export interface NormalizeResult {
  isValid: boolean;
  errorCode?: NormalizeErrorCode;
  errorMessage?: string;
  candle?: ArenaCandle;
}
