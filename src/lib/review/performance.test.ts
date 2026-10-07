import { describe, expect, it } from "vitest";
import { performanceIntelligence } from "./performance";
import type { TradeFact } from "@/lib/memory/analytics";

const t = (id: string, result: string, r: number, o: Partial<TradeFact> = {}): TradeFact => ({
  trade_id: id, symbol: "XAUUSD", result, r_multiple: r, profit_loss_usd: r * 10, regime: "TRENDING", approach: "TREND_FOLLOWING",
  location: "SUPPORT", trigger_pattern: "ENGULF", failure_category: result === "LOSS" ? "LATE_ENTRY" : null, data_source: "REAL_MT5", opened_at: "2026-10-07T00:00:00Z", ...o,
});

describe("performanceIntelligence", () => {
  it("never mixes data sources", () => {
    const p = performanceIntelligence([t("a", "WIN", 2), t("b", "LOSS", -1, { data_source: "SYNTHETIC" })], []);
    expect(p.summary?.trades).toBe(1);
    expect(p.excluded_other_sources).toBe(1);
  });
  it("flags small samples per group", () => {
    const p = performanceIntelligence([t("a", "WIN", 2), t("b", "LOSS", -1)], []);
    expect(p.sample_note).not.toBeNull();
    expect(p.by_regime[0]!.sufficient).toBe(false);
    expect(p.summary?.winRate).toBe(0.5);
    expect(p.summary?.avgR).toBe(0.5);
  });
  it("joins compliance status with outcome, unreviewed stays UNREVIEWED", () => {
    const p = performanceIntelligence([t("a", "WIN", 2), t("b", "LOSS", -1)], [{ trade_id: "a", compliance_status: "COMPLIANT", review_version: "trade-review-v1" }]);
    const keys = p.compliance_vs_outcome.map((g) => g.key).sort();
    expect(keys).toEqual(["COMPLIANT", "UNREVIEWED"]);
    expect(p.reviewed_trades).toBe(1);
  });
  it("failure distribution only counts losses", () => {
    const p = performanceIntelligence([t("a", "WIN", 2), t("b", "LOSS", -1), t("c", "LOSS", -1, { failure_category: "FAKE_BREAK" })], []);
    expect(p.failure_distribution.reduce((s, f) => s + f.count, 0)).toBe(2);
    expect(p.failure_distribution[0]!.share).toBe(0.5);
  });
});
