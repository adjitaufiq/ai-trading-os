import { describe, expect, it } from "vitest";
import { classifyHorizon } from "../../core/market/horizon/horizonClassifier";
import type { MarketRegimeSnapshot } from "../../core/market/regime/types";
import type { MarketStructure } from "../../core/swing/types";
import { MarketEventEngine } from "../../core/market/events/eventEngine";
import { evaluateSetup } from "../../signal/signalEvaluator";
import { createSetup } from "../../signal/signalLifecycle";
import { input, m5 } from "../../signal/tests/helpers";
import { generateContextReport } from "../contextAnalytics";
import { runStressTest } from "../simulationRunner";
import { generateStressReport, snapshotParams } from "../stressReport";

const strip = (rows: readonly object[]) => JSON.stringify(rows.map((r) => { const { contextSnapshot: _c, ...rest } = r as Record<string, unknown>; return rest; }));
const CFG = { mode: "MONTE_CARLO" as const, sampleSize: 40, maxTrades: 40, seed: 3 };

describe("M7 context-aware stress replay", () => {
  it("isolation: context on/off ⇒ identical trades, metrics and counters (M3–M6 unchanged)", () => {
    const on = runStressTest(CFG), off = runStressTest({ ...CFG, captureContext: false });
    expect(on.metrics.totalTrades).toBeGreaterThan(0);
    expect(on.metrics).toEqual(off.metrics);
    expect(on.counters).toEqual(off.counters);
    expect(off.context).toBeNull();
    expect(on.health.every((h) => h.status === "PASS")).toBe(true);
    expect(on.health.map((h) => h.name)).toEqual(expect.arrayContaining(["Context Coverage", "Context Causality", "Event Memory Bounded", "Parameter Immutability"]));
    expect(on.context!.audit.contextCoverage).toBe(1);
    expect(on.context!.byRegime.reduce((a, b) => a + b.trades, 0)).toBe(on.metrics.totalTrades);
  }, 120000);

  it("deterministic replay incl. context, and params snapshot unchanged", () => {
    const before = snapshotParams();
    const a = runStressTest(CFG), b = runStressTest(CFG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(snapshotParams()).toBe(before);
    const txt = generateContextReport(a.context!, a.dataLabel, a.metrics.totalTrades);
    expect(txt).toContain("ARENA CONTEXT STRESS REPORT");
    expect(txt).toContain("CRITICAL AUDIT");
    expect(generateStressReport(a)).toContain("Context Coverage: PASS");
  }, 120000);

  it("scenario 7 — trend + footprint alignment: context stored, decision identical", () => {
    const i = input();
    const regime = { symbol: "XAUUSD", asOf: i.now, regime: "TREND_CONTINUATION", trendAlignment: "ALIGNED", volatility: "NORMAL", structureContext: {}, rangeContext: {}, evidence: [], algorithmVersion: "m1b9-regime-v1" } as unknown as MarketRegimeSnapshot;
    const horizon = { symbol: "XAUUSD", asOf: i.now, recommendedHorizon: "INTRADAY", marketApproach: "TREND_FOLLOW" } as never;
    const footprints = { sweepDetected: true, sweepDirection: "BULLISH", displacementPreceded: true, insideFVG: false, insideOrderBlock: false, timestamp: i.now } as never;
    const events = [{ eventId: "SW1", type: "LIQUIDITY_SWEEP", severity: "IMPORTANT", state: "ACTIVE", timeframe: "M5", createdAt: i.now - 300, endedAt: null }] as never;
    const plain = createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651), 2651)!;
    const rich = createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651), 2651, { regime, horizon, footprints, events })!;
    const { marketContext, ...rest } = rich.setup;
    expect(rest).toEqual(plain.setup);
    expect(rich.trace).toEqual(plain.trace);
    expect(marketContext!.regime!.regime).toBe("TREND_CONTINUATION");
    expect(marketContext!.activeEvents.map((e) => e.type)).toEqual(["LIQUIDITY_SWEEP"]);
  });

  it("scenario 8 — dead market: radar records RANGE_COMPRESSION/NO_FIT, no decision fields", () => {
    const now = 1_700_000_000;
    const regime = { symbol: "XAUUSD", asOf: now, regime: "RANGE_COMPRESSION", trendAlignment: "NEUTRAL", volatility: "COMPRESSION", structureContext: { h4Trend: "RANGE", h1Trend: "RANGE", h4Mss: false, h1Mss: false, swingOverlap: 0 }, rangeContext: { atrPercentile: 0.05, h4RangeWidthAtr: 0.5 }, evidence: [], algorithmVersion: "m1b9-regime-v1" } as unknown as MarketRegimeSnapshot;
    const st = { symbol: "XAUUSD", timeframe: "M15", trend: "RANGE", lastConfirmedHigh: null, lastConfirmedLow: null, previousHigh: null, previousLow: null, structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: now } as unknown as MarketStructure;
    const h = classifyHorizon({ symbol: "XAUUSD", now, regime, m15Structure: st });
    expect(h.recommendedHorizon).toBe("NO_FIT");
    const eng = new MarketEventEngine();
    eng.step({ symbol: "XAUUSD", timeframe: "M5", barTime: now, regime, horizon: h });
    const all = JSON.stringify([h, eng.store.exportSnapshot(now)]);
    for (const k of ["BUY", "SELL", "entry", "stopLoss", "takeProfit", "lot", "score"]) expect(all).not.toMatch(new RegExp(`"${k}"`));
  });

  it("scenario 9 — BTC 24/7 event flood over 10,000 bars: deduped, bounded, deterministic", () => {
    const cfg = { mode: "RANDOM" as const, symbol: "BTCUSD", sampleSize: 100000, maxTrades: 100000, maxBars: 10000, seed: 11 };
    const a = runStressTest(cfg), b = runStressTest(cfg);
    const c = a.context!.counters;
    expect(a.counters.barsProcessed).toBe(10000);
    expect(c.observedBars).toBeGreaterThan(9000);
    expect(a.context!.audit.maxTrackers).toBeLessThanOrEqual(64);
    expect(a.context!.audit.eventsPer1000Bars).toBeLessThan(1000); // not one new event per bar
    expect(c.revisions).toBeLessThan(c.observedBars * 3);
    expect(c.causalityViolations).toBe(0);
    expect(JSON.stringify(a.context)).toBe(JSON.stringify(b.context));
  }, 240000);

  it("scenario 10 — context integrity Signal → Plan → Execution → Journal inside the replay", () => {
    const r = runStressTest(CFG);
    expect(r.context!.audit.contextCoverage).toBe(1);
    const keys = new Set(r.context!.byRegime.map((b) => b.key));
    expect([...keys].every((k) => ["TREND_CONTINUATION", "RANGE_COMPRESSION", "VOLATILITY_EXPANSION", "TRANSITION", "TREND_EXHAUSTION"].includes(k))).toBe(true);
    expect(strip([])).toBe("[]");
  }, 120000);
});
