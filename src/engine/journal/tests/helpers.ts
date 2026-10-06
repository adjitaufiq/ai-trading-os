import type { JournalTrade } from "../types";

let n = 0;
export function jt(o: Partial<JournalTrade> & { ctx?: Partial<JournalTrade["context"]> } = {}): JournalTrade {
  const { ctx, ...rest } = o;
  const pnl = rest.profitLossUSD ?? 20;
  n += 1;
  return {
    tradeId: `XAUUSD_BUY_${String(n).padStart(3, "0")}`, symbol: "XAUUSD", direction: "BUY", executionMode: "PAPER", assetClass: "COMMODITY", session: "LONDON", plannedEntryPrice: 2650, actualEntryPrice: 2650, slippagePoints: 0, latencyMs: 0,
    entryPrice: 2650, exitPrice: 2656, stopLoss: 2645, takeProfit: 2656, lot: 0.1, riskUSD: 50,
    profitLossUSD: pnl, profitLossPercent: pnl / 100, result: pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAK_EVEN",
    closeReason: pnl > 0 ? "TP_HIT" : "SL_HIT", durationSeconds: 600,
    context: { bias: "H4_BULLISH", h1Phase: "PULLBACK", priceLocation: "AT_SUPPORT", locationTier: "TIER_1", triggerPattern: "BULLISH_REJECTION_WICK", reactionQuality: "STRONG", emaContext: "EMA21_RETEST", rr: 1.5, ...ctx },
    decisionTrace: ["PLAN Setup READY: PASS"], openedAt: 1700000000 + n * 1000, closedAt: 1700000600 + n * 1000,
    ...rest,
  };
}
