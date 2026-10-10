// Execution Readiness projection (Phase 1). Pure field copy of existing engine state into per-stage lamps.
// It never evaluates indicators, bias, setups, plans or risk; it only reads outcomes the engine already recorded.
// Missing data ⇒ UNKNOWN, old data ⇒ STALE; neither is ever reported as PASS.
import type { PaperReadinessView } from "../paper/LivePaperLoop";
import type { SymbolEngineHealth } from "./types";
import type { ExecutionMode } from "../execution/demo/types";

export const READINESS_SCHEMA = "engine-readiness-v1" as const;
/** Paper loop runs once per CLOSED M5; two missed bars + 60 s grace ⇒ STALE. */
export const READINESS_STALE_MS = 2 * 300_000 + 60_000;

export type LampStatus = "PASS" | "BLOCKED" | "UNKNOWN" | "STALE";
export interface ReadinessLamp { readonly status: LampStatus; readonly reason: string | null; readonly at: number | null }

export interface EngineReadiness {
  readonly schema: typeof READINESS_SCHEMA;
  readonly symbol: string;
  readonly generated_at: number;
  readonly last_evaluated_at: number | null;
  readonly stale: boolean;
  readonly decision: string | null;
  readonly market: ReadinessLamp;
  readonly primary_bias: ReadinessLamp & { readonly bias: "BUY" | "SELL" | "NONE" | null };
  readonly m2: ReadinessLamp & { readonly state: string | null; readonly direction: "BUY" | "SELL" | "NONE" | null };
  readonly m3: ReadinessLamp & { readonly plan_status: string | null };
  readonly m4: ReadinessLamp & { readonly decision: string | null; readonly reasons: readonly string[] };
  readonly demo: ReadinessLamp & { readonly mode: ExecutionMode; readonly kill_switch: boolean | null; readonly open_positions: number | null; readonly trades_today: number | null; readonly last_event: string | null; readonly last_event_at: number | null };
  readonly gateway: ReadinessLamp;
  readonly account: ReadinessLamp & { readonly login: number | null; readonly server: string | null };
  readonly open_paper_position: boolean | null;
}

const lamp = (status: LampStatus, reason: string | null, at: number | null): ReadinessLamp => ({ status, reason, at });
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" ? v as Record<string, unknown> : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" ? v : null;

export function buildReadiness(i: {
  symbol: string; now: number; health: SymbolEngineHealth | null; executionMode: ExecutionMode;
  paper: PaperReadinessView | null; demo: unknown;
}): EngineReadiness {
  const p = i.paper;
  const at = p?.lastEvaluatedAt ?? null;
  const stale = at === null || i.now - at > READINESS_STALE_MS;
  const fresh = (l: ReadinessLamp): ReadinessLamp => l.status === "PASS" && stale ? lamp("STALE", l.reason, l.at) : l;

  const market = !i.health ? lamp("UNKNOWN", "NOT_MOUNTED", null)
    : i.health.state === "ONLINE" ? lamp("PASS", null, i.health.last_update_at) : lamp("BLOCKED", `ENGINE_${i.health.state}${i.health.error ? ` ${i.health.error}` : ""}`, i.health.last_update_at);

  const pb = p?.primaryBias ?? null;
  const primary = !p ? lamp("UNKNOWN", "PAPER_LOOP_UNAVAILABLE", null) : !pb ? lamp(at === null ? "UNKNOWN" : "BLOCKED", "NO_PRIMARY_BIAS", at)
    : pb.bias === "NONE" ? lamp("BLOCKED", "NO_PRIMARY_BIAS", pb.asOf) : lamp("PASS", null, pb.asOf);

  const m2v = p?.m2 ?? null;
  const m2 = !m2v ? lamp("UNKNOWN", p?.decision ?? "NO_EVALUATION", at) : m2v.state === "READY" ? lamp("PASS", null, m2v.at) : lamp("BLOCKED", p?.decision ?? m2v.state, m2v.at);
  const m3v = p?.m3 ?? null;
  const m3 = !m3v ? lamp("UNKNOWN", "NO_PLAN_ATTEMPT", null) : m3v.status === "PLANNED" ? lamp("PASS", null, m3v.at) : lamp("BLOCKED", `PLAN_HOLD ${m3v.holdReason ?? ""}`.trim(), m3v.at);
  const m4v = p?.m4 ?? null;
  const m4 = !m4v ? lamp("UNKNOWN", "NO_RISK_ATTEMPT", null) : m4v.decision === "APPROVED" ? lamp("PASS", null, m4v.at) : lamp("BLOCKED", `RISK_${m4v.decision} ${m4v.reasons.join(",")}`.trim(), m4v.at);

  const d = rec(i.demo), acc = rec(d?.["account"]), last = rec(d?.["lastEvent"]);
  const kill = typeof d?.["killSwitch"] === "boolean" ? d["killSwitch"] as boolean : null;
  const accReason = str(acc?.["reason"]);
  const lastAt = num(last?.["at"]);
  const demo = i.executionMode !== "DEMO_STRESS_TEST" ? lamp("BLOCKED", `MODE_${i.executionMode}`, null)
    : !d || !acc ? lamp("UNKNOWN", "DEMO_STATUS_UNAVAILABLE", null)
    : kill ? lamp("BLOCKED", "KILL_SWITCH", lastAt) : lamp("PASS", null, lastAt);
  const gateway = i.executionMode !== "DEMO_STRESS_TEST" || !acc ? lamp("UNKNOWN", acc ? "MODE_NOT_DEMO" : "DEMO_STATUS_UNAVAILABLE", null)
    : accReason === "IDENTITY_UNAVAILABLE" ? lamp("BLOCKED", "GATEWAY_UNREACHABLE_OR_NO_IDENTITY", lastAt)
    : lamp("PASS", null, lastAt);
  const account = !acc ? lamp("UNKNOWN", "DEMO_STATUS_UNAVAILABLE", null)
    : acc["ok"] === true ? lamp("PASS", null, lastAt) : lamp("BLOCKED", accReason ?? "ACCOUNT_NOT_VALIDATED", lastAt);

  return Object.freeze({
    schema: READINESS_SCHEMA, symbol: i.symbol, generated_at: i.now, last_evaluated_at: at, stale, decision: p?.decision ?? null,
    market,
    primary_bias: { ...fresh(primary), bias: pb?.bias ?? null },
    m2: { ...fresh(m2), state: m2v?.state ?? null, direction: m2v?.direction ?? null },
    m3: { ...fresh(m3), plan_status: m3v?.status ?? null },
    m4: { ...fresh(m4), decision: m4v?.decision ?? null, reasons: m4v?.reasons ?? [] },
    demo: { ...demo, mode: i.executionMode, kill_switch: kill, open_positions: num(d?.["openPositions"]), trades_today: num(d?.["tradesToday"]), last_event: str(last?.["type"]), last_event_at: lastAt },
    gateway, account: { ...account, login: num(acc?.["login"]), server: str(acc?.["server"]) },
    open_paper_position: p ? p.openPosition : null,
  });
}
