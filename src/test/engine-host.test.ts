import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LivePaperLoop, PAPER_STATE_VERSION, type PaperLoopState } from "@/core/paper/LivePaperLoop";
import { MemoryEngineStore, PaperPersistence } from "@/core/enginehost/persistence";
import { routeEngineRequest } from "@/core/enginehost/api";
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
    expect(h(fakeReader({ radar: "INITIALIZING", observed: 99_000 })).state).toBe("SYNCING");
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
      expect(src, f).not.toMatch(/order_send|placeOrder|src\/probe|engine\/execution/);
    }
  });
});
