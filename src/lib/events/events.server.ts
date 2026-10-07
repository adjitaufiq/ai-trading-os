// Proof-of-life capture (server-only): copy Engine Host pipeline/demo/radar events into append-only engine_events,
// then dispatch notifications for newly inserted READY / EXECUTION / BLOCKED events. Insert-only; never writes to the VPS.
// Notification failure never fails the capture: missing credentials ⇒ delivery_status PENDING with the reason.
import type { EngineSymbolBundle } from "@/core/enginehost/types";
import { AI_ALERTS_PER_RUN, composeAlert, explainEvent, sendTelegramMessage } from "@/lib/assistant/telegram.server";

export interface EventRow {
  event_key: string; symbol: string; event_type: "RADAR" | "READY" | "BLOCKED" | "EXECUTION" | "EXIT" | "ENGINE_OFFLINE" | "ENGINE_ONLINE"; stage: string | null;
  signal_id: string | null; occurred_at: string; direction: string | null; confidence: number | null;
  timeframe_context: Record<string, unknown>; reason: string; snapshot_ref: string | null;
  entry: number | null; stop_loss: number | null; take_profit: number | null; payload: unknown;
  execution_result?: string | null; block_reason?: string | null; source?: string;
}

export interface PipelineEv {
  type: "READY" | "BLOCKED" | "EXECUTION" | "EXIT"; stage: string; symbol: string; signalId: string | null; direction: "BUY" | "SELL" | null;
  at: number; reason: string; entry: number | null; stopLoss: number | null; takeProfit: number | null;
  confidence: number | null; timeframe_context: Record<string, unknown>; snapshot_ref: number | null;
}
interface DemoEv { type: string; signalId: string | null; symbol: string | null; detail?: string; data?: Record<string, unknown>; at: number }

const iso = (ms: number) => new Date(ms).toISOString();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function pipelineToRow(e: PipelineEv): EventRow {
  return {
    event_key: `pipe:${e.symbol}:${e.type}:${e.stage}:${e.signalId ?? "-"}:${e.at}`, symbol: e.symbol, event_type: e.type, stage: e.stage,
    signal_id: e.signalId, occurred_at: iso(e.at), direction: e.direction, confidence: e.confidence, timeframe_context: e.timeframe_context ?? {},
    reason: e.reason, snapshot_ref: e.snapshot_ref !== null ? iso(e.snapshot_ref) : null,
    entry: e.entry, stop_loss: e.stopLoss, take_profit: e.takeProfit, payload: e,
    execution_result: e.type === "EXECUTION" || e.type === "EXIT" ? e.reason : null,
    block_reason: e.type === "BLOCKED" ? `${e.stage}: ${e.reason}` : null,
  };
}

export function demoToRows(events: readonly DemoEv[]): EventRow[] {
  const sends = new Map(events.filter((e) => e.type === "SEND_ATTEMPT").map((e) => [e.signalId, e]));
  const out: EventRow[] = [];
  for (const e of events) {
    if (!e.symbol) continue;
    const kind = e.type === "BLOCKED" ? "BLOCKED" : e.type === "CLOSED" ? "EXIT" : ["FILLED", "REJECTED", "ERROR"].includes(e.type) ? "EXECUTION" : null;
    if (!kind) continue;
    const intent = ((e.data?.["intent"] ?? sends.get(e.signalId)?.data?.["intent"]) ?? null) as Record<string, unknown> | null;
    out.push({
      event_key: `demo:${e.type}:${e.signalId ?? "-"}:${e.at}`, symbol: e.symbol, event_type: kind,
      stage: kind === "BLOCKED" ? "DEMO_GUARD" : "DEMO_MT5", signal_id: e.signalId, occurred_at: iso(e.at),
      direction: (intent?.["direction"] as string | undefined) ?? null, confidence: null, timeframe_context: {},
      reason: `${e.type} ${e.detail ?? ""}`.trim(), snapshot_ref: null,
      entry: kind === "EXECUTION" ? num(e.data?.["price"]) : kind === "EXIT" ? num(e.data?.["price"]) : num(intent?.["plannedEntry"]),
      stop_loss: num(intent?.["stopLoss"]), take_profit: num(intent?.["takeProfit"]), payload: e,
      execution_result: kind === "EXECUTION" || kind === "EXIT" ? `${e.type} ${e.detail ?? ""}`.trim() : null,
      block_reason: kind === "BLOCKED" ? (e.detail ?? e.type) : null,
    });
  }
  return out;
}

/** RADAR: radar has an active candidate setup on the evaluated M5 close (copy of engine labels). */
export function bundleToRadarRow(b: EngineSymbolBundle): EventRow | null {
  const s = b.radar.snapshot, i = s?.intelligence;
  if (!s || !i || typeof b.last_m5_close !== "number" || !i.setup || i.setup === "NO_SETUP" || i.setup === "RANGE_ONLY") return null;
  return {
    event_key: `radar:${b.symbol}:${b.last_m5_close}`, symbol: b.symbol, event_type: "RADAR", stage: i.status, signal_id: null,
    occurred_at: iso(b.last_m5_close), direction: null, confidence: i.confidence,
    timeframe_context: { bias: i.bias, h4: i.h4_state, h1: i.h1_state, m15: i.m15_condition, m5: i.m5_condition, regime: s.regime.type, decision: i.status },
    reason: `${i.setup} · ${i.status}`, snapshot_ref: s.generatedAt ? iso(s.generatedAt) : null,
    entry: null, stop_loss: i.key_levels?.support ?? null, take_profit: i.key_levels?.resistance ?? null, payload: { setup: i.setup, reasons: (i.reasons ?? []).slice(0, 6) },
  };
}

const ALERT_TYPES = new Set(["READY", "EXECUTION", "BLOCKED", "EXIT", "ENGINE_OFFLINE", "ENGINE_ONLINE"]);

/** Human alert title derived from copied event fields (no inference beyond text match on the engine's own reason). */
export function alertTitle(r: { event_type: string; reason: string }): string {
  const t = r.reason.toUpperCase();
  if (r.event_type === "READY") return "🟡 READY detected";
  if (r.event_type === "BLOCKED") return "⛔ EXECUTION BLOCKED";
  if (r.event_type === "EXECUTION") return /REJECT|ERROR/.test(t) ? "⚠️ DEMO ORDER FAILED" : "🟢 DEMO ORDER OPENED";
  if (r.event_type === "EXIT") return /\bTP\b|TAKE_PROFIT|TAKE PROFIT/.test(t) ? "✅ TP HIT" : /\bSL\b|STOP_LOSS|STOP LOSS/.test(t) ? "🔴 SL HIT" : "⏹ POSITION CLOSED";
  if (r.event_type === "ENGINE_OFFLINE") return "🚨 ENGINE OFFLINE";
  if (r.event_type === "ENGINE_ONLINE") return "✅ ENGINE BACK ONLINE";
  return r.event_type;
}

export function formatAlert(r: { symbol: string; event_type: string; stage: string | null; direction: string | null; confidence: number | null; reason: string; entry: number | null; stop_loss: number | null; take_profit: number | null; occurred_at: string }): string {
  const lines = [`<b>${alertTitle(r)}</b> ${r.symbol} ${r.direction ?? ""}`.trim(), `Stage: ${r.stage ?? "-"}`, `Confidence: ${r.confidence ?? "-"}`, `Reason: ${r.reason}`];
  if (r.entry !== null || r.stop_loss !== null) lines.push(`Entry ${r.entry ?? "-"} · SL ${r.stop_loss ?? "-"} · TP ${r.take_profit ?? "-"}`);
  lines.push(`${r.occurred_at} · DEMO lab, bukan akun real`);
  return lines.join("\n").replace(/&(?!lt;|gt;|amp;)/g, "&amp;");
}

export async function captureEngineEvents(baseUrl: string, bundles: readonly EngineSymbolBundle[], demoEvents: readonly DemoEv[]) {
  const rows: EventRow[] = [];
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/engine/pipeline`);
    const evs = r.ok ? (((await r.json()) as { data?: { events?: PipelineEv[] } }).data?.events ?? []) : [];
    rows.push(...evs.map(pipelineToRow));
  } catch (e) { console.error("[engine-events] pipeline fetch failed", (e as Error).message); }
  rows.push(...demoToRows(demoEvents));
  for (const b of bundles) { const r = bundleToRadarRow(b); if (r) rows.push(r); }
  return ingestEventRows(rows);
}

/** Insert-only (dedupe on event_key) + Telegram dispatch for newly inserted alertable rows. */
export async function ingestEventRows(rows: EventRow[]) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (!rows.length) return { inserted: 0, notified: 0 };
  const { data, error } = await supabaseAdmin.from("engine_events").upsert(rows as never, { onConflict: "event_key", ignoreDuplicates: true }).select();
  if (error) { console.error("[engine-events] write failed", error.message); return { inserted: 0, notified: 0, error: error.message }; }
  let notified = 0, aiUsed = 0;
  for (const ev of (data ?? []) as (EventRow & { id: string })[]) {
    if (!ALERT_TYPES.has(ev.event_type)) continue;
    const why = ev.event_type !== "ENGINE_OFFLINE" && ev.event_type !== "ENGINE_ONLINE" && aiUsed < AI_ALERTS_PER_RUN ? (aiUsed++, await explainEvent(ev)) : null;
    const res = await sendTelegramMessage(process.env["TELEGRAM_CHAT_ID"] ?? "", composeAlert(ev, why));
    if (res.status !== "SENT") console.warn(`[engine-events] ${ev.event_key} delivery ${res.status}: ${res.note}`);
    const { error: ne } = await supabaseAdmin.from("engine_notifications").insert({ event_id: ev.id, channel: "TELEGRAM", delivery_status: res.status, note: res.note });
    if (ne) console.error("[engine-events] notification log failed", ne.message);
    notified++;
  }
  return { inserted: data?.length ?? 0, notified };
}

/** ENGINE_OFFLINE / ENGINE_ONLINE transitions, deduped against the latest recorded health event. */
export async function recordEngineHealth(online: boolean, detail: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("engine_events").select("event_type").in("event_type", ["ENGINE_OFFLINE", "ENGINE_ONLINE"]).order("occurred_at", { ascending: false }).limit(1);
  const last = data?.[0]?.event_type ?? "ENGINE_ONLINE";
  const type = online ? "ENGINE_ONLINE" : "ENGINE_OFFLINE";
  if (last === type) return { changed: false };
  const now = new Date().toISOString();
  return ingestEventRows([{ event_key: `health:${type}:${now}`, symbol: "ALL", event_type: type, stage: "HEALTH", signal_id: null, occurred_at: now,
    direction: null, confidence: null, timeframe_context: {}, reason: detail, snapshot_ref: null, entry: null, stop_loss: null, take_profit: null, payload: {}, source: "health" }]);
}
