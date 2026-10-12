import { describe, expect, it } from "vitest";
import { buildExecutionStatus } from "./executionStatus";
import { exeLamp } from "@/lib/exeLamp";
import { isEngineHostHealth, isExecutionStatus } from "./client";
import type { EngineReadiness } from "./readiness";
import type { SymbolEngineHealth } from "./types";

const NOW = 1_000_000;
const sym = { symbol: "BTCUSD", state: "ONLINE" } as unknown as SymbolEngineHealth;
const rd = (m2: string, m4: string, stale = false) => ({ stale, m2: { status: m2 }, m4: { status: m4 } }) as unknown as EngineReadiness;
const demo = { account: { ok: true, reason: null }, openPositions: 0 };
const base = { now: NOW, symbols: [sym], armed: true, shadowActive: false, killSwitch: false, demo, reconciliationBlocked: false, readiness: [rd("BLOCKED", "UNKNOWN")] };

describe("Status Synchronization acceptance", () => {
  it("A: engine online, no signal → ONLINE / DEMO_EXECUTION / yellow WAITING SIGNAL", () => {
    const s = buildExecutionStatus(base);
    expect(isExecutionStatus(s)).toBe(true);
    const l = exeLamp(s, NOW, "LIVE", NOW);
    expect([l.engine, l.mode, l.execution, l.tone]).toEqual(["ONLINE", "DEMO_EXECUTION", "WAITING_SIGNAL", "waiting"]);
  });
  it("B: Decision Gate READY + risk PASS → green READY", () => {
    const l = exeLamp(buildExecutionStatus({ ...base, readiness: [rd("PASS", "PASS")] }), NOW, "LIVE", NOW);
    expect([l.execution, l.tone]).toEqual(["READY", "healthy"]);
  });
  it("C: kill switch active → red BLOCKED", () => {
    const s = buildExecutionStatus({ ...base, killSwitch: true, readiness: [rd("PASS", "PASS")] });
    const l = exeLamp(s, NOW, "LIVE", NOW);
    expect([l.execution, l.tone]).toEqual(["BLOCKED", "attention"]);
    expect(s.blockers).toContain("KILL_SWITCH");
  });
  it("D: stale data is never green", () => {
    const ready = buildExecutionStatus({ ...base, readiness: [rd("PASS", "PASS")] });
    expect(exeLamp(ready, NOW - 31_000, "LIVE", NOW).tone).not.toBe("healthy");
    expect(exeLamp(buildExecutionStatus({ ...base, readiness: [rd("PASS", "PASS", true)] }), NOW, "LIVE", NOW).tone).not.toBe("healthy");
    expect(exeLamp(null, null, "LIVE", NOW).tone).toBe("unknown");
    expect(exeLamp(ready, NOW, "OFFLINE", NOW).tone).toBe("unknown");
  });
  it("MONITOR_ONLY and MT5 disconnect are red", () => {
    expect(exeLamp(buildExecutionStatus({ ...base, armed: false }), NOW, "LIVE", NOW).tone).toBe("attention");
    expect(exeLamp(buildExecutionStatus({ ...base, demo: { account: { ok: false, reason: "IDENTITY_UNAVAILABLE" } } }), NOW, "LIVE", NOW).tone).toBe("attention");
  });
  it("dashboard accepts DEMO health, rejects unknown modes and MONITOR_ONLY+enabled", () => {
    const h = { symbols: [sym] };
    expect(isEngineHostHealth({ ...h, operating_mode: "DEMO", execution_enabled: true })).toBe(true);
    expect(isEngineHostHealth({ ...h, operating_mode: "MONITOR_ONLY", execution_enabled: false })).toBe(true);
    expect(isEngineHostHealth({ ...h, operating_mode: "MONITOR_ONLY", execution_enabled: true })).toBe(false);
    expect(isEngineHostHealth({ ...h, operating_mode: "LIVE", execution_enabled: true })).toBe(false);
  });
});
