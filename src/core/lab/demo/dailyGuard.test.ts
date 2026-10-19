import { describe, expect, it } from "vitest";
import { evaluateDailyGuard, INITIAL_GUARD_STATE, restoreGuardState, type GuardInput, type DailyGuardState } from "./dailyGuard";

const T = Date.UTC(2026, 9, 19, 10) / 1000;
const base: GuardInput = { serverTimeSec: T, accountVerifiedDemo: true, reconciliationClean: true, deals: [], positions: [], closeFailures: 0 };
const deal = (ticket: number, profit: number, extra = {}) => ({ ticket, time: T - 60, profit, isBot: true, ...extra });
const pos = (ticket: number, profit: number | null, symbol = "XAUUSD") => ({ ticket, signalId: `s${ticket}`, symbol, profit });

describe("lab demo daily guard", () => {
  it("fails closed until baseline/account/reconciliation are present", () => {
    expect(evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, accountVerifiedDemo: false }).allowEntries).toBe(false);
    expect(evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, deals: null }).allowEntries).toBe(false);
    expect(evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, reconciliationClean: false }).allowEntries).toBe(false);
    expect(evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, serverTimeSec: null }).allowEntries).toBe(false);
    expect(evaluateDailyGuard(INITIAL_GUARD_STATE, base).allowEntries).toBe(true);
  });

  it("+$50 target stops entries and closes all bot positions", () => {
    const d = evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, deals: [deal(1, 40)], positions: [pos(5, 6), pos(6, 4, "BTCUSD")] });
    expect(d.totalUsd).toBe(50);
    expect(d.allowEntries).toBe(false);
    expect(d.closeTickets.map((c) => c.ticket)).toEqual([5, 6]);
  });

  it("-$30 loss stops entries and closes bot positions; fees count", () => {
    const d = evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, deals: [deal(1, -25, { commission: -2, swap: -1 })], positions: [pos(5, -2)] });
    expect(d.totalUsd).toBe(-30);
    expect(d.allowEntries).toBe(false);
    expect(d.state.phase).toBe("FLATTENING");
  });

  it("combines all modes/symbols and never double-counts a deal", () => {
    const a = evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, deals: [deal(1, 10), deal(2, 5, { isBot: true })] });
    const b = evaluateDailyGuard(a.state, { ...base, deals: [deal(1, 10), deal(2, 5), deal(3, -3)] });
    expect(b.state.realizedUsd).toBe(12);
    const manual = evaluateDailyGuard(b.state, { ...base, deals: [deal(9, 100, { isBot: false })] });
    expect(manual.state.realizedUsd).toBe(12);
  });

  it("close failure / unknown floating fails closed", () => {
    const hit = evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, deals: [deal(1, 60)], positions: [pos(5, 0)] });
    expect(evaluateDailyGuard(hit.state, { ...base, positions: [pos(5, 0)], closeFailures: 1 }).state.phase).toBe("HALTED_FAIL_CLOSED");
    expect(evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, positions: [pos(5, null)] }).allowEntries).toBe(false);
  });

  it("latched day stays closed after restart; new broker day reopens only when clean", () => {
    const hit = evaluateDailyGuard(INITIAL_GUARD_STATE, { ...base, deals: [deal(1, 60)] });
    const restored = restoreGuardState(JSON.parse(JSON.stringify(hit.state))) as DailyGuardState;
    expect(evaluateDailyGuard(restored, { ...base, deals: [deal(1, 60)] }).allowEntries).toBe(false);
    expect(evaluateDailyGuard(restored, { ...base, deals: [deal(1, 60)] }).state.realizedUsd).toBe(60);
    const next = T + 86_400;
    expect(evaluateDailyGuard(restored, { ...base, serverTimeSec: next, reconciliationClean: false }).allowEntries).toBe(false);
    expect(evaluateDailyGuard(restored, { ...base, serverTimeSec: next }).allowEntries).toBe(true);
    expect(restoreGuardState("garbage").phase).toBe("HALTED_FAIL_CLOSED");
  });
});
