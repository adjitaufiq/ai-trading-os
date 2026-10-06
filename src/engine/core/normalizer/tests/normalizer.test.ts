import { describe, expect, it } from "vitest";
import { validateAndNormalize } from "../normalizer";
import { CandleStore, MAX_CANDLES_PER_SERIES } from "../candleStore";
import type { RawGatewayPayload } from "../types";

const base: RawGatewayPayload = {
  symbol: "XAUUSD",
  time: 1_700_000_000,
  open: 2000,
  high: 2015,
  low: 1995,
  close: 2010,
  volume: 123,
  spread: 2,
  source: "MT5",
};

describe("M1B.1 validateAndNormalize", () => {
  it("PASS: valid MT5 payload (long-form OHLC)", () => {
    const r = validateAndNormalize(base, "M5");
    expect(r.isValid).toBe(true);
    expect(r.candle).toMatchObject({
      symbol: "XAUUSD",
      timeframe: "M5",
      timestamp: base.time,
      open: 2000,
      high: 2015,
      low: 1995,
      close: 2010,
      volume: 123,
      spread: 2,
      source: "MT5",
      isClosed: true,
      sequence: 1,
    });
    expect(r.candle?.id).toBe("XAUUSD_M5_1700000000");
  });

  it("PASS: valid standard OHLC payload (short-form o/h/l/c)", () => {
    const r = validateAndNormalize(
      { symbol: "BTCUSD", time: 1_700_000_000, o: 60000, h: 60100, l: 59900, c: 60050 },
      "M15",
    );
    expect(r.isValid).toBe(true);
    expect(r.candle).toMatchObject({ open: 60000, high: 60100, low: 59900, close: 60050, source: "MOCK" });
  });

  it("FAIL: high lower than close → OHLC_INTEGRITY_VIOLATION", () => {
    const r = validateAndNormalize({ ...base, open: 2000, close: 2010, high: 2005 }, "M5");
    expect(r.isValid).toBe(false);
    expect(r.errorCode).toBe("OHLC_INTEGRITY_VIOLATION");
  });

  it("FAIL: low higher than open → OHLC_INTEGRITY_VIOLATION", () => {
    const r = validateAndNormalize({ ...base, open: 2000, close: 1990, low: 2005 }, "M5");
    expect(r.isValid).toBe(false);
    expect(r.errorCode).toBe("OHLC_INTEGRITY_VIOLATION");
  });

  it("FAIL: duplicate timestamp → DUPLICATE_TIMESTAMP", () => {
    const first = validateAndNormalize(base, "M5").candle!;
    const r = validateAndNormalize(base, "M5", first);
    expect(r.isValid).toBe(false);
    expect(r.errorCode).toBe("DUPLICATE_TIMESTAMP");
  });

  it("FAIL: gap larger than one interval → GAP_DETECTED, nothing fabricated", () => {
    const first = validateAndNormalize(base, "M5").candle!;
    const r = validateAndNormalize({ ...base, time: base.time + 600 }, "M5", first); // M5 = 300s
    expect(r.isValid).toBe(false);
    expect(r.errorCode).toBe("GAP_DETECTED");
  });

  it("PASS: exactly one interval later is not a gap", () => {
    const first = validateAndNormalize(base, "M5").candle!;
    const r = validateAndNormalize({ ...base, time: base.time + 300 }, "M5", first);
    expect(r.isValid).toBe(true);
  });

  it("VERIFY: sequence increments from lastCandle", () => {
    const first = validateAndNormalize(base, "M5").candle!;
    expect(first.sequence).toBe(1);
    const second = validateAndNormalize({ ...base, time: base.time + 300 }, "M5", first).candle!;
    expect(second.sequence).toBe(2);
    const third = validateAndNormalize({ ...base, time: base.time + 600 }, "M5", second).candle!;
    expect(third.sequence).toBe(3);
  });
});

describe("M1B.1 CandleStore", () => {
  const candleAt = (t: number) => validateAndNormalize({ ...base, time: t }, "M5").candle!;

  it("VERIFY: stores and retrieves per symbol+timeframe", () => {
    const store = new CandleStore();
    store.insert(candleAt(1_700_000_000));
    store.insert(candleAt(1_700_000_300));
    expect(store.size("XAUUSD", "M5")).toBe(2);
    expect(store.last("XAUUSD", "M5")?.timestamp).toBe(1_700_000_300);
    expect(store.size("BTCUSD", "M5")).toBe(0);
  });

  it("VERIFY: duplicate timestamps are never inserted", () => {
    const store = new CandleStore();
    expect(store.insert(candleAt(1_700_000_000))).toBe(true);
    expect(store.insert(candleAt(1_700_000_000))).toBe(false);
    expect(store.size("XAUUSD", "M5")).toBe(1);
  });

  it("VERIFY: max 500 candles per series, oldest evicted", () => {
    const store = new CandleStore();
    for (let i = 0; i < MAX_CANDLES_PER_SERIES + 10; i++) {
      store.insert(candleAt(1_700_000_000 + i * 300));
    }
    expect(store.size("XAUUSD", "M5")).toBe(MAX_CANDLES_PER_SERIES);
    const bars = store.get("XAUUSD", "M5");
    expect(bars[0]!.timestamp).toBe(1_700_000_000 + 10 * 300); // oldest 10 evicted
    expect(store.last("XAUUSD", "M5")?.timestamp).toBe(1_700_000_000 + (MAX_CANDLES_PER_SERIES + 9) * 300);
  });
});
