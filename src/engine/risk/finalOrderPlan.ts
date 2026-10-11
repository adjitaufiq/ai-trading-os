// Phase 4A — FINAL_ORDER_PLAN: the single authoritative lot calculation for broker execution (M4).
// Inputs: real broker account balance/equity, broker contract spec, SL distance from the approved plan, policy risk.
// Pure, no broker I/O. Execution receives only {symbol, direction, lot, entry, sl, tp} and never recalculates.
import { calculatePositionSize } from "./positionSizer";
import type { RiskPolicy } from "./riskPolicy";
import type { BrokerSymbolInfo } from "./types";

export interface FinalOrderPlan {
  readonly symbol: string; readonly direction: "BUY" | "SELL";
  readonly lot: number; readonly entry: number; readonly sl: number; readonly tp: number;
}
export interface FinalOrderAudit {
  readonly balance: number; readonly equity: number; readonly sizingBase: number;
  readonly risk_per_trade: number; readonly budgetUSD: number; readonly actualRiskUSD: number; readonly slDistance: number;
}
export type FinalOrderPlanResult =
  | { readonly ok: true; readonly plan: FinalOrderPlan; readonly audit: FinalOrderAudit }
  | { readonly ok: false; readonly reason: "INVALID_ACCOUNT" | "INVALID_PLAN" | "LOT_BELOW_MINIMUM"; readonly detail?: string };

export function buildFinalOrderPlan(
  input: { symbol: string; direction: "BUY" | "SELL"; entry: number; sl: number; tp: number },
  account: { balance: number; equity: number },
  broker: BrokerSymbolInfo,
  policy: RiskPolicy,
): FinalOrderPlanResult {
  if (!(account.balance > 0) || !(account.equity > 0)) return { ok: false, reason: "INVALID_ACCOUNT" };
  const slDistance = Math.abs(input.entry - input.sl);
  if (!(input.entry > 0 && input.sl > 0 && input.tp > 0 && slDistance > 0)) return { ok: false, reason: "INVALID_PLAN" };
  // Conservative base: the lower of balance and equity (an open drawdown never inflates size).
  const sizingBase = Math.min(account.balance, account.equity);
  const budgetUSD = sizingBase * policy.risk_per_trade;
  const size = calculatePositionSize(budgetUSD, slDistance, broker, true);
  if (!size || !(size.finalLot >= broker.volumeMin)) return { ok: false, reason: "LOT_BELOW_MINIMUM", detail: `raw ${size?.rawLot ?? "?"}` };
  return {
    ok: true,
    plan: Object.freeze({ symbol: input.symbol, direction: input.direction, lot: size.finalLot, entry: input.entry, sl: input.sl, tp: input.tp }),
    audit: Object.freeze({ balance: account.balance, equity: account.equity, sizingBase, risk_per_trade: policy.risk_per_trade, budgetUSD, actualRiskUSD: size.actualRiskUSD, slDistance }),
  };
}
