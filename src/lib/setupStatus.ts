// Mobile setup status projection (presentation only). Copies existing snapshot + EXE lamp fields into one
// final, precedence-ordered status. Never computes indicators, R:R, gate or risk; never sends anything.
import type { TradingSnapshot } from "@/core/technical/tradingState";
import type { ExeLamp } from "@/lib/exeLamp";

export type SetupStatusKind = "SIAP_EXEC" | "EXEC_BLOCKED" | "EXEC_UNKNOWN" | "BAD_RR" | "WAIT" | "PROJECTION" | "UNAVAILABLE";
export type SetupTone = "healthy" | "waiting" | "attention" | "unknown";

export interface PlanView {
  readonly source: "REFERENCE_PLAN" | "RADAR_PLAN";
  readonly entry: number | null;
  readonly sl: number | null;
  readonly tp1: number | null;
  readonly tp2: number | null;
  readonly final_rr: number | null;
  readonly economics_status: string | null;
  readonly economics_reason: string | null;
}

export interface SetupStatus {
  readonly kind: SetupStatusKind;
  readonly tone: SetupTone;
  readonly label: string;
  readonly reason: string;
  /** Short badge text for the bottom bar (informational, never a button). */
  readonly badge: string;
  readonly plan: PlanView | null;
}

const human = (v: string | null | undefined) => (v ? v.replaceAll("_", " ") : "—");

/** One plan source only: execution reference_plan when available, else radar projection. Never mixed. */
export function pickPlan(s: TradingSnapshot | null): PlanView | null {
  if (!s) return null;
  const r = s.reference_plan;
  if (r.status === "AVAILABLE")
    return { source: "REFERENCE_PLAN", entry: r.entry, sl: r.sl, tp1: r.tp1, tp2: r.tp2, final_rr: r.final_rr, economics_status: r.economics_status, economics_reason: r.economics_reason };
  const p = s.radar_plan;
  if (p && p.status === "AVAILABLE")
    return { source: "RADAR_PLAN", entry: p.reference_entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, final_rr: p.final_rr ?? null, economics_status: p.economics_status ?? null, economics_reason: p.economics_reason ?? null };
  return null;
}

const isBadRr = (p: PlanView | null) => !!p && (p.economics_status === "BAD_RR" || p.tp1 == null || !(p.final_rr != null && p.final_rr > 0));

export function setupStatus(s: TradingSnapshot | null, exe: ExeLamp | null | undefined): SetupStatus {
  const plan = pickPlan(s);
  const mk = (kind: SetupStatusKind, tone: SetupTone, label: string, reason: string, badge: string): SetupStatus =>
    Object.freeze({ kind, tone, label, reason, badge, plan });
  if (!s || s.availability !== "AVAILABLE")
    return mk("UNAVAILABLE", "unknown", "DATA BELUM TERSEDIA", human(s?.availability_reason ?? "SNAPSHOT_UNAVAILABLE"), "AUTO DEMO · DATA BELUM TERSEDIA");
  const ready = s.signal.state === "READY";
  if (ready) {
    if (plan?.source !== "REFERENCE_PLAN")
      return mk("WAIT", "waiting", "MENUNGGU — PLAN EKSEKUSI BELUM ADA", human(s.reference_plan.status === "NOT_AVAILABLE" ? s.reference_plan.reason : null), "AUTO DEMO · MENUNGGU SETUP");
    if (isBadRr(plan))
      return mk("BAD_RR", "attention", "DITOLAK · BAD R:R", `Order ditolak: TP/R:R tidak valid (${human(plan.economics_reason ?? "TP_NULL")})`, "ORDER DITAHAN · BAD R:R");
    // Setup is technically valid; final say belongs to fresh runtime execution status.
    if (!exe || exe.tone === "unknown" || exe.execution === "UNKNOWN" || exe.label === "EXE STALE" || exe.label === "EXE DEGRADED")
      return mk("EXEC_UNKNOWN", "unknown", "STATUS EKSEKUSI TIDAK DIKETAHUI", exe ? `${exe.label} · ${exe.detail}` : "Status runtime eksekusi belum tersedia", "STATUS EKSEKUSI TIDAK DIKETAHUI");
    if (exe.execution === "BLOCKED" || exe.tone === "attention")
      return mk("EXEC_BLOCKED", "attention", "DIBLOKIR EKSEKUSI", `${exe.label} · ${exe.detail}`, `ORDER DITAHAN · ${exe.label.replace(/^EXE /, "")}`);
    if (exe.tone === "healthy" && (exe.execution === "READY" || exe.execution === "ACTIVE"))
      return mk("SIAP_EXEC", "healthy", "SIAP EXEC", "Sinyal READY, plan eksekusi valid, runtime eksekusi fresh dan tidak diblokir", "AUTO DEMO · SIAP EXEC");
    return mk("EXEC_UNKNOWN", "unknown", "STATUS EKSEKUSI TIDAK DIKETAHUI", `${exe.label} · ${exe.detail}`, "STATUS EKSEKUSI TIDAK DIKETAHUI");
  }
  // Not READY: never an order plan.
  if (plan && plan.source === "REFERENCE_PLAN" && plan.economics_status === "BAD_RR")
    return mk("BAD_RR", "attention", "DITOLAK · BAD R:R", `Order ditolak: TP/R:R tidak valid (${human(plan.economics_reason)})`, "ORDER DITAHAN · BAD R:R");
  if (plan?.source === "RADAR_PLAN" || !plan) {
    const why = plan?.economics_status === "BAD_RR" ? `Proyeksi BAD R:R (${human(plan.economics_reason)}) · ${human(s.signal.reason)}` : human(s.signal.reason);
    if (s.primary_bias === "NONE" || !plan)
      return mk("PROJECTION", "unknown", "PROYEKSI — BUKAN RENCANA ORDER", why, s.primary_bias === "NONE" ? "AUTO DEMO · MONITORING" : "AUTO DEMO · MENUNGGU SETUP");
    return mk("PROJECTION", "waiting", "PROYEKSI — BUKAN RENCANA ORDER", why, "AUTO DEMO · MENUNGGU SETUP");
  }
  return mk("WAIT", "waiting", "MENUNGGU TRIGGER", human(s.signal.reason), "AUTO DEMO · MENUNGGU SETUP");
}
