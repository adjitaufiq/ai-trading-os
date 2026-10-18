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
