import { describe, expect, it } from "vitest";
import { buildLabReport, formatLabReport, maxDrawdown, winLossStats } from "@/core/lab/labReport";
import { allSwitches } from "@/core/lab/modeSwitch";
import type { LabTrade } from "@/core/lab/labLedger";

const NOW = 10 * 3600 * 1000;
const t = (id: string, strategy: LabTrade["strategy"], pnl: number, closedAt: number | null): LabTrade => ({
  id, strategy, symbol: "BTCUSD", side: "BUY", why: "", opened_at: 0, signal_bar_time: 0, entry: 1, sl: 0, tp: 2, lot: 0.05,
  status: closedAt == null ? "OPEN" : "CLOSED", mark: 1, pnl_usd: pnl, closed_at: closedAt, exit_price: closedAt == null ? null : 1, exit_reason: closedAt == null ? null : "TP", version: "x",
});

describe("lab report", () => {
  const trades = [t("a", "FAST_BREAKOUT", 5, NOW - 1000), t("b", "FAST_BREAKOUT", -2, NOW - 4 * 3600 * 1000), t("c", "TOUCH_SNR", -5, NOW - 1000),
    t("o1", "EMA_CROSS", 1, null), t("o2", "EMA_CROSS", 1, null), t("o3", "EMA_CROSS", -1, null)];
  const state = { trades, seen: {}, started_at: 0 };
  const sw = { ...allSwitches(true), TOUCH_SNR: false };

  it("counts only trades closed in the last 3 hours as recent", () => {
    const r = buildLabReport(state, sw, NOW);
    expect(r.recent.trades).toBe(2);
    expect(r.recent.pnl).toBe(0);
    expect(r.closed).toBe(3);
    expect(r.open).toBe(3);
  });
  it("flags stacking above 2 open and excludes OFF modes from worst-ON", () => {
    const r = buildLabReport(state, sw, NOW);
    expect(r.stacking.map((x) => x.strategy)).toEqual(["EMA_CROSS"]);
    expect(r.worstOn).toBeNull();
    expect(r.off).toEqual(["TOUCH_SNR"]);
    expect(r.rows[0]!.strategy).toBe("FAST_BREAKOUT");
  });
  it("labels the copied text as paper simulation", () => {
    expect(formatLabReport(buildLabReport(state, sw, NOW))).toContain("SIMULASI PAPER");
  });
  it("computes avg win/loss and actual R:R", () => {
    expect(winLossStats([2, 4, -5, -5])).toEqual({ avgWin: 3, avgLoss: 5, rr: 0.6 });
  });
  it("max drawdown is peak to lowest later trough of realized balance", () => {
    expect(maxDrawdown([5, -3, -4, 10, -2], 500).usd).toBe(7);
  });
});

describe("lab report daily + limits", () => {
  it("separates today WIB P/L from all-time and prints real limits", async () => {
    const { DEFAULT_OPERATOR } = await import("@/core/lab/operatorControl");
    const now = Date.UTC(2026, 9, 18, 18, 0); // 01:00 WIB 19 Oct
    const tr = [t("y", "FAST_BREAKOUT", -10, Date.UTC(2026, 9, 18, 16, 0)), t("z", "FAST_BREAKOUT", 4, Date.UTC(2026, 9, 18, 17, 30))];
    const r = buildLabReport({ trades: tr, seen: {}, started_at: 0 }, allSwitches(true), now, { ...DEFAULT_OPERATOR, maxOpenTotal: 3 });
    expect(r.today.pnl).toBe(4);
    expect(r.realized).toBe(-6);
    const txt = formatLabReport(r);
    expect(txt).toContain("Maks entry total bersamaan: 3");
    expect(txt).not.toContain("tanpa batas");
  });
});
