// Automation execution state machine + pre-execution checklist (observability only).
// Pure projection of the ExecutionStatusView facts the host already holds. It never gates, sends or arms
// anything: order gating stays in DemoExecutionBridge/Layer + Shadow Guard. Session arm = operator
// DEMO arm file validated by demoArm.ts (read-only; no write path). No per-trade approval; without it session_arm stays NOT_ARMED.
import type { ExecutionStatusView } from "./executionStatus";

export type AutomationStage = "MONITOR_ONLY" | "PAPER_READY" | "DEMO_CONNECTED" | "DEMO_ARMED" | "DEMO_EXECUTION";
export const AUTOMATION_STAGES: readonly AutomationStage[] = ["MONITOR_ONLY", "PAPER_READY", "DEMO_CONNECTED", "DEMO_ARMED", "DEMO_EXECUTION"];

export type CheckState = "PASS" | "FAIL" | "UNKNOWN";
export type ChecklistKey =
  | "ENGINE_ONLINE" | "MARKET_DATA_FRESH" | "SNR_AVAILABLE" | "DECISION_GATE_PASS" | "RISK_PASS"
  | "MT5_DEMO_CONNECTED" | "ACCOUNT_VERIFIED" | "SHADOW_GUARD_CLEARED" | "SESSION_ARM";
export interface ChecklistItem { readonly key: ChecklistKey; readonly label: string; readonly state: CheckState }

export interface AutomationTransition { readonly from: AutomationStage | null; readonly to: AutomationStage; readonly at: number; readonly reason: string }

export interface AutomationView {
  readonly stage: AutomationStage;
  /** Operator-facing lifecycle label (copy of the same facts; never gates). */
  readonly phase: LifecyclePhase;
  /** True while Shadow Guard blocks sends: phase may reach SIGNAL but never DEMO_EXECUTION. */
  readonly shadow_blocked: boolean;
  readonly session_arm: "NOT_ARMED" | "ARMED";
  readonly checklist: readonly ChecklistItem[];
  /** BLOCKED unless every checklist item is PASS. */
  readonly verdict: "EXECUTION_BLOCKED" | "CLEARED";
  readonly transitions: readonly AutomationTransition[];
}

export type LifecyclePhase = "MONITOR_ONLY" | "DEMO_CONNECTED" | "WAITING_SETUP" | "SIGNAL" | "DEMO_EXECUTION";

/** Session-armed lifecycle label. Shadow does not hide WAITING_SETUP/SIGNAL, only DEMO_EXECUTION. */
export function derivePhase(s: ExecutionStatusView, armed: boolean): LifecyclePhase {
  if (s.engine !== "ONLINE" || s.stale || s.mode !== "DEMO_EXECUTION" || s.mt5 !== "CONNECTED" || s.account !== "PASS") return "MONITOR_ONLY";
  if (!armed || s.kill_switch || s.reconciliation !== "CLEAN") return "DEMO_CONNECTED";
  if (s.execution === "ACTIVE" && s.shadow === "CLEAR") return "DEMO_EXECUTION";
  return s.signal === "READY" ? "SIGNAL" : "WAITING_SETUP";
}

const pf = (ok: boolean, known = true): CheckState => (!known ? "UNKNOWN" : ok ? "PASS" : "FAIL");

export function buildChecklist(s: ExecutionStatusView, snrAvailable: boolean | null, sessionArmed: boolean): readonly ChecklistItem[] {
  return Object.freeze([
    { key: "ENGINE_ONLINE", label: "Engine Host ONLINE", state: pf(s.engine === "ONLINE") },
    { key: "MARKET_DATA_FRESH", label: "Market Data Fresh", state: pf(!s.stale && s.engine !== "OFFLINE", s.signal !== "UNKNOWN" || s.stale) },
    { key: "SNR_AVAILABLE", label: "SNR Available", state: pf(snrAvailable === true, snrAvailable !== null) },
    { key: "DECISION_GATE_PASS", label: "Decision Gate PASS", state: pf(s.signal === "READY", s.signal !== "UNKNOWN") },
    { key: "RISK_PASS", label: "Risk PASS", state: pf(s.risk === "PASS", s.risk !== "UNKNOWN") },
    { key: "MT5_DEMO_CONNECTED", label: "MT5 DEMO Connected", state: pf(s.mt5 === "CONNECTED", s.mt5 !== "UNKNOWN") },
    { key: "ACCOUNT_VERIFIED", label: "Account Verified", state: pf(s.account === "PASS", s.account !== "UNKNOWN") },
    { key: "SHADOW_GUARD_CLEARED", label: "Shadow Guard Cleared", state: pf(s.shadow === "CLEAR" && !s.kill_switch) },
    { key: "SESSION_ARM", label: "Session Arm", state: pf(sessionArmed) },
  ].map((x) => Object.freeze(x as ChecklistItem)));
}

/** Highest stage whose prerequisites all hold; any fault falls back. Default (no facts) = MONITOR_ONLY. */
export function deriveStage(s: ExecutionStatusView, sessionArmed: boolean): { stage: AutomationStage; reason: string } {
  if (s.engine !== "ONLINE" || s.stale) return { stage: "MONITOR_ONLY", reason: s.stale ? "DATA_STALE" : `ENGINE_${s.engine}` };
  if (s.mode !== "DEMO_EXECUTION" || s.mt5 !== "CONNECTED" || s.account !== "PASS") return { stage: "PAPER_READY", reason: s.mode !== "DEMO_EXECUTION" ? "EXECUTION_PERMISSION_DISABLED" : "DEMO_NOT_VERIFIED" };
  const armable = sessionArmed && s.shadow === "CLEAR" && !s.kill_switch && s.reconciliation === "CLEAN";
  if (!armable) return { stage: "DEMO_CONNECTED", reason: !sessionArmed ? "SESSION_ARM_REQUIRED" : s.kill_switch ? "KILL_SWITCH" : s.shadow !== "CLEAR" ? "SHADOW_GUARD_ACTIVE" : "RECONCILE_NOT_CLEAN" };
  if (s.execution === "ACTIVE") return { stage: "DEMO_EXECUTION", reason: "POSITION_OPEN" };
  return { stage: "DEMO_ARMED", reason: "ALL_GATES_CLEAR" };
}

/** In-memory append-only transition recorder; `onTransition` lets the host persist each change. */
export class AutomationStateTracker {
  private current: AutomationStage | null = null;
  private readonly log: AutomationTransition[] = [];
  constructor(private readonly o: { readonly cap?: number; readonly onTransition?: ((t: AutomationTransition) => void) | undefined; readonly sessionArmed?: () => boolean } = {}) {}

  observe(s: ExecutionStatusView, snrAvailable: boolean | null, now: number): AutomationView {
    let armed = false;
    try { armed = this.o.sessionArmed?.() === true; } catch { armed = false; }
    const { stage, reason } = deriveStage(s, armed);
    if (stage !== this.current) {
      const t = Object.freeze({ from: this.current, to: stage, at: now, reason });
      this.log.push(t);
      if (this.log.length > (this.o.cap ?? 200)) this.log.shift();
      this.current = stage;
      try { this.o.onTransition?.(t); } catch { /* recording failure never changes state */ }
    }
    const checklist = buildChecklist(s, snrAvailable, armed);
    return Object.freeze({
      stage, phase: derivePhase(s, armed), shadow_blocked: s.shadow !== "CLEAR", session_arm: armed ? "ARMED" as const : "NOT_ARMED" as const, checklist,
      verdict: checklist.every((c) => c.state === "PASS") ? "CLEARED" as const : "EXECUTION_BLOCKED" as const,
      transitions: Object.freeze(this.log.slice(-20)),
    });
  }
}
