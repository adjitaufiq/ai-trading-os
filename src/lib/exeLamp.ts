// EXE lamp projection (presentation only). Primary source: engine host /v1/engine/execution-status copy.
// Fallback (mirror): the same sanitized status relay the bottom bar shows, when the primary route is unavailable.
// Never infers signals, risk or permission. Missing / stale / browser-session data is never green.
import type { ExecutionStatusView } from "@/core/enginehost/executionStatus";
import type { AutomationView } from "@/core/enginehost/automationState";
import type { PublicEngineStatus } from "@/lib/engineStatus/relay";

export type ExeTone = "healthy" | "waiting" | "attention" | "unknown";
export interface ExeLamp {
  readonly tone: ExeTone;
  readonly label: string;
  readonly engine: string;
  readonly mode: string;
  readonly execution: string;
  readonly ageSec: number | null;
  readonly detail: string;
  /** Host automation stage + checklist copy; null when not reported. Stale data never shows CLEARED. */
  readonly automation?: AutomationView | null;
  /** Which source produced this lamp. */
  readonly source?: "EXECUTION_STATUS" | "STATUS_RELAY";
}

/** Execution-status older than this is STALE and cannot render green. */
export const EXE_STALE_MS = 30_000;

function exeLampBase(exec: ExecutionStatusView | null, receivedAt: number | null, attach: string, now: number): ExeLamp {
  if (attach !== "LIVE" || !exec || receivedAt === null) {
    return Object.freeze({ tone: "unknown" as const, label: "EXE NOT CONNECTED", engine: attach === "LIVE" ? "ONLINE" : "OFFLINE", mode: "—", execution: "UNKNOWN", ageSec: null, detail: "Status eksekusi Engine Host belum tersedia" });
  }
  const ageSec = Math.max(0, Math.round((now - receivedAt) / 1000));
  const stale = exec.stale || now - receivedAt > EXE_STALE_MS;
  const base = { engine: exec.engine, mode: exec.mode, ageSec };
  const facts = `ENGINE ${exec.engine} · MODE ${exec.mode} · EXECUTION ${exec.execution} · account ${exec.account} · mt5 ${exec.mt5} · risk ${exec.risk} · kill ${exec.kill_switch ? "ON" : "OFF"} · shadow ${exec.shadow} · recon ${exec.reconciliation} · ${ageSec}s lalu`;
  const blockers = exec.blockers.length ? ` · ${exec.blockers.join(", ")}` : "";
  if (stale) return Object.freeze({ ...base, tone: "attention" as const, label: "EXE STALE", execution: "UNKNOWN", detail: `Data status kedaluwarsa · ${facts}` });
  if (exec.execution === "BLOCKED" || exec.mode === "MONITOR_ONLY") return Object.freeze({ ...base, tone: "attention" as const, label: "EXE BLOCKED", execution: "BLOCKED", detail: facts + blockers });
  if (exec.execution === "READY" || exec.execution === "ACTIVE") return Object.freeze({ ...base, tone: "healthy" as const, label: exec.execution === "ACTIVE" ? "EXE ACTIVE" : "EXE READY", execution: exec.execution, detail: facts });
  if (exec.execution === "WAITING_SIGNAL") return Object.freeze({ ...base, tone: "waiting" as const, label: "EXE ARMED · WAITING SIGNAL", execution: "WAITING_SIGNAL", detail: facts });
  return Object.freeze({ ...base, tone: "waiting" as const, label: "EXE VERIFYING", execution: "UNKNOWN", detail: facts + blockers });
}

export function exeLamp(exec: ExecutionStatusView | null, receivedAt: number | null, attach: string, now: number): ExeLamp {
  const lamp = exeLampBase(exec, receivedAt, attach, now);
  const a = lamp.tone === "unknown" ? null : exec?.automation ?? null;
  if (!a) return Object.freeze({ ...lamp, source: "EXECUTION_STATUS" as const });
  const stale = lamp.label === "EXE STALE";
  return Object.freeze({ ...lamp, source: "EXECUTION_STATUS" as const, automation: stale ? Object.freeze({ ...a, verdict: "EXECUTION_BLOCKED" as const }) : a });
}

/** Mirror of the bottom status bar (sanitized relay). Copy only; stale/offline/missing is never green. */
export function relayExeLamp(s: PublicEngineStatus | null, err: string | null): ExeLamp | null {
  if (err || !s) return null;
  const ageSec = s.heartbeat_age_ms === null ? null : Math.round(s.heartbeat_age_ms / 1000);
  const src = "STATUS_RELAY" as const;
  if (s.status !== "ONLINE" || !s.snapshot) {
    return Object.freeze({ source: src, tone: "attention" as const, label: s.status === "NO_DATA" ? "EXE NO HEARTBEAT" : "EXE OFFLINE", engine: "OFFLINE", mode: "—", execution: "UNKNOWN", ageSec, detail: s.status === "NO_DATA" ? "Belum ada heartbeat dari VPS" : `Engine offline · heartbeat ${ageSec ?? "-"}s lalu` });
  }
  const x = s.snapshot;
  const facts = `ENGINE ${x.engine} · MODE ${x.mode} · EXECUTION ${x.execution} · ${x.phase ?? x.stage ?? "-"} · signal ${x.signal} · MT5 ${x.mt5} · kill ${x.kill_switch ? "ON" : "OFF"} · Shadow ${x.shadow} · data ${s.data} · heartbeat ${ageSec ?? "-"}s lalu${x.blockers.length ? ` · blocker ${x.blockers.join(", ")}` : ""}`;
  const base = { source: src, engine: x.engine, mode: x.mode, ageSec };
  if (s.data !== "FRESH" || x.stale || x.engine !== "ONLINE" || x.mt5 !== "CONNECTED") return Object.freeze({ ...base, tone: "attention" as const, label: "EXE DEGRADED", execution: "UNKNOWN", detail: facts });
  if (x.execution === "BLOCKED" || x.mode === "MONITOR_ONLY" || x.kill_switch || x.shadow === "BLOCKING") return Object.freeze({ ...base, tone: "attention" as const, label: "EXE BLOCKED", execution: "BLOCKED", detail: facts });
  if (x.execution === "READY" || x.execution === "ACTIVE") return Object.freeze({ ...base, tone: "healthy" as const, label: x.execution === "ACTIVE" ? "EXE ACTIVE" : "EXE READY", execution: x.execution, detail: facts });
  if (x.execution === "WAITING_SIGNAL") return Object.freeze({ ...base, tone: "waiting" as const, label: "EXE ARMED · WAITING SIGNAL", execution: "WAITING_SIGNAL", detail: facts });
  return Object.freeze({ ...base, tone: "waiting" as const, label: "EXE VERIFYING", execution: "UNKNOWN", detail: facts });
}

/** Primary execution-status when connected; otherwise mirror the bottom-bar relay. */
export function pickExeLamp(primary: ExeLamp, relay: ExeLamp | null): ExeLamp {
  return primary.tone === "unknown" && relay ? relay : primary;
}
