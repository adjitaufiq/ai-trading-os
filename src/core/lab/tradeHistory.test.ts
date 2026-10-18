import { describe, expect, it } from "vitest";
import { groupByDay, wibDay } from "./tradeHistory";
import type { LabTrade } from "./labLedger";

const t = (o: Partial<LabTrade>): LabTrade => ({ id: Math.random().toString(), strategy: "M5_FAST_BREAKOUT" as never, symbol: "BTCUSD", side: "BUY", why: "", opened_at: 0, signal_bar_time: 0, entry: 1, sl: 0, tp: 2, lot: 1, status: "CLOSED", mark: 1, pnl_usd: 0, closed_at: 1, exit_price: 1, exit_reason: "TP", version: "v", ...o });
// 2026-10-18 17:30 UTC = 2026-10-19 00:30 WIB
const lateUtc = Date.UTC(2026, 9, 18, 17, 30);

describe("lab trade history", () => {
  it("uses WIB day: 17:30 UTC belongs to next day", () => { expect(wibDay(lateUtc)).toBe("2026-10-19"); });
  it("per-day net, wins, losses and open", () => {
    const g = groupByDay([
      t({ opened_at: lateUtc, pnl_usd: 5 }), t({ opened_at: lateUtc, pnl_usd: 5 }),
      t({ opened_at: Date.UTC(2026, 9, 18, 5), pnl_usd: -5 }), t({ opened_at: Date.UTC(2026, 9, 18, 6), pnl_usd: 2 }),
      t({ opened_at: Date.UTC(2026, 9, 18, 7), status: "OPEN", pnl_usd: -1 }),
    ]);
    expect(g.map((d) => d.day)).toEqual(["2026-10-19", "2026-10-18"]);
    expect(g[0]).toMatchObject({ net: 10, wins: 2, losses: 0, open: 0 });
    expect(g[1]).toMatchObject({ net: -3, wins: 1, losses: 1, open: 1, floating: -1 });
  });
  it("filters market and result", () => {
    const all = [t({ symbol: "XAUUSD", pnl_usd: 3 }), t({ pnl_usd: -5 }), t({ status: "OPEN" })];
    expect(groupByDay(all, "XAUUSD")[0]!.trades).toHaveLength(1);
    expect(groupByDay(all, "ALL", "LOSS")[0]!.net).toBe(-5);
    expect(groupByDay(all, "ALL", "OPEN")[0]!.open).toBe(1);
  });
});
