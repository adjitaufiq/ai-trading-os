// Server-only: reads stored history with pagination (no row cap) and assembles the report. Read-only on trading data.
import { buildWorkbook, telegramSummary, type EventRow, type ReportInput, type SessionRow, type TradeRow } from "./labReport";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
const PAGE = 1000;

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function collectReportInput(db: Admin, cutoffMs: number): Promise<ReportInput> {
  const notes: string[] = [];
  const [sess, paper, demo, demoEv, eng] = await Promise.all([
    all<Record<string, unknown>>((a, b) => db.from("lab_journal_sessions").select("id,source,started_at_ms,initial_balance,client_as_of_ms,synced_at,summary").order("id").range(a, b)),
    all<Record<string, unknown>>((a, b) => db.from("lab_journal_trades").select("session_id,trade_id,strategy,symbol,side,status,pnl_usd,opened_at_ms,closed_at_ms,revision,payload").order("session_id").order("trade_id").range(a, b)),
    all<Record<string, unknown>>((a, b) => db.from("lab_demo_trades").select("*").order("agent_id").order("signal_id").range(a, b)),
    all<Record<string, unknown>>((a, b) => db.from("lab_demo_events").select("event_type,signal_id,symbol,strategy,at_ms,payload").order("agent_id").order("event_key").range(a, b)),
    all<Record<string, unknown>>((a, b) => db.from("engine_events").select("occurred_at,symbol,event_type,stage,signal_id,direction,reason,execution_result,block_reason,source").order("occurred_at").range(a, b)),
  ]);
  const srcOf = new Map(sess.map((s) => [String(s["id"]), String(s["source"])]));
  const trades: TradeRow[] = [
    ...paper.map((r) => ({ ...(r as unknown as TradeRow), pnl_usd: Number(r["pnl_usd"]), opened_at_ms: Number(r["opened_at_ms"]), closed_at_ms: r["closed_at_ms"] == null ? null : Number(r["closed_at_ms"]), revision: Number(r["revision"]), source: srcOf.get(String(r["session_id"])) ?? "BROWSER_PAPER" })),
    ...demo.map((r) => ({ session_id: String(r["agent_id"]), trade_id: String(r["signal_id"]), strategy: String(r["strategy"]), symbol: String(r["symbol"]), side: String(r["side"]), status: String(r["status"]), pnl_usd: r["pnl_usd"] == null ? 0 : Number(r["pnl_usd"]), opened_at_ms: Number(r["opened_at_ms"]), closed_at_ms: r["closed_at_ms"] == null ? null : Number(r["closed_at_ms"]), revision: Number(r["snapshot_at_ms"]), payload: (r["payload"] ?? {}) as Record<string, unknown>, source: "MT5_DEMO" })),
  ];
  if (!demo.length) notes.push("MT5_DEMO: belum ada trade dari VPS (lab_demo_trades kosong).");
  notes.push("Lab Paper: log sinyal, snapshot posisi historis, floating per jam, dan event risk guard tidak pernah dicatat → NOT_RECORDED.");
  notes.push("Signal_Log/Risk_Events dari engine_events adalah ARENA engine, bukan Strategy Lab.");
  const sessions: SessionRow[] = sess.map((s) => ({ id: String(s["id"]), source: String(s["source"]), started_at_ms: s["started_at_ms"] == null ? null : Number(s["started_at_ms"]), initial_balance: Number(s["initial_balance"]), client_as_of_ms: Number(s["client_as_of_ms"]), synced_at: String(s["synced_at"]), summary: (s["summary"] ?? {}) as Record<string, unknown> }));
  const ev: EventRow[] = eng.map((e) => ({ source: `ARENA_ENGINE:${e["source"]}`, at: String(e["occurred_at"]), symbol: e["symbol"] as string, type: String(e["event_type"]), stage: e["stage"] as string | null, signal_id: e["signal_id"] as string | null, direction: e["direction"] as string | null, reason: String(e["reason"] ?? ""), result: e["execution_result"] as string | null, block_reason: e["block_reason"] as string | null }));
  const dEv: EventRow[] = demoEv.map((e) => ({ source: "MT5_DEMO", at: e["at_ms"] ? new Date(Number(e["at_ms"])).toISOString() : "", symbol: e["symbol"] as string | null, type: String(e["event_type"]), stage: null, signal_id: e["signal_id"] as string | null, direction: null, reason: JSON.stringify(e["payload"]).slice(0, 300), result: null, block_reason: null }));
  const isRisk = (e: EventRow) => e.type === "BLOCKED" || !!e.block_reason || /GUARD|STOP|TARGET|HALT|CAP|BLACKOUT|FLATTEN|REJECT/i.test(e.type);
  const signals = [...ev, ...dEv].filter((e) => !isRisk(e));
  const risk = [...ev, ...dEv].filter(isRisk);
  return { trades: (await import("./labReport")).dedupTrades(trades), rawTradeRows: paper.length + demo.length, sessions, signals, risk, demoTradeRows: demo.length, notes, cutoffMs };
}

async function sendDocument(bytes: Uint8Array, filename: string, caption: string): Promise<{ ok: boolean; note: string }> {
  const bot = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const { operatorChatId } = await import("@/lib/assistant/telegram.server");
  if (!bot) return { ok: false, note: "TELEGRAM_BOT_TOKEN missing" };
  const fd = new FormData();
  fd.append("chat_id", operatorChatId());
  fd.append("caption", caption.slice(0, 1000));
  fd.append("document", new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot}/sendDocument`, { method: "POST", body: fd });
    const body = await r.text();
    const ok = r.ok && /"ok":true/.test(body);
    if (!ok) console.error(`[lab-report] sendDocument [${r.status}]: ${body.slice(0, 300)}`);
    return { ok, note: ok ? "ok" : `[${r.status}] ${body.slice(0, 200)}` };
  } catch (e) { return { ok: false, note: (e as Error).message }; }
}

export interface RunResult { ok: boolean; skipped?: boolean; slot: string; status: string; trades?: number; rows?: number; net?: number; bytes?: number; telegram?: string | undefined; note?: string; base64?: string; filename?: string }

/** One run: collect → workbook → (optional) Telegram. Hourly slots are deduped via unique slot_key. */
export async function runLabReport(opts: { trigger: "HOURLY" | "MANUAL"; telegram: boolean; returnFile: boolean }): Promise<RunResult> {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const now = Date.now();
  const hourWib = new Date(now + 7 * 3600_000).toISOString().slice(0, 13);
  const slot = opts.trigger === "HOURLY" ? `HOURLY:${hourWib}` : `MANUAL:${now}`;
  if (opts.trigger === "HOURLY") {
    const { data: prev } = await db.from("lab_report_runs").select("id,status,telegram_status,telegram_attempts").eq("slot_key", slot).maybeSingle();
    if (prev && (prev.telegram_status === "SENT" || prev.telegram_attempts >= 3 || prev.status === "RUNNING")) return { ok: true, skipped: true, slot, status: prev.status };
    if (prev) await db.from("lab_report_runs").update({ status: "RUNNING", note: "retry" }).eq("id", prev.id);
    else { const { error } = await db.from("lab_report_runs").insert({ slot_key: slot, trigger: opts.trigger }); if (error) return { ok: true, skipped: true, slot, status: "DUPLICATE" }; }
  } else await db.from("lab_report_runs").insert({ slot_key: slot, trigger: opts.trigger });
  const fin = (p: Record<string, unknown>) => db.from("lab_report_runs").update({ finished_at: new Date().toISOString(), ...p }).eq("slot_key", slot);
  try {
    const input = await collectReportInput(db, now);
    const { bytes, summary } = buildWorkbook(input);
    const filename = `lab-report-${summary.cutoff_wib.replace(/[: ]/g, "-")}-WIB.xlsx`;
    let tg: string | undefined; let attempts = 0;
    if (opts.telegram) {
      const { data: row } = await db.from("lab_report_runs").select("telegram_attempts").eq("slot_key", slot).maybeSingle();
      attempts = (row?.telegram_attempts ?? 0);
      const { sendTelegramMessage, operatorChatId } = await import("@/lib/assistant/telegram.server");
      const msg = await sendTelegramMessage(operatorChatId(), telegramSummary(summary, true));
      const doc = await sendDocument(bytes, filename, `Lab Report ${summary.cutoff_wib} WIB · ${summary.unique_trades} trade`);
      attempts += 1;
      tg = doc.ok ? "SENT" : `FAILED: doc ${doc.note}; msg ${msg.status}`;
    }
    const first = input.trades[0]?.opened_at_ms;
    await fin({ status: "OK", trade_rows: input.rawTradeRows, unique_trades: summary.unique_trades, net_pnl: summary.total.net, first_trade_at: first ? new Date(first).toISOString() : null, last_trade_at: input.trades.length ? new Date(Math.max(...input.trades.map((t) => t.closed_at_ms ?? t.opened_at_ms))).toISOString() : null, file_bytes: bytes.length, ...(opts.telegram ? { telegram_status: tg?.startsWith("SENT") ? "SENT" : "FAILED", telegram_attempts: attempts, note: tg } : {}) });
    return { ok: true, slot, status: "OK", trades: summary.unique_trades, rows: input.rawTradeRows, net: summary.total.net, bytes: bytes.length, telegram: tg, ...(opts.returnFile ? { base64: Buffer.from(bytes).toString("base64"), filename } : {}) };
  } catch (e) {
    const note = (e as Error).message;
    console.error("[lab-report] failed", note);
    await fin({ status: "FAILED", note });
    return { ok: false, slot, status: "FAILED", note };
  }
}
