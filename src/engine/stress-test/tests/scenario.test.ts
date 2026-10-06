import { describe, expect, it } from "vitest";
import { validateAndNormalize } from "../../core/normalizer/normalizer";
import type { ArenaCandle } from "../../core/normalizer/types";
import { generatePath, generateSegment, mulberry32 } from "../scenarioGenerator";
import { ALL_SCENARIOS, STRESS_ENV, type MarketScenario } from "../types";

const seg = (sc: MarketScenario, n = 600, seed = 7) =>
  generateSegment("XAUUSD", sc, n, mulberry32(seed), { price: STRESS_ENV.BASE_PRICE, ts: STRESS_ENV.START_TS, i: 0 }).map((b) => b.raw);
const avgRange = (bars: ReturnType<typeof seg>) => bars.reduce((a, b) => a + (b.high! - b.low!), 0) / bars.length;
const avgSpread = (bars: ReturnType<typeof seg>) => bars.reduce((a, b) => a + b.spread!, 0) / bars.length;

describe("scenario generator", () => {
  it("deterministic for same seed, differs for other seed", () => {
    expect(generatePath("XAUUSD", 3, 500)).toEqual(generatePath("XAUUSD", 3, 500));
    expect(generatePath("XAUUSD", 3, 500)).not.toEqual(generatePath("XAUUSD", 4, 500));
  });
  it("every bar passes M1B.1 normalizer (OHLC integrity, no gaps, MOCK source)", () => {
    let last: ArenaCandle | undefined;
    for (const { raw } of generatePath("XAUUSD", 11, 3000)) {
      const r = validateAndNormalize(raw, "M5", last);
      expect(r.isValid).toBe(true);
      expect(r.candle!.source).toBe("MOCK");
      last = r.candle;
    }
  });
  it("covers all six scenarios across a long path", () => {
    const seen = new Set(generatePath("XAUUSD", 5, STRESS_ENV.SEGMENT_BARS * 30).map((b) => b.scenario));
    for (const s of ALL_SCENARIOS) expect(seen.has(s)).toBe(true);
  });
  it("HIGH_VOLATILITY wider than NORMAL_TREND; LOW_LIQUIDITY narrower with wider spread", () => {
    expect(avgRange(seg("HIGH_VOLATILITY"))).toBeGreaterThan(avgRange(seg("NORMAL_TREND")) * 2);
    expect(avgRange(seg("LOW_LIQUIDITY"))).toBeLessThan(avgRange(seg("NORMAL_TREND")));
    expect(avgSpread(seg("LOW_LIQUIDITY"))).toBeGreaterThan(avgSpread(seg("NORMAL_TREND")));
  });
  it("RANGE_MARKET mean-reverts near its start; NORMAL_TREND drifts", () => {
    const r = seg("RANGE_MARKET", 1500), t = seg("NORMAL_TREND", 1500);
    expect(Math.abs(r.at(-1)!.close! - STRESS_ENV.BASE_PRICE)).toBeLessThan(30);
    expect(Math.abs(t.at(-1)!.close! - STRESS_ENV.BASE_PRICE)).toBeGreaterThan(50);
  });
  it("LIQUIDITY_HUNT emits periodic long wicks", () => {
    const b = seg("LIQUIDITY_HUNT", 450);
    const spikes = b.filter((x) => x.high! - x.low! > 3.2);
    expect(spikes.length).toBeGreaterThanOrEqual(8);
  });
});
