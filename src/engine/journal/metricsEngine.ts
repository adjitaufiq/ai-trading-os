import type { ExcursionMetrics, JournalTrade, PerformanceMetrics } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function calculatePerformance(trades: readonly JournalTrade[]): PerformanceMetrics {
  const n = trades.length;
  const wins = trades.filter((t) => t.profitLossUSD > 0).map((t) => t.profitLossUSD);
  const losses = trades.filter((t) => t.profitLossUSD < 0).map((t) => -t.profitLossUSD);
  const totalProfit = wins.reduce((s, x) => s + x, 0), totalLoss = losses.reduce((s, x) => s + x, 0);
  const winRate = n ? wins.length / n : 0, lossRate = n ? losses.length / n : 0;
  const averageWin = mean(wins), averageLoss = mean(losses);
  return {
    totalTrades: n, winningTrades: wins.length, losingTrades: losses.length, winRate: r4(winRate),
    totalProfit: r2(totalProfit), totalLoss: r2(totalLoss),
    profitFactor: totalLoss > 0 ? r4(totalProfit / totalLoss) : totalProfit > 0 ? Infinity : 0,
    averageRiskReward: r4(mean(trades.map((t) => t.context.rr))),
    expectancy: r4(winRate * averageWin - lossRate * averageLoss),
    expectancyR: r4(mean(trades.filter((t) => t.riskUSD > 0).map((t) => t.profitLossUSD / t.riskUSD))),
    averageWin: r2(averageWin), averageLoss: r2(averageLoss),
  };
}

/** MAE ≤ 0, MFE ≥ 0, in price units, from bars observed while the trade was open. */
export function calculateExcursion(direction: "BUY" | "SELL", entry: number, bars: readonly { high: number; low: number }[]): ExcursionMetrics {
  if (!bars.length) return { maximumAdverseExcursion: 0, maximumFavorableExcursion: 0 };
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  const mae = direction === "BUY" ? lo - entry : entry - hi;
  const mfe = direction === "BUY" ? hi - entry : entry - lo;
  return { maximumAdverseExcursion: r4(Math.min(0, mae)), maximumFavorableExcursion: r4(Math.max(0, mfe)) };
}
