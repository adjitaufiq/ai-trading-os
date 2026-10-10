import { describe, expect, it } from "vitest";
import { buildReadiness, READINESS_STALE_MS } from "@/core/enginehost/readiness";
import { routeEngineRequest } from "@/core/enginehost/api";
import { LivePaperLoop, type PaperReadinessView } from "@/core/paper/LivePaperLoop";
import type { SymbolEngineHealth } from "@/core/enginehost/types";

const NOW = 1_800_000_000_000;
const health = (state: SymbolEngineHealth["state"] = "ONLINE") => ({ symbol: "XAUUSD", state, last_update_at: NOW - 1000, latency_ms: 10, error: null, radar_status: "READY", mount_status: "RUNNING", restarts: 0, clock: {} }) as unknown as SymbolEngineHealth;
const paper = (o: Partial<PaperReadinessView> = {}): PaperReadinessView => ({
  lastEvaluatedAt: NOW - 60_000, decision: "OPEN BUY",
  primaryBias: { bias: "BUY", asOf: NOW - 60_000, source: "TECHNICAL_H4_CLOSED" },
  m2: { at: NOW - 60_000, state: "READY", direction: "BUY" },
  m3: { at: NOW - 60_000, status: "PLANNED", holdReason: null, signalId: "s1" },
  m4: { at: NOW - 60_000, decision: "APPROVED", reasons: [], signalId: "s1" },
  openPosition: true, ...o,
});
const demo = (o: Record<string, unknown> = {}) => ({ mode: "DEMO_STRESS_TEST", killSwitch: false, account: { ok: true, reason: null, login: 123, server: "Exness-MT5Trial" }, openPositions: 1, tradesToday: 2, lastEvent: { type: "FILLED", at: NOW - 5000 }, ...o });

describe("Execution readiness (Phase 1, read-only)", () => {
  it("copies every stage from existing state when available", () => {
    const r = buildReadiness({ symbol: "XAUUSD", now: NOW, health: health(), executionMode: "DEMO_STRESS_TEST", paper: paper(), demo: demo() });
    expect(r.stale).toBe(false);
    expect([r.market, r.primary_bias, r.m2, r.m3, r.m4, r.demo, r.gateway, r.account].map((l) => l.status)).toEqual(Array(8).fill("PASS"));
    expect(r.primary_bias.bias).toBe("BUY");
    expect(r.m2.direction).toBe("BUY");
    expect(r.demo).toMatchObject({ kill_switch: false, open_positions: 1, trades_today: 2, last_event: "FILLED" });
    expect(r.account).toMatchObject({ login: 123, server: "Exness-MT5Trial" });
  });

  it("missing paper/demo state is UNKNOWN, never PASS", () => {
    const r = buildReadiness({ symbol: "XAUUSD", now: NOW, health: null, executionMode: "DEMO_STRESS_TEST", paper: null, demo: null });
    for (const l of [r.market, r.primary_bias, r.m2, r.m3, r.m4, r.demo, r.gateway, r.account]) expect(l.status).toBe("UNKNOWN");
    expect(r.stale).toBe(true);
  });

  it("old evaluation turns PASS lamps STALE", () => {
    const old = NOW - READINESS_STALE_MS - 1;
    const r = buildReadiness({ symbol: "XAUUSD", now: NOW, health: health(), executionMode: "DEMO_STRESS_TEST", paper: paper({ lastEvaluatedAt: old }), demo: demo() });
    expect(r.stale).toBe(true);
    expect([r.primary_bias.status, r.m2.status, r.m3.status, r.m4.status]).toEqual(["STALE", "STALE", "STALE", "STALE"]);
  });

  it("reports block reasons verbatim", () => {
    const r = buildReadiness({
      symbol: "XAUUSD", now: NOW, health: health("BOOTSTRAP"), executionMode: "DEMO_STRESS_TEST",
      paper: paper({ decision: "NO_SETUP COUNTER_PRIMARY_BIAS", primaryBias: { bias: "NONE", asOf: NOW - 1000, source: "TECHNICAL_H4_CLOSED" }, m2: { at: NOW - 1000, state: "NO_SETUP COUNTER_PRIMARY_BIAS", direction: "SELL" }, m3: { at: NOW - 1000, status: "HOLD", holdReason: "RR_TOO_LOW", signalId: "s" }, m4: { at: NOW - 1000, decision: "REJECTED", reasons: ["SPREAD_TOO_WIDE"], signalId: "s" } }),
      demo: demo({ killSwitch: true, account: { ok: false, reason: "IDENTITY_UNAVAILABLE", login: null, server: null } }),
    });
    expect(r.market).toMatchObject({ status: "BLOCKED", reason: "ENGINE_BOOTSTRAP" });
    expect(r.primary_bias).toMatchObject({ status: "BLOCKED", reason: "NO_PRIMARY_BIAS" });
    expect(r.m2).toMatchObject({ status: "BLOCKED", reason: "NO_SETUP COUNTER_PRIMARY_BIAS" });
    expect(r.m3).toMatchObject({ status: "BLOCKED", reason: "PLAN_HOLD RR_TOO_LOW" });
    expect(r.m4).toMatchObject({ status: "BLOCKED", reason: "RISK_REJECTED SPREAD_TOO_WIDE" });
    expect(r.demo).toMatchObject({ status: "BLOCKED", reason: "KILL_SWITCH" });
    expect(r.gateway.status).toBe("BLOCKED");
    expect(r.account).toMatchObject({ status: "BLOCKED", reason: "IDENTITY_UNAVAILABLE" });
  });

  it("host not in demo mode blocks the demo lamp", () => {
    const r = buildReadiness({ symbol: "XAUUSD", now: NOW, health: health(), executionMode: "REAL_DISABLED", paper: paper(), demo: { mode: "REAL_DISABLED" } });
    expect(r.demo).toMatchObject({ status: "BLOCKED", reason: "MODE_REAL_DISABLED" });
    expect(r.gateway.status).toBe("UNKNOWN");
  });

  it("fresh paper loop exposes an empty readiness view", () => {
    const loop = new LivePaperLoop("XAUUSD", "REAL_MT5", { tick_size: 0.01, contract_size: 100 } as never);
    expect(loop.readiness()).toEqual({ lastEvaluatedAt: null, decision: null, primaryBias: null, m2: null, m3: null, m4: null, openPosition: false, gate: null });
  });

  it("serves GET-only readiness routes", () => {
    const host = {
      symbols: ["XAUUSD"], health: () => ({}) as never, reader: () => null,
      readiness: (s: string, now: number) => buildReadiness({ symbol: s, now, health: null, executionMode: "REAL_DISABLED", paper: null, demo: null }),
    };
    const all = JSON.parse(routeEngineRequest(host, "GET", "/v1/engine/readiness", NOW).body);
    expect(all.data.symbols[0].schema).toBe("engine-readiness-v1");
    const one = JSON.parse(routeEngineRequest(host, "GET", "/v1/engine/XAUUSD/readiness", NOW).body);
    expect(one.data.readiness.symbol).toBe("XAUUSD");
    expect(routeEngineRequest(host, "POST", "/v1/engine/readiness", NOW).status).toBe(405);
    expect(routeEngineRequest(host, "GET", "/v1/engine/EURUSD/readiness", NOW).status).toBe(404);
  });
});
