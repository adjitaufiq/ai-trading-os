// Telegram = mobile extension of the dashboard AI Assistant. Same persona (analystInstructions), same live context
// (buildLiveContext → AI Context Builder), same memory/journal/performance context. AI ≠ AUTHORITY:
// every fact line in an alert (symbol, direction, confidence, entry/SL/TP, execution result) is copied verbatim from
// the engine event; the LLM only writes the "Kenapa" explanation and can never change direction or create a signal.
import { generateText } from "ai";
import { analystInstructions } from "./analyst";
import { buildLiveContext } from "./context.server";
import { selectLlmAdapter } from "./llm/gateway.server";
import { buildMemoryContext } from "../memory/context.server";
import { escapeTelegramHtml as esc, limitTelegramHtml, markdownToTelegramHtml, readableEngineText, telegramHtmlToPlainText } from "./telegramFormat";

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";
/** Max AI explanations per capture run (bounded work; remaining alerts use the deterministic template). */
export const AI_ALERTS_PER_RUN = 4;

export interface AlertEvent {
  symbol: string; event_type: string; stage: string | null; direction: string | null; confidence: number | null; reason: string;
  entry: number | null; stop_loss: number | null; take_profit: number | null; occurred_at: string;
  timeframe_context?: Record<string, unknown> | null; execution_result?: string | null; block_reason?: string | null;
}

async function adminContext(scope: string): Promise<string> {
  if (scope === "BOTH") {
    const contexts = await Promise.all(["XAUUSD", "BTCUSD"].map(async (symbol) =>
      `SCOPE=${symbol}\n${await adminContext(symbol).catch(() => "LIVE_CONTEXT: UNAVAILABLE; MEMORY_CONTEXT: UNAVAILABLE")}`));
    return `LAPORAN DUA SIMBOL: sumber dan timestamp terpisah; jangan mencampur data.\n${contexts.join("\n\n")}`;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [live, mem] = await Promise.all([buildLiveContext(scope), scope === "ENGINE" ? Promise.resolve("") : buildMemoryContext(supabaseAdmin as never, scope).catch(() => "MEMORY_CONTEXT: UNAVAILABLE")]);
  return mem ? `${live}\n\n=== ${mem}\nATURAN MEMORY: sebut ukuran sampel; jangan menyimpulkan dari sampel kecil; jangan usulkan perubahan aturan.` : live;
}

async function ask(scope: string, prompt: string, tier: "fast" | "medium"): Promise<string | null> {
  const adapter = selectLlmAdapter();
  if (!adapter) return null;
  try {
    const sel = adapter.create(new Request("http://internal/telegram"), tier);
    const live = await adminContext(scope).catch((e) => { console.error("[telegram-ai] context failed", e); return "LIVE_CONTEXT: UNAVAILABLE"; });
    const r = await generateText({
      model: sel.model, system: analystInstructions(scope, "TELEGRAM", live), prompt,
      ...(sel.providerOptions ? { providerOptions: sel.providerOptions } : {}),
    } as Parameters<typeof generateText>[0]);
    return r.text.trim() || null;
  } catch (e) {
    console.warn("[telegram-ai] explanation unavailable", (e as { statusCode?: number }).statusCode ?? (e as Error).message);
    return null;
  }
}

/** AI "Kenapa" section for an engine event. Returns null on any AI failure (caller sends facts only). */
export async function explainEvent(ev: AlertEvent): Promise<string | null> {
  const scope = ev.symbol === "XAUUSD" || ev.symbol === "BTCUSD" ? ev.symbol : "ENGINE";
  const prompt = `Engine mencatat peristiwa berikut (FAKTA pada occurred_at, jangan diubah):\n${JSON.stringify(ev)}\n\nTulis ringkasan eksekutif untuk notifikasi HP (maks 4 bullet satu tingkat, Bahasa Indonesia profesional, tanpa tabel/blok kode):\n- Takeaway peristiwa dan alasan kunci dari timeframe_context/reason event. LIVE_CONTEXT lebih baru hanya untuk pengawasan saat ini, bukan bukti alasan historis event.\n${ev.event_type === "EXIT" ? "- Ringkas hasil dan alasan penutupan yang tercatat; review hanya bila tersedia, jangan mengarang kepatuhan atau hasil.\n" : ""}${ev.event_type === "BLOCKED" ? "- Jelaskan block_reason tanpa menebak aturan lain.\n" : ""}- Radar/pengawasan: hanya status tercatat, sebut belum tersedia bila kosong.\nJangan menyebut arah selain "${ev.direction ?? "-"}", jangan membuat entry/SL/TP baru, jangan menyarankan order.`;
  return ask(scope, prompt, "fast");
}

/** Q&A from the operator's phone: same persona + context as dashboard. */
export async function answerQuestion(text: string): Promise<string> {
  const up = text.toUpperCase();
  const xau = /XAU|GOLD|EMAS/.test(up), btc = /BTC|BITCOIN/.test(up);
  const scope = (xau && btc) || /KEDUA SIMBOL|SEMUA SIMBOL|BRIEFING|RINGKASAN PASAR/.test(up) && !xau && !btc ? "BOTH" : xau ? "XAUUSD" : btc ? "BTCUSD" : /ENGINE|VPS|HEALTH|ONLINE|OFFLINE/.test(up) ? "ENGINE" : "KNOWLEDGE";
  const out = await ask(scope, `${text}\n\n(Sajikan sebagai briefing profesional Telegram; fakta dan keputusan hanya dari sumber yang tersedia.)`, "medium");
  return markdownToTelegramHtml(out ?? "AI sedang tidak tersedia. Kondisi engine belum diverifikasi; silakan coba lagi sebentar.");
}

const TITLES: Record<string, string> = { READY: "🚨 ENGINE READY", BLOCKED: "⛔ EXECUTION BLOCKED", ENGINE_OFFLINE: "🚨 ENGINE OFFLINE", ENGINE_ONLINE: "✅ ENGINE BACK ONLINE" };
export function alertHeadline(ev: { event_type: string; reason: string }): string {
  const t = ev.reason.toUpperCase();
  if (ev.event_type === "EXECUTION") return /REJECT|ERROR/.test(t) ? "⚠️ DEMO ORDER FAILED" : "🟢 DEMO ORDER OPENED";
  if (ev.event_type === "EXIT") return /\bTP\b|TAKE_PROFIT|TAKE PROFIT/.test(t) ? "🎯 TP HIT" : /\bSL\b|STOP_LOSS|STOP LOSS/.test(t) ? "🛑 SL HIT" : "⏹ POSITION CLOSED";
  return TITLES[ev.event_type] ?? ev.event_type;
}

/** UTC "YYYY-MM-DD HH:mm UTC"; raw string passthrough when unparseable. */
function fmtUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
const numStr = (v: number | null) => (v === null ? "-" : String(v));
const dirText = (d: string | null, emoji: boolean): string => {
  const up = (d ?? "").toUpperCase();
  if (!up) return "-";
  if (!emoji) return up;
  return up === "BUY" ? "🟢 BUY" : up === "SELL" ? "🔴 SELL" : up;
};
/** RR from engine entry/SL/TP only; "-" when any leg missing (never inferred). */
function rrText(entry: number | null, sl: number | null, tp: number | null): string | null {
  if (entry === null || sl === null || tp === null) return null;
  const risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
  return risk > 0 && reward > 0 ? `1:${(reward / risk).toFixed(2)}` : null;
}
/** Result taken verbatim from the engine/journal R figure inside the reason; "-" when absent. */
function resultText(reason: string): string {
  const m = reason.match(/([+-]?\d+(?:\.\d+)?)\s*R\b/i);
  return m?.[1] ? `${m[1]}R` : "-";
}
const bulletReason = (reason: string): string[] => {
  const parts = reason.split(/\s*[;·|]\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [reason.trim() || "-"];
};

/** Facts (verbatim from engine event) + optional AI "Kenapa" — operator-format templates. */
export function composeAlert(ev: AlertEvent, why: string | null): string {
  const tf = (ev.timeframe_context ?? {}) as Record<string, unknown>;
  const L: string[] = [];
  const field = (label: string, value: string) => { L.push(`<b>${label}:</b>`, markdownToTelegramHtml(readableEngineText(value || "Belum tersedia"))); };
  const tfVal = (k: string): string => {
    const v = tf[k];
    return v === undefined || v === null || String(v).trim() === "" ? "-" : String(v);
  };

  if (ev.event_type === "ENGINE_OFFLINE" || ev.event_type === "ENGINE_ONLINE") {
    L.push(`<b>${esc(alertHeadline(ev))}</b>`, "", markdownToTelegramHtml(readableEngineText(ev.reason)));
  } else if (ev.event_type === "BLOCKED") {
    L.push("<b>⛔ EXECUTION BLOCKED</b>", "");
    field("Symbol", ev.symbol);
    field("Direction", dirText(ev.direction, false));
    field("Engine", "READY");
    const br = (ev.block_reason ?? "").trim() || `${ev.stage ?? "-"}: ${ev.reason}`;
    const sep = br.indexOf(":");
    field("Blocked By", sep > 0 ? br.slice(0, sep).trim() : (ev.stage ?? "-"));
    field("Reason", sep > 0 ? br.slice(sep + 1).trim() : br);
  } else if (ev.event_type === "EXIT") {
    L.push(`<b>${esc(alertHeadline(ev))}</b>`, "", esc(`${ev.symbol} ${ev.direction ?? ""}`.trim()), "");
    const isDemo = ev.stage === "DEMO_MT5";
    field("Entry", isDemo ? "-" : numStr(ev.entry));
    field("Exit", isDemo ? numStr(ev.entry) : "-");
    field("Result", resultText(ev.reason));
    field("Reason Review", ev.reason || "-");
    L.push("<b>Journal:</b>", "Saved");
  } else {
    // READY / EXECUTION — one template; execution_result decides the Execution line.
    L.push(`<b>${esc(ev.event_type === "READY" ? "🚨 ENGINE READY" : alertHeadline(ev))}</b>`, "");
    field("Symbol", ev.symbol);
    field("Direction", dirText(ev.direction, true));
    field("Time", fmtUtc(ev.occurred_at));
    field("Engine Decision", typeof tf["decision"] === "string" && tf["decision"] ? tf["decision"] : "READY");
    field("Confidence", ev.confidence !== null ? `${ev.confidence}/100` : "-");
    L.push("", "<b>Market Context:</b>");
    for (const [k, label] of [["h4", "H4"], ["h1", "H1"], ["m15", "M15"], ["m5", "M5"]] as const)
      field(label, tfVal(k));
    L.push("", "<b>Setup Reason:</b>");
    for (const b of bulletReason(ev.reason)) L.push(markdownToTelegramHtml(`• ${readableEngineText(b)}`));
    L.push("", "<b>Trade Plan:</b>");
    field("Entry", numStr(ev.entry));
    field("Stop Loss", numStr(ev.stop_loss));
    field("Take Profit", numStr(ev.take_profit));
    field("Risk/Reward", rrText(ev.entry, ev.stop_loss, ev.take_profit) ?? "-");
    const er = (ev.execution_result ?? "").trim();
    L.push("", "<b>Execution:</b>", markdownToTelegramHtml(er ? (/REJECT|ERROR/i.test(er) ? `⚠️ ${er}` : `✅ ${er}`) : "⏳ Menunggu validasi risiko, rencana trade, dan akun demo"));
    L.push("<b>Mode:</b>", "DEMO_MT5");
  }

  if (why) L.push("", "<b>Ringkasan Eksekutif:</b>", markdownToTelegramHtml(why));
  L.push("", `<i>${esc(fmtUtc(ev.occurred_at))} · DEMO lab · AI hanya menjelaskan</i>`);
  return limitTelegramHtml(L.join("\n"));
}

/** Operator chats: env TELEGRAM_CHAT_ID plus explicit fallback so alerts/Q&A keep working if the env var is unreadable at runtime. */
export const OPERATOR_CHAT_IDS: [string, ...string[]] = ["6393450326"];
export function operatorChatId(): string {
  const env = process.env["TELEGRAM_CHAT_ID"]?.trim();
  return env || OPERATOR_CHAT_IDS[0];
}
export function isOperatorChat(chatId: string | number): boolean {
  const id = String(chatId).trim();
  const env = process.env["TELEGRAM_CHAT_ID"]?.trim();
  return (!!env && id === env) || OPERATOR_CHAT_IDS.includes(id);
}

/** Webhook secret seed: direct bot token (survives workspace moves) first, connector key as fallback. */
export function telegramWebhookSeed(): string | undefined {
  return process.env["TELEGRAM_BOT_TOKEN"]?.trim() || process.env["TELEGRAM_API_KEY"] || undefined;
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<{ status: "SENT" | "FAILED" | "PENDING"; note: string }> {
  const bot = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const lk = process.env["LOVABLE_API_KEY"], tk = process.env["TELEGRAM_API_KEY"];
  if (!chatId || (!bot && (!lk || !tk))) return { status: "PENDING", note: `Telegram not configured (${[!bot && !tk && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_CHAT_ID"].filter(Boolean).join(", ")} missing)` };
  try {
    const deliver = async (message: string, html: boolean) => {
    const body0 = JSON.stringify({ chat_id: chatId, text: message, ...(html ? { parse_mode: "HTML" } : {}), disable_web_page_preview: true });
    const r = bot
      ? await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body0 })
      : await fetch(`${GATEWAY}/sendMessage`, {
          method: "POST", headers: { Authorization: `Bearer ${lk}`, "X-Connection-Api-Key": tk!, "Content-Type": "application/json" }, body: body0,
        });
    const body = await r.text();
    let payload: { ok?: boolean; description?: string; error_code?: number } | null = null;
    try { payload = JSON.parse(body); } catch { /* Preserve provider response below. */ }
    const success = r.ok && payload?.ok === true;
    if (!success) console.error(`[telegram] provider rejected message [${r.status}]: ${body}`);
    return { success, status: payload?.error_code ?? r.status, body, description: payload?.description ?? body };
    };
    const first = await deliver(limitTelegramHtml(text), true);
    if (first.success) return { status: "SENT", note: "ok" };
    // Retry only an explicit HTML/entity parsing rejection, never auth/quota/network failures.
    if (first.status === 400 && /can't parse entities|cannot parse entities|unsupported start tag|can't find end tag/i.test(first.description)) {
      const fallback = await deliver(telegramHtmlToPlainText(text), false);
      if (fallback.success) return { status: "SENT", note: "ok (plain-text fallback)" };
      return { status: "FAILED", note: `[${fallback.status}] ${fallback.body.slice(0, 300)}` };
    }
    return { status: "FAILED", note: `[${first.status}] ${first.body.slice(0, 300)}` };
  } catch (e) { return { status: "FAILED", note: (e as Error).message }; }
}
