import type { TradePlan } from "../plan/types";
import { deriveAccountState, isCooldownActive, type LossStreak } from "./accountState";
import { checkExposure } from "./exposureGuard";
import { checkMargin, checkSlippage, checkSpread } from "./executionGuard";
import { calculatePositionSize } from "./positionSizer";
import { calculateRiskBudget, isValidRiskConfig } from "./riskGuard";
import {
  RISK_POLICY_VERSION, type AccountProfile, type BlockReason, type BrokerSymbolInfo, type ExposureLimits,
  type OpenPositionExposure, type RiskCheckResult, type RiskTraceStep,
} from "./types";

export interface RiskContext {
  nowSec: number;
  positions: readonly OpenPositionExposure[];
  exposureLimits: ExposureLimits;
  spread: { current: number; history: readonly number[]; hardCaps?: Readonly<Record<string, number>> };
  quote?: { ask: number; bid: number; maxSlippage: number };
  lossStreak: LossStreak;
  freeMargin?: number;
  strictRiskMode: boolean;
}

const AUDIT = Object.freeze({ executable: false, orderSent: false, mode: "MONITOR_ONLY" }) as RiskCheckResult["audit"];

/** Pure evaluation. Reads the TradePlan, never mutates it, never calls a broker. */
export function evaluateRisk(plan: TradePlan, account: AccountProfile, broker: BrokerSymbolInfo, ctx: RiskContext): RiskCheckResult {
  const trace: RiskTraceStep[] = [];
  const reasons: BlockReason[] = [];
  const state = deriveAccountState(account);
  const out = (decision: RiskCheckResult["decision"], extra: Partial<RiskCheckResult> = {}): RiskCheckResult =>
    Object.freeze({ decision, reasons, positionSize: null, accountState: state, reality: null, trace, policyVersion: RISK_POLICY_VERSION, audit: AUDIT, ...extra });
  const block = (r: BlockReason, name: string, detail?: string) => { reasons.push(r); trace.push({ name, result: "FAIL", detail }); return out("BLOCKED"); };

  // 1. TradePlan valid
  const slDist = plan.riskDistance ?? (plan.sl !== null ? Math.abs(plan.entry - plan.sl) : NaN);
  if (plan.status !== "PLANNED" || plan.sl === null || plan.tp === null || !(slDist > 0) || plan.symbol !== broker.symbol || !isValidRiskConfig(account))
    return block("INVALID_RISK", "TradePlan/config", `status=${plan.status}`);
  trace.push({ name: "TradePlan/config", result: "PASS" });

  // 2. Account state + cooldown
  if (state === "LOCKED") return block("DAILY_DD_LIMIT", "Account state", "LOCKED until 00:00 UTC");
  if (isCooldownActive(ctx.lossStreak, ctx.nowSec)) return block("COOLDOWN_ACTIVE", "Cooldown", `${ctx.lossStreak.consecutiveLosses} consecutive losses`);
  trace.push({ name: "Account state", result: "PASS", detail: state });

  // 3. Budget
  const exp = checkExposure(plan.symbol, ctx.positions, ctx.exposureLimits);
  if (exp.remainingUSD <= 0) return block("EXPOSURE_LIMIT", "Exposure", `symbol=${exp.symbolRiskUSD} total=${exp.totalRiskUSD}`);
  const budget = calculateRiskBudget(account, state, exp.remainingUSD);
  if (!(budget > 0)) return block("DAILY_DD_LIMIT", "Risk budget", "no daily loss remaining");
  trace.push({ name: "Risk budget", result: "PASS", detail: `${budget.toFixed(2)} USD` });

  // 4. Lot + minimum lot reality check
  const size = calculatePositionSize(budget, slDist, broker, ctx.strictRiskMode);
  if (!size) return block("INVALID_RISK", "Position size", "invalid broker contract");
  const reality = { plannedBudgetUSD: budget, actualExecutionRiskUSD: size.actualRiskUSD, deviationPercent: size.riskDeviationPercent, isForcedByMinLot: size.forcedMinimumLot };
  let warn = false;
  if (size.finalLot < broker.volumeMin) {
    reasons.push("LOT_BELOW_MINIMUM"); trace.push({ name: "Minimum lot", result: "FAIL", detail: `raw ${size.rawLot}` });
    return out("BLOCKED", { positionSize: size, reality });
  }
  if (size.forcedMinimumLot) { warn = true; reasons.push("LOT_BELOW_MINIMUM"); trace.push({ name: "Minimum lot", result: "WARN", detail: `forced ${broker.volumeMin}, real risk ${size.actualRiskUSD} (+${size.riskDeviationPercent}%)` }); }
  else trace.push({ name: "Minimum lot", result: "PASS", detail: `lot ${size.finalLot}` });

  // 5. Exposure with actual risk
  if (!checkExposure(plan.symbol, ctx.positions, ctx.exposureLimits, size.actualRiskUSD).ok) { reasons.push("EXPOSURE_LIMIT"); trace.push({ name: "Exposure", result: "FAIL" }); return out("BLOCKED", { positionSize: size, reality }); }
  trace.push({ name: "Exposure", result: "PASS" });

  // 6. Margin
  if (!checkMargin(size.finalLot, broker.marginPerLot, ctx.freeMargin ?? account.equity)) { reasons.push("INSUFFICIENT_MARGIN"); trace.push({ name: "Margin", result: "FAIL" }); return out("BLOCKED", { positionSize: size, reality }); }
  trace.push({ name: "Margin", result: "PASS" });

  // 7. Spread
  const sp = checkSpread(plan.symbol, ctx.spread.current, ctx.spread.history, ctx.spread.hardCaps);
  if (!sp.ok) { reasons.push("SPREAD_TOO_HIGH"); trace.push({ name: "Spread", result: "FAIL", detail: sp.detail }); return out("BLOCKED", { positionSize: size, reality }); }
  trace.push({ name: "Spread", result: "PASS", detail: sp.detail });

  // 8. Slippage pre-check (optional when no quote)
  if (ctx.quote) {
    const sl = checkSlippage(plan.direction, plan.entry, ctx.quote.ask, ctx.quote.bid, ctx.quote.maxSlippage);
    if (!sl.ok) { reasons.push("SLIPPAGE_TOO_HIGH"); trace.push({ name: "Slippage", result: "FAIL", detail: sl.detail }); return out("BLOCKED", { positionSize: size, reality }); }
    trace.push({ name: "Slippage", result: "PASS", detail: sl.detail });
  } else trace.push({ name: "Slippage", result: "SKIP", detail: "no quote" });

  return out(warn ? "WARNING" : "APPROVED", { positionSize: size, reality });
}
