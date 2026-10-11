import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DemoExecutionLayer, OrderLifecycleLog, PositionReconciler } from "@/core/execution/demo/DemoExecutionLayer";
import { DemoExecutionBridge } from "@/core/execution/demo/DemoExecutionBridge";
import { DEMO_RISK_PROFILE, type DemoExecGatewayPort, type DemoOrderIntent, type DemoOrderRequest, type DemoPosition } from "@/core/execution/demo/types";
import { shadowSafetyFromPolicy } from "@/core/execution/shadow/ShadowGuard";
import { DEFAULT_RISK_POLICY, parseRiskPolicy, riskPercentOf } from "@/engine/risk/riskPolicy";
import { buildFinalOrderPlan } from "@/engine/risk/finalOrderPlan";
import { VIRTUAL_ACCOUNT_DEFAULTS } from "@/core/paper/LivePaperLoop";

const T = Date.UTC(2026, 9, 11);
const XAU = { symbol: "XAUUSD", volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 0 };
const intent = (id = "sig1"): DemoOrderIntent => ({
  signalId: id, planId: "p", symbol: "XAUUSD", direction: "BUY", plannedEntry: 2000, stopLoss: 1995, takeProfit: 2010, rr: 2, closedBarAt: 0,
  context: { regime: null, h4Bias: null, h1State: null, setup: null, decision: "READY", confidence: null, primaryBias: "BUY", reasons: [], signalSource: {}, engineSnapshot: null },
});

function gw(balance: number, positions: DemoPosition[] = [], sent: DemoOrderRequest[] = []): DemoExecGatewayPort {
  return {
    account: async () => ({ login: 1, server: "S", tradeMode: "DEMO", balance, equity: balance, currency: "USD" }),
    symbol: async () => XAU,
    positions: async () => positions,
    closeDeal: async () => null,
    sendOrder: async (r) => { sent.push(r); positions.push({ ticket: 9, symbol: r.symbol, comment: `arena:${r.signalId}` }); return { status: "FILLED", ticket: 9, price: 2000, retcode: 10009, comment: "ok" }; },
  };
}
const mem = () => { const lines: string[] = []; return { lines, store: { readLines: () => lines, append: (l: string) => lines.push(l) } }; };

describe("Phase 4A execution integrity", () => {
  it("single risk source: 0.5% everywhere, derived from one policy", () => {
    expect(DEFAULT_RISK_POLICY.risk_per_trade).toBe(0.005);
    expect(riskPercentOf(DEFAULT_RISK_POLICY)).toBe(0.5);
    expect(DEMO_RISK_PROFILE.riskPercent).toBe(0.5);
    expect(VIRTUAL_ACCOUNT_DEFAULTS.riskPercent).toBe(0.5);
    const file = parseRiskPolicy(readFileSync("engine-host/risk-policy.json", "utf8"));
    expect(file).toEqual({ ok: true, policy: DEFAULT_RISK_POLICY });
  });

  it("FINAL_ORDER_PLAN uses real broker balance and 0.5%", () => {
    const r = buildFinalOrderPlan({ symbol: "XAUUSD", direction: "BUY", entry: 2000, sl: 1995, tp: 2010 }, { balance: 20_000, equity: 20_000 }, XAU, DEFAULT_RISK_POLICY);
    expect(r.ok && r.plan.lot).toBe(0.2); // 100 USD / (5/0.01*1)
    expect(r.ok && r.audit.budgetUSD).toBe(100);
  });

  it("bridge sizes from broker balance; execution layer forwards lot unchanged", async () => {
    const sent: DemoOrderRequest[] = []; const positions: DemoPosition[] = [];
    const lc = new OrderLifecycleLog(mem().store, () => T);
    const layer = new DemoExecutionLayer({ mode: "DEMO", gateway: gw(20_000, positions, sent), whitelist: { logins: [1], servers: ["S"] }, lifecycle: lc });
    const bridge = new DemoExecutionBridge({ mode: "DEMO_STRESS_TEST", gateway: layer.asGatewayPort(), whitelist: { logins: [1], servers: ["S"] }, store: mem().store, killSwitch: () => false, now: () => T,
      profile: { ...DEMO_RISK_PROFILE, riskPercent: 1 } }); // a conflicting profile value is ignored
    await bridge.handle(intent());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.volume).toBe(0.2);
    expect(JSON.parse(lc.all().find((r) => r.state === "REQUESTED") ? JSON.stringify(lc.all()[0]!.data) : "{}").volume).toBe(0.2);
  });

  it("duplicate order and duplicate symbol blocked on real broker positions", async () => {
    const sent: DemoOrderRequest[] = [];
    const lc = new OrderLifecycleLog(mem().store, () => T);
    const layer = new DemoExecutionLayer({ mode: "DEMO", gateway: gw(1e4, [], sent), whitelist: { logins: [1], servers: ["S"] }, lifecycle: lc, maxPositions: 3, maxSymbols: 2 });
    expect(await layer.execute(intent("a"), { approved: true, volume: 0.1 })).toMatchObject({ sent: true });
    expect(await layer.execute(intent("a"), { approved: true, volume: 0.1 })).toMatchObject({ blocked_by: "DUPLICATE_ORDER" });
    expect(await layer.execute(intent("b"), { approved: true, volume: 0.1 })).toMatchObject({ blocked_by: "DUPLICATE_SYMBOL" });
    expect(sent).toHaveLength(1);
  });

  it("ghost position detected, blocks new orders, and block survives restart", async () => {
    const lcMem = mem(); const rcMem = mem(); const sent: DemoOrderRequest[] = [];
    const ghost: DemoPosition[] = [{ ticket: 77, symbol: "BTCUSD", comment: "manual" }];
    const lc = new OrderLifecycleLog(lcMem.store, () => T);
    const rc = new PositionReconciler({ gateway: gw(1e4, ghost), lifecycle: lc, store: rcMem.store, now: () => T });
    const rec = await rc.reconcile("PERIODIC");
    expect(rec.ok).toBe(false);
    expect(rec.issues[0]).toMatchObject({ kind: "UNTRACKED_POSITION", ticket: 77 });
    // restart: new instances from the same files
    const lc2 = new OrderLifecycleLog(lcMem.store, () => T);
    const rc2 = new PositionReconciler({ gateway: gw(1e4, []), lifecycle: lc2, store: rcMem.store, now: () => T });
    expect(rc2.blocked()).toBe(true);
    const layer = new DemoExecutionLayer({ mode: "DEMO", gateway: gw(1e4, [], sent), whitelist: { logins: [1], servers: ["S"] }, lifecycle: lc2, reconciler: rc2 });
    expect(await layer.execute(intent("z"), { approved: true, volume: 0.1 })).toMatchObject({ blocked_by: "RECONCILE_MISMATCH" });
    expect(sent).toHaveLength(0);
    expect((await rc2.reconcile("PERIODIC")).ok).toBe(true);
    expect(rc2.blocked()).toBe(false);
  });

  it("post-order reconcile journals a clean state after fill", async () => {
    const rcMem = mem(); const positions: DemoPosition[] = [];
    const lc = new OrderLifecycleLog(mem().store, () => T);
    const g = gw(1e4, positions);
    const rc = new PositionReconciler({ gateway: g, lifecycle: lc, store: rcMem.store, now: () => T });
    const layer = new DemoExecutionLayer({ mode: "DEMO", gateway: g, whitelist: { logins: [1], servers: ["S"] }, lifecycle: lc, reconciler: rc });
    await layer.execute(intent("p"), { approved: true, volume: 0.1 });
    const last = JSON.parse(rcMem.lines.at(-1)!);
    expect(last).toMatchObject({ trigger: "POST_ORDER", ok: true, broker_positions: 1, internal_open: 1 });
  });

  it("safety config cannot be overridden by environment", () => {
    process.env.MAX_DAILY_TRADE = "99"; process.env.RISK_PER_TRADE = "0.05";
    expect(shadowSafetyFromPolicy(DEFAULT_RISK_POLICY).maxDailyTrades).toBe(5);
    expect(riskPercentOf(DEFAULT_RISK_POLICY)).toBe(0.5);
    delete process.env.MAX_DAILY_TRADE; delete process.env.RISK_PER_TRADE;
    expect(parseRiskPolicy('{"risk_per_trade":0.005,"max_position":1,"max_symbol":1,"max_daily_trade":5,"emergency_stop":false,"extra":1}').ok).toBe(false);
    expect(parseRiskPolicy('{"risk_per_trade":0.5,"max_position":1,"max_symbol":1,"max_daily_trade":5,"emergency_stop":false}').ok).toBe(false);
  });
});
