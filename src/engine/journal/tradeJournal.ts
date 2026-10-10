import type { DataSource } from "../contracts/dataSource";
import { deepFreeze } from "../execution/executionSnapshot";
import type { FootprintSnapshot } from "../core/market/institutional-radar/types";
import type { PaperTrade } from "../execution/types";
import { footprintTags, type MarketContextSnapshot } from "../signal/context";

const toJournalContext = (m: MarketContextSnapshot) => ({
  regime: m.regime?.regime ?? null, horizon: m.horizon?.recommendedHorizon ?? null, marketApproach: m.horizon?.marketApproach ?? null,
  footprintTags: footprintTags(m.footprints), eventReferences: m.activeEvents.map((e) => ({ ...e })),
});
import type { EntryDecisionSnapshot, ExcursionMetrics, JournalContext, JournalFilter, JournalTrade, SaveResult, TradeOutcome } from "./types";
import { defaultSymbolRegistry, type SymbolRegistry } from "../../core/broker/SymbolRegistry";
import { resolveMarketSession } from "../../core/temporal/MarketSessionResolver";

export const outcomeOf = (pnl: number): TradeOutcome => (pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAK_EVEN");

/** BUY: (actual − planned)/point; SELL: (planned − actual)/point. Positive = adverse. */
export function slippagePoints(direction: "BUY" | "SELL", planned: number, actual: number, point: number): number {
  const raw = (direction === "BUY" ? actual - planned : planned - actual) / point;
  return Math.round(raw * 1e6) / 1e6;
}

/** Map a CLOSED M5 paper trade to a journal row. Copies values; never recalculates them. */
export function fromPaperTrade(t: PaperTrade, extra: { h1Phase: string; locationTier: string; rr: number; dataSource?: DataSource; primaryBias?: { bias: "BUY" | "SELL" | "NONE"; asOf: number; source: "TECHNICAL_H4_CLOSED" }; entryDecision?: EntryDecisionSnapshot }, excursion?: ExcursionMetrics, footprints?: FootprintSnapshot, registry: SymbolRegistry = defaultSymbolRegistry): JournalTrade | null {
  if (t.state !== "CLOSED" || !t.result || t.openedAt === null || t.closedAt === null) return null;
  const s = t.snapshot;
  const meta = registry.require(s.symbol);
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
    ...(footprints ? { footprints: { ...footprints } } : {}),
    ...(s.marketContext ? { contextSnapshot: toJournalContext(s.marketContext) } : {}),
    assetClass: meta.assetClass,
    session: resolveMarketSession(t.openedAt * 1000, meta.assetClass),
    plannedEntryPrice: t.fill.marketPrice,
    actualEntryPrice: t.fill.actualEntry,
    slippagePoints: slippagePoints(s.direction, t.fill.marketPrice, t.fill.actualEntry, meta.point),
    latencyMs: 0,
    dataSource: extra.dataSource ?? "SYNTHETIC",
    ...(extra.primaryBias ? { primaryBias: extra.primaryBias.bias, primaryBiasAsOf: extra.primaryBias.asOf, primaryBiasSource: extra.primaryBias.source } : {}),
    ...(extra.entryDecision ? { entryDecision: extra.entryDecision } : {}),
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
