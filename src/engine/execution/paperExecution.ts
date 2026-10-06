// Paper fill simulation. Nothing here reaches a broker or sends an order.
import type { TradePlan } from "../plan/types";
import type { RiskCheckResult } from "../risk/types";
import { buildSnapshot, deepFreeze } from "./executionSnapshot";
import type { ContractValue, FillResult, FillSimulation, PaperTrade, RejectReason, SignalSource, TradeEvent } from "./types";

const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

export function simulateFill(direction: "BUY" | "SELL", marketPrice: number, sim: FillSimulation): FillResult | null {
  if (sim.slippage > sim.maxSlippage) return null;
  const drift = Math.max(0, sim.latencyMs) * Math.max(0, sim.latencyDriftPerMs);
  const adverse = Math.max(0, sim.spread) + Math.max(0, sim.slippage) + drift;
  return { marketPrice, actualEntry: r8(direction === "BUY" ? marketPrice + adverse : marketPrice - adverse), spreadApplied: sim.spread, slippageApplied: sim.slippage, latencyDrift: drift };
}

export interface CreateInput {
  plan: TradePlan;
  risk: RiskCheckResult;
  marketPrice: number;
  sim: FillSimulation;
  contract: ContractValue;
  accountEquity: number;
  signalSource: SignalSource;
  now: number;
}

export type CreateResult =
  | { state: "PENDING"; trade: PaperTrade; events: TradeEvent[] }
  | { state: "REJECTED"; reason: RejectReason; events: TradeEvent[] };

export function createPaperTrade(i: CreateInput): CreateResult {
  const id = `paper_${i.plan.id}_${i.now}`;
  const reject = (reason: RejectReason): CreateResult => ({ state: "REJECTED", reason, events: [Object.freeze({ type: "TRADE_REJECTED", tradeId: id, at: i.now, detail: reason })] });
  if (i.risk.decision !== "APPROVED" || !i.risk.positionSize) return reject("RISK_NOT_APPROVED");
  if (i.plan.status !== "PLANNED" || i.plan.sl === null || i.plan.tp === null) return reject("INVALID_PLAN");
  if (!(Number.isFinite(i.marketPrice) && i.marketPrice > 0)) return reject("INVALID_MARKET_PRICE");
  const fill = simulateFill(i.plan.direction, i.marketPrice, i.sim);
  if (!fill) return reject("SLIPPAGE_EXCEEDED");
  const snapshot = buildSnapshot({
    tradeId: id, symbol: i.plan.symbol, direction: i.plan.direction, entryPrice: fill.actualEntry,
    stopLoss: i.plan.sl, takeProfit: i.plan.tp, lot: i.risk.positionSize.finalLot, riskUSD: i.risk.positionSize.actualRiskUSD,
    signalSource: i.signalSource,
    decisionTrace: [...i.plan.trace.map((s) => `PLAN ${s.name}: ${s.result}`), ...i.risk.trace.map((s) => `RISK ${s.name}: ${s.result}`)],
    createdAt: i.now,
    ...(i.plan.marketContext ? { marketContext: i.plan.marketContext } : {}),
  });
  const trade: PaperTrade = deepFreeze({
    id, state: "PENDING", snapshot, fill, contract: { ...i.contract }, accountEquity: i.accountEquity,
    openedAt: null, closedAt: null, result: null,
    audit: { executionMode: "PAPER", orderSent: false, brokerTouched: false },
  });
  return { state: "PENDING", trade, events: [Object.freeze({ type: "TRADE_CREATED", tradeId: id, at: i.now })] };
}
