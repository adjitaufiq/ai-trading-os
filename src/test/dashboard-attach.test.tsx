// Phase 2.1 acceptance: dashboard = view layer only when the engine host is LIVE.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EngineHostClient } from "@/core/enginehost/client";
import { ENGINE_HOST_SCHEMA, type EngineSymbolBundle } from "@/core/enginehost/types";
import { EngineHostStore, type EventSourceLike } from "@/lib/engineHostStore";
import { Telemetry } from "@/core/technical/indicators";
import { TechnicalSlicePanel } from "@/components/TechnicalSlicePanel";
import { PaperJournalStore } from "@/lib/paperJournal";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";

const SYMS = ["XAUUSD", "BTCUSD"];
const health = { operating_mode: "MONITOR_ONLY", execution_enabled: false, started_at: 0, persistence: "VPS_DISK",
  symbols: SYMS.map((symbol) => ({ symbol, state: "ONLINE", last_update_at: 1, latency_ms: 5, error: null, radar_status: "ACTIVE", mount_status: "MOUNTED", restarts: 0, clock: { status: "UNKNOWN", clock_drift_ms: null } })) };
const slice = (symbol: string) => ({ symbol, current: null, last_known: null, transitions: [], transitions_total: 0, spread: { ...new Telemetry(1).summary(), policy: "RESEARCH_REQUIRED" },
  latency_ms: { gateway_roundtrip: new Telemetry(1).summary(), evaluate: new Telemetry(1).summary() }, last_error: null,
  feed: { last_tick_event_at: null, last_tick_observed_at: null, last_tick_age_ms: null, freshness_policy: "RESEARCH_REQUIRED" }, canonical: null,
  time_axis: "BROKER_SERVER_TIME_UNRESOLVED_G2", data_source: "CANONICAL_MARKET_RUNTIME" });
const bundle = (symbol: string, ts: number, balance = 10_250): EngineSymbolBundle => ({
  symbol, source: "ENGINE_HOST", timestamp: ts, health: health.symbols.find((s) => s.symbol === symbol) as never, slice: slice(symbol) as never,
  radar: { snapshot: null, health: null }, live: null, last_m5_close: null, trades: [],
  account: { dataSource: "REAL_MT5", balance, equity: balance, openPositions: 0, realizedPnL: balance - 10_000, drawdownPercent: 0, riskPercent: 1, closedTrades: 3, lastDecision: "EVALUATED" } as never,
});
const env = (data: unknown) => ({ schema: ENGINE_HOST_SCHEMA, source: "ENGINE_HOST", generated_at: 1, data });

function fakeFetch(state: { up: boolean; calls: number }) {
  return (async (url: string) => {
    state.calls++;
    if (!state.up) throw new Error("ECONNREFUSED");
    const body = url.endsWith("/v1/engine/health") ? env(health) : env({ bundles: SYMS.map((s) => bundle(s, 1)) });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}
class FakeES implements EventSourceLike {
  handlers = new Map<string, (e: { data: string }) => void>();
  onerror = null; closed = false;
  addEventListener(t: string, cb: (e: { data: string }) => void) { this.handlers.set(t, cb); }
  close() { this.closed = true; }
  emit(t: string, payload: unknown) { this.handlers.get(t)?.({ data: JSON.stringify(payload) }); }
}
function mkStore(net: { up: boolean; calls: number }, es?: FakeES[]) {
  let now = 0;
  const store = new EngineHostStore({
    client: new EngineHostClient({ baseUrl: "http://engine.test", fetchImpl: fakeFetch(net) }), symbols: SYMS, now: () => now,
    eventSource: es ? () => { const e = new FakeES(); es.push(e); return e; } : null,
  });
  return { store, setNow: (n: number) => { now = n; } };
}

describe("Phase 2.1 dashboard full attach", () => {
  it("Test A — VPS LIVE: SOURCE ENGINE HOST, cards render the API values", async () => {
    const { store } = mkStore({ up: true, calls: 0 });
    await store.sync();
    expect(store.getState().status).toBe("LIVE");
    render(<TechnicalSlicePanel runtimes={SYMS.map((symbol) => ({ symbol, reader: null }))} selectedSymbol="XAUUSD" engine={store} store={new PaperJournalStore(null)} />);
    fireEvent.click(screen.getByTestId("cockpit-tab-radar"));
    expect(screen.getByTestId("engine-source").textContent).toMatch(/^ENGINE HOST VPS \(LIVE\)/);
    expect(screen.getByTestId("account-balance").textContent).toBe("$10,250.00");
    expect(screen.getByTestId("account-persistence").textContent).toMatch(/VPS/);
    expect(screen.getByTestId("mc-intel-source").textContent).toBe("ENGINE HOST VPS (LIVE)");
  });

  it("SSE priority: an SSE SNAPSHOT_UPDATE updates the store and the render (no polling)", async () => {
    const net = { up: true, calls: 0 }, es: FakeES[] = [];
    const { store } = mkStore(net, es);
    await store.sync();
    const callsAfterAttach = net.calls;
    render(<TechnicalSlicePanel runtimes={SYMS.map((symbol) => ({ symbol, reader: null }))} selectedSymbol="XAUUSD" engine={store} store={new PaperJournalStore(null)} />);
    fireEvent.click(screen.getByTestId("cockpit-tab-radar"));
    act(() => es[0]!.emit("SNAPSHOT_UPDATE", { type: "SNAPSHOT_UPDATE", symbol: "XAUUSD", timestamp: "x", data: bundle("XAUUSD", 2, 10_400) }));
    expect(screen.getByTestId("account-balance").textContent).toBe("$10,400.00");
    // Cross-symbol frame is rejected.
    act(() => es[0]!.emit("SNAPSHOT_UPDATE", { type: "SNAPSHOT_UPDATE", symbol: "XAUUSD", timestamp: "x", data: bundle("BTCUSD", 3, 1) }));
    expect(screen.getByTestId("account-balance").textContent).toBe("$10,400.00");
    expect(net.calls).toBe(callsAfterAttach);
  });

  it("Test B — VPS disconnect: OFFLINE fallback after hysteresis, with reason", async () => {
    const net = { up: true, calls: 0 };
    const { store, setNow } = mkStore(net);
    await store.sync();
    net.up = false;
    for (let i = 1; i <= 2; i++) { setNow(i * 20_000); await store.watchdog(); expect(store.getState().status).toBe("LIVE"); }
    setNow(60_000); await store.watchdog();
    expect(store.getState().status).toBe("OFFLINE");
    expect(store.getState().error).toMatch(/UNREACHABLE/);
    expect(store.getState().bundles).toEqual({});
    net.up = true; setNow(80_000); await store.watchdog();
    expect(store.getState().status).toBe("LIVE");
  });

  it("Test B — engine host unreachable at load ⇒ OFFLINE immediately (browser session may mount)", async () => {
    const { store } = mkStore({ up: false, calls: 0 });
    await store.sync();
    expect(store.getState().status).toBe("OFFLINE");
  });

  it("Test C — refresh: a fresh store restores radar/account/journal from one snapshot, no warmup wait", async () => {
    const { store } = mkStore({ up: true, calls: 0 });
    await store.sync(); // F5 ⇒ new store
    const b = store.getState().bundles["XAUUSD"]!;
    expect(b.account?.closedTrades).toBe(3);
    expect(b.slice).not.toBeNull();
    expect(Object.keys(store.getState().bundles).sort()).toEqual([...SYMS].sort());
  });

  it("Test D — never mix: engine store + a mounted browser runtime ⇒ STATE SOURCE MISMATCH", async () => {
    const { store } = mkStore({ up: true, calls: 0 });
    await store.sync();
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: {} as MarketRuntimeReader }]} selectedSymbol="XAUUSD" engine={store} store={new PaperJournalStore(null)} />);
    expect(screen.getByTestId("state-source-mismatch").textContent).toMatch(/STATE SOURCE MISMATCH/);
  });

  it("Test D — no duplicate engine: local runtime mounts only in BROWSER SESSION; panels hold no polling", () => {
    const idx = readFileSync("src/routes/index.tsx", "utf8");
    // A. The browser-session guard exists...
    expect(idx).toMatch(/if \(!browserSession\)/);
    // B. ...and that same guard clears the mounted local runtime (whitespace-tolerant: proves the invariant,
    // not the source formatting). ENGINE HOST LIVE ⇒ browserSession false ⇒ no local runtime stays mounted.
    expect(idx).toMatch(/if \(!browserSession\)\s*\{\s*setMounted\(\{\}\)\s*;/);
    // C. ...and that branch returns immediately (whitespace/comment-tolerant): the guard block is exactly
    // setMounted({}) + return, so mountCanonicalRuntime cannot run through it; and it appears only after the guard.
    const strip = idx.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const guard = strip.match(/if\s*\(\s*!browserSession\s*\)\s*\{([^{}]*(?:\{\s*\}[^{}]*)*)\}/);
    expect(guard).not.toBeNull();
    expect(guard![1]!.replace(/\s+/g, "")).toBe("setMounted({});return;");
    expect(strip.indexOf("mountCanonicalRuntime(", strip.indexOf(guard![0]))).toBeGreaterThan(strip.indexOf(guard![0]));
    expect(idx).toMatch(/const browserSession = engineState\.status === "DISABLED" \|\| engineState\.status === "OFFLINE"/);
    // BROWSER SESSION side of the invariant: only a browser session may consume the mounted local readers.
    expect(idx).toMatch(/browserSession \? \(mounted\[/);
    const radar = readFileSync("src/components/RadarObservabilityPanel.tsx", "utf8");
    expect(radar).not.toMatch(/setInterval|useEngineHost|radarSnapshot\(/);
    const panel = readFileSync("src/components/TechnicalSlicePanel.tsx", "utf8");
    expect(panel).not.toMatch(/useEngineHost\(|reader\.radarSnapshot/);
  });
});
