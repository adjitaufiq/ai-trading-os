// AI Trading Assistant streaming handler (server-only). AI ≠ AUTHORITY: explains KB + live Engine Host facts only.
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { knowledgeBaseText, KNOWLEDGE_BASE_VERSION } from "./knowledgeBase";
import { buildLiveContext } from "./context.server";
import { withLovableAiGatewayRunIdHeader } from "./gateway.server";
import { selectLlmAdapter } from "./llm/gateway.server";
import { buildMemoryContext } from "../memory/context.server";
import { briefingInstructions, extractPrice, isBriefingRequest } from "./briefing";
import { classifyIntent, tierForIntent } from "./routing";

function json(status: number, error: string) {
  return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
}

function instructions(scope: string, topic: string, live: string) {
  return `PERAN: Senior Trading Analyst yang menjelaskan keputusan Engine Host. Anda adalah "AI Trading Assistant" di dalam Personal AI Trading OS — asisten pengetahuan internal untuk Trading Engine, Radar, Market Structure, dan Paper Trading. Anda BUKAN chatbot umum.

ATURAN WAJIB:
1. Definisi/arti istilah: jawab HANYA dari KNOWLEDGE BASE di bawah. Sebutkan nama enum engine aslinya bila berbeda dari istilah user (mis. TRENDING = TREND_CONTINUATION). Jika istilah tidak ada di KB, katakan belum ada di knowledge base.
2. Kondisi sekarang ("apa yang terjadi sekarang", "kenapa NO SETUP", dll.): baca HANYA dari LIVE_CONTEXT. Sebutkan nilai aktual (regime, horizon, approach, events, status radar, level) dan waktu snapshot. Jika LIVE_CONTEXT UNAVAILABLE atau field null, katakan data belum tersedia — jangan mengarang angka.
3. Jangan pernah mencampur data simbol. Thread ini scope=${scope}${scope === "XAUUSD" || scope === "BTCUSD" ? `; hanya bahas data live ${scope}. Jika user menanyakan simbol lain, minta buka thread simbol tersebut.` : "."}
4. AI ≠ AUTHORITY: jangan menyarankan kirim order, jangan menghitung ulang indikator, jangan mengubah risiko, jangan membuat sinyal BUY/SELL sendiri. Sistem MONITOR_ONLY; semua trade adalah simulasi paper.
5. Bahasa: ikuti bahasa user (Bahasa Indonesia santai bila user pakai Indonesia, English bila English). Ringkas, terstruktur, pakai markdown dan bullet. Maksimal ~250 kata kecuali diminta detail.
6. Format jawaban kondisi live (baca AI_CONTEXT_PAYLOAD): (a) kondisi market sekarang, (b) kenapa engine memilih decision ini (pakai reasons), (c) kondisi apa yang akan mengubah keputusan (confirmation_needed / invalidation / key_levels), (d) apa yang ditunggu Radar. Jangan pernah override decision engine.

Topik thread: ${topic}

=== KNOWLEDGE BASE (${KNOWLEDGE_BASE_VERSION}) ===
${knowledgeBaseText()}

=== ${live}`;
}

export async function handleAssistantChat(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return json(401, "Silakan login dulu.");
  const url = process.env["SUPABASE_URL"]!, key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  const supabase = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
  const userId = claims?.claims?.sub;
  if (authErr || !userId) return json(401, "Sesi tidak valid, silakan login ulang.");

  let body: { threadId?: unknown; messages?: unknown };
  try { body = await request.json(); } catch { return json(400, "Request tidak valid."); }
  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const messages = Array.isArray(body.messages) ? (body.messages as UIMessage[]) : null;
  if (!threadId || !messages || messages.length === 0) return json(400, "Request tidak valid.");

  const { data: thread, error: tErr } = await supabase.from("assistant_threads").select("id, user_id, symbol, topic, title").eq("id", threadId).maybeSingle();
  if (tErr) return json(500, "Gagal membaca thread.");
  if (!thread || thread.user_id !== userId) return json(404, "Thread tidak ditemukan.");

  const last = messages[messages.length - 1]!;
  if (last.role === "user") {
    const { error } = await supabase.from("assistant_messages").upsert(
      { thread_id: threadId, user_id: userId, sdk_id: last.id, role: "user", parts: last.parts as never },
      { onConflict: "thread_id,sdk_id", ignoreDuplicates: true },
    );
    if (error) return json(500, "Gagal menyimpan pesan.");
    const text = last.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
    const patch: { updated_at: string; title?: string } = { updated_at: new Date().toISOString() };
    if (thread.title === "Percakapan baru" && text) patch.title = text.slice(0, 60);
    await supabase.from("assistant_threads").update(patch).eq("id", threadId);
  }

  const scope = thread.symbol ?? "KNOWLEDGE";
  const [liveCtx, memoryCtx] = await Promise.all([buildLiveContext(scope), scope === "ENGINE" ? Promise.resolve("") : buildMemoryContext(supabase, scope)]);
  const live = memoryCtx ? `${liveCtx}\n\n=== ${memoryCtx}\nATURAN MEMORY: boleh membandingkan kondisi sekarang dengan similar_past_states dan menjelaskan statistik journal; sebut ukuran sampel; jangan menyimpulkan dari sampel kecil; jangan pernah mengusulkan perubahan aturan engine atau optimasi otomatis.` : liveCtx;
  const lastText = last.role === "user" ? last.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") : "";
  const briefing = (scope === "XAUUSD" || scope === "BTCUSD") && isBriefingRequest(lastText);
  // Phase 4C: intent classifier picks the task tier; tier scales reasoning only, never permissions.
  const intent = classifyIntent(lastText, { briefing });
  const tier = tierForIntent(intent);
  const adapter = selectLlmAdapter();
  if (!adapter) return json(500, "AI belum dikonfigurasi.");
  const sel = adapter.create(request, tier);
  const result = streamText({
    model: sel.model,
    instructions: instructions(scope, thread.topic, live) + (briefing ? `\n\n${briefingInstructions(scope, extractPrice(liveCtx))}` : ""),
    messages: await convertToModelMessages(messages),
    abortSignal: request.signal,
    ...(sel.providerOptions ? { providerOptions: sel.providerOptions } : {}),
  } as Parameters<typeof streamText>[0]);

  const response = result.toUIMessageStreamResponse({
    originalMessages: messages,
    sendReasoning: true,
    onFinish: async ({ responseMessage }) => {
      const { error } = await supabase.from("assistant_messages").upsert(
        { thread_id: threadId, user_id: userId, sdk_id: responseMessage.id, role: "assistant", parts: responseMessage.parts as never },
        { onConflict: "thread_id,sdk_id" },
      );
      if (error) console.error("assistant message persist failed", error.message);
    },
    onError: (e) => {
      const msg = (e as { statusCode?: number; message?: string });
      if (msg?.statusCode === 402) return "Kredit AI habis. Tambah kredit di Settings → Plans & credits.";
      if (msg?.statusCode === 429) return "Terlalu banyak permintaan, coba lagi sebentar.";
      return "AI sedang tidak tersedia. Coba lagi nanti.";
    },
  });
  return sel.getRunId && sel.waitForRunId ? withLovableAiGatewayRunIdHeader(response, { getRunId: sel.getRunId, waitForRunId: sel.waitForRunId }) : response;
}
