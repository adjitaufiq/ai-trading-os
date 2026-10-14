// DEMO-only session-arm auto-renewal (pure). It only EXTENDS expires_at of an arm file that is ALREADY valid
// under checkDemoArm; it never creates an arm, never changes account_hash/mode/armed, never revives an expired arm,
// never clears a kill switch or Shadow, and never creates a signal or order. Every per-order gate (Decision Gate,
// Risk sizing/approval, Shadow Guard, DemoExecutionLayer preflight, reconciliation) still runs per candidate.
// Any failed precondition ⇒ no renewal; the arm then expires naturally and new entries are held (fail-closed).
import { checkDemoArm } from "./demoArm";

export interface ArmRenewalPolicy {
  /** Renew only when the remaining validity drops below this. */
  readonly renew_window_ms: number;
  /** New expiry = now + extend_ms (never further). */
  readonly extend_ms: number;
  /** Account read and reconciliation must be at most this old. */
  readonly max_evidence_age_ms: number;
}
export const ARM_RENEWAL_POLICY: ArmRenewalPolicy = Object.freeze({
  renew_window_ms: 6 * 3_600_000,
  extend_ms: 24 * 3_600_000,
  max_evidence_age_ms: 120_000,
});

export type ArmRenewalReason =
  | "NOT_DEMO_ACCOUNT_MODE" | "NOT_DEMO_EXECUTION_MODE" | "ARM_NOT_VALID" | "KILL_SWITCH" | "SHADOW_BLOCKING"
  | "RISK_PREFLIGHT_FAILED" | "ACCOUNT_NOT_VERIFIED" | "RECONCILIATION_NOT_CLEAN" | "DATA_STALE" | "NOT_DUE";

export interface ArmRenewalInput {
  readonly raw: string | null;
  readonly now: number;
  readonly whitelistHashes: readonly string[];
  readonly accountMode: string;
  readonly executionPathMode: string;
  readonly killSwitch: boolean;
  readonly shadowActive: boolean;
  /** Policy-level readiness only (file loaded, valid, emergency_stop false). NOT a trade-specific risk approval. */
  readonly riskPolicyReady: boolean;
  /** Time of the latest DEMO account read that passed whitelist login+server validation (null = never). */
  readonly accountVerifiedAt: number | null;
  /** Latest reconciliation record (null = none yet). */
  readonly reconciliation: { readonly ok: boolean; readonly at: number } | null;
  readonly reconciliationBlocked: boolean;
  /** True only when every symbol engine is ONLINE with fresh live data. */
  readonly dataFresh: boolean;
}

export type ArmRenewalResult =
  | { readonly renew: true; readonly next_raw: string; readonly previous_expires_at: number; readonly expires_at: number }
  | { readonly renew: false; readonly reason: ArmRenewalReason };

export function evaluateArmRenewal(i: ArmRenewalInput, p: ArmRenewalPolicy = ARM_RENEWAL_POLICY): ArmRenewalResult {
  const no = (reason: ArmRenewalReason) => ({ renew: false as const, reason });
  if (i.accountMode !== "DEMO") return no("NOT_DEMO_ACCOUNT_MODE");
  if (i.executionPathMode !== "DEMO") return no("NOT_DEMO_EXECUTION_MODE");
  if (i.killSwitch) return no("KILL_SWITCH");
  const c = checkDemoArm({ raw: i.raw, now: i.now, whitelistHashes: i.whitelistHashes, killSwitch: false });
  if (!c.ok) return no("ARM_NOT_VALID");
  if (i.shadowActive) return no("SHADOW_BLOCKING");
  if (!i.riskPolicyReady) return no("RISK_PREFLIGHT_FAILED");
  if (i.accountVerifiedAt === null || i.now - i.accountVerifiedAt > p.max_evidence_age_ms) return no("ACCOUNT_NOT_VERIFIED");
  const r = i.reconciliation;
  if (i.reconciliationBlocked || !r || !r.ok || i.now - r.at > p.max_evidence_age_ms) return no("RECONCILIATION_NOT_CLEAN");
  if (!i.dataFresh) return no("DATA_STALE");
  const f = JSON.parse(i.raw as string) as Record<string, unknown>;
  const prev = f["expires_at"] as number;
  if (prev - i.now > p.renew_window_ms) return no("NOT_DUE");
  const expires_at = i.now + p.extend_ms;
  if (expires_at <= prev) return no("NOT_DUE");
  // Preserve every other field byte-for-byte in value (armed, mode, account_hash untouched).
  return { renew: true, next_raw: JSON.stringify({ ...f, expires_at }), previous_expires_at: prev, expires_at };
}
