import { describe, expect, it } from "vitest";
import type { ArenaCandle } from "../../normalizer/types";
import type { MarketStructure, SwingPoint } from "../../swing/types";
import { classifyPriceLocation, computeAtr } from "../priceLocationEngine";

const T0 = 1_700_000_000;
// 20 closed M15 candles with constant true range 4 → ATR14 = 4.
function candles(n = 20, runningExtreme?: number): ArenaCandle[] {
  const out: ArenaCandle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `c${i}`, symbol: "XAUUSD", timeframe: "M15", timestamp: T0 + i * 900,
      open: 2660, high: 2662, low: 2658, close: 2660, volume: 0, spread: 0, source: "MT5", isClosed: true, sequence: i + 1 });
  }
  if (runningExtreme !== undefined)
    out.push({ ...out[n - 1], id: "run", timestamp: T0 + n * 900, high: runningExtreme, low: 2600, isClosed: false, sequence: n + 1 });
  return out;
}
function sw(type: "HIGH" | "LOW", price: number, confirmedAt = T0): SwingPoint {
  return { id: `${type}_${price}`, symbol: "XAUUSD", timeframe: "M15", type, price, timestamp: confirmedAt - 2700,
    confirmedAt, strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0 };
}
function struct(low: number, high: number, confirmedAt = T0): MarketStructure {
  return { symbol: "XAUUSD", timeframe: "M15", trend: "RANGE", lastConfirmedHigh: sw("HIGH", high, confirmedAt),
    lastConfirmedLow: sw("LOW", low, confirmedAt), previousHigh: null, previousLow: null,
    structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: confirmedAt };
}
const NOW = T0 + 20 * 900;
const run = (price: number, s = struct(2650.5, 2670), c = candles()) =>
  classifyPriceLocation({ currentPrice: price, m15Structure: s, m15Candles: c, now: NOW });

describe("M1B.5 price location", () => {
  it("ATR from closed candles = 4", () => expect(computeAtr(candles())).toBe(4));

  it("near support → AT_SUPPORT / TIER_1_CORE with distance", () => {
    const r = run(2651.5);
    expect(r.ok && r.context).toMatchObject({ priceLocation: "AT_SUPPORT", locationTier: "TIER_1_CORE",
      keyLevelPrice: 2650.5, distanceToLevel: 1, nearestLevelType: "SUPPORT", rangePosition: "LOWER_RANGE" });
  });

  it("near resistance → AT_RESISTANCE / TIER_1_CORE", () => {
    const r = run(2669.2);
    expect(r.ok && r.context).toMatchObject({ priceLocation: "AT_RESISTANCE", locationTier: "TIER_1_CORE", nearestLevelType: "RESISTANCE" });
  });

  it("between levels → MID_RANGE / NO_TIER", () => {
    const r = run(2660);
    expect(r.ok && r.context).toMatchObject({ priceLocation: "MID_RANGE", locationTier: "NO_TIER", rangePosition: "MID_RANGE" });
  });

  it("slight pierce without CLOSED break → BREAKOUT_WAITING / TIER_3_PENDING", () => {
    const r = run(2670.5); // 0.5 <= 0.15*4=0.6, last close 2660 < 2670
    expect(r.ok && r.context).toMatchObject({ priceLocation: "BREAKOUT_WAITING", locationTier: "TIER_3_PENDING", keyLevelPrice: 2670 });
    const s = run(2650.0);
    expect(s.ok && s.context.priceLocation).toBe("BREAKOUT_WAITING");
  });

  it("deep pierce is not BREAKOUT_WAITING", () => {
    const r = run(2672);
    expect(r.ok && r.context).toMatchObject({ priceLocation: "MID_RANGE", locationTier: "NO_TIER" });
  });

  it("uses confirmed swings only (unconfirmed at now → no levels)", () => {
    const r = classifyPriceLocation({ currentPrice: 2651, m15Structure: struct(2650.5, 2670, NOW + 900), m15Candles: candles(), now: NOW });
    expect(r).toEqual({ ok: false, reason: "NO_CONFIRMED_LEVELS" });
  });

  it("ignores running candle for ATR and break confirmation", () => {
    expect(computeAtr(candles(20, 2800))).toBe(4);
    const r = run(2651.5, struct(2650.5, 2670), candles(20, 2800));
    expect(r.ok && r.context.priceLocation).toBe("AT_SUPPORT");
  });

  it("rejects non-M15 structure and insufficient ATR history", () => {
    expect(run(2660, { ...struct(2650.5, 2670), timeframe: "H1" })).toEqual({ ok: false, reason: "NOT_M15_STRUCTURE" });
    expect(run(2660, struct(2650.5, 2670), candles(10))).toEqual({ ok: false, reason: "INSUFFICIENT_ATR_HISTORY" });
  });
});
