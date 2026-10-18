import { describe, it, expect } from "vitest";
import { getMonthCalendar } from "@/core/lab/tradeHistory";
import type { LabTrade } from "@/core/lab/labLedger";
const t = (id: string, iso: string, pnl: number, symbol = "XAUUSD", status = "CLOSED") => ({ id, symbol, status, opened_at: Date.parse(iso), pnl_usd: pnl } as unknown as LabTrade);
describe("getMonthCalendar", () => {
  const trades = [t("a", "2026-10-18T18:00:00Z", 5), t("b", "2026-10-19T02:00:00Z", -2, "BTCUSD"), t("c", "2026-10-01T00:00:00Z", -3), t("d", "2026-10-19T03:00:00Z", 9, "XAUUSD", "OPEN")];
  it("groups by WIB day, closed only", () => {
    const c = getMonthCalendar(trades, 2026, 10);
    expect(c.cells[18]).toMatchObject({ net: 3, wins: 1, losses: 1, trades: 2 });
    expect(c.net).toBe(0); expect(c.winDays).toBe(1); expect(c.lossDays).toBe(1);
    expect(c.leading).toBe(4); expect(c.cells.length).toBe(31);
  });
  it("market filter", () => { expect(getMonthCalendar(trades, 2026, 10, "BTCUSD").net).toBe(-2); });
});
