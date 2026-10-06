import type { ArenaCandle } from "../../normalizer/types";
import type { PriceContext, PriceLocation } from "../../location/types";
import type { EMAAction, EMAContext } from "../../ema/types";

export const T0 = 1_700_000_100;

export function c(i: number, open: number, high: number, low: number, close: number, isClosed = true): ArenaCandle {
  return {
    id: `m5_${i}`, symbol: "XAUUSD", timeframe: "M5", timestamp: T0 + i * 300,
    open, high, low, close, volume: 0, spread: 0, source: "MT5", isClosed, sequence: i + 1,
  };
}

export function loc(priceLocation: PriceLocation): PriceContext {
  return {
    currentPrice: 2000, priceLocation, locationTier: priceLocation === "MID_RANGE" ? "NO_TIER" : "TIER_1_CORE",
    keyLevelPrice: 2000, distanceToLevel: 0, distancePercent: 0,
    nearestLevelType: priceLocation === "AT_RESISTANCE" ? "RESISTANCE" : "SUPPORT",
    rangePosition: "MID_RANGE", description: "", lastUpdated: 0,
  };
}

export function ema(actions: EMAAction[]): EMAContext {
  return {
    symbol: "XAUUSD", timeframe: "M15",
    values: { symbol: "XAUUSD", timeframe: "M15", timestamp: 0, ema5: 2000, ema21: 2000, ema50: 2000 },
    slope21: "FLAT", slope50: "FLAT", pricePosition: "INSIDE_EMA_ZONE", actions,
    distanceToEMA21: 0, distanceToEMA50: 0, compression: false, expansion: false, updatedAt: 0,
  };
}
