// Live dashboard wiring: WS config derivation, browser socket injection, canonical runtime mounting,
// bounded source-clock skew, and absence of any execution surface.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import { deriveWsBaseUrl, makeGatewayConfig } from "@/core/broker/gateway/config";
import { AnomalyClassifier } from "@/core/broker/AnomalyClassifier";
import type { BrokerMarketEvent } from "@/core/broker/types";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { browserWebSocketFactory } from "@/lib/browserWebSocket";
import { measureBrokerOffset, mountCanonicalRuntime, resolveSymbolSpec, RUNTIME_CLASSIFIER, RUNTIME_POLICY, type MountedRuntime } from "@/lib/canonicalRuntimes";

describe("gateway WS config", () => {
  it("published HTTPS gateway derives WSS on the same origin", () => {
    const c = makeGatewayConfig({ httpBaseUrl: "https://abc.trycloudflare.com" });
    expect(c.wsBaseUrl).toBe("wss://abc.trycloudflare.com");
    expect(deriveWsBaseUrl("http://127.0.0.1:8000")).toBe("ws://127.0.0.1:8000");
  });
  it("explicit WS override wins; credentials still rejected", () => {
    expect(makeGatewayConfig({ httpBaseUrl: "https://a.example", wsBaseUrl: "wss://b.example" }).wsBaseUrl).toBe("wss://b.example");
    expect(() => makeGatewayConfig({ httpBaseUrl: "https://u:p@a.example" })).toThrow();
  });
  it("real config is labelled as configured Exness target, never FAKE_MT5_LOCAL", () => {
    expect(makeGatewayConfig({ httpBaseUrl: "https://a.example" }).environment).toBe("EXNESS_MT5_GATEWAY");
  });
});

describe("browser wsFactory", () => {
  it("constructs the global WebSocket with the requested URL", () => {
    const urls: string[] = [];
    class Stub { constructor(u: string) { urls.push(u); } }
    vi.stubGlobal("WebSocket", Stub);
    const ws = browserWebSocketFactory("wss://a.example/v1/stream");
    expect(ws).toBeInstanceOf(Stub);
    expect(urls).toEqual(["wss://a.example/v1/stream"]);
    vi.unstubAllGlobals();
  });
});

const ev = (event_at: number, observed_at: number, ingested_at: number): BrokerMarketEvent => ({
  symbol: "XAUUSD", bid: 1, ask: 1.1, event_at, observed_at, ingested_at, source: "EXNESS_MT5",
  provenance: { raw_event_id: `e${event_at}`, source: "EXNESS_MT5", symbol: "XAUUSD", received_at: observed_at, normalizer_version: "t", connection_epoch: 1, delivery: "STREAM" },
} as unknown as BrokerMarketEvent);
const DISTINCT = { dedup_class: "DISTINCT_OBSERVATION", evidence_status: "PROVEN" } as const;
const base = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };

describe("bounded positive source clock skew", () => {
  it("source 2.3s ahead of bridge is accepted and flagged, raw times untouched", () => {
    const c = new AnomalyClassifier({ ...base, maxSourceTimeSkewMs: 10_000 });
    const e = ev(1_000_2300, 1_000_0000, 1_000_0500);
    const out = c.classify(e, DISTINCT);
    expect(out.map((a) => a.disposition)).not.toContain("REJECT");
    expect(out.find((a) => a.classification === "SOURCE_TIME_SKEW")?.disposition).toBe("ACCEPT_WITH_FLAG");
    expect(e.event_at).toBe(1_000_2300);
  });
  it("large future timestamps stay TEMPORAL_INVALID", () => {
    const c = new AnomalyClassifier({ ...base, maxSourceTimeSkewMs: 10_000 });
    expect(c.classify(ev(1_000_0000 + 30_000, 1_000_0000, 1_000_0500), DISTINCT)[0]!.classification).toBe("TEMPORAL_INVALID");
  });
  it("default (no skew policy) keeps strict ordering", () => {
    expect(new AnomalyClassifier(base).classify(ev(1_000_0001, 1_000_0000, 1_000_0500), DISTINCT)[0]!.classification).toBe("TEMPORAL_INVALID");
  });
  it("dashboard runtime classifier declares an explicit finite skew bound", () => {
    expect(RUNTIME_CLASSIFIER.maxSourceTimeSkewMs).toBe(RUNTIME_POLICY.max_source_time_skew_ms);
    expect(Number.isFinite(RUNTIME_POLICY.history_window_ms)).toBe(true);
  });
});

describe("G2 offset measurement (no default)", () => {
  it("aligned real tick (incl. negative bridge delay) ⇒ measured offset 0, diff preserved", () => {
    expect(measureBrokerOffset(1_000_2300, 1_000_0000)).toEqual({ status: "MEASURED", broker_utc_offset_ms: 0, observed_diff_ms: 2300 });
  });
  it("hours apart ⇒ UNRESOLVED, never guessed", () => {
    expect(measureBrokerOffset(1_000_0000 + 3 * 3_600_000, 1_000_0000).status).toBe("UNRESOLVED");
  });
});

const okEnv = <T,>(data: T, recv = 1_000_0000) => ({ ok: true as const, data, envelope: { source: "EXNESS_MT5", source_mode: "REAL", timing: { bridge_received_at: recv } } });
const spec = { broker_symbol: "XAUUSD", description: "", path: "", currency_base: "XAU", currency_profit: "USD", digits: 3, point: 0.001, trade_contract_size: 100 };
const fakeClient = (tickMs = 1_000_2000) => ({
  getSymbol: vi.fn(async () => okEnv(spec)),
  getLatestTick: vi.fn(async () => okEnv({ broker_symbol: "XAUUSD", raw_time_msc: tickMs })),
});

describe("live runtime mounting", () => {
  it("resolves spec from the gateway (BROKER_REPORTED), not synthetic constants", async () => {
    const r = await resolveSymbolSpec(fakeClient() as never, "XAUUSD");
    expect(r.ok && r.spec).toMatchObject({ origin: "BROKER_REPORTED", digits: 3, point: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
  });
  it("mounts a canonical runtime with live WS factory and finite history, and stop() tears it down", async () => {
    const reader = { symbol: "XAUUSD" };
    const rt = { reader, start: vi.fn(async () => "SYNCHRONIZED"), stop: vi.fn(), checkBoundaries: vi.fn() };
    const create = vi.fn(() => rt as never);
    const seen: MountedRuntime[] = [];
    const wsFactory = vi.fn();
    const stop = mountCanonicalRuntime({ client: fakeClient() as never, config: makeGatewayConfig({ httpBaseUrl: "https://a.example" }), wsFactory, symbol: "XAUUSD", now: () => 5_000_000, onChange: (m) => seen.push(m), create });
    await vi.waitFor(() => expect(rt.start).toHaveBeenCalled());
    expect((create.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).toMatchObject({ wsFactory, classifier: RUNTIME_CLASSIFIER, binding: { broker_symbol: "XAUUSD" } });
    expect(rt.start).toHaveBeenCalledWith({ history_from: 5_000_000 - RUNTIME_POLICY.history_window_ms, history_to: 5_000_000 });
    expect(seen.at(-1)?.reader).toBe(reader);
    stop();
    expect(rt.stop).toHaveBeenCalled();
  });
  it("unresolved offset ⇒ no runtime, reader null, reason surfaced (no fallback)", async () => {
    vi.useFakeTimers();
    const create = vi.fn();
    const seen: MountedRuntime[] = [];
    const stop = mountCanonicalRuntime({ client: fakeClient(1_000_0000 + 7_200_000) as never, config: makeGatewayConfig({ httpBaseUrl: "https://a.example" }), wsFactory: vi.fn(), symbol: "XAUUSD", onChange: (m) => seen.push(m), create: create as never });
    await vi.waitFor(() => expect(seen.at(-1)?.status).toMatch(/G2_OFFSET_UNRESOLVED/));
    expect(create).not.toHaveBeenCalled();
    expect(seen.every((m) => m.reader === null)).toBe(true);
    stop(); vi.useRealTimers();
  });
});

describe("no execution surface in live wiring", () => {
  it("new dashboard modules carry no order/trade functions", () => {
    for (const f of ["src/lib/canonicalRuntimes.ts", "src/lib/browserWebSocket.ts", "src/routes/index.tsx", "src/components/RealMarketTerminal.tsx", "src/core/broker/gateway/config.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/order_send|order_check|positions_get|placeOrder|executeOrder|invoke\(/);
    }
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
});
