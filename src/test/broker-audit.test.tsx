// Stage 3 — Real broker observability / audit UI. Deterministic (fake fetch, fixed clocks).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrokerGatewayClient, type FetchLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { BrokerAuditTerminal } from "@/components/BrokerAuditTerminal";
import { auditBars, spreadPrice, tickAge, utc } from "@/core/broker/audit/brokerAudit";
import { routeFor } from "@/core/broker/BrokerFeedPipeline";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import type { BridgeBar } from "@/core/broker/gateway/types";

const MSC = 1790974679954;
const NOW = MSC + 5_000;
let seq = 0;
const env = (cap: string, delivery: string, data: unknown, sourceEventAt: number | null = null) => ({
  schema_version: "3.0B-1", bridge_instance_id: "exness-demo-x", connection_epoch: 7, request_id: `req-${++seq}`.padEnd(32, "0"), sequence: seq,
  delivery, source: "EXNESS_MT5", source_mode: "REAL", capability: cap,
  timing: { source_event_at: sourceEventAt, bridge_received_at: MSC + 100, bridge_sent_at: MSC + 101, client_sent_at: null, client_received_at: null },
  latency: { source_arrival_delay_observed_ms: sourceEventAt == null ? null : 100 - (sourceEventAt - MSC), bridge_processing_ms: 1, bridge_to_client_apparent_delay_ms: null, transport_rtt_ms: null },
  ok: true, data, error: null,
});
const tick = { broker_symbol: "XAUUSD", raw_time_s: 1790974679, raw_time_msc: MSC, time_precision: "ms", bid: 4140.348, ask: 4140.53, last: 0.0, volume: 0.0, flags: 6 };
const spec = (s: string) => ({ broker_symbol: s, description: `${s} desc`, path: `Crypto\\${s}`, currency_base: "BTC", currency_profit: "USD", digits: 3, point: 0.001, trade_contract_size: 100 });
const BTC = ["BTCJPY", "BTCKRW", "BTCUSD", "BTCUSDT", "ETHBTC", "BTCTHB", "BTCXAG", "BTCXAU", "BTCZAR", "BTCAUD", "BTCCNH"];
const TF_S = { M5: 300, M15: 900, H1: 3600, H4: 14400 } as const;
const bar = (tf: keyof typeof TF_S, t: number, k: number): BridgeBar => ({
  broker_symbol: "XAUUSD", timeframe: tf, raw_time_s: t, time_precision: "s",
  open: 4138.554 + k, high: 4138.751 + k, low: 4135.741 + k, close: 4137.433 + k, tick_volume: 544 + k, spread: 168 + k, real_volume: 0,
} as unknown as BridgeBar);
const T0 = 1790973900;
const barsFor = (tf: keyof typeof TF_S) => {
  const d = TF_S[tf];
  // M5 has an explicit 2-interval gap and a duplicate to exercise diagnostics.
  const times = tf === "M5" ? [T0, T0 + d, T0 + 4 * d, T0 + 4 * d] : [T0, T0 + d, T0 + 2 * d];
  return times.map((t, i) => bar(tf, t, i));
};
const cov = (n: number, a: number, b: number) => ({ requested_from: null, requested_to: null, returned_count: n, oldest_returned_at: a, newest_returned_at: b, coverage_status: "COMPLETE", reason: null });

const realFetch: FetchLike = async (url) => {
  const u = new URL(url);
  const p = u.pathname;
  let body: unknown;
  if (p === "/v1/health") body = env("SYSTEM.HEALTH", "LIVE", { bridge_instance_id: "exness-demo-x", connection_epoch: 7, source_mode: "REAL", terminal_connected: true });
  else if (p === "/v1/terminal") body = env("SYSTEM.TERMINAL_INFO", "LIVE", { connected: true, terminal_ping_us: 12000, terminal_ping_ms: 12, retransmission: 0, trade_allowed_observed: true, tradeapi_disabled_observed: false, authority: "OBSERVATION_ONLY" });
  else if (p === "/v1/symbols") body = env("DISCOVERY.SYMBOLS", "LIVE", BTC.map(spec));
  else if (p === "/v1/symbols/XAUUSD") body = env("DISCOVERY.SYMBOL_INFO", "LIVE", { ...spec("XAUUSD"), currency_base: "XAU", path: "Metals\\XAUUSD" });
  else if (p === "/v1/ticks/latest/XAUUSD") body = env("MARKET_DATA.TICKS", "LIVE", tick, MSC);
  else if (p.startsWith("/v1/bars/XAUUSD/")) {
    const tf = p.split("/").pop() as keyof typeof TF_S;
    const items = barsFor(tf);
    body = env("MARKET_DATA.BARS", "BACKFILL", { items, coverage: cov(items.length, items[0].raw_time_s, items[items.length - 1].raw_time_s) });
  } else return { status: 404, text: async () => "" };
  return { status: 200, text: async () => JSON.stringify(body) };
};
const mono = () => { let t = 0; return { now: () => (t += 5) }; };
const mk = (f: FetchLike) => new BrokerGatewayClient({ config: makeGatewayConfig({ timeoutMs: 1000 }), wallClock: new ReplayClock(NOW), monoClock: mono(), fetchImpl: f });
const renderT = (f: FetchLike = realFetch, stale: number | null = 60_000) =>
  render(<BrokerAuditTerminal client={mk(f)} now={() => NOW} pollMs={60_000} initialStaleAfterMs={stale} />);
const tid = (id: string) => screen.getByTestId(id);

describe("Stage 3 audit helpers (pure)", () => {
  it("spread = ask − bid in price units", () => expect(spreadPrice(4140.348, 4140.53)).toBe(4140.53 - 4140.348));
  it("fresh / stale / unknown; negative age never clamped; LIVE not an input", () => {
    expect(tickAge(MSC, MSC + 1000, 60_000)).toEqual({ status: "FRESH", age_ms: 1000 });
    expect(tickAge(MSC, MSC + 3_600_000, 60_000).status).toBe("STALE");
    expect(tickAge(MSC, MSC + 1000, null)).toEqual({ status: "UNKNOWN", age_ms: 1000 });
    expect(tickAge(null, MSC, 60_000)).toEqual({ status: "UNKNOWN", age_ms: null });
    expect(tickAge(MSC, MSC - 50, 60_000).age_ms).toBe(-50);
  });
  it("utc rendering", () => expect(utc(MSC)).toBe("2026-10-02 21:37:59.954 UTC"));
  it("gap / duplicate / out-of-order detection without creating bars", () => {
    const input = [bar("M5", T0, 0), bar("M5", T0 + 300, 1), bar("M5", T0 + 1200, 2), bar("M5", T0 + 1200, 3), bar("M5", T0 + 900, 4)];
    const snapshot = JSON.stringify(input);
    const a = auditBars(input, "M5");
    expect(a.diagnostics.map((d) => d.kind)).toEqual(["FIRST", "CONTIGUOUS", "INTERVAL_GAP", "DUPLICATE_TIMESTAMP", "OUT_OF_ORDER"]);
    expect(a.diagnostics[2].missing_intervals).toBe(2);
    expect(a.count).toBe(5);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it("BACKFILL can never route to LIVE_MUTATION", () => {
    for (const d of ["ACCEPT", "ACCEPT_WITH_FLAG", "QUARANTINE", "RECONCILE", "REJECT"] as const) expect(routeFor(d, "BACKFILL")).not.toBe("LIVE_MUTATION");
  });
});

describe("Stage 3 audit terminal (render)", () => {
  it("raw XAU tick: exact bid/ask, spread, raw timestamps + UTC, LIVE delivery, sequence separate from event time", async () => {
    renderT();
    await waitFor(() => expect(tid("raw-bid").textContent).toBe("4140.348"));
    expect(tid("raw-ask").textContent).toBe("4140.53");
    expect(tid("top-bid").textContent).toBe("4140.348");
    expect(tid("raw-spread").textContent).toBe(String(4140.53 - 4140.348));
    await waitFor(() => expect(tid("top-spread").textContent).toBe("0.182"));
    expect(tid("raw-time-msc").textContent).toContain(String(MSC));
    expect(tid("raw-time-msc").textContent).toContain("2026-10-02 21:37:59.954 UTC");
    expect(tid("raw-time-s").textContent).toContain("1790974679");
    expect(tid("tick-delivery").textContent).toBe("LIVE");
    expect(within(tid("transport-seq")).getByTestId("tick-sequence").textContent).toMatch(/^\d+$/);
    expect(within(tid("temporal")).getByTestId("source-event-at").textContent).toContain(String(MSC));
    expect(tid("transport-seq").contains(tid("source-event-at"))).toBe(false);
  });
  it("freshness from broker event time with explicit threshold; UNKNOWN without policy", async () => {
    const r = renderT();
    await waitFor(() => expect(tid("freshness").textContent).toBe("FRESH · age 5000 ms"));
    r.unmount();
    render(<BrokerAuditTerminal client={mk(realFetch)} now={() => NOW} pollMs={60_000} initialStaleAfterMs={1000} />);
    await waitFor(() => expect(tid("freshness").textContent).toBe("STALE · age 5000 ms"));
    fireEvent.change(screen.getByLabelText("stale threshold ms"), { target: { value: "" } });
    await waitFor(() => expect(tid("freshness").textContent).toBe("UNKNOWN · age 5000 ms"));
  });
  it("symbol spec rendered exactly; unexposed fields labeled", async () => {
    renderT();
    await waitFor(() => expect(tid("spec-broker_symbol").textContent).toBe("XAUUSD"));
    expect(tid("spec-digits").textContent).toBe("3");
    expect(tid("spec-point").textContent).toBe("0.001");
    expect(tid("spec-trade_contract_size").textContent).toBe("100");
    expect(tid("spec-path").textContent).toBe("Metals\\XAUUSD");
    expect(within(tid("symbol-spec")).getAllByText("NOT EXPOSED BY CURRENT CONTRACT").length).toBeGreaterThan(0);
  });
  it("M5/M15/H1/H4 switching; raw OHLC/tick_volume/spread/real_volume preserved; BACKFILL labeled; coverage; gaps; no synthetic candles", async () => {
    renderT();
    await waitFor(() => expect(screen.getByTestId("coverage-H4")).toBeTruthy());
    // M5: 4 returned bars → exactly 4 rows and 4 candles (gap NOT filled).
    expect(screen.getAllByTestId("bar-row")).toHaveLength(4);
    expect(tid("candle-chart").getAttribute("data-candles")).toBe("4");
    expect(tid("bars-delivery").textContent).toBe("BACKFILL");
    expect(tid("gap-gaps").textContent).toBe("1");
    expect(tid("gap-dups").textContent).toBe("1");
    expect(tid("gap-ooo").textContent).toBe("0");
    const first = screen.getAllByTestId("bar-row").at(-1)!;
    for (const v of ["4138.554", "4138.751", "4135.741", "4137.433", "544", "168", "1790973900"]) expect(first.textContent).toContain(v);
    expect(within(tid("coverage")).getAllByText("REQUEST COMPLETED")).toHaveLength(4);
    expect(tid("coverage").textContent).toContain("NOT \"OBSERVATION COVERAGE COMPLETE\"");
    for (const tf of ["M15", "H1", "H4"]) {
      fireEvent.click(screen.getByRole("tab", { name: tf }));
      expect(screen.getAllByTestId("bar-row")).toHaveLength(3);
      expect(screen.getAllByTestId("bar-row")[0].textContent).toContain(tf);
      expect(tid("gap-gaps").textContent).toBe("0");
      expect(tid("bars-delivery").textContent).toBe("BACKFILL");
    }
  });
  it("MT5 comparison stays PENDING; BTC ambiguity preserved with every candidate", async () => {
    renderT();
    await waitFor(() => expect(screen.getAllByTestId("btc-row")).toHaveLength(BTC.length));
    expect(screen.getAllByTestId("btc-row").map((r) => r.firstChild!.textContent)).toEqual(BTC);
    expect(tid("btc-resolution").textContent).toBe("BTC SYMBOL RESOLUTION: AMBIGUOUS");
    expect(tid("compare-status").textContent).toBe("COMPARISON PENDING");
    expect(tid("mt5-compare").textContent).not.toMatch(/\bMATCH\b(?! automatically)/);
  });
  it("no mock fallback when gateway is unreachable", async () => {
    renderT(async () => { throw new Error("down"); });
    await waitFor(() => expect(screen.getAllByTestId("audit-error").length).toBeGreaterThan(0));
    expect(tid("raw-bid").textContent).toBe("—");
    expect(screen.queryAllByTestId("btc-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("bar-row")).toHaveLength(0);
    expect(document.body.textContent).toContain("NO MOCK FALLBACK");
  });
  it("safety: MONITOR_ONLY, execution ABSENT, no BUY/SELL/order controls, no LIVE TRADING", async () => {
    renderT();
    await waitFor(() => expect(tid("raw-bid").textContent).toBe("4140.348"));
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    expect(tid("op-mode").textContent).toBe("MONITOR_ONLY");
    expect(tid("exec-enabled").textContent).toBe("false");
    for (const l of ["EXNESS MT5", "REAL", "READ-ONLY", "MONITOR_ONLY", "EXECUTION ABSENT", "WEBSOCKET DEFERRED"]) expect(tid("audit-labels").textContent).toContain(l);
    expect(document.body.textContent).not.toMatch(/LIVE TRADING/i);
    for (const b of screen.getAllByRole("button")) expect(b.textContent).not.toMatch(/buy|sell|order|close position/i);
    const src = readFileSync("src/components/BrokerAuditTerminal.tsx", "utf8") + readFileSync("src/core/broker/audit/brokerAudit.ts", "utf8") + readFileSync("src/routes/audit.tsx", "utf8");
    expect(src).not.toMatch(/order_send|order_check|positions_|orders_|invoke\(|\.rpc\(|WebSocket\(|MetaTrader5/);
  });
  it("Wire 3.0B-1 validators unchanged (hash pinned to pre-task source)", () => {
    const h = createHash("sha256").update(readFileSync("src/core/broker/gateway/validate.ts")).digest("hex");
    expect(h).toBe("5da33b861c4c90a038d7e166f7b4f9931cce31242edf32fec7c4277484af6340");
    expect(readFileSync("src/core/broker/gateway/validate.ts", "utf8")).toContain('"3.0B-1"');
  });
});
