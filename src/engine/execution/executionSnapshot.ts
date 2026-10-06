import type { SignalSource, TradeDirection, TradeSnapshot } from "./types";

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export interface SnapshotInput {
  tradeId: string; symbol: string; direction: TradeDirection; entryPrice: number; stopLoss: number;
  takeProfit: number; lot: number; riskUSD: number; signalSource: SignalSource; decisionTrace: string[]; createdAt: number;
}

/** Immutable decision context. Copies inputs so callers cannot mutate it afterwards. */
export function buildSnapshot(i: SnapshotInput): TradeSnapshot {
  return deepFreeze({ ...i, signalSource: { ...i.signalSource }, decisionTrace: [...i.decisionTrace], executionMode: "PAPER" as const });
}
