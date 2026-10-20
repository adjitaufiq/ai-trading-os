import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { aggregate, buildWorkbook, dedupTrades, maxDrawdown, type TradeRow } from "./labReport";

const t = (id: string, pnl: number, rev = 1, status = "CLOSED", closed = 2000): TradeRow => ({ session_id: "s", trade_id: id, strategy: "M", symbol: "XAUUSD", side: "BUY", status, pnl_usd: pnl, opened_at_ms: 1000, closed_at_ms: status === "CLOSED" ? closed : null, revision: rev, payload: {}, source: "BROWSER_PAPER" });

describe("lab report", () => {
  it("dedup keeps highest revision so OPEN→CLOSED is one trade", () => {
    const d = dedupTrades([t("a", 0, 1, "OPEN"), t("a", 5, 2), t("b", -10)]);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.trade_id === "a")!.status).toBe("CLOSED");
  });
  it("net = gross profit + gross loss over closed trades only", () => {
    const a = aggregate([t("a", 5), t("b", -10), t("c", 3, 1, "OPEN")]);
    expect(a).toMatchObject({ trades: 2, wins: 1, losses: 1, gross_profit: 5, gross_loss: -10, net: -5, win_rate: 50 });
  });
  it("max drawdown follows close order", () => {
    expect(maxDrawdown([t("a", 10, 1, "CLOSED", 1), t("b", -15, 1, "CLOSED", 2), t("c", 2, 1, "CLOSED", 3)])).toBe(-15);
  });
  it("workbook has all 10 sheets and every unique trade", () => {
    const { bytes } = buildWorkbook({ trades: [t("a", 5), t("b", -10)], rawTradeRows: 3, sessions: [], signals: [], risk: [], demoTradeRows: 0, notes: [], cutoffMs: 3000 });
    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toEqual(["Dashboard", "Trades_Raw", "Sessions", "Hourly_Snapshots", "Position_Snapshots", "Signal_Log", "Risk_Events", "Mode_Performance", "Hourly_Performance", "Data_Quality"]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets["Trades_Raw"]!)).toHaveLength(2);
  });
});
