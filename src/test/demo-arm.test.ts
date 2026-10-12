import { describe, expect, it } from "vitest";
import { checkDemoArm } from "@/core/enginehost/demoArm";
import { derivePhase } from "@/core/enginehost/automationState";
import type { ExecutionStatusView } from "@/core/enginehost/executionStatus";

const H = "ab".repeat(32);
const ok = (o: object) => JSON.stringify({ armed: true, expires_at: 2000, account_login_hash: H, ...o });
const base: ExecutionStatusView = { schema: "engine-execution-status-v1", engine: "ONLINE", mode: "DEMO_EXECUTION", execution: "BLOCKED", account: "PASS",
  mt5: "CONNECTED", shadow: "BLOCKING", kill_switch: false, risk: "UNKNOWN", reconciliation: "CLEAN", signal: "WAITING", stale: false, blockers: ["SHADOW_GUARD_ACTIVE"], checked_at: 0 };

describe("demo arm (session system gate)", () => {
  it("fails closed", () => {
    const c = (raw: string | null, killSwitch = false) => checkDemoArm({ raw, now: 1000, whitelistHashes: [H], killSwitch });
    expect(c(null)).toEqual({ ok: false, reason: "ARM_FILE_MISSING" });
    expect(c("{bad")).toEqual({ ok: false, reason: "ARM_FILE_INVALID" });
    expect(c(ok({ expires_at: 999 }))).toEqual({ ok: false, reason: "ARM_EXPIRED" });
    expect(c(ok({ account_login_hash: "cd".repeat(32) }))).toEqual({ ok: false, reason: "ARM_ACCOUNT_MISMATCH" });
    expect(c(ok({ armed: false }))).toEqual({ ok: false, reason: "NOT_ARMED" });
    expect(c(ok({}), true)).toEqual({ ok: false, reason: "KILL_SWITCH" });
    expect(c(ok({}))).toEqual({ ok: true });
  });
  it("lifecycle phases; shadow never reaches DEMO_EXECUTION", () => {
    expect(derivePhase({ ...base, mode: "MONITOR_ONLY", mt5: "UNKNOWN", account: "UNKNOWN" }, true)).toBe("MONITOR_ONLY");
    expect(derivePhase(base, false)).toBe("DEMO_CONNECTED");
    expect(derivePhase(base, true)).toBe("WAITING_SETUP");
    expect(derivePhase({ ...base, signal: "READY" }, true)).toBe("SIGNAL");
    expect(derivePhase({ ...base, execution: "ACTIVE" }, true)).toBe("SIGNAL".length ? "WAITING_SETUP" : "");
    expect(derivePhase({ ...base, shadow: "CLEAR", execution: "ACTIVE", blockers: [] }, true)).toBe("DEMO_EXECUTION");
  });
});
