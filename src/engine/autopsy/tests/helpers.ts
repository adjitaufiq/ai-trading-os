import type { JournalTrade } from "../../journal/types";
import type { AutopsyMarketData } from "../types";

export function loss(o: Partial<JournalTrade> & { ctx?: Partial<JournalTrade["context"]> } = {}): JournalTrade {
  const { ctx, ...rest } = o;
  return {
    tradeId: "XAUUSD_BUY_501", symbol: "XAUUSD", direction: "BUY", executionMode: "PAPER", assetClass: "COMMODITY", session: "LONDON", plannedEntryPrice: 2650, actualEntryPrice: 2650, slippagePoints: 0, latencyMs: 0,
    entryPrice: 2650, exitPrice: 2647, stopLoss: 2647, takeProfit: 2656, lot: 0.1, riskUSD: 30,
    profitLossUSD: -30, profitLossPercent: -0.3, result: "LOSS", closeReason: "SL_HIT", durationSeconds: 1800,
    context: { bias: "H4_BULLISH", h1Phase: "PULLBACK", priceLocation: "AT_SUPPORT", locationTier: "TIER_1", triggerPattern: "BULLISH_REJECTION_WICK", reactionQuality: "STRONG", emaContext: "EMA21_RETEST", rr: 2, ...ctx },
    decisionTrace: ["PLAN Setup READY: PASS"], openedAt: 1700000000, closedAt: 1700001800, ...rest,
  };
}

/** Clean market: normal candles, follow-through then SL, price continues lower after. */
export function market(o: Partial<AutopsyMarketData> = {}): AutopsyMarketData {
  return {
    tradeBars: [{ high: 2651.5, low: 2649.5 }, { high: 2651, low: 2648.5 }, { high: 2650, low: 2648 }, { high: 2649, low: 2646.8 }],
    futureCandles: [{ high: 2647.5, low: 2645 }, { high: 2646, low: 2643 }],
    atr: 2, spreadAtEntry: 0.2, normalSpread: 0.2,
    execution: { plannedEntry: 2650, actualEntry: 2650.1, latencyMs: 50 },
    ...o,
  };
}
