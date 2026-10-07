// Pure demo-lab guards: account identity binding + execution safety limits. No I/O.
import type { AccountBlockReason, DemoAccountIdentity, DemoRiskProfile, DemoWhitelist, ExecutionMode, SafetyBlockReason } from "./types";

export function validateDemoAccount(id: DemoAccountIdentity | null, wl: DemoWhitelist): { ok: true } | { ok: false; reason: AccountBlockReason } {
  if (!id) return { ok: false, reason: "IDENTITY_UNAVAILABLE" };
  if (id.tradeMode !== "DEMO") return { ok: false, reason: "ACCOUNT_NOT_DEMO" };
  if (!wl.logins.includes(id.login)) return { ok: false, reason: "ACCOUNT_NOT_WHITELISTED" };
  if (!wl.servers.includes(id.server)) return { ok: false, reason: "SERVER_NOT_WHITELISTED" };
  return { ok: true };
}

export interface SafetyState {
  readonly mode: ExecutionMode;
  readonly killSwitch: boolean;
  readonly consumedSignalIds: ReadonlySet<string>;
  readonly openPositions: number;
  readonly tradesToday: number;
  readonly dayStartBalance: number;
  readonly equity: number;
}

export function dailyLossPercent(dayStartBalance: number, equity: number): number {
  return dayStartBalance > 0 ? Math.max(0, ((dayStartBalance - equity) / dayStartBalance) * 100) : 0;
}

/** Order of checks is fixed; first failure wins. */
export function checkDemoSafety(signalId: string, s: SafetyState, p: DemoRiskProfile): { ok: true } | { ok: false; reason: SafetyBlockReason } {
  if (s.mode !== "DEMO_STRESS_TEST") return { ok: false, reason: "MODE_NOT_DEMO" };
  if (s.killSwitch) return { ok: false, reason: "KILL_SWITCH" };
  if (s.consumedSignalIds.has(signalId)) return { ok: false, reason: "DUPLICATE_SIGNAL" };
  if (s.openPositions >= p.maxOpenPositions) return { ok: false, reason: "MAX_OPEN_POSITIONS" };
  if (s.tradesToday >= p.maxTradesPerDay) return { ok: false, reason: "MAX_DAILY_TRADES" };
  if (dailyLossPercent(s.dayStartBalance, s.equity) >= p.maxDailyLossPercent - 1e-9) return { ok: false, reason: "DAILY_LOSS_LIMIT" };
  return { ok: true };
}

export function parseWhitelist(logins: string | undefined, servers: string | undefined): DemoWhitelist {
  const split = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return Object.freeze({ logins: split(logins).map(Number).filter((n) => Number.isInteger(n) && n > 0), servers: split(servers) });
}
