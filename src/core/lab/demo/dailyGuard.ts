/**
 * Lab DEMO daily portfolio guard (pure). Combines realized broker deals (deduped by deal ticket,
 * profit+swap+commission) and floating P/L of bot positions across ALL modes and symbols.
 * Trading day = broker server day: dayKey derived from broker server time (seconds, already in server TZ,
 * as MT5 reports deal.time), so DST/timezone follow the broker, never the VPS clock.
 * Thresholds are triggers, not guaranteed close prices. Per-trade SL stays mandatory elsewhere.
 * Any missing/unknown input fails closed (entries blocked).
 */
export const LAB_DEMO_DAILY_GUARD_VERSION = "lab-demo-daily-guard-v1";

export interface DailyGuardLimits {
  readonly targetUsd: number; // +50
  readonly lossUsd: number; // 30 (as positive magnitude)
}
export const DEFAULT_DAILY_LIMITS: DailyGuardLimits = Object.freeze({ targetUsd: 50, lossUsd: 30 });

export interface BrokerDeal {
  readonly ticket: number;
  readonly time: number; // broker server time, seconds
  readonly profit: number;
  readonly swap?: number;
  readonly commission?: number;
  readonly fee?: number;
  readonly isBot: boolean; // magic + signal id verified by caller
}
export interface BotPosition {
  readonly ticket: number;
  readonly signalId: string;
  readonly symbol: string;
  readonly profit: number | null; // floating incl. swap if broker reports it
}

export type GuardPhase = "TRADING" | "TARGET_HIT" | "LOSS_HIT" | "FLATTENING" | "HALTED_FAIL_CLOSED";

export interface DailyGuardState {
  readonly dayKey: string | null;
  readonly phase: GuardPhase;
  readonly countedDealTickets: readonly number[];
  readonly realizedUsd: number;
  readonly triggeredAt: number | null;
  readonly reason: string | null;
}
export const INITIAL_GUARD_STATE: DailyGuardState = Object.freeze({
  dayKey: null, phase: "HALTED_FAIL_CLOSED", countedDealTickets: [], realizedUsd: 0, triggeredAt: null, reason: "BASELINE_NOT_RESTORED",
});

export function brokerDayKey(serverTimeSec: number): string {
  return new Date(serverTimeSec * 1000).toISOString().slice(0, 10);
}

export interface GuardInput {
  readonly serverTimeSec: number | null;
  readonly accountVerifiedDemo: boolean;
  readonly reconciliationClean: boolean;
  readonly deals: readonly BrokerDeal[] | null; // today's deals, null = unavailable
  readonly positions: readonly BotPosition[] | null; // null = unavailable
  readonly closeFailures: number; // unresolved close failures (UNVERIFIED/REJECTED/timeout)
}

export interface GuardDecision {
  readonly state: DailyGuardState;
  readonly allowEntries: boolean;
  readonly closeTickets: readonly { ticket: number; signalId: string }[];
  readonly totalUsd: number | null;
  readonly floatingUsd: number | null;
}

const net = (d: BrokerDeal) => d.profit + (d.swap ?? 0) + (d.commission ?? 0) + (d.fee ?? 0);

export function evaluateDailyGuard(prev: DailyGuardState, input: GuardInput, limits: DailyGuardLimits = DEFAULT_DAILY_LIMITS): GuardDecision {
  const halt = (reason: string, s: DailyGuardState = prev): GuardDecision => ({
    state: Object.freeze({ ...s, phase: "HALTED_FAIL_CLOSED", reason }), allowEntries: false, closeTickets: [], totalUsd: null, floatingUsd: null,
  });
  if (input.serverTimeSec == null) return halt("BROKER_TIME_UNAVAILABLE");
  const day = brokerDayKey(input.serverTimeSec);
  // New broker day ⇒ fresh baseline, but only reopen after checks below pass.
  let s: DailyGuardState = prev.dayKey === day ? prev : { dayKey: day, phase: "TRADING", countedDealTickets: [], realizedUsd: 0, triggeredAt: null, reason: null };
  if (!input.accountVerifiedDemo) return halt("ACCOUNT_NOT_VERIFIED_DEMO", s);
  if (input.deals == null || input.positions == null) return halt("PNL_DATA_UNAVAILABLE", s);
  if (input.positions.some((p) => p.profit == null)) return halt("FLOATING_UNKNOWN", s);

  const seen = new Set(s.countedDealTickets);
  let realized = s.realizedUsd;
  for (const d of input.deals) {
    if (!d.isBot || seen.has(d.ticket) || brokerDayKey(d.time) !== day) continue;
    seen.add(d.ticket);
    realized += net(d);
  }
  const floating = input.positions.reduce((a, p) => a + (p.profit as number), 0);
  const total = realized + floating;
  s = { ...s, countedDealTickets: [...seen], realizedUsd: realized };

  const all = input.positions.map((p) => ({ ticket: p.ticket, signalId: p.signalId }));
  const latched = s.phase === "TARGET_HIT" || s.phase === "LOSS_HIT" || s.phase === "FLATTENING";
  if (!latched) {
    if (total >= limits.targetUsd) s = { ...s, phase: "TARGET_HIT", triggeredAt: input.serverTimeSec, reason: `TOTAL ${total.toFixed(2)} >= +${limits.targetUsd}` };
    else if (total <= -limits.lossUsd) s = { ...s, phase: "LOSS_HIT", triggeredAt: input.serverTimeSec, reason: `TOTAL ${total.toFixed(2)} <= -${limits.lossUsd}` };
  }
  if (s.phase === "TARGET_HIT" || s.phase === "LOSS_HIT" || s.phase === "FLATTENING") {
    const next = all.length ? "FLATTENING" : s.phase === "FLATTENING" ? (s.reason?.startsWith("TOTAL") && total >= 0 ? "TARGET_HIT" : s.phase) : s.phase;
    if (input.closeFailures > 0) return halt("CLOSE_UNVERIFIED", { ...s });
    return { state: Object.freeze({ ...s, phase: next as GuardPhase }), allowEntries: false, closeTickets: all, totalUsd: total, floatingUsd: floating };
  }
  if (input.closeFailures > 0) return halt("CLOSE_UNVERIFIED", s);
  if (!input.reconciliationClean) return halt("RECONCILIATION_NOT_CLEAN", s);
  return { state: Object.freeze({ ...s, phase: "TRADING", reason: null }), allowEntries: true, closeTickets: [], totalUsd: total, floatingUsd: floating };
}

/** Restart recovery: persisted state is reused only for the same broker day; never re-opens a latched day. */
export function restoreGuardState(raw: unknown): DailyGuardState {
  if (!raw || typeof raw !== "object") return INITIAL_GUARD_STATE;
  const r = raw as Partial<DailyGuardState>;
  if (typeof r.dayKey !== "string" || !Array.isArray(r.countedDealTickets) || typeof r.realizedUsd !== "number" || typeof r.phase !== "string") return INITIAL_GUARD_STATE;
  return Object.freeze({ dayKey: r.dayKey, phase: r.phase as GuardPhase, countedDealTickets: r.countedDealTickets.filter((x) => typeof x === "number"), realizedUsd: r.realizedUsd, triggeredAt: r.triggeredAt ?? null, reason: r.reason ?? null });
}
