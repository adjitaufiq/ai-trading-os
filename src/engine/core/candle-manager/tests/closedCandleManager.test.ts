// M1B.2 — unit tests for Closed Candle Manager & Anti-Repaint Calculation Gate.
import { describe, expect, it } from "vitest";

import { validateAndNormalize } from "../../normalizer/normalizer";
import type { ArenaCandle } from "../../normalizer/types";
import { ClosedCandleManager, calculationLockGate, evaluateCandleStatus } from "./closedCandleManager";

function makeCandle(overrides: Partial<ArenaCandle> = {}): ArenaCandle {
  return {
    id: "XAUUSD_M5_100",
    symbol: "XAUUSD",
    timeframe: "M5",
    timestamp: 100,
    open: 2000,
    high: 2010,
    low: 1995,
    close: 2005,
    volume: 100,
    spread: 0.2,
    source: "MOCK",
    isClosed: true,
    sequence: 1,
    ...overrides,
  };
}

function normalized(symbol = "XAUUSD", time: number, last?: ArenaCandle): ArenaCandle {
  const result = validateAndNormalize({ symbol, time, o: 1, h: 2, l: 1, c: 2, source: "MOCK" }, "M5", last);
  if (!result.isValid || !result.candle) throw new Error(`normalizer rejected: ${result.errorCode}`);
  return result.candle;
}

describe("evaluateCandleStatus", () => {
  it("PASS: M5 candle closed exactly at boundary (timestamp+300) returns CLOSED", () => {
    const candle = makeCandle({ timestamp: 100, timeframe: "M5" });
    expect(evaluateCandleStatus(candle, 400)).toBe("CLOSED");
  });

  it("PASS: candle not yet at interval boundary returns RUNNING", () => {
    const candle = makeCandle({ timestamp: 100, timeframe: "M5" });
    expect(evaluateCandleStatus(candle, 399)).toBe("RUNNING");
  });

  it("PASS: running candle (isClosed=false) returns RUNNING even past boundary", () => {
    const candle = makeCandle({ isClosed: false });
    expect(evaluateCandleStatus(candle, 10_000)).toBe("RUNNING");
  });

  it("PASS: M15 boundary uses 900s, H1 3600s, H4 14400s", () => {
    expect(evaluateCandleStatus(makeCandle({ timeframe: "M15", timestamp: 0 }), 900)).toBe("CLOSED");
    expect(evaluateCandleStatus(makeCandle({ timeframe: "M15", timestamp: 0 }), 899)).toBe("RUNNING");
    expect(evaluateCandleStatus(makeCandle({ timeframe: "H1", timestamp: 0 }), 3600)).toBe("CLOSED");
    expect(evaluateCandleStatus(makeCandle({ timeframe: "H1", timestamp: 0 }), 3599)).toBe("RUNNING");
    expect(evaluateCandleStatus(makeCandle({ timeframe: "H4", timestamp: 0 }), 14400)).toBe("CLOSED");
    expect(evaluateCandleStatus(makeCandle({ timeframe: "H4", timestamp: 0 }), 14399)).toBe("RUNNING");
  });

  it("PASS: non-finite OHLC returns INVALID", () => {
    expect(evaluateCandleStatus(makeCandle({ close: Number.NaN }), 10_000)).toBe("INVALID");
  });
});

describe("calculationLockGate", () => {
  it("PASS: closed candle allows calculation with READY and the candle", () => {
    const candle = makeCandle({ isClosed: true });
    const result = calculationLockGate(candle);
    expect(result).toEqual({ canCalculate: true, reason: "READY", candle });
  });

  it("FAIL: running candle (isClosed=false) blocks calculation", () => {
    const candle = makeCandle({ isClosed: false });
    const result = calculationLockGate(candle);
    expect(result).toEqual({ canCalculate: false, reason: "WAITING_CANDLE_CLOSE" });
    expect(result.candle).toBeUndefined();
  });
});

describe("ClosedCandleManager — freshness telemetry", () => {
  it("PASS: fresh data returns SYNCED", () => {
    const manager = new ClosedCandleManager();
    manager.recordClosedCandle("XAUUSD", "M5", makeCandle({ timestamp: 1000 }));
    const telemetry = manager.getFreshnessTelemetry("XAUUSD", "M5", 1100);
    expect(telemetry.processingState).toBe("SYNCED");
    expect(telemetry.lastClosedTimestamp).toBe(1000);
    expect(telemetry.ageSeconds).toBe(100);
  });

  it("PASS: data older than 2x interval returns WAITING_DATA", () => {
    const manager = new ClosedCandleManager();
    manager.recordClosedCandle("XAUUSD", "M5", makeCandle({ timestamp: 1000 }));
    // interval*2 = 600s; age 601s => WAITING_DATA
    const telemetry = manager.getFreshnessTelemetry("XAUUSD", "M5", 1601);
    expect(telemetry.processingState).toBe("WAITING_DATA");
    expect(telemetry.ageSeconds).toBe(601);
  });

  it("PASS: exactly 2x interval is still SYNCED (strictly greater rule)", () => {
    const manager = new ClosedCandleManager();
    manager.recordClosedCandle("XAUUSD", "M5", makeCandle({ timestamp: 1000 }));
    expect(manager.getFreshnessTelemetry("XAUUSD", "M5", 1600).processingState).toBe("SYNCED");
  });

  it("PASS: series with no sync data returns WAITING_DATA with zero timestamps", () => {
    const manager = new ClosedCandleManager();
    const telemetry = manager.getFreshnessTelemetry("BTCUSD", "H1", 5000);
    expect(telemetry).toEqual({
      symbol: "BTCUSD",
      timeframe: "H1",
      lastClosedTimestamp: 0,
      lastSyncTimestamp: 0,
      ageSeconds: 0,
      processingState: "WAITING_DATA",
    });
  });

  it("PASS: series tracked via raw-normalized candles feed telemetry correctly", () => {
    const manager = new ClosedCandleManager();
    const c1 = normalized("XAUUSD", 300);
    const c2 = normalized("XAUUSD", 600, c1);
    manager.recordClosedCandle("XAUUSD", "M5", c1);
    manager.recordClosedCandle("XAUUSD", "M5", c2);
    expect(manager.getFreshnessTelemetry("XAUUSD", "M5", 700)).toMatchObject({
      lastClosedTimestamp: 600,
      processingState: "SYNCED",
    });
  });
});

describe("ClosedCandleManager — backfill protection", () => {
  it("PASS: GAP_DETECTED locks the series with BACKFILLING telemetry", () => {
    const manager = new ClosedCandleManager();
    const c1 = normalized("XAUUSD", 300);
    manager.recordClosedCandle("XAUUSD", "M5", c1);

    // Simulate the normalizer rejecting a gap (delta > interval).
    const gapResult = validateAndNormalize({ symbol: "XAUUSD", time: 1500, o: 1, h: 2, l: 1, c: 2 }, "M5", c1);
    expect(gapResult.isValid).toBe(false);
    expect(gapResult.errorCode).toBe("GAP_DETECTED");
    manager.reportGap("XAUUSD", "M5");

    expect(manager.isBackfillRequired("XAUUSD", "M5")).toBe(true);
    expect(manager.getFreshnessTelemetry("XAUUSD", "M5", 1500).processingState).toBe("BACKFILLING");
  });

  it("FAIL: gate blocks calculation while gap is un-repaired (BACKFILL_REQUIRED)", () => {
    const manager = new ClosedCandleManager();
    const c1 = normalized("XAUUSD", 300);
    manager.recordClosedCandle("XAUUSD", "M5", c1);
    manager.reportGap("XAUUSD", "M5");

    const candle = makeCandle({ symbol: "XAUUSD", timeframe: "M5", timestamp: 900, isClosed: true });
    const result = manager.gateCalculation(candle, 1000);
    expect(result).toEqual({ canCalculate: false, reason: "BACKFILL_REQUIRED" });
  });

  it("PASS: resolveBackfill re-syncs the series and unlocks calculation", () => {
    const manager = new ClosedCandleManager();
    const c1 = normalized("XAUUSD", 300);
    manager.recordClosedCandle("XAUUSD", "M5", c1);
    manager.reportGap("XAUUSD", "M5");

    const repaired = normalized("XAUUSD", 900);
    manager.resolveBackfill("XAUUSD", "M5", repaired);
    expect(manager.isBackfillRequired("XAUUSD", "M5")).toBe(false);

    const telemetry = manager.getFreshnessTelemetry("XAUUSD", "M5", 1000);
    expect(telemetry.processingState).toBe("SYNCED");
    expect(telemetry.lastClosedTimestamp).toBe(900);

    const candle = makeCandle({ timestamp: 900, isClosed: true });
    expect(manager.gateCalculation(candle, 1000)).toMatchObject({ canCalculate: true, reason: "READY" });
  });
});

describe("ClosedCandleManager — gateCalculation end to end", () => {
  it("FAIL: running candle blocks calculation even when series is synced", () => {
    const manager = new ClosedCandleManager();
    manager.recordClosedCandle("XAUUSD", "M5", makeCandle({ timestamp: 1000 }));
    const candle = makeCandle({ timestamp: 1050, isClosed: false });
    expect(manager.gateCalculation(candle, 1100)).toEqual({
      canCalculate: false,
      reason: "WAITING_CANDLE_CLOSE",
    });
  });

  it("FAIL: stale series blocks calculation with STALE_DATA", () => {
    const manager = new ClosedCandleManager();
    manager.recordClosedCandle("XAUUSD", "M5", makeCandle({ timestamp: 1000 }));
    const candle = makeCandle({ timestamp: 1000, isClosed: true });
    expect(manager.gateCalculation(candle, 1601)).toEqual({ canCalculate: false, reason: "STALE_DATA" });
  });

  it("PASS: synced series + closed candle => READY", () => {
    const manager = new ClosedCandleManager();
    manager.recordClosedCandle("XAUUSD", "M5", makeCandle({ timestamp: 1000 }));
    const candle = makeCandle({ timestamp: 1000, isClosed: true });
    const result = manager.gateCalculation(candle, 1100);
    expect(result.canCalculate).toBe(true);
    expect(result.reason).toBe("READY");
    expect(result.candle).toEqual(candle);
  });
});
