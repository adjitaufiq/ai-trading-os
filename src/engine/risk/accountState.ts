import { RISK_PARAMS as P, type AccountProfile, type AccountState } from "./types";

const DAY = 86_400;

/** Peak-to-equity drawdown in percent. */
export function peakDrawdownPercent(a: AccountProfile): number {
  if (!(a.peakEquity > 0)) return 0;
  return Math.max(0, ((a.peakEquity - a.equity) / a.peakEquity) * 100);
}

/** Deterministic state machine: NORMAL → RECOVERY → LOCKED. */
export function deriveAccountState(a: AccountProfile): AccountState {
  if (a.currentDailyDDPercent >= a.maxDailyLossPercent) return "LOCKED";
  if (peakDrawdownPercent(a) > P.RECOVERY_DRAWDOWN_PERCENT) return "RECOVERY";
  return "NORMAL";
}

export function stateRiskMultiplier(state: AccountState, a: AccountProfile): number {
  if (state === "LOCKED") return 0;
  if (state === "RECOVERY") return a.recoveryMultiplier > 0 ? a.recoveryMultiplier : P.DEFAULT_RECOVERY_MULTIPLIER;
  return 1;
}

/** Next 00:00 UTC (epoch seconds). */
export function nextUtcMidnight(nowSec: number): number {
  return Math.floor(nowSec / DAY) * DAY + DAY;
}

export interface LossStreak { consecutiveLosses: number; lastLossAt: number | null }

/** Cooldown active when ≥ MAX losses and the last loss is in the current UTC day. */
export function isCooldownActive(s: LossStreak, nowSec: number): boolean {
  if (s.consecutiveLosses < P.MAX_CONSECUTIVE_LOSSES || s.lastLossAt === null) return false;
  return nextUtcMidnight(s.lastLossAt) > nowSec;
}
