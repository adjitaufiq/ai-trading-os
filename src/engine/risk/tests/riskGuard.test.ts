import { describe, expect, it } from "vitest";
import { deriveAccountState, isCooldownActive, nextUtcMidnight } from "../accountState";
import { checkSlippage, checkSpread } from "../executionGuard";
import { calculateRiskBudget } from "../riskGuard";
import type { AccountProfile } from "../types";

export const acct = (o: Partial<AccountProfile> = {}): AccountProfile => ({
  mode: "STANDARD", state: "NORMAL", equity: 10000, peakEquity: 10000, riskType: "PERCENTAGE", riskValue: 1,
  maxDailyLossPercent: 3, currentDailyDDPercent: 0, recoveryMultiplier: 0.5, ...o,
});
const DAY = 86400, T = 1700000000;

describe("account state + budget", () => {
  it("NORMAL uses full risk", () => {
    expect(deriveAccountState(acct())).toBe("NORMAL");
    expect(calculateRiskBudget(acct(), "NORMAL", 1e9)).toBe(100);
  });
  it("drawdown >10% ⇒ RECOVERY with half risk", () => {
    const a = acct({ equity: 8900, peakEquity: 10000 });
    expect(deriveAccountState(a)).toBe("RECOVERY");
    expect(calculateRiskBudget(a, "RECOVERY", 1e9)).toBeCloseTo(44.5);
  });
  it("daily loss limit reached ⇒ LOCKED, zero budget", () => {
    const a = acct({ currentDailyDDPercent: 3 });
    expect(deriveAccountState(a)).toBe("LOCKED");
    expect(calculateRiskBudget(a, "LOCKED", 1e9)).toBe(0);
  });
  it("budget = min(risk, daily remaining, exposure remaining)", () => {
    expect(calculateRiskBudget(acct({ currentDailyDDPercent: 2.5 }), "NORMAL", 1e9)).toBe(50);
    expect(calculateRiskBudget(acct(), "NORMAL", 30)).toBe(30);
    expect(calculateRiskBudget(acct({ riskType: "FIXED_USD", riskValue: 75 }), "NORMAL", 1e9)).toBe(75);
  });
});

describe("cooldown", () => {
  it("3 losses today ⇒ active; resets at 00:00 UTC", () => {
    const s = { consecutiveLosses: 3, lastLossAt: T };
    expect(isCooldownActive(s, T + 60)).toBe(true);
    expect(isCooldownActive(s, nextUtcMidnight(T))).toBe(false);
    expect(isCooldownActive({ consecutiveLosses: 2, lastLossAt: T }, T)).toBe(false);
    expect(nextUtcMidnight(T) % DAY).toBe(0);
  });
});

describe("spread + slippage", () => {
  const hist = Array(20).fill(0.2);
  it("hard cap XAU 0.35 blocks", () => expect(checkSpread("XAUUSD", 0.36, []).ok).toBe(false));
  it("SMA20×1.5 blocks", () => expect(checkSpread("BTCUSD", 0.31, hist).ok).toBe(false));
  it("normal spread passes", () => expect(checkSpread("XAUUSD", 0.25, hist).ok).toBe(true));
  it("slippage uses ASK for BUY, BID for SELL", () => {
    expect(checkSlippage("BUY", 2000, 2000.6, 2000.3, 0.5).ok).toBe(false);
    expect(checkSlippage("SELL", 2000, 2000.6, 2000.3, 0.5).ok).toBe(true);
  });
});
