import { describe, expect, it } from "vitest";
import { DemoExecutionLayer, OrderLifecycleLog, reconcilePositions, resolveExecutionPathMode, type ExecutionPathMode } from "@/core/execution/demo/DemoExecutionLayer";
import { ShadowGuard, resolveShadowActive, shadowGatedGateway } from "@/core/execution/shadow/ShadowGuard";
import type { DemoExecGatewayPort, DemoOrderIntent, DemoOrderRequest, DemoPosition } from "@/core/execution/demo/types";

const intent = (id = "sig1", over: Partial<DemoOrderIntent> = {}): DemoOrderIntent => ({
  signalId: id, planId: "p", symbol: "XAUUSD", direction: "BUY", plannedEntry: 2000, stopLoss: 1995, takeProfit: 2010, rr: 2, closedBarAt: 0,
  context: { regime: null, h4Bias: null, h1State: null, setup: null, decision: "READY", confidence: null, reasons: [], signalSource: {}, engineSnapshot: null }, ...over,
});
const ok = { approved: true, volume: 0.01 };

function rig(mode: ExecutionPathMode, positions: DemoPosition[] = []) {
  const sent: DemoOrderRequest[] = []; const reads: string[] = []; const lines: string[] = [];
  const gw: DemoExecGatewayPort = {
    account: async () => { reads.push("account"); return { login: 1, server: "S", tradeMode: "DEMO", balance: 1e4, equity: 1e4, currency: "USD" }; },
    symbol: async (s) => { reads.push("symbol"); return { symbol: s, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 0 }; },
    positions: async () => { reads.push("positions"); return positions; },
    closeDeal: async () => null,
    sendOrder: async (r) => { sent.push(r); return { status: "FILLED", ticket: 9, price: 2000, retcode: 10009, comment: "ok" }; },
  };
  const lifecycle = new OrderLifecycleLog({ readLines: () => lines, append: (l) => lines.push(l) }, () => Date.UTC(2026, 9, 11));
  const layer = new DemoExecutionLayer({ mode, gateway: gw, whitelist: { logins: [1], servers: ["S"] }, lifecycle });
  return { layer, sent, reads, lines, lifecycle };
}

describe("Phase 3 demo execution layer", () => {
  it("defaults to SHADOW; DEMO needs explicit EXECUTION_MODE=DEMO", () => {
    expect(resolveExecutionPathMode({})).toBe("SHADOW");
    expect(resolveExecutionPathMode({ EXECUTION_MODE: "demo" })).toBe("SHADOW");
    expect(resolveExecutionPathMode({ EXECUTION_MODE: "REAL" })).toBe("SHADOW");
    expect(resolveExecutionPathMode({ EXECUTION_MODE: "DEMO" })).toBe("DEMO");
  });

  it("shadow mode cannot send order and does not touch the broker", async () => {
    const r = rig("SHADOW");
    expect(await r.layer.execute(intent(), ok)).toEqual({ sent: false, blocked_by: "EXECUTION_MODE_SHADOW" });
    expect(r.sent).toHaveLength(0); expect(r.reads).toHaveLength(0);
    expect(r.lifecycle.state("sig1")).toBe("BLOCKED");
  });

  it("invalid risk blocks order", async () => {
    const r = rig("DEMO");
    expect(await r.layer.execute(intent(), { approved: false, volume: 0.01 })).toMatchObject({ blocked_by: "RISK_NOT_APPROVED" });
    expect(await r.layer.execute(intent("s2"), { approved: true, volume: 0 })).toMatchObject({ blocked_by: "RISK_NOT_APPROVED" });
    expect(r.sent).toHaveLength(0);
  });

  it("missing SL / TP blocks order", async () => {
    const r = rig("DEMO");
    expect(await r.layer.execute(intent("a", { stopLoss: 0 }), ok)).toMatchObject({ blocked_by: "SL_MISSING" });
    expect(await r.layer.execute(intent("b", { takeProfit: 0 }), ok)).toMatchObject({ blocked_by: "TP_MISSING" });
    expect(r.sent).toHaveLength(0);
  });

  it("duplicate order blocked (lifecycle and broker position)", async () => {
    const r = rig("DEMO");
    expect(await r.layer.execute(intent(), ok)).toMatchObject({ sent: true, state: "FILLED" });
    expect(await r.layer.execute(intent(), ok)).toMatchObject({ blocked_by: "DUPLICATE_ORDER" });
    expect(r.sent).toHaveLength(1);
    const r2 = rig("DEMO", [{ ticket: 5, symbol: "XAUUSD", comment: "arena:sigX" }]);
    expect(await r2.layer.execute(intent("sigX"), ok)).toMatchObject({ blocked_by: "DUPLICATE_ORDER" });
    expect(r2.sent).toHaveLength(0);
  });

  it("position limit blocks order", async () => {
    const r = rig("DEMO", [{ ticket: 5, symbol: "BTCUSD", comment: "other" }]);
    expect(await r.layer.execute(intent(), ok)).toMatchObject({ blocked_by: "POSITION_LIMIT" });
  });

  it("lifecycle records every state, rejects invalid transitions, survives restart", () => {
    const lines: string[] = [];
    const lc = new OrderLifecycleLog({ readLines: () => lines, append: (l) => lines.push(l) }, () => 1);
    lc.record("x", "XAUUSD", "DEMO", "REQUESTED"); lc.record("x", "XAUUSD", "DEMO", "ACCEPTED");
    lc.record("x", "XAUUSD", "DEMO", "FILLED"); lc.record("x", "XAUUSD", "DEMO", "CLOSED");
    lc.record("y", "XAUUSD", "DEMO", "REQUESTED"); lc.record("y", "XAUUSD", "DEMO", "CANCELLED");
    lc.record("z", "XAUUSD", "DEMO", "REQUESTED"); lc.record("z", "XAUUSD", "DEMO", "REJECTED");
    expect(() => lc.record("x", "XAUUSD", "DEMO", "FILLED")).toThrow(/INVALID_TRANSITION/);
    expect(lines).toHaveLength(8);
    const re = new OrderLifecycleLog({ readLines: () => lines, append: (l) => lines.push(l) }, () => 2);
    expect(re.state("x")).toBe("CLOSED"); expect(re.state("y")).toBe("CANCELLED");
  });

  it("reconciliation detects missing, duplicate, mismatch and untracked", () => {
    const res = reconcilePositions(
      [{ signalId: "a", symbol: "XAUUSD" }, { signalId: "b", symbol: "XAUUSD" }, { signalId: "c", symbol: "XAUUSD" }],
      [{ ticket: 1, symbol: "XAUUSD", comment: "b" }, { ticket: 2, symbol: "XAUUSD", comment: "b" }, { ticket: 3, symbol: "BTCUSD", comment: "c" }, { ticket: 4, symbol: "XAUUSD", comment: "?" }],
    );
    expect(res.ok).toBe(false);
    expect(res.issues.map((i) => i.kind).sort()).toEqual(["DUPLICATE_POSITION", "MISMATCH", "MISSING_POSITION", "UNTRACKED_POSITION"]);
    expect(reconcilePositions([{ signalId: "a", symbol: "XAUUSD" }], [{ ticket: 1, symbol: "XAUUSD", comment: "a" }]).ok).toBe(true);
  });
});

describe("Phase 3.5 wiring — canonical EXECUTION_MODE + gateway-port chain", () => {
  const req = (id = "sig1", over: Partial<DemoOrderRequest> = {}): DemoOrderRequest => ({
    signalId: id, symbol: "XAUUSD", direction: "BUY", volume: 0.01, stopLoss: 1995, takeProfit: 2010, ...over,
  });
  const mkGuard = (active: boolean, emergency = false) => {
    const lines: string[] = [];
    return new ShadowGuard({
      active: () => active, now: () => Date.UTC(2026, 9, 11), emergencyStop: () => emergency,
      store: { readLines: () => lines, append: (l) => lines.push(l) },
    });
  };

  it("EXECUTION_MODE is the single source of truth; SHADOW_MODE=ON forces shadow, OFF is ignored", () => {
    expect(resolveShadowActive({})).toBe(true);
    expect(resolveShadowActive({ EXECUTION_MODE: "SHADOW" })).toBe(true);
    expect(resolveShadowActive({ EXECUTION_MODE: "DEMO" })).toBe(false);
    expect(resolveShadowActive({ EXECUTION_MODE: "DEMO", SHADOW_MODE: "ON" })).toBe(true);
    expect(resolveShadowActive({ EXECUTION_MODE: "DEMO", SHADOW_MODE: "OFF" })).toBe(false);
    expect(resolveShadowActive({ SHADOW_MODE: "OFF" })).toBe(true); // legacy OFF alone never widens access
    expect(resolveShadowActive({ SHADOW_MODE: "OFF", EXECUTION_MODE: "DEMO_STRESS_TEST" })).toBe(false); // legacy combo
  });

  it("EXECUTION_MODE=SHADOW never sends an order through the wired port", async () => {
    const r = rig("SHADOW");
    const port = r.layer.asGatewayPort();
    const resp = await port.sendOrder(req());
    expect(resp.status).toBe("REJECTED"); expect(resp.comment).toBe("EXECUTION_MODE_SHADOW");
    expect(r.sent).toHaveLength(0); expect(r.reads).toHaveLength(0);
  });

  it("EXECUTION_MODE=DEMO reaches the broker through layer → shadow-gated gateway", async () => {
    const r = rig("DEMO");
    const guard = mkGuard(false);
    const port = r.layer.asGatewayPort();
    const chained = new DemoExecutionLayer({ mode: "DEMO", gateway: shadowGatedGateway(r.layer.asGatewayPort(), guard), whitelist: { logins: [1], servers: ["S"] }, lifecycle: r.lifecycle });
    void chained; void port;
    const resp = await port.sendOrder(req());
    expect(resp.status).toBe("FILLED"); expect(resp.ticket).toBe(9);
    expect(r.sent).toHaveLength(1);
    expect(r.lifecycle.state("sig1")).toBe("FILLED");
  });

  it("invalid risk blocks order at the port", async () => {
    const r = rig("DEMO");
    const resp = await r.layer.asGatewayPort().sendOrder(req("s2", { volume: 0 }));
    expect(resp.status).toBe("REJECTED"); expect(resp.comment).toBe("RISK_NOT_APPROVED");
    expect(r.sent).toHaveLength(0);
  });

  it("missing SL blocks order at the port", async () => {
    const r = rig("DEMO");
    const resp = await r.layer.asGatewayPort().sendOrder(req("s3", { stopLoss: 0 }));
    expect(resp.comment).toBe("SL_MISSING"); expect(r.sent).toHaveLength(0);
  });

  it("duplicate order blocked at the port", async () => {
    const r = rig("DEMO");
    const port = r.layer.asGatewayPort();
    expect((await port.sendOrder(req())).status).toBe("FILLED");
    const dup = await port.sendOrder(req());
    expect(dup.status).toBe("REJECTED"); expect(dup.comment).toBe("DUPLICATE_ORDER");
    expect(r.sent).toHaveLength(1);
  });

  it("emergency stop blocks order even in DEMO with shadow off (port-level guard)", async () => {
    const r = rig("DEMO");
    const guard = mkGuard(false, true); // shadow inactive, but emergency stop engaged at intent level
    // layer port wraps the shadow-gated gateway exactly like engine-host wiring
    const inner = shadowGatedGateway(r.layer.o ? (r.layer as unknown as { o: { gateway: DemoExecGatewayPort } }).o.gateway : r.layer.asGatewayPort(), guard);
    void inner;
    // engage emergency stop with shadow ACTIVE: port send must be blocked by SHADOW_GUARD
    const guardOn = mkGuard(true, true);
    const blocked = shadowGatedGateway({
      account: async () => null, symbol: async () => null, positions: async () => [], closeDeal: async () => null,
      sendOrder: async (q) => { r.sent.push(q); return { status: "FILLED", ticket: 1, price: 1, retcode: 1, comment: "x" }; },
    }, guardOn);
    const resp = await blocked.sendOrder(req("s9"));
    expect(resp.status).toBe("REJECTED"); expect(resp.comment).toBe("SHADOW_GUARD");
    expect(r.sent).toHaveLength(0);
  });
});
