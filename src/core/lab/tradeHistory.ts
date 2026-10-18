// Pure grouping of Strategy Lab PAPER trades by WIB calendar day (entry date) with per-day P/L resume. Read-only view model.
import type { LabTrade } from "./labLedger";

export type HistoryResult = "ALL" | "PROFIT" | "LOSS" | "OPEN";
export type HistoryMarket = "ALL" | "XAUUSD" | "BTCUSD";
const WIB_MS = 7 * 3_600_000;

/** YYYY-MM-DD of the WIB (UTC+7) calendar day. */
export const wibDay = (ms: number) => new Date(ms + WIB_MS).toISOString().slice(0, 10);

export function matches(t: LabTrade, market: HistoryMarket, result: HistoryResult): boolean {
  if (market !== "ALL" && t.symbol !== market) return false;
  if (result === "OPEN") return t.status === "OPEN";
  if (result === "PROFIT") return t.status === "CLOSED" && t.pnl_usd > 0;
  if (result === "LOSS") return t.status === "CLOSED" && t.pnl_usd <= 0;
  return true;
}

export interface DayGroup { day: string; trades: LabTrade[]; net: number; wins: number; losses: number; open: number; floating: number }

/** Groups by entry day (newest first). Resume counts only filtered trades; net = realized of CLOSED trades. */
export function groupByDay(trades: readonly LabTrade[], market: HistoryMarket = "ALL", result: HistoryResult = "ALL"): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const t of trades) {
    if (!matches(t, market, result)) continue;
    const day = wibDay(t.opened_at);
    const g = map.get(day) ?? { day, trades: [], net: 0, wins: 0, losses: 0, open: 0, floating: 0 };
    g.trades.push(t);
    if (t.status === "OPEN") { g.open++; g.floating += t.pnl_usd; }
    else { g.net += t.pnl_usd; if (t.pnl_usd > 0) g.wins++; else g.losses++; }
    map.set(day, g);
  }
  for (const g of map.values()) g.trades.sort((a, b) => b.opened_at - a.opened_at);
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

export interface CalendarCell { day: string; date: number; net: number; wins: number; losses: number; trades: number }
export interface MonthCalendar { year: number; month: number; leading: number; cells: CalendarCell[]; net: number; winDays: number; lossDays: number; trades: number; wins: number; losses: number; best: CalendarCell | null; worst: CalendarCell | null }

/** Month grid (month 1-12, WIB entry day, CLOSED trades only, market filter). leading = blank cells before day 1 (Sunday-first). */
export function getMonthCalendar(trades: readonly LabTrade[], year: number, month: number, market: HistoryMarket = "ALL"): MonthCalendar {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: CalendarCell[] = Array.from({ length: dim }, (_, i) => ({ day: `${prefix}${String(i + 1).padStart(2, "0")}`, date: i + 1, net: 0, wins: 0, losses: 0, trades: 0 }));
  for (const t of trades) {
    if (t.status !== "CLOSED" || (market !== "ALL" && t.symbol !== market)) continue;
    const d = wibDay(t.opened_at);
    if (!d.startsWith(prefix)) continue;
    const c = cells[Number(d.slice(8)) - 1]!;
    c.trades++; c.net += t.pnl_usd; if (t.pnl_usd > 0) c.wins++; else c.losses++;
  }
  const active = cells.filter((c) => c.trades > 0);
  const best = active.reduce<CalendarCell | null>((b, c) => (!b || c.net > b.net ? c : b), null);
  const worst = active.reduce<CalendarCell | null>((b, c) => (!b || c.net < b.net ? c : b), null);
  return {
    year, month, leading: new Date(Date.UTC(year, month - 1, 1)).getUTCDay(), cells,
    net: active.reduce((s, c) => s + c.net, 0), winDays: active.filter((c) => c.net > 0).length, lossDays: active.filter((c) => c.net <= 0).length,
    trades: active.reduce((s, c) => s + c.trades, 0), wins: active.reduce((s, c) => s + c.wins, 0), losses: active.reduce((s, c) => s + c.losses, 0), best, worst,
  };
}
