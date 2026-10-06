import type { ArenaCandle } from "../../core/normalizer/types";
import type { MarketBias, MarketBiasState } from "../../core/bias/types";
import type { EMAAction, EMAContext, EMAPricePosition } from "../../core/ema/types";
import type { PriceContext, PriceLocation } from "../../core/location/types";
import type { ReactionResult } from "../../core/reaction/types";
import type { EvaluatorInput } from "../signalEvaluator";

export const T0 = 1_700_000_400;

export const m5 = (i: number, close: number, isClosed = true): ArenaCandle => ({
  id: `m5_${i}`, symbol: "XAUUSD", timeframe: "M5", timestamp: T0 + i * 300,
  open: close, high: close + 1, low: close - 1, close, volume: 0, spread: 0, source: "MT5", isClosed, sequence: i + 1,
});

export const bias = (b: MarketBias): MarketBiasState => ({
  symbol: "XAUUSD", overallBias: b,
  h4: { timeframe: "H4", bias: b, phase: "CONTINUATION", structure: "HH_HL", description: "" },
  h1: { timeframe: "H1", bias: b === "BULLISH" ? "BEARISH" : b, phase: "PULLBACK", structure: "LH_LL", description: "" },
  alignment: "COUNTER_TREND", lastUpdated: 0,
});

export const loc = (l: PriceLocation, type: "SUPPORT" | "RESISTANCE" = l === "AT_RESISTANCE" ? "RESISTANCE" : "SUPPORT", dist = 0.5): PriceContext => ({
  currentPrice: 2650.5, priceLocation: l, locationTier: "TIER_1_CORE", keyLevelPrice: 2650.5,
  distanceToLevel: dist, distancePercent: 0, nearestLevelType: type, rangePosition: "LOWER_RANGE", description: "", lastUpdated: 0,
});

export const ema = (actions: EMAAction[], pricePosition: EMAPricePosition = "INSIDE_EMA_ZONE"): EMAContext => ({
  symbol: "XAUUSD", timeframe: "M15",
  values: { symbol: "XAUUSD", timeframe: "M15", timestamp: 0, ema5: 0, ema21: 0, ema50: 0 },
  slope21: "FLAT", slope50: "FLAT", pricePosition, actions,
  distanceToEMA21: 0, distanceToEMA50: 0, compression: false, expansion: false, updatedAt: 0,
});

export const reaction = (dir: "BULLISH" | "BEARISH", quality: ReactionResult["quality"] = "STRONG", ts = T0): ReactionResult => ({
  symbol: "XAUUSD", timeframe: "M5", pattern: dir === "BULLISH" ? "BULLISH_REJECTION_WICK" : "BEARISH_ENGULFING",
  direction: dir, quality, isValid: quality === "STRONG" || quality === "MODERATE",
  locationConfirmed: true, emaContextConfirmed: true, candleTimestamp: ts, description: "",
});

export const input = (p: Partial<EvaluatorInput> = {}): EvaluatorInput => ({
  bias: bias("BULLISH"), priceContext: loc("AT_SUPPORT"), emaContext: ema(["EMA21_RETEST"]),
  reaction: reaction("BULLISH"), m15Atr: 4, m15StructureShift: "NONE", m15StructureValid: true,
  m5CandleClosed: true, dataStale: false, now: T0 + 300, ...p,
});
