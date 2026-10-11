import { describe, expect, it } from "vitest";
import { resolveMarketSession } from "../../../core/temporal/MarketSessionResolver";
import { generatePath } from "../scenarioGenerator";
import { runMultiAssetReplay } from "../dualAssetReplay";
import { runStressTest } from "../simulationRunner";
import { snapshotParams } from "../stressReport";

const BARS = 8000; // ~4 weeks of M5 → several weekends
const xauPath = generatePath("XAUUSD", 21, BARS);
const btcPath = generatePath("BTCUSD", 22, BARS);
const run = (symbol: string, bars = symbol === "XAUUSD" ? xauPath : btcPath) =>
  runStressTest({ symbol, mode: "HISTORICAL_REPLAY", historicalBars: bars.map((b) => b.raw), sampleSize: 1000, maxTrades: 1000, maxBars: BARS, disableHumanApproval: true });
const xau = run("XAUUSD");
const btc = run("BTCUSD");
const dow = (sec: number) => new Date(sec * 1000).getUTCDay();

describe("BTC 24/7", () => {
  it("continuity: every step is +300s across Fri→Sat→Sun→Mon", () => {
    for (let i = 1; i < btcPath.length; i++) expect(btcPath[i]!.raw.time - btcPath[i - 1]!.raw.time).toBe(300);
    expect(new Set(btcPath.map((b) => dow(b.raw.time)))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    expect(btc.counters.barsProcessed).toBe(BARS);
    expect(btc.calendarGapsAccepted).toBe(0);
  });
  it("weekend session tagging", () => {
    for (const b of btcPath) {
      const d = dow(b.raw.time);
      expect(b.session).toBe(d === 0 || d === 6 ? "WEEKEND" : resolveMarketSession(b.raw.time * 1000, "CRYPTO"));
      expect(b.session).not.toBe("MARKET_CLOSED");
    }
  });
  it("context keeps updating through weekends (no reset)", () => {
    expect(btc.context!.counters.observedBars).toBeGreaterThan(0);
    expect(btc.context!.audit.causalityViolations).toBe(0);
  });
});

describe("XAU calendar", () => {
  it("no bars emitted inside the closed window", () => {
    for (const b of xauPath) expect(resolveMarketSession(b.raw.time * 1000, "COMMODITY")).not.toBe("MARKET_CLOSED");
    expect(xauPath.some((b) => dow(b.raw.time) === 6)).toBe(false);
  });
  it("reopen jumps to Sunday 22:00 UTC and the pipeline accepts it", () => {
    const jumps = xauPath.filter((b, i) => i > 0 && b.raw.time - xauPath[i - 1]!.raw.time > 300);
    expect(jumps.length).toBeGreaterThanOrEqual(3);
    for (const j of jumps) { const d = new Date(j.raw.time * 1000); expect([d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes()]).toEqual([0, 22, 0]); }
    expect(xau.calendarGapsAccepted).toBe(jumps.length);
    expect(xau.counters.barsProcessed).toBe(BARS);
  });
  it("zero trades opened or journaled in MARKET_CLOSED", () => {
    for (const t of xau.trades!) expect(t.session).not.toBe("MARKET_CLOSED");
  });
  it("a gap NOT explained by the calendar is still rejected", () => {
    const holed = xauPath.filter((_, i) => i < 100 || i > 110).map((b) => b.raw);
    const r = runStressTest({ symbol: "XAUUSD", mode: "HISTORICAL_REPLAY", historicalBars: holed, maxBars: 300, disableHumanApproval: true });
    expect(r.counters.barsProcessed).toBe(100);
  });
});

describe("dual replay M1B.8–M6.5", () => {
  it("both symbols produce trades with complete journal rows and causal context", () => {
    for (const [r, ac] of [[xau, "COMMODITY"], [btc, "CRYPTO"]] as const) {
      expect(r.trades!.length).toBeGreaterThan(0);
      expect(r.context!.audit.causalityViolations).toBe(0);
      expect(r.health.every((h) => h.status === "PASS")).toBe(true);
      for (const t of r.trades!) {
        expect(t.assetClass).toBe(ac);
        expect(t.session).toBe(resolveMarketSession(t.openedAt * 1000, ac));
        expect(t.latencyMs).toBe(0);
        for (const k of ["plannedEntryPrice", "actualEntryPrice", "slippagePoints"] as const) expect(Number.isFinite(t[k])).toBe(true);
        expect(t.contextSnapshot).toBeDefined();
      }
    }
  });
  it("params unchanged by the dual run", () => {
    const before = JSON.stringify(snapshotParams());
    run("BTCUSD");
    expect(JSON.stringify(snapshotParams())).toBe(before);
  });
});

describe("cross-symbol isolation", () => {
  it("combined BTC+XAU feed gives identical XAU result to XAU alone", () => {
    const mixed = xauPath.flatMap((b, i) => [b.raw, btcPath[i]!.raw]);
    const res = runMultiAssetReplay(mixed, { sampleSize: 1000, maxTrades: 1000, maxBars: BARS });
    expect(JSON.stringify(res["XAUUSD"]!.trades)).toBe(JSON.stringify(xau.trades));
    expect(res["XAUUSD"]!.metrics).toEqual(xau.metrics);
    expect(res["XAUUSD"]!.context).toEqual(xau.context);
    expect(JSON.stringify(res["BTCUSD"]!.trades)).toBe(JSON.stringify(btc.trades));
  }, 30_000); // CPU-bound 2×8000-bar replay; deterministic, no shared mutable state — only slow under full-suite CPU contention
  it("same price, different meaning: identical prices never share levels or rows", () => {
    const clone = xauPath.map((b) => ({ ...b.raw, symbol: "BTCUSD" }));
    const res = runMultiAssetReplay([...xauPath.map((b) => b.raw), ...clone], { sampleSize: 1000, maxTrades: 1000, maxBars: BARS });
    expect(JSON.stringify(res["XAUUSD"]!.trades)).toBe(JSON.stringify(xau.trades));
    for (const t of res["BTCUSD"]!.trades!) { expect(t.symbol).toBe("BTCUSD"); expect(t.assetClass).toBe("CRYPTO"); }
    for (const t of res["XAUUSD"]!.trades!) expect(t.symbol).toBe("XAUUSD");
  });
});
