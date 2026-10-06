import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePath } from "../scenarioGenerator";
import { runStressTest } from "../simulationRunner";
import { generateStressReport, snapshotParams } from "../stressReport";

describe("simulation runner", () => {
  const small = { sampleSize: 8, maxTrades: 8, seed: 1 };

  it("runs unattended end-to-end and all health checks PASS", () => {
    const r = runStressTest(small);
    expect(r.ok).toBe(true);
    expect(r.dataLabel).toBe("SIMULATION_SYNTHETIC");
    expect(r.metrics.totalTrades).toBe(8);
    expect(r.sampleReached).toBe(true);
    for (const h of r.health) expect(h.status, h.name).toBe("PASS");
    expect(r.counters.tradesOpened).toBeGreaterThanOrEqual(r.counters.tradesClosed);
  }, 60000);

  it("deterministic: same config ⇒ identical result", () => {
    expect(runStressTest(small)).toEqual(runStressTest(small));
  }, 60000);

  it("does not modify strategy parameters", () => {
    const before = snapshotParams();
    runStressTest(small);
    expect(snapshotParams()).toBe(before);
  }, 60000);

  it("RANDOM mode and maxTrades cap", () => {
    const r = runStressTest({ mode: "RANDOM", sampleSize: 50, maxTrades: 3, seed: 2 });
    expect(r.metrics.totalTrades).toBeLessThanOrEqual(3);
  }, 60000);

  it("HISTORICAL_REPLAY consumes supplied raw bars through normalizer", () => {
    const bars = generatePath("XAUUSD", 9, 6000).map((b) => b.raw);
    const r = runStressTest({ mode: "HISTORICAL_REPLAY", historicalBars: bars, sampleSize: 3, maxTrades: 3 });
    expect(r.ok).toBe(true);
    expect(r.dataLabel).toBe("HISTORICAL_REPLAY");
    expect(r.counters.barsProcessed).toBeGreaterThan(0);
    expect(r.byScenario.every((s) => s.scenario === "HISTORICAL")).toBe(true);
  }, 60000);

  it("refuses non-automatable or invalid configs", () => {
    expect(runStressTest({ disableHumanApproval: false }).error).toBe("HUMAN_APPROVAL_NOT_AUTOMATABLE");
    expect(runStressTest({ mode: "HISTORICAL_REPLAY" }).error).toBe("HISTORICAL_BARS_REQUIRED");
    expect(runStressTest({ sampleSize: 0 }).error).toBe("INVALID_CONFIG");
  });

  it("report states WHAT FAILED, no recommendation applied", () => {
    const txt = generateStressReport(runStressTest(small));
    expect(txt).toContain("ARENA STRESS TEST REPORT");
    expect(txt).toContain("System Health:");
    expect(txt).toContain("no parameter recommendation is applied");
  }, 60000);

  it("module has no broker/gateway/order surface", () => {
    const dir = join(__dirname, "..");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(new RegExp(["core/broker", "gateway", "order" + "_send", "fetch\\(", "WebSocket", "localStorage"].join("|")));
    }
  });
});
