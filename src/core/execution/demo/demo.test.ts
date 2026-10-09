import { describe, expect, it } from "vitest";
import { DemoExecutionBridge } from "./DemoExecutionBridge";
import { checkDemoSafety, parseWhitelist, validateDemoAccount } from "./guards";
import { DEMO_RISK_PROFILE, parseExecutionMode, type DemoAccountIdentity, type DemoExecGatewayPort, type DemoOrderIntent, type DemoOrderRequest } from "./types";

const demoAcct: DemoAccountIdentity = { login: 111, server: "Exness-MT5Trial", tradeMode: "DEMO", balance: 10_000, equity: 10_000, currency: "USD" };
const wl = { logins: [111], servers: ["Exness-MT5Trial"] };

function intent(id = "sig1"): DemoOrderIntent {
  return { signalId: id, planId: "p", symbol: "XAUUSD", direction: "BUY", plannedEntry: 2000, stopLoss: 1995, takeProfit: 2010, rr: 2, closedBarAt: 0,
    context: { regime: "TRENDING", h4Bias: "BULLISH", h1State: "PULLBACK", setup: "S", decision: "READY", confidence: 80, reasons: [], signalSource: {}, engineSnapshot: null } };
}

function rig(over: Partial<{ acct: DemoAccountIdentity | null; positions: number; kill: boolean; mode: "DEMO_STRESS_TEST" | "REAL_DISABLED" }> = {}) {
  const sent: DemoOrderRequest[] = [];
  const lines: string[] = [];
  let t = Date.UTC(2026, 9, 7, 9);
  const gw: DemoExecGatewayPort = {
    account: async () => (over.acct === undefined ? demoAcct : over.acct),
    symbol: async (s) => ({ symbol: s, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 0 }),
    positions: async () => Array.from({ length: over.positions ?? 0 }, (_, i) => ({ ticket: i + 1, symbol: "XAUUSD", comment: "" })),
    closeDeal: async () => null,
    sendOrder: async (r) => { sent.push(r); return { status: "FILLED", ticket: 99, price: 2000.1, retcode: 10009, comment: "done" }; },
  };
  const mk = () => new DemoExecutionBridge({ mode: over.mode ?? "DEMO_STRESS_TEST", gateway: gw, whitelist: wl, killSwitch: () => over.kill ?? false, now: () => (t += 10),
    store: { readLines: () => lines, append: (l) => lines.push(l) } });
  return { sent, lines, mk };
}

describe("demo account validator", () => {
  it("blocks real, unknown login, unknown server, missing identity", () => {
    expect(validateDemoAccount({ ...demoAcct, tradeMode: "REAL" }, wl)).toEqual({ ok: false, reason: "ACCOUNT_NOT_DEMO" });
    expect(validateDemoAccount({ ...demoAcct, login: 5 }, wl)).toEqual({ ok: false, reason: "ACCOUNT_NOT_WHITELISTED" });
    expect(validateDemoAccount({ ...demoAcct, server: "Exness-Real" }, wl)).toEqual({ ok: false, reason: "SERVER_NOT_WHITELISTED" });
    expect(validateDemoAccount(null, wl)).toEqual({ ok: false, reason: "IDENTITY_UNAVAILABLE" });
    expect(validateDemoAccount(demoAcct, wl)).toEqual({ ok: true });
  });
  it("defaults to REAL_DISABLED and parses whitelists", () => {
    expect(parseExecutionMode(undefined)).toBe("REAL_DISABLED");
    expect(parseExecutionMode("REAL")).toBe("REAL_DISABLED");
    expect(parseWhitelist("111, x", "A,B")).toEqual({ logins: [111], servers: ["A", "B"] });
  });
});

describe("demo safety", () => {
  const base = { mode: "DEMO_STRESS_TEST" as const, killSwitch: false, consumedSignalIds: new Set<string>(), openPositions: 0, tradesToday: 0, dayStartBalance: 10_000, equity: 10_000 };
  it.each([
    [{ killSwitch: true }, "KILL_SWITCH"], [{ consumedSignalIds: new Set(["s"]) }, "DUPLICATE_SIGNAL"], [{ openPositions: 1 }, "MAX_OPEN_POSITIONS"],
    [{ tradesToday: 5 }, "MAX_DAILY_TRADES"], [{ equity: 9_800 }, "DAILY_LOSS_LIMIT"], [{ mode: "REAL_DISABLED" as const }, "MODE_NOT_DEMO"],
  ])("%o ⇒ %s", (patch, reason) => expect(checkDemoSafety("s", { ...base, ...patch }, DEMO_RISK_PROFILE)).toEqual({ ok: false, reason }));
});

describe("DemoExecutionBridge", () => {
  it("sends once with 0.5% risk lot and journals context", async () => {
    const r = rig(); const b = r.mk();
    const e = await b.handle(intent());
    expect(e.type).toBe("FILLED");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.volume).toBe(0.1); // 50 USD / (5 / 0.01 * 1)
    const rec = b.records()[0]!;
    expect(rec).toMatchObject({ executionResult: "FILLED", actualEntry: 2000.1, ticket: 99, stopLoss: 1995, takeProfit: 2010 });
    expect(rec.context.regime).toBe("TRENDING");
  });
  it("duplicate signal is blocked, also after restart from the log", async () => {
    const r = rig(); await r.mk().handle(intent());
    const again = await r.mk().handle(intent());
    expect(again).toMatchObject({ type: "BLOCKED", detail: "DUPLICATE_SIGNAL" });
    expect(r.sent).toHaveLength(1);
  });
  it.each([
    [{ acct: { ...demoAcct, tradeMode: "REAL" as const } }, "ACCOUNT_NOT_DEMO"],
    [{ kill: true }, "KILL_SWITCH"], [{ positions: 1 }, "MAX_OPEN_POSITIONS"], [{ mode: "REAL_DISABLED" as const }, "MODE_NOT_DEMO"],
  ])("%o never sends (%s)", async (over, reason) => {
    const r = rig(over); const e = await r.mk().handle(intent());
    expect(e.type).toBe("BLOCKED"); expect(e.detail).toContain(reason); expect(r.sent).toHaveLength(0);
  });
  it("write-ahead SEND_ATTEMPT precedes the result", async () => {
    const r = rig(); await r.mk().handle(intent());
    const types = r.lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types.indexOf("SEND_ATTEMPT")).toBeLessThan(types.indexOf("FILLED"));
  });
});

describe("BLOCKED_COUNTER_PRIMARY_BIAS", () => {
  it("blocks BUY when closed-H4 primary bias is SELL, with full audit payload, and sends nothing", async () => {
    const { sent, lines, mk } = rig();
    const base = intent("cx");
    const ev = await mk().handle({ ...base, context: { ...base.context, h4Bias: "BEARISH", primaryBias: "SELL", counterTrendCondition: "BULLISH_PULLBACK" } });
    expect(ev.type).toBe("BLOCKED");
    expect(ev.data?.["reason"]).toBe("BLOCKED_COUNTER_PRIMARY_BIAS");
    expect(ev.data?.["audit"]).toMatchObject({ attemptedSide: "BUY", primaryBias: "SELL", counterTrendCondition: "BULLISH_PULLBACK", timeframeConflict: { H4: "SELL", attempted: "BUY", source: "TECHNICAL_H4_CLOSED" } });
    expect(sent).toHaveLength(0);
    expect(lines.some((l) => l.includes("BLOCKED_COUNTER_PRIMARY_BIAS"))).toBe(true);
  });
});
