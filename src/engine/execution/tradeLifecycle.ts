import { deepFreeze } from "./executionSnapshot";
import type { CloseReason, ExecutionErrorCode, ExecutionState, PaperTrade, TradeEvent, TradeResult } from "./types";

const ALLOWED: Record<ExecutionState, readonly ExecutionState[]> = {
  IDLE: ["PENDING", "REJECTED"],
  PENDING: ["OPEN", "REJECTED"],
  OPEN: ["PARTIAL", "CLOSED"],
  PARTIAL: ["CLOSED"],
  CLOSED: [],
  REJECTED: [],
};

export const canTransition = (from: ExecutionState, to: ExecutionState) => ALLOWED[from].includes(to);

export type LifecycleResult =
  | { ok: true; trade: PaperTrade; event: TradeEvent }
  | { ok: false; error: ExecutionErrorCode; trade: PaperTrade };

export function openPaperTrade(t: PaperTrade, now: number): LifecycleResult {
  if (!canTransition(t.state, "OPEN")) return { ok: false, error: "INVALID_TRANSITION", trade: t };
  const trade = deepFreeze({ ...t, state: "OPEN" as const, openedAt: now });
  return { ok: true, trade, event: Object.freeze({ type: "TRADE_OPENED", tradeId: t.id, at: now }) };
}

export function computeResult(t: PaperTrade, exit: number, reason: CloseReason, now: number): TradeResult {
  const s = t.snapshot;
  const diff = s.direction === "BUY" ? exit - t.fill.actualEntry : t.fill.actualEntry - exit;
  const pnl = Math.round((diff / t.contract.tickSize) * t.contract.tickValue * s.lot * 100) / 100;
  return Object.freeze({
    tradeId: t.id, entry: t.fill.actualEntry, exit, profitLossUSD: pnl,
    profitLossPercent: t.accountEquity > 0 ? Math.round((pnl / t.accountEquity) * 10000) / 100 : 0,
    closeReason: reason, durationSeconds: Math.max(0, now - (t.openedAt ?? now)),
  });
}

export function closePaperTrade(t: PaperTrade, reason: CloseReason, exit: number, now: number): LifecycleResult {
  if (!canTransition(t.state, "CLOSED")) return { ok: false, error: "INVALID_TRANSITION", trade: t };
  const result = computeResult(t, exit, reason, now);
  const trade = deepFreeze({ ...t, state: "CLOSED" as const, closedAt: now, result });
  return { ok: true, trade, event: Object.freeze({ type: "TRADE_CLOSED", tradeId: t.id, at: now, detail: reason }) };
}

const FROZEN_FIELDS = ["entryPrice", "stopLoss", "takeProfit", "lot", "riskUSD", "decisionTrace"] as const;

/** Any attempt to change a frozen field after creation is refused. */
export function attemptModify(t: PaperTrade, patch: Partial<Record<(typeof FROZEN_FIELDS)[number], unknown>>): { ok: false; error: "IMMUTABLE_TRADE_ERROR"; trade: PaperTrade } {
  void patch;
  return { ok: false, error: "IMMUTABLE_TRADE_ERROR", trade: t };
}
