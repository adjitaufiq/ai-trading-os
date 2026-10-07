import { describe, expect, it } from "vitest";
import { deriveControl, maskAccount, signRequest, verifyRequest, type ExecutionConfigWire } from "./contract";
import { ControlPlaneAgent } from "./agentSync";

const cfg = (o: Partial<ExecutionConfigWire> = {}): ExecutionConfigWire => ({
  execution_mode: "DEMO_STRESS_TEST", demo_enabled: true, kill_switch: false, risk_percent: 0.5, max_open_positions: 1,
  max_daily_loss_percent: 2, max_daily_trades: 5, allowed_symbols: ["XAUUSD"], updated_at: "x", ...o,
});

describe("control plane contract", () => {
  it("fail-closed when config missing", () => expect(deriveControl(null).halted).toBe(true));
  it("armed only for DEMO_STRESS_TEST + demo_enabled + kill off", () => {
    expect(deriveControl(cfg()).halted).toBe(false);
    expect(deriveControl(cfg({ kill_switch: true })).reason).toBe("KILL_SWITCH");
    expect(deriveControl(cfg({ demo_enabled: false })).halted).toBe(true);
    expect(deriveControl(cfg({ execution_mode: "PAPER_ONLY" })).halted).toBe(true);
    expect(deriveControl(cfg({ execution_mode: "REAL" })).mode).toBe("REAL_DISABLED");
    expect(deriveControl(cfg(), true).reason).toBe("DEMO_LAB_STOPPED");
  });
  it("out-of-range risk falls back to the demo profile", () => {
    expect(deriveControl(cfg({ risk_percent: 50 })).profile.riskPercent).toBe(0.5);
    expect(deriveControl(cfg({ risk_percent: 1 })).profile.riskPercent).toBe(1);
  });
  it("masks account numbers", () => expect(maskAccount(12345678)).toBe("*****678"));
  it("signature verifies and rejects tamper/skew/missing secret", async () => {
    const now = 1_700_000_000_000; const ts = String(now);
    const sig = await signRequest("s3cret", ts, "POST", "/api/public/agent/heartbeat", "{}");
    const base = { ts, sig, method: "POST", path: "/api/public/agent/heartbeat", body: "{}", now };
    expect(await verifyRequest("s3cret", base)).toBe(true);
    expect(await verifyRequest("s3cret", { ...base, body: "{\"x\":1}" })).toBe(false);
    expect(await verifyRequest("other", base)).toBe(false);
    expect(await verifyRequest("s3cret", { ...base, now: now + 10 * 60_000 })).toBe(false);
    expect(await verifyRequest(undefined, base)).toBe(false);
  });
  it("agent: kill switch propagates on next pull; stale config halts", async () => {
    let t = 1_000_000; let kill = false;
    const fetchImpl = (async () => new Response(JSON.stringify({ config: cfg({ kill_switch: kill }), control: { halted: kill } }))) as unknown as typeof fetch;
    const a = new ControlPlaneAgent({ baseUrl: "https://x", secret: "s", agentId: "t", version: "v", executionMode: "DEMO_STRESS_TEST", now: () => t, status: () => null, fetchImpl });
    expect(a.current().halted).toBe(true);
    await a.pullConfig(); expect(a.current().halted).toBe(false);
    kill = true; await a.pullConfig(); expect(a.current().reason).toBe("KILL_SWITCH");
    kill = false; await a.pullConfig(); t += 61_000; expect(a.current().reason).toBe("CONFIG_STALE");
  });
});
