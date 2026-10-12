import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LivePaperLoop, PAPER_STATE_VERSION, type PaperLoopState } from "@/core/paper/LivePaperLoop";
import { MemoryEngineStore, PaperPersistence } from "@/core/enginehost/persistence";
import { buildEngineEvents, routeEngineRequest } from "@/core/enginehost/api";
import { deriveBrokerClock } from "@/core/enginehost/brokerClock";
import { render, screen } from "@testing-library/react";
import { RadarObservabilityPanel } from "@/components/RadarObservabilityPanel";
import { deriveSymbolHealth } from "@/core/enginehost/health";
import { EngineHost } from "@/core/enginehost/EngineHost";
import { EngineHostClient } from "@/core/enginehost/client";
import type { MarketRuntime, MarketRuntimeReader } from "@/core/runtime/MarketRuntime";

const spec = Object.freeze({ symbol: "XAUUSD", origin: "BROKER_REPORTED" as const, digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
const row = (id: string) => ({ tradeId: id, profitLossUSD: 10, openedAt: 1, closedAt: 2, symbol: "XAUUSD" });
const stateWith = (journal: unknown[], balance = 10_010): PaperLoopState => ({
  version: PAPER_STATE_VERSION, symbol: "XAUUSD", dataSource: "REAL_MT5", balance, peak: balance, dayKey: 1, dayStart: 10_000,
  streak: { consecutiveLosses: 0, lastLossAt: null }, lastClose: 1_000_000, decision: "WAIT", spreads: [0.1], after: [], setup: null, open: null, journal,
});

describe("engine host — paper state persistence", () => {
  it("export → restore round-trips the virtual account on a fresh loop", () => {
    const a = new LivePaperLoop("XAUUSD", "REAL_MT5", spec);
    const s = { ...a.exportState(), balance: 10_250, peak: 10_300, decision: "OPEN BUY" } as PaperLoopState;
    const b = new LivePaperLoop("XAUUSD", "REAL_MT5", spec);
    b.restoreState(JSON.parse(JSON.stringify(s)));
    expect(b.account().balance).toBe(10_250);
    expect(b.account().lastDecision).toBe("OPEN BUY");
  });

  it("refuses foreign symbol / mixed data source / non-fresh loop", () => {
    const b = new LivePaperLoop("XAUUSD", "REAL_MT5", spec);
    expect(() => b.restoreState({ ...stateWith([]), symbol: "BTCUSD" })).toThrow();
    expect(() => b.restoreState({ ...stateWith([]), dataSource: "SYNTHETIC" })).toThrow();
    b.restoreState(stateWith([]));
    expect(() => b.restoreState(stateWith([]))).toThrow(/fresh/);
  });

  it("journal mirror is append-only: each tradeId written once, nothing rewritten", () => {
    const store = new MemoryEngineStore();
    const p = new PaperPersistence(store);
    p.load("XAUUSD", "REAL_MT5");
    p.persist(stateWith([row("T1")]));
    p.persist(stateWith([row("T1"), row("T2")], 10_020));
    p.persist(stateWith([row("T1"), row("T2")], 10_020));
    expect(store.journals.get("XAUUSD")!.map((l) => JSON.parse(l).tradeId)).toEqual(["T1", "T2"]);
    // a new process does not re-append already persisted rows
    const p2 = new PaperPersistence(store);
    expect(p2.load("XAUUSD", "REAL_MT5").state?.balance).toBe(10_020);
    p2.persist(stateWith([row("T1"), row("T2"), row("T3")], 10_030));
    expect(store.journals.get("XAUUSD")).toHaveLength(3);
  });

  it("corrupt or mismatched snapshot is reported, never replaced by defaults", () => {
    const store = new MemoryEngineStore();
    store.snapshots.set("XAUUSD", "{nope");
    expect(new PaperPersistence(store).load("XAUUSD", "REAL_MT5").error).toMatch(/CORRUPT/);
    store.snapshots.set("XAUUSD", JSON.stringify(stateWith([])));
    expect(new PaperPersistence(store).load("XAUUSD", "SYNTHETIC").error).toMatch(/SOURCE_MISMATCH/);
  });
});

function fakeReader(o: { lifecycle?: string; boot?: string; observed?: number | null; radar?: string }): MarketRuntimeReader {
  return {
    symbol: "XAUUSD",
    snapshot: () => ({ lifecycle: o.lifecycle ?? "RUNNING", bootstrap_state: o.boot ?? "SYNCHRONIZED", degraded_reason: null, last_stream_error: null }),
    latestLiveObservation: () => (o.observed == null ? null : { observed_at: o.observed, event_at: o.observed - 300 }),
    radarHealth: () => ({ status: o.radar ?? "ACTIVE", lastSuccessfulEvaluation: 0, validationMode: "REAL" }),
    radarSnapshot: () => null,
  } as unknown as MarketRuntimeReader;
}

describe("engine host — health", () => {
  const h = (reader: MarketRuntimeReader | null, mount_status = "MOUNTED", now = 100_000) => deriveSymbolHealth({ symbol: "XAUUSD", reader, mount_status, restarts: 0, now });
  it("maps runtime evidence to STARTING/SYNCING/ONLINE/DEGRADED/OFFLINE", () => {
    expect(h(null, "RESOLVING_SPEC").state).toBe("STARTING");
    expect(h(null, "SPEC_UNAVAILABLE TIMEOUT").state).toBe("OFFLINE");
    expect(h(fakeReader({ boot: "FETCHING_HISTORY", observed: 99_000 })).state).toBe("SYNCING");
    expect(h(fakeReader({ radar: "INITIALIZING", observed: 99_000 })).state).toBe("BOOTSTRAP");
    const on = h(fakeReader({ observed: 99_000 }));
    expect(on.state).toBe("ONLINE");
    expect(on.latency_ms).toBe(300);
    expect(h(fakeReader({ observed: 1_000 }), "MOUNTED", 500_000).error).toBe("STALE_FEED");
    expect(h(fakeReader({ boot: "DEGRADED", observed: 99_000 })).state).toBe("DEGRADED");
    expect(h(fakeReader({ lifecycle: "STOPPED" })).state).toBe("OFFLINE");
  });
});

describe("engine host — read-only API", () => {
  const host = { symbols: ["XAUUSD"], reader: () => fakeReader({ observed: 1 }), health: () => ({ operating_mode: "MONITOR_ONLY", execution_enabled: false, started_at: 0, persistence: "VPS_DISK", symbols: [] }) } as never;
  it("serves GET routes in engine-host-v1 envelopes and rejects writes", () => {
    const r = routeEngineRequest(host, "GET", "/v1/engine/health", 5);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ schema: "engine-host-v1", source: "ENGINE_HOST", data: { execution_enabled: false } });
    expect(routeEngineRequest(host, "GET", "/v1/engine/XAUUSD/radar", 5).status).toBe(200);
    expect(routeEngineRequest(host, "GET", "/v1/engine/BTCUSD/radar", 5).status).toBe(404);
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect(routeEngineRequest(host, m, "/v1/engine/health", 5).status).toBe(405);
    expect(routeEngineRequest(host, "GET", "/v1/engine/order", 5).status).toBe(404);
  });
});

describe("engine host — supervisor restores state into each new runtime", () => {
  it("restores before start and remounts after sustained OFFLINE", () => {
    const store = new MemoryEngineStore();
    store.snapshots.set("XAUUSD", JSON.stringify(stateWith([row("T1")], 10_500)));
    let now = 0, mounts = 0;
    const restored: number[] = [];
    const host = new EngineHost({
      symbols: ["XAUUSD"], persistence: new PaperPersistence(store), now: () => now,
      policy: { tick_ms: 1000, remount_after_ms: 10_000, backoff_min_ms: 1000, backoff_max_ms: 4000 },
      mount: ({ onChange, onRuntime }) => {
        mounts++;
        const loop = new LivePaperLoop("XAUUSD", "REAL_MT5", spec);
        const rt = { paperState: () => loop.exportState(), restorePaperState: (s: PaperLoopState) => { loop.restoreState(s); restored.push(s.balance); } } as unknown as MarketRuntime;
        onRuntime(rt);
        onChange({ symbol: "XAUUSD", reader: fakeReader({ lifecycle: "STOPPED" }), status: "MOUNTED" });
        return () => {};
      },
    });
    host.start(); host.stop(); // stop clears the interval; drive ticks manually
    expect(restored).toEqual([10_500]);
    expect(host.health().symbols[0]!.state).toBe("OFFLINE");
    now = 5_000; host.tick(); expect(mounts).toBe(1);
    now = 16_000; host.tick(); expect(mounts).toBe(2);
    expect(restored).toEqual([10_500, 10_500]);
    expect(host.health().symbols[0]!.restarts).toBe(1);
  });
});

describe("engine host — client", () => {
  const ok = (data: unknown) => (async () => new Response(JSON.stringify({ schema: "engine-host-v1", source: "ENGINE_HOST", generated_at: 1, data }))) as unknown as typeof fetch;
  it("accepts valid health and rejects envelopes claiming execution", async () => {
    const good = await new EngineHostClient({ baseUrl: "https://x.test", fetchImpl: ok({ operating_mode: "MONITOR_ONLY", execution_enabled: false, symbols: [{ symbol: "XAUUSD", state: "ONLINE" }] }) }).health();
    expect(good.ok).toBe(true);
    const bad = await new EngineHostClient({ baseUrl: "https://x.test", fetchImpl: ok({ operating_mode: "MONITOR_ONLY", execution_enabled: true, symbols: [] }) }).health();
    expect(bad).toEqual({ ok: false, error: "INVALID_ENVELOPE" });
    expect(() => new EngineHostClient({ baseUrl: "https://u:p@x.test" })).toThrow();
  });
});

describe("engine host — architecture", () => {
  it("has no order/execution or probe imports", () => {
    const dirs = [join(process.cwd(), "src/core/enginehost"), join(process.cwd(), "engine-host")];
    for (const d of dirs) for (const f of readdirSync(d).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(d, f), "utf8");
      expect(src, f).not.toMatch(/order_send|placeOrder|src\/probe|["'][^"'\n]*engine\/execution(?!-status)/);
    }
  });
});

describe("Phase 2 — persistent engine host", () => {
  it("broker clock: NORMAL ≤ 3000 ms, DRIFT_WARNING above, never rewrites timestamps", () => {
    const ev = { event_at: 1_000_000, observed_at: 1_001_000 };
    const n = deriveBrokerClock(ev);
    expect([n.status, n.clock_drift_ms, n.broker_time]).toEqual(["NORMAL", 1000, new Date(1_000_000).toISOString()]);
    expect(deriveBrokerClock({ event_at: 1_000_000, observed_at: 1_004_500 }).status).toBe("DRIFT_WARNING");
    expect(deriveBrokerClock({ event_at: 1_004_500, observed_at: 1_000_000 }).status).toBe("DRIFT_WARNING");
    expect(ev).toEqual({ event_at: 1_000_000, observed_at: 1_001_000 }); // input untouched
    expect(deriveBrokerClock(null).status).toBe("UNKNOWN");
  });

  it("BOOTSTRAP until the radar baseline exists; health carries the broker clock", () => {
    const b = deriveSymbolHealth({ symbol: "XAUUSD", reader: fakeReader({ radar: "INITIALIZING", observed: 99_000 }), mount_status: "MOUNTED", restarts: 0, now: 100_000 });
    expect(b.state).toBe("BOOTSTRAP");
    expect(b.clock.status).toBe("NORMAL");
  });

  it("serves market-context, aggregate account/journal and SSE events; still read-only", () => {
    const snap = { generatedAt: 7, lastEvaluatedBarTime: 6, intelligence: { status: "WAIT_CONFIRMATION" } };
    const reader = { ...fakeReader({ observed: 1 }), radarSnapshot: () => snap, paperAccount: () => ({ balance: 1 }), paperTrades: () => [row("T1")] };
    const host = { symbols: ["XAUUSD"], reader: () => reader, health: () => ({ operating_mode: "MONITOR_ONLY", execution_enabled: false, symbols: [] }) } as never;
    expect(JSON.parse(routeEngineRequest(host, "GET", "/v1/engine/XAUUSD/market-context", 1).body).data).toMatchObject({ report: { status: "WAIT_CONFIRMATION" }, evaluated_bar_close: 6 });
    expect(JSON.parse(routeEngineRequest(host, "GET", "/v1/engine/account", 1).body).data.accounts).toHaveLength(1);
    expect(JSON.parse(routeEngineRequest(host, "GET", "/v1/engine/journal", 1).body).data.trades).toHaveLength(1);
    expect(routeEngineRequest(host, "POST", "/v1/engine/journal", 1).status).toBe(405);
    const seen = new Map<string, number>();
    expect(buildEngineEvents(host, 1, seen).map((e) => e.type)).toEqual(["HEALTH_UPDATE", "RADAR_UPDATE", "MARKET_CONTEXT_UPDATE"]);
    expect(buildEngineEvents(host, 2, seen).map((e) => e.type)).toEqual(["HEALTH_UPDATE"]); // no new CLOSED evaluation ⇒ no duplicate
  });

  it("restart recovery: a new host process restores snapshot + journal; journal rows are never rewritten", () => {
    const store = new MemoryEngineStore();
    const p1 = new PaperPersistence(store);
    p1.load("XAUUSD", "REAL_MT5");
    p1.persist(stateWith([row("T1")], 10_010));
    p1.persist(stateWith([row("T1"), row("T2")], 10_020));
    const before = [...store.readJournalLines("XAUUSD")];
    // "VPS restart": brand-new persistence over the same disk
    const { state } = new PaperPersistence(store).load("XAUUSD", "REAL_MT5");
    expect(state?.balance).toBe(10_020);
    expect(state?.journal).toHaveLength(2);
    new PaperPersistence(store).persist(stateWith([row("T1"), row("T2")], 10_020));
    expect(store.readJournalLines("XAUUSD").slice(0, before.length)).toEqual(before);
  });

  it("gateway reconnect: sustained STALE_FEED (DEGRADED) triggers a remount", () => {
    let now = 0, mounts = 0;
    const host = new EngineHost({
      symbols: ["XAUUSD"], persistence: new PaperPersistence(new MemoryEngineStore()), now: () => now,
      policy: { tick_ms: 1000, remount_after_ms: 10_000, backoff_min_ms: 1000, backoff_max_ms: 4000 },
      mount: ({ onChange }) => { mounts++; onChange({ symbol: "XAUUSD", reader: fakeReader({ observed: 1 }), status: "MOUNTED" }); return () => {}; },
    });
    host.start(); host.stop();
    now = 200_000; host.tick(); expect(host.health().symbols[0]!.error).toBe("STALE_FEED");
    now = 211_000; host.tick(); expect(mounts).toBe(2);
  });

  it("dashboard attach mode: labels never mix; ephemeral warning only in browser session", () => {
    const facts = (source: "ENGINE_HOST" | "BROWSER_SESSION") => ({ source, symbol: "XAUUSD", timestamp: 1, radar: null, radarHealth: null, live: null, lastM5Close: null, account: null, trades: [],
      engineHealth: source === "ENGINE_HOST" ? deriveSymbolHealth({ symbol: "XAUUSD", reader: fakeReader({ observed: 99_000 }), mount_status: "MOUNTED", restarts: 0, now: 100_000 }) : null });
    const { unmount } = render(<RadarObservabilityPanel facts={facts("ENGINE_HOST")} symbol="XAUUSD" />);
    expect(screen.getByTestId("engine-source").textContent).toMatch(/^ENGINE HOST VPS \(LIVE\)/);
    expect(screen.queryByTestId("ephemeral-warning")).toBeNull();
    unmount();
    render(<RadarObservabilityPanel facts={facts("BROWSER_SESSION")} symbol="XAUUSD" fallbackReason="TIMEOUT" />);
    expect(screen.getByTestId("engine-source").textContent).toMatch(/^BROWSER SESSION \(EPHEMERAL\) · ENGINE HOST OFFLINE/);
    expect(screen.getByTestId("ephemeral-warning")).toBeTruthy();
  });

  it("no execution surface in engine host or radar volatility path", () => {
    for (const f of ["src/core/enginehost/brokerClock.ts", "src/core/enginehost/api.ts", "engine-host/main.ts", "src/core/radar/RadarRuntimeService.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/OrderSend|order_send|placeOrder|engine\/execution(?!-status)|engine\/risk|\/v1\/order/i);
    }
  });
});
