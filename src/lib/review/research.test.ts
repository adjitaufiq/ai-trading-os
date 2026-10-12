import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { attributeTrade, metrics, regimeBucket, researchIntelligence, setupPerformance, type ResearchTrade } from "./research";

const mk = (i: number, o: Partial<ResearchTrade> = {}): ResearchTrade => ({
  trade_id: `t${i}`, symbol: "BTCUSD", result: i % 3 === 0 ? "LOSS" : "WIN", r_multiple: i % 3 === 0 ? -1 : 2, profit_loss_usd: 0,
  regime: "TRENDING", approach: "TREND_FOLLOW", location: "H1_SNR", trigger_pattern: "M5_ENGULFING", failure_category: i % 3 === 0 ? "LATE_ENTRY" : null,
  data_source: "REAL_MT5", opened_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), closed_at: new Date(Date.UTC(2026, 9, 1, 0, i + 30)).toISOString(), ...o,
});

describe("Research Intelligence V1", () => {
  it("small sample → INSUFFICIENT DATA, no ranking, no conclusion", () => {
    const r = researchIntelligence(Array.from({ length: 10 }, (_, i) => mk(i)), []);
    expect(r.conclusion_allowed).toBe(false);
    expect(r.note).toContain("INSUFFICIENT DATA — NO CONCLUSION");
    expect(r.setups.every((s) => s.status === "INSUFFICIENT_SAMPLE" && s.winRate === null && s.bestCondition === null)).toBe(true);
    expect(r.regimes.every((g) => g.status === "INSUFFICIENT_SAMPLE" && g.bestSetup === null)).toBe(true);
  });

  it("setup ranked only at ≥20 trades", () => {
    const rows = setupPerformance([...Array.from({ length: 20 }, (_, i) => mk(i)), ...Array.from({ length: 19 }, (_, i) => mk(100 + i, { trigger_pattern: "PIN_BAR" }))]);
    expect(rows[0]).toMatchObject({ setup: "H1_SNR + M5_ENGULFING", status: "RANKED", trades: 20, confidence: "LOW" });
    expect(rows[1]).toMatchObject({ setup: "H1_SNR + PIN_BAR", status: "INSUFFICIENT_SAMPLE", avgR: null });
  });

  it("strategy conclusion only at ≥50 trades", () => {
    expect(researchIntelligence(Array.from({ length: 50 }, (_, i) => mk(i)), []).conclusion_allowed).toBe(true);
  });

  it("metrics: expectancy, profit factor, drawdown, holding time", () => {
    const m = metrics([mk(1), mk(3), mk(4), mk(6)]); // +2 -1 +2 -1
    expect(m).toEqual({ trades: 4, expectancyR: 0.5, profitFactor: 2, maxDrawdownR: 1, avgHoldingMinutes: 30 });
  });

  it("attribution lists factors from recorded labels; unknown regime stays UNKNOWN", () => {
    const a = attributeTrade(mk(3, { regime: null }), { trade_id: "t3", compliance_status: "VIOLATION", review_version: "v1" }, []);
    expect(a.regime).toBe("UNKNOWN");
    expect(a.loss_factors).toEqual(["Failure: LATE_ENTRY", "Entry quality: VIOLATION", "Regime tidak tercatat"]);
    expect(regimeBucket("RANGING")).toBe("RANGE");
    expect(regimeBucket("HIGH_VOLATILITY")).toBe("HIGH_VOLATILITY");
  });

  it("module never imports strategy, signal, risk, gate or execution code", () => {
    const src = readFileSync("src/lib/review/research.ts", "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*(execution|risk|decision|gate|signal|strategy|broker|enginehost|technical)/i);
  });
});
