// Execution Status projection (observability only). Pure copy of facts the host already holds:
// demo bridge arm state, account identity, shadow status, kill switches, reconciliation and the
// readiness outcomes the engine already recorded. It never evaluates indicators, signals, risk or
// orders. Missing data ⇒ UNKNOWN, old data ⇒ stale; neither is ever reported as READY.
import type { EngineReadiness } from "./readiness";
import type { SymbolEngineHealth } from "./types";

export const EXECUTION_STATUS_SCHEMA = "engine-execution-status-v1" as const;

export type EngineStatus = "ONLINE" | "DEGRADED" | "OFFLINE";
/** MONITOR_ONLY = execution permission disabled (never "waiting for signal"). */
export type TradingMode = "MONITOR_ONLY" | "DEMO_EXECUTION";
export type ExecutionPermission = "READY" | "WAITING_SIGNAL" | "ACTIVE" | "BLOCKED" | "UNKNOWN";
export type TriState = "PASS" | "FAIL" | "UNKNOWN";

export interface ExecutionStatusView {
  readonly schema: typeof EXECUTION_STATUS_SCHEMA;
  readonly engine: EngineStatus;
  readonly mode: TradingMode;
  readonly execution: ExecutionPermission;
  readonly account: TriState;
  readonly mt5: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
  readonly shadow: "CLEAR" | "BLOCKING";
  readonly kill_switch: boolean;
  readonly risk: "PASS" | "BLOCKED" | "UNKNOWN";
  readonly reconciliation: "CLEAN" | "MISMATCH" | "UNKNOWN";
  /** READY only when a Decision Gate READY state with risk APPROVED exists (not mere pattern detection). */
  readonly signal: "READY" | "WAITING" | "UNKNOWN";
  readonly stale: boolean;
  readonly blockers: readonly string[];
  readonly checked_at: number;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

export function buildExecutionStatus(i: {
  readonly now: number;
  readonly symbols: readonly SymbolEngineHealth[];
  /** Demo path armed (EXECUTION_MODE=DEMO wiring present). */
  readonly armed: boolean;
  readonly shadowActive: boolean;
  readonly killSwitch: boolean;
  /** DemoExecutionBridge.status() copy, or null when not armed/unavailable. */
  readonly demo: unknown;
  /** Reconciler blocked flag; null when no reconciler exists (not armed). */
  readonly reconciliationBlocked: boolean | null;
  /** Per-symbol readiness projections already computed by the host. */
  readonly readiness: readonly (EngineReadiness | null)[];
}): ExecutionStatusView {
  const engine: EngineStatus = i.symbols.some((s) => s.state === "ONLINE")
    ? "ONLINE"
    : i.symbols.some((s) => s.state === "DEGRADED" || s.state === "SYNCING" || s.state === "BOOTSTRAP")
      ? "DEGRADED"
      : "OFFLINE";
  const mode: TradingMode = i.armed ? "DEMO_EXECUTION" : "MONITOR_ONLY";

  const d = rec(i.demo);
  const acc = rec(d?.["account"]);
  const account: TriState = !i.armed ? "UNKNOWN" : !acc ? "UNKNOWN" : acc["ok"] === true ? "PASS" : "FAIL";
  const mt5: ExecutionStatusView["mt5"] = !i.armed || !acc
    ? "UNKNOWN"
    : acc["reason"] === "IDENTITY_UNAVAILABLE"
      ? "DISCONNECTED"
      : acc["ok"] === true
        ? "CONNECTED"
        : "UNKNOWN";
  const shadow: ExecutionStatusView["shadow"] = i.shadowActive ? "BLOCKING" : "CLEAR";
  const reconciliation: ExecutionStatusView["reconciliation"] =
    i.reconciliationBlocked === null ? "UNKNOWN" : i.reconciliationBlocked ? "MISMATCH" : "CLEAN";

  const rs = i.readiness.filter((r): r is EngineReadiness => r !== null);
  const fresh = rs.filter((r) => !r.stale);
  // Valid signal = Decision Gate READY (M2 PASS) with risk APPROVED (M4 PASS) on fresh evaluation.
  const signalReady = fresh.some((r) => r.m2.status === "PASS" && r.m4.status === "PASS");
  const signal: ExecutionStatusView["signal"] = signalReady ? "READY" : fresh.length ? "WAITING" : "UNKNOWN";
  const m4s = fresh.map((r) => r.m4).filter((l) => l.status !== "UNKNOWN");
  const risk: ExecutionStatusView["risk"] = !m4s.length
    ? "UNKNOWN"
    : m4s.some((l) => l.status === "PASS")
      ? "PASS"
      : "BLOCKED";

  const stale = rs.length > 0 && fresh.length === 0;

  const blockers: string[] = [];
  if (mode === "MONITOR_ONLY") blockers.push("EXECUTION_PERMISSION_DISABLED");
  if (i.killSwitch) blockers.push("KILL_SWITCH");
  if (shadow === "BLOCKING") blockers.push("SHADOW_GUARD_ACTIVE");
  if (i.armed && mt5 === "DISCONNECTED") blockers.push("MT5_DISCONNECTED");
  if (i.armed && account === "FAIL") blockers.push("ACCOUNT_NOT_VALIDATED");
  if (reconciliation === "MISMATCH") blockers.push("RECONCILE_MISMATCH");
  if (engine === "OFFLINE") blockers.push("ENGINE_OFFLINE");
  if (stale) blockers.push("DATA_STALE");

  const openPositions = typeof d?.["openPositions"] === "number" ? (d["openPositions"] as number) : 0;
  const safe =
    mode === "DEMO_EXECUTION" && !i.killSwitch && shadow === "CLEAR" && account === "PASS" &&
    mt5 === "CONNECTED" && reconciliation === "CLEAN" && engine !== "OFFLINE" && !stale;
  const execution: ExecutionPermission = blockers.length
    ? "BLOCKED"
    : !safe
      ? "UNKNOWN"
      : openPositions > 0
        ? "ACTIVE"
        : signal === "READY"
          ? "READY"
          : "WAITING_SIGNAL";

  return Object.freeze({
    schema: EXECUTION_STATUS_SCHEMA, engine, mode, execution, account, mt5, shadow,
    kill_switch: i.killSwitch, risk, reconciliation, signal, stale,
    blockers: Object.freeze(blockers), checked_at: i.now,
  });
}
