import { describe, it, expect, vi } from "vitest";
import { ShadowGuard, shadowGatedGateway, resolveShadowActive, parseShadowSafety, type ShadowStore } from "@/core/execution/shadow/ShadowGuard";
import { DemoExecutionBridge } from "@/core/execution/demo/DemoExecutionBridge";
import type { DemoExecGatewayPort, DemoOrderIntent } from "@/core/execution/demo/types";
import { marketDataHealth, decisionHealth } from "@/core/enginehost/monitoring";
import { routeEngineRequest } from "@/core/enginehost/api";

const mem = (): ShadowStore & { lines: string[] } => { const lines: string[] = []; return { lines, readLines: () => [...lines], append: (l) => { lines.push(l); } }; };
const intent = (id = "sig1", o: Partial<DemoOrderIntent> = {}): DemoOrderIntent => ({
  signalId: id, planId: "p", symbol: "XAUUSD", direction: "BUY", plannedEntry: 2000, stopLoss: 1990, takeProfit: 2020, rr: 2, closedBarAt: 1,
  context: { regime: "TREND", h4Bias: "BULLISH", h1State: null, setup: "Z1", decision: "READY", confidence: 0.7, primaryBias: "BUY", reasons: ["r"], signalSource: { m3: "x" }, engineSnapshot: null }, ...o,
});
const port = () => {
  const sendOrder = vi.fn(async () => ({ status: "FILLED" as const, ticket: 1, price: 2000, retcode: 10009, comment: "ok" }));
  const p: DemoExecGatewayPort = {
    account: async () => ({ login: 1, server: "S", tradeMode: "DEMO", balance: 10000, equity: 10000, currency: "USD" }),
    symbol: async () => ({ symbol: "XAUUSD", contractSize: 100, tickSize: 0.01, tickValue: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 } as never),
    positions: async () => [], closeDeal: async () => null, sendOrder,
  };
  return { p, sendOrder };
};

describe("Shadow Guard", () => {
  it("ALLOW decision → shadow block → no broker request (intent gate + port)", async () => {
    const { p, sendOrder } = port();
    const g = new ShadowGuard({ active: () => true, store: mem(), now: () => 1e12 });
    const r = g.gate(intent());
    expect(r.allow).toBe(false);
    expect(r.record).toMatchObject({ mode: "SHADOW", symbol: "XAUUSD", decision: "ALLOW", blocked_by: "SHADOW_GUARD", execution: { shadow_block: true, order_prevented: true } });
    expect(r.record.risk_plan).toMatchObject({ entry: 2000, stop_loss: 1990, take_profit: 2020 });
    expect(r.record.market).toMatchObject({ timeframe: "M5", bias: "BUY", zone: "Z1" });
    // even if a bug forwards the intent to a fully-armed demo bridge, the gated port never sends
    const bridge = new DemoExecutionBridge({ mode: "DEMO_STRESS_TEST", gateway: shadowGatedGateway(p, g), whitelist: { logins: [1], servers: ["S"] }, store: { readLines: () => [], append: () => {} }, killSwitch: () => false, now: () => 1e12 });
    await bridge.handle(intent("sig2"));
    expect(sendOrder).not.toHaveBeenCalled();
    expect(g.all().some((x) => x.source === "GATEWAY_PORT" && x.blocked_by === "SHADOW_GUARD")).toBe(true);
  });

  it("restart keeps shadow journal and duplicate protection", () => {
    const s = mem();
    new ShadowGuard({ active: () => true, store: s, now: () => 1e12 }).gate(intent("a"));
    const g2 = new ShadowGuard({ active: () => true, store: s, now: () => 1e12 });
    expect(g2.status().blocked_total).toBe(1);
    expect(g2.gate(intent("a")).record.blocked_by).toBe("DUPLICATE_ORDER");
    expect(s.lines.length).toBe(2);
  });

  it("duplicate second request is rejected even with shadow off", () => {
    const g = new ShadowGuard({ active: () => false, store: mem(), now: () => 1e12 });
    expect(g.gate(intent("d")).allow).toBe(true);
    expect(g.gate(intent("d"))).toMatchObject({ allow: false, record: { blocked_by: "DUPLICATE_ORDER" } });
  });

  it("safety config: SL/TP required, emergency stop, max position, daily cap", () => {
    const mk = (o: object = {}) => new ShadowGuard({ active: () => false, store: mem(), now: () => 1e12, ...o });
    expect(mk().gate(intent("s", { stopLoss: 0 })).record.blocked_by).toBe("SL_REQUIRED");
    expect(mk().gate(intent("t", { takeProfit: 0 })).record.blocked_by).toBe("TP_REQUIRED");
    expect(mk({ emergencyStop: () => true }).gate(intent()).record.blocked_by).toBe("EMERGENCY_STOP");
    expect(mk({ openState: () => ({ openPositions: 1, openSymbols: ["XAUUSD"] }) }).gate(intent()).record.blocked_by).toBe("MAX_POSITION");
    const cap = mk({ safety: parseShadowSafety({ MAX_DAILY_TRADE: "1" }) });
    expect(cap.gate(intent("1")).allow).toBe(true);
    expect(cap.gate(intent("2")).record.blocked_by).toBe("MAX_DAILY_TRADE");
  });

  it("shadow is fail-closed by default", () => {
    expect(resolveShadowActive({})).toBe(true);
    expect(resolveShadowActive({ SHADOW_MODE: "OFF" })).toBe(true);
    expect(resolveShadowActive({ SHADOW_MODE: "OFF", EXECUTION_MODE: "DEMO_STRESS_TEST" })).toBe(false);
  });
});

describe("monitoring projection", () => {
  const reader = (tickAt: number | null, m5Close: number) => ({
    latestLiveObservation: () => (tickAt === null ? null : { observed_at: tickAt }),
    closedBars: (tf: string) => (tf === "M5" ? [{ close_time: m5Close }] : []),
    brokerHistoryBars: () => [],
  }) as never;
  it("distinguishes no new candle from feed stopped", () => {
    const now = 10_000_000;
    expect(marketDataHealth(reader(now - 1000, now - 60_000), now)[0]!.status).toBe("FRESH");
    expect(marketDataHealth(reader(now - 1000, now - 3_000_000), now)[0]!.status).toBe("NO_NEW_CANDLE");
    expect(marketDataHealth(reader(now - 600_000, now - 60_000), now)[0]!.status).toBe("FEED_STOPPED");
    expect(marketDataHealth(reader(null, now), now)[1]!.status).toBe("NO_DATA");
  });
  it("decision health copies gate fields", () => {
    expect(decisionHealth({ lastEvaluatedAt: 5, decision: "X", primaryBias: { bias: "BUY", asOf: 1, source: "TECHNICAL_H4_CLOSED" }, m2: null, m3: { at: 1, status: "WAIT", holdReason: null, signalId: "s" }, m4: null, openPosition: false, gate: { decision: "BLOCK", reason: "BLOCK_NO_TRIGGER" as never, arenaStatus: "CARI_BUY", candidate: "BUY" } }))
      .toEqual({ last_analysis_at: 5, arena: "CARI_BUY", h4_bias: "BUY", m1b: "WAIT", decision: "BLOCK", reason: "BLOCK_NO_TRIGGER" });
  });
  it("serves /v1/journal/status, /v1/engine/shadow, /v1/engine/monitoring", () => {
    const host = { symbols: [], reader: () => null, health: () => ({}) as never, shadowStatus: () => ({ active: true }), monitoring: () => ({ engine_status: "ONLINE" }) as never, journalStatus: () => ({ database: { status: "OK" } }) as never };
    for (const p of ["/v1/journal/status", "/v1/engine/shadow", "/v1/engine/monitoring", "/v1/engine/readiness"]) expect(routeEngineRequest(host, "GET", p, 1).status).toBe(200);
    expect(routeEngineRequest(host, "POST", "/v1/engine/shadow", 1).status).toBe(405);
  });
});
