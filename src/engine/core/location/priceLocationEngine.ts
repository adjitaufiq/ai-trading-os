import type { ArenaCandle } from "../normalizer/types";
import type { MarketStructure } from "../swing/types";
import type { MarketBiasState } from "../bias/types";
import {
  LOCATION_PARAMS as P,
  type PriceContext,
  type RangePosition,
} from "./types";

/** Wilder ATR over CLOSED candles only (running candles are discarded). */
export function computeAtr(candles: readonly ArenaCandle[], period: number = P.ATR_PERIOD): number | null {
  const closed = candles.filter((c) => c.isClosed);
  if (closed.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < closed.length; i++) {
    const c = closed[i], prev = closed[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

export function classifyRangePosition(price: number, low: number, high: number): RangePosition {
  if (!(high > low)) return "MID_RANGE";
  const pos = (price - low) / (high - low);
  if (pos < P.RANGE_LOWER_BOUND) return "LOWER_RANGE";
  if (pos > P.RANGE_UPPER_BOUND) return "UPPER_RANGE";
  return "MID_RANGE";
}

export interface LocationInput {
  currentPrice: number;
  /** Confirmed M15 structure from M1B.3. */
  m15Structure: MarketStructure;
  /** M15 candles; only isClosed===true are used. */
  m15Candles: readonly ArenaCandle[];
  /** Optional M1B.4 bias — informational only (appended to description). */
  bias?: MarketBiasState;
  now: number;
}

export type LocationResult =
  | { ok: true; context: PriceContext }
  | { ok: false; reason: "NOT_M15_STRUCTURE" | "NO_CONFIRMED_LEVELS" | "INSUFFICIENT_ATR_HISTORY" | "INVALID_PRICE" };

export function classifyPriceLocation(input: LocationInput): LocationResult {
  const { currentPrice: price, m15Structure: s, m15Candles, bias, now } = input;
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "INVALID_PRICE" };
  if (s.timeframe !== "M15") return { ok: false, reason: "NOT_M15_STRUCTURE" };
  // Only swings already confirmed at `now` are usable.
  const sup = s.lastConfirmedLow && s.lastConfirmedLow.confirmedAt <= now ? s.lastConfirmedLow.price : null;
  const res = s.lastConfirmedHigh && s.lastConfirmedHigh.confirmedAt <= now ? s.lastConfirmedHigh.price : null;
  if (sup === null || res === null) return { ok: false, reason: "NO_CONFIRMED_LEVELS" };
  const atr = computeAtr(m15Candles);
  if (atr === null || atr <= 0) return { ok: false, reason: "INSUFFICIENT_ATR_HISTORY" };

  const closed = m15Candles.filter((c) => c.isClosed);
  const lastClose = closed[closed.length - 1].close;
  const rangeLow = Math.min(sup, res), rangeHigh = Math.max(sup, res);
  const rangePosition = classifyRangePosition(price, rangeLow, rangeHigh);
  const biasNote = bias ? ` | bias ${bias.overallBias}/${bias.alignment}` : "";

  const build = (
    priceLocation: PriceContext["priceLocation"],
    locationTier: PriceContext["locationTier"],
    level: number,
    nearestLevelType: PriceContext["nearestLevelType"],
    description: string,
  ): LocationResult => {
    const distanceToLevel = round(Math.abs(price - level));
    return {
      ok: true,
      context: Object.freeze({
        currentPrice: price, priceLocation, locationTier, keyLevelPrice: level,
        distanceToLevel, distancePercent: round((distanceToLevel / price) * 100, 6),
        nearestLevelType, rangePosition, description: description + biasNote, lastUpdated: now,
      }),
    };
  };

  const dSup = price - sup; // >=0 above support
  const dRes = res - price; // >=0 below resistance
  const atLvl = atr * P.AT_LEVEL_ATR_MULT;
  const brk = atr * P.BREAKOUT_WAITING_ATR_MULT;

  if (dSup >= 0 && dSup <= atLvl)
    return build("AT_SUPPORT", "TIER_1_CORE", sup, "SUPPORT", `Price at confirmed M15 support ${sup}`);
  if (dRes >= 0 && dRes <= atLvl)
    return build("AT_RESISTANCE", "TIER_1_CORE", res, "RESISTANCE", `Price at confirmed M15 resistance ${res}`);
  // AT_SUPPLY_DEMAND: no source in v1.
  if (dRes < 0 && -dRes <= brk && lastClose <= res)
    return build("BREAKOUT_WAITING", "TIER_3_PENDING", res, "RESISTANCE", `Testing above resistance ${res}, no CLOSED break — do not chase`);
  if (dSup < 0 && -dSup <= brk && lastClose >= sup)
    return build("BREAKOUT_WAITING", "TIER_3_PENDING", sup, "SUPPORT", `Testing below support ${sup}, no CLOSED break — do not chase`);

  const nearSup = Math.abs(dSup) <= Math.abs(dRes);
  const level = nearSup ? sup : res;
  const outside = price < rangeLow || price > rangeHigh;
  return build("MID_RANGE", "NO_TIER", level, nearSup ? "SUPPORT" : "RESISTANCE",
    outside ? "Price outside confirmed M15 range (level broken) — awaiting new structure"
      : `Price in ${rangePosition} away from key levels — not an entry location`);
}

function round(n: number, dp = 8): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
