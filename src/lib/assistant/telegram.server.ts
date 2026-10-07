// Telegram = mobile extension of the dashboard AI Assistant. Same persona (analystInstructions), same live context
// (buildLiveContext → AI Context Builder), same memory/journal/performance context. AI ≠ AUTHORITY:
// every fact line in an alert (symbol, direction, confidence, entry/SL/TP, execution result) is copied verbatim from
// the engine event; the LLM only writes the "Kenapa" explanation and can never change direction or create a signal.
import { generateText } from "ai";
import { analystInstructions } from "./analyst";
import { buildLiveContext } from "./context.server";
import { selectLlmAdapter } from "./llm/gateway.server";
import { buildMemoryContext } from "../memory/context.server";

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";
/** Max AI explanations per capture run (bounded work; remaining alerts use the deterministic template). */
export const AI_ALERTS_PER_RUN = 4;

export interface AlertEvent {
  symbol: string; event_type: string; stage: string | null; direction: string | null; confidence: number | null; reason: string;
  entry: number | null; stop_loss: number | null; take_profit: number | null; occurred_at: string;
  timeframe_context?: Record<string, unknown> | null; execution_result?: string | null; block_reason?: string | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function adminContext(scope: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [live, mem] = await Promise.all([buildLiveContext(scope), scope === "ENGINE" ? Promise.resolve("") : buildMemoryContext(supabaseAdmin as never, scope).catch(() => "MEMORY_CONTEXT: UNAVAILABLE")]);
  return mem ? `${live}\n\n=== ${mem}\nATURAN MEMORY: sebut ukuran sampel; jangan menyimpulkan dari sampel kecil; jangan usulkan perubahan aturan.` : live;
}

async function ask(scope: string, prompt: string, tier: "fast" | "medium"): Promise<string | null> {
  const adapter = selectLlmAdapter();
  if (!adapter) return null;
  const sel = adapter.create(new Request("http://internal/telegram"), tier);
  const live = await adminContext(scope);
  try {
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
  const prompt = `Engine baru saja mencatat event berikut (FAKTA, jangan diubah):\n${JSON.stringify(ev)}\n\nTulis penjelasan singkat untuk notifikasi HP (maks 6 bullet, Bahasa Indonesia santai, TANPA markdown tabel, tanpa heading):\n- Kenapa engine sampai ke event ini: pakai timeframe_context + reasons di LIVE_CONTEXT (H4/H1/M15/M5).\n${ev.event_type === "EXIT" ? "- Ringkas hasil trade dan kenapa TP/SL kena, plus 1 poin review kepatuhan bila ada di memory.\n" : ""}${ev.event_type === "BLOCKED" ? "- Jelaskan aturan yang memblokir (block_reason) dengan bahasa trader.\n" : ""}Jangan menyebut arah selain "${ev.direction ?? "-"}", jangan membuat entry/SL/TP baru, jangan menyarankan order.`;
  return ask(scope, prompt, "fast");
}

/** Q&A from the operator's phone: same persona + context as dashboard. */
export async function answerQuestion(text: string): Promise<string> {
  const up = text.toUpperCase();
  const scope = /XAU|GOLD|EMAS/.test(up) ? "XAUUSD" : /BTC|BITCOIN/.test(up) ? "BTCUSD" : /ENGINE|VPS|HEALTH|ONLINE|OFFLINE/.test(up) ? "ENGINE" : "KNOWLEDGE";
  const out = await ask(scope, `${text}\n\n(Jawab untuk dibaca di Telegram: ringkas, bullet, tanpa tabel.)`, "medium");
  return out ?? "AI sedang tidak tersedia. Data engine tetap jalan; coba lagi sebentar.";
}

const TITLES: Record<string, string> = { READY: "🚨 READY DETECTED", BLOCKED: "⛔ EXECUTION BLOCKED", ENGINE_OFFLINE: "🚨 ENGINE OFFLINE", ENGINE_ONLINE: "✅ ENGINE BACK ONLINE" };
export function alertHeadline(ev: { event_type: string; reason: string }): string {
  const t = ev.reason.toUpperCase();
  if (ev.event_type === "EXECUTION") return /REJECT|ERROR/.test(t) ? "⚠️ DEMO ORDER FAILED" : "🟢 DEMO ORDER OPENED";
  if (ev.event_type === "EXIT") return /\bTP\b|TAKE_PROFIT|TAKE PROFIT/.test(t) ? "✅ TP HIT" : /\bSL\b|STOP_LOSS|STOP LOSS/.test(t) ? "🔴 SL HIT" : "⏹ POSITION CLOSED";
  return TITLES[ev.event_type] ?? ev.event_type;
}

/** Facts (verbatim) + optional AI explanation. */
export function composeAlert(ev: AlertEvent, why: string | null): string {
  const tf = ev.timeframe_context ?? {};
  const L: string[] = [`<b>${alertHeadline(ev)}</b>`, "", `<b>${esc(ev.symbol)} ${esc(ev.direction ?? "")}</b>`.trim()];
  if (why) L.push("", "<b>Kenapa:</b>", esc(why));
  const ctx = ["h4", "h1", "m15", "m5"].map((k) => tf[k] ? `${k.toUpperCase()} ${String(tf[k])}` : null).filter(Boolean);
  if (ctx.length) L.push("", `<b>MTF:</b> ${esc(ctx.join(" · "))}`);
  if (ev.confidence !== null) L.push(`<b>Confidence:</b> ${ev.confidence}%`);
  if (tf["decision"]) L.push(`<b>Engine Decision:</b> ${esc(String(tf["decision"]))}`);
  if (ev.entry !== null || ev.stop_loss !== null) L.push(`<b>Entry</b> ${ev.entry ?? "-"} · <b>SL</b> ${ev.stop_loss ?? "-"} · <b>TP</b> ${ev.take_profit ?? "-"}`);
  if (ev.block_reason) L.push(`<b>Blocked:</b> ${esc(ev.block_reason)}`);
  L.push(`<b>Execution:</b> ${esc(ev.execution_result ?? (ev.event_type === "READY" ? "menunggu Risk/TradePlan/validasi demo" : `${ev.stage ?? "-"} · ${ev.reason}`))}`);
  L.push("", `<i>${esc(ev.occurred_at)} · DEMO lab · AI hanya menjelaskan</i>`);
  return L.join("\n").slice(0, 4000);
}

/** Operator chats: env TELEGRAM_CHAT_ID plus explicit fallback so alerts/Q&A keep working if the env var is unreadable at runtime. */
export const OPERATOR_CHAT_IDS = ["6393450326"];
export function operatorChatId(): string {
  const env = process.env["TELEGRAM_CHAT_ID"]?.trim();
  return env || OPERATOR_CHAT_IDS[0];
}
export function isOperatorChat(chatId: string | number): boolean {
  const id = String(chatId).trim();
  const env = process.env["TELEGRAM_CHAT_ID"]?.trim();
  return (!!env && id === env) || OPERATOR_CHAT_IDS.includes(id);
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<{ status: "SENT" | "FAILED" | "PENDING"; note: string }> {
  const lk = process.env["LOVABLE_API_KEY"], tk = process.env["TELEGRAM_API_KEY"];
  if (!lk || !tk || !chatId) return { status: "PENDING", note: `Telegram not configured (${[!tk && "TELEGRAM_API_KEY", !chatId && "TELEGRAM_CHAT_ID", !lk && "LOVABLE_API_KEY"].filter(Boolean).join(", ")} missing)` };
  try {
    const r = await fetch(`${GATEWAY}/sendMessage`, {
      method: "POST", headers: { Authorization: `Bearer ${lk}`, "X-Connection-Api-Key": tk, "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const body = await r.text();
    if (!r.ok) return { status: "FAILED", note: `[${r.status}] ${body.slice(0, 300)}` };
    return { status: "SENT", note: "ok" };
  } catch (e) { return { status: "FAILED", note: (e as Error).message }; }
}
