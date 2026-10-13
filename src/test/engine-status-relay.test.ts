import { describe, it, expect } from "vitest";
import { RelayPush, publicStatus, healthTransition, HEARTBEAT_STALE_MS } from "@/lib/engineStatus/relay";
import { signRequest, verifyRequest } from "@/core/execution/control/contract";

const snap = {
  schema: "engine-status-relay-v1", engine: "ONLINE", mode: "DEMO_EXECUTION", execution: "WAITING_SIGNAL", mt5: "CONNECTED",
  shadow: "CLEAR", kill_switch: false, signal: "WAITING", stale: false, phase: "WAITING_SETUP", stage: "DEMO_ARMED",
  blockers: [], symbols: ["XAUUSD", "BTCUSD"], engine_checked_at: 1, engine_reachable: true,
};
const NOW = 1_800_000_000_000;
const row = (ageMs: number, s: unknown = snap) => ({ received_at: new Date(NOW - ageMs).toISOString(), snapshot: s });

describe("status relay schema", () => {
  it("accepts the minimal snapshot", () => { expect(RelayPush.safeParse({ agent_id: "vps-1", snapshot: snap }).success).toBe(true); });
  it.each(["balance", "equity", "login", "server", "positions", "entry", "stop_loss", "journal", "raw"])("rejects sensitive field %s", (k) => {
    expect(RelayPush.safeParse({ agent_id: "vps-1", snapshot: { ...snap, [k]: 1 } }).success).toBe(false);
  });
  it("rejects free-text blockers and foreign symbols", () => {
    expect(RelayPush.safeParse({ agent_id: "a", snapshot: { ...snap, blockers: ["login 464 bad"] } }).success).toBe(false);
    expect(RelayPush.safeParse({ agent_id: "a", snapshot: { ...snap, symbols: ["EURUSD"] } }).success).toBe(false);
  });
});

describe("status relay auth", () => {
  const p = "/api/public/agent/engine-status";
  it("valid signature passes; wrong secret, missing, tampered body, old ts fail", async () => {
    const ts = String(NOW), body = "{}";
    const sig = await signRequest("s3", ts, "POST", p, body);
    expect(await verifyRequest("s3", { ts, sig, method: "POST", path: p, body, now: NOW })).toBe(true);
    expect(await verifyRequest("other", { ts, sig, method: "POST", path: p, body, now: NOW })).toBe(false);
    expect(await verifyRequest(undefined, { ts, sig, method: "POST", path: p, body, now: NOW })).toBe(false);
    expect(await verifyRequest("s3", { ts, sig: null, method: "POST", path: p, body, now: NOW })).toBe(false);
    expect(await verifyRequest("s3", { ts, sig, method: "POST", path: p, body: '{"x":1}', now: NOW })).toBe(false);
    expect(await verifyRequest("s3", { ts, sig, method: "POST", path: p, body, now: NOW + 10 * 60_000 })).toBe(false);
  });
});

describe("dashboard public status", () => {
  it("fresh healthy heartbeat ⇒ ONLINE/FRESH", () => {
    const s = publicStatus(row(10_000), NOW);
    expect([s.status, s.data, s.snapshot?.phase]).toEqual(["ONLINE", "FRESH", "WAITING_SETUP"]);
  });
  it("stale heartbeat ⇒ OFFLINE, snapshot hidden", () => {
    const s = publicStatus(row(HEARTBEAT_STALE_MS + 1), NOW);
    expect([s.status, s.data, s.snapshot]).toEqual(["OFFLINE", "UNKNOWN", null]);
  });
  it("agent alive but engine unreachable ⇒ OFFLINE", () => {
    expect(publicStatus(row(1000, { ...snap, engine_reachable: false, engine: "OFFLINE" }), NOW).status).toBe("OFFLINE");
  });
  it("engine stale data ⇒ STALE", () => { expect(publicStatus(row(1000, { ...snap, stale: true }), NOW).data).toBe("STALE"); });
  it("no row ⇒ NO_DATA; corrupt row ⇒ OFFLINE", () => {
    expect(publicStatus(null, NOW).status).toBe("NO_DATA");
    expect(publicStatus(row(1000, { balance: 1 }), NOW).status).toBe("OFFLINE");
  });
});

describe("telegram debounce", () => {
  it("brief gap under stale threshold does not alert", () => {
    expect(healthTransition("ENGINE_ONLINE", publicStatus(row(HEARTBEAT_STALE_MS - 1), NOW))).toBeNull();
  });
  it("offline only after stale threshold, once", () => {
    const st = publicStatus(row(HEARTBEAT_STALE_MS + 1), NOW);
    expect(healthTransition("ENGINE_ONLINE", st)).toBe("ENGINE_OFFLINE");
    expect(healthTransition("ENGINE_OFFLINE", st)).toBeNull();
  });
  it("back online on healthy heartbeat after offline", () => {
    expect(healthTransition("ENGINE_OFFLINE", publicStatus(row(1000), NOW))).toBe("ENGINE_ONLINE");
  });
  it("no data never alerts", () => { expect(healthTransition("ENGINE_ONLINE", publicStatus(null, NOW))).toBeNull(); });
});
