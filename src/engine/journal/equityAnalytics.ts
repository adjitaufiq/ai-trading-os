import type { EquitySummary, JournalTrade } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildEquityCurve(trades: readonly JournalTrade[], startingEquity: number): EquitySummary {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt || a.tradeId.localeCompare(b.tradeId));
  let equity = startingEquity, peak = startingEquity, maxDD = 0;
  const points = sorted.map((t) => {
    equity = r2(equity + t.profitLossUSD);
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? r2(((peak - equity) / peak) * 100) : 0;
    maxDD = Math.max(maxDD, dd);
    return { timestamp: t.closedAt, equity, drawdownPercent: dd };
  });
  return { points, peakEquity: peak, currentEquity: equity, maxDrawdownPercent: maxDD };
}
