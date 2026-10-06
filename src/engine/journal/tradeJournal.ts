import { deepFreeze } from "../execution/executionSnapshot";
import type { PaperTrade } from "../execution/types";
import type { ExcursionMetrics, JournalContext, JournalFilter, JournalTrade, SaveResult, TradeOutcome } from "./types";

export const outcomeOf = (pnl: number): TradeOutcome => (pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAK_EVEN");

/** Map a CLOSED M5 paper trade to a journal row. Copies values; never recalculates them. */
export function fromPaperTrade(t: PaperTrade, extra: { h1Phase: string; locationTier: string; rr: number }, excursion?: ExcursionMetrics): JournalTrade | null {
  if (t.state !== "CLOSED" || !t.result || t.openedAt === null || t.closedAt === null) return null;
  const s = t.snapshot;
  const context: JournalContext = {
    bias: s.signalSource.bias, h1Phase: extra.h1Phase, priceLocation: s.signalSource.location, locationTier: extra.locationTier,
    triggerPattern: s.signalSource.trigger, reactionQuality: s.signalSource.reactionQuality, emaContext: s.signalSource.emaContext, rr: extra.rr,
  };
  return {
    tradeId: t.id, symbol: s.symbol, direction: s.direction, executionMode: "PAPER",
    entryPrice: s.entryPrice, exitPrice: t.result.exit, stopLoss: s.stopLoss, takeProfit: s.takeProfit, lot: s.lot, riskUSD: s.riskUSD,
    profitLossUSD: t.result.profitLossUSD, profitLossPercent: t.result.profitLossPercent, result: outcomeOf(t.result.profitLossUSD),
    closeReason: t.result.closeReason, durationSeconds: t.result.durationSeconds, context, decisionTrace: [...s.decisionTrace],
    openedAt: t.openedAt, closedAt: t.closedAt, ...(excursion ? { excursion } : {}),
  };
}

export function matchesFilter(t: JournalTrade, f: JournalFilter): boolean {
  return (f.symbol === undefined || t.symbol === f.symbol)
    && (f.direction === undefined || t.direction === f.direction)
    && (f.result === undefined || t.result === f.result)
    && (f.location === undefined || t.context.priceLocation === f.location)
    && (f.trigger === undefined || t.context.triggerPattern === f.trigger)
    && (f.closeReason === undefined || t.closeReason === f.closeReason)
    && (f.dateRange === undefined || (t.closedAt >= f.dateRange.from && t.closedAt <= f.dateRange.to));
}

/** Append-only journal. No update or delete API exists. */
export class TradeJournal {
  private readonly rows: Readonly<JournalTrade>[] = [];
  private readonly ids = new Set<string>();

  saveTrade(trade: JournalTrade): SaveResult {
    if (!trade.tradeId || !Number.isFinite(trade.profitLossUSD) || !(trade.closedAt >= trade.openedAt)) return { ok: false, error: "INVALID_TRADE" };
    if (this.ids.has(trade.tradeId)) return { ok: false, error: "DUPLICATE_TRADE_ID" };
    const stored = deepFreeze(structuredClone({ ...trade, result: outcomeOf(trade.profitLossUSD) }));
    this.rows.push(stored);
    this.ids.add(trade.tradeId);
    return { ok: true, trade: stored };
  }

  getAll(): readonly Readonly<JournalTrade>[] { return Object.freeze([...this.rows]); }
  get size(): number { return this.rows.length; }
  queryTrades(f: JournalFilter): readonly Readonly<JournalTrade>[] { return Object.freeze(this.rows.filter((t) => matchesFilter(t, f))); }
}
