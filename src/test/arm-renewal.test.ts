import { describe, expect, it } from "vitest";
import { evaluateArmRenewal, ARM_RENEWAL_POLICY, type ArmRenewalInput } from "@/core/enginehost/armRenewal";
import { decideInstance } from "@/core/enginehost/instanceGuard";
import { checkDemoArm } from "@/core/enginehost/demoArm";

const H = "ab".repeat(32);
const NOW = 10_000_000_000;
const HOUR = 3_600_000;
const arm = (o: object = {}) => JSON.stringify({ armed: true, mode: "DEMO", expires_at: NOW + 2 * HOUR, account_hash: H, ...o });
// WAITING_SETUP state: no candidate exists; renewal must not need a trade-specific risk approval.
const base: ArmRenewalInput = {
  raw: arm(), now: NOW, whitelistHashes: [H], accountMode: "DEMO", executionPathMode: "DEMO",
  killSwitch: false, shadowActive: false, riskPolicyReady: true, accountVerifiedAt: NOW - 10_000,
  reconciliation: { ok: true, at: NOW - 10_000 }, reconciliationBlocked: false, dataFresh: true,
};

describe("DEMO session-arm auto-renewal", () => {
  it("renews a valid arm during WAITING_SETUP without any trade candidate", () => {
    const r = evaluateArmRenewal(base);
    expect(r.renew).toBe(true);
    if (!r.renew) return;
    const next = JSON.parse(r.next_raw);
    expect(next).toEqual({ armed: true, mode: "DEMO", account_hash: H, expires_at: NOW + ARM_RENEWAL_POLICY.extend_ms });
    expect(checkDemoArm({ raw: r.next_raw, now: NOW + 23 * HOUR, whitelistHashes: [H], killSwitch: false })).toEqual({ ok: true });
  });
  it("is not due while far from expiry", () => {
    expect(evaluateArmRenewal({ ...base, raw: arm({ expires_at: NOW + 20 * HOUR }) })).toEqual({ renew: false, reason: "NOT_DUE" });
  });
  it("never applies outside DEMO", () => {
    expect(evaluateArmRenewal({ ...base, accountMode: "REAL" })).toEqual({ renew: false, reason: "NOT_DEMO_ACCOUNT_MODE" });
    expect(evaluateArmRenewal({ ...base, accountMode: "PAPER" })).toEqual({ renew: false, reason: "NOT_DEMO_ACCOUNT_MODE" });
    expect(evaluateArmRenewal({ ...base, executionPathMode: "SHADOW" })).toEqual({ renew: false, reason: "NOT_DEMO_EXECUTION_MODE" });
  });
  it("never creates or revives an arm", () => {
    for (const raw of [null, "", "{bad", arm({ expires_at: NOW - 1 }), arm({ armed: false }), arm({ mode: "REAL" }), arm({ account_hash: "cd".repeat(32) })])
      expect(evaluateArmRenewal({ ...base, raw })).toEqual({ renew: false, reason: "ARM_NOT_VALID" });
  });
  it("every safety condition blocks renewal", () => {
    const c = (o: Partial<ArmRenewalInput>) => evaluateArmRenewal({ ...base, ...o });
    expect(c({ killSwitch: true })).toEqual({ renew: false, reason: "KILL_SWITCH" });
    expect(c({ shadowActive: true })).toEqual({ renew: false, reason: "SHADOW_BLOCKING" });
    expect(c({ riskPolicyReady: false })).toEqual({ renew: false, reason: "RISK_PREFLIGHT_FAILED" });
    expect(c({ accountVerifiedAt: null })).toEqual({ renew: false, reason: "ACCOUNT_NOT_VERIFIED" });
    expect(c({ accountVerifiedAt: NOW - 10 * 60_000 })).toEqual({ renew: false, reason: "ACCOUNT_NOT_VERIFIED" });
    expect(c({ reconciliation: null })).toEqual({ renew: false, reason: "RECONCILIATION_NOT_CLEAN" });
    expect(c({ reconciliation: { ok: false, at: NOW } })).toEqual({ renew: false, reason: "RECONCILIATION_NOT_CLEAN" });
    expect(c({ reconciliationBlocked: true })).toEqual({ renew: false, reason: "RECONCILIATION_NOT_CLEAN" });
    expect(c({ reconciliation: { ok: true, at: NOW - 10 * 60_000 } })).toEqual({ renew: false, reason: "RECONCILIATION_NOT_CLEAN" });
    expect(c({ dataFresh: false })).toEqual({ renew: false, reason: "DATA_STALE" });
  });
  it("gateway down (no account read) ⇒ no renewal ⇒ arm expires and orders are held", () => {
    const r = evaluateArmRenewal({ ...base, accountVerifiedAt: null });
    expect(r.renew).toBe(false);
    expect(checkDemoArm({ raw: base.raw, now: NOW + 3 * HOUR, whitelistHashes: [H], killSwitch: false })).toEqual({ ok: false, reason: "ARM_EXPIRED" });
  });
  it("renewal output alone never arms when the kill switch is on", () => {
    const r = evaluateArmRenewal(base);
    if (!r.renew) throw new Error("expected renew");
    expect(checkDemoArm({ raw: r.next_raw, now: NOW, whitelistHashes: [H], killSwitch: true })).toEqual({ ok: false, reason: "KILL_SWITCH" });
  });
});

describe("single engine-host instance guard", () => {
  const alive = (pids: number[]) => (p: number) => pids.includes(p);
  it("refuses when port 8090 is already in use", () => {
    expect(decideInstance({ portInUse: true, lockRaw: null, selfPid: 1, isPidAlive: alive([]) })).toEqual({ start: false, reason: "PORT_IN_USE" });
  });
  it("refuses when a live process holds the lock", () => {
    expect(decideInstance({ portInUse: false, lockRaw: JSON.stringify({ pid: 42 }), selfPid: 1, isPidAlive: alive([42]) })).toEqual({ start: false, reason: "LOCK_HELD_BY_LIVE_PROCESS" });
  });
  it("starts after crash (stale lock) and on clean boot", () => {
    expect(decideInstance({ portInUse: false, lockRaw: JSON.stringify({ pid: 42 }), selfPid: 1, isPidAlive: alive([]) })).toEqual({ start: true, stale_lock: true });
    expect(decideInstance({ portInUse: false, lockRaw: "{torn", selfPid: 1, isPidAlive: alive([]) })).toEqual({ start: true, stale_lock: true });
    expect(decideInstance({ portInUse: false, lockRaw: null, selfPid: 1, isPidAlive: alive([]) })).toEqual({ start: true, stale_lock: false });
  });
});
