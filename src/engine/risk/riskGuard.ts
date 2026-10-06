import { stateRiskMultiplier } from "./accountState";
import type { AccountProfile, AccountState } from "./types";

export function isValidRiskConfig(a: AccountProfile): boolean {
  return Number.isFinite(a.equity) && a.equity > 0 && Number.isFinite(a.riskValue) && a.riskValue > 0
    && Number.isFinite(a.maxDailyLossPercent) && a.maxDailyLossPercent > 0
    && (a.riskType !== "PERCENTAGE" || a.riskValue <= 100);
}

export function dailyLossRemainingUSD(a: AccountProfile): number {
  return Math.max(0, (a.equity * (a.maxDailyLossPercent - a.currentDailyDDPercent)) / 100);
}

/** Risk Budget = min(Equity×Risk% ×stateMultiplier, Daily Loss Remaining, Exposure Remaining). */
export function calculateRiskBudget(a: AccountProfile, state: AccountState, exposureRemainingUSD: number): number {
  const base = a.riskType === "PERCENTAGE" ? (a.equity * a.riskValue) / 100 : a.riskValue;
  const scaled = base * stateRiskMultiplier(state, a);
  return Math.max(0, Math.min(scaled, dailyLossRemainingUSD(a), Math.max(0, exposureRemainingUSD)));
}
