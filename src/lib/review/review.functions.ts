// Phase 5A — AI Trade Review (operator-only). Deterministic compliance + LLM performance-analyst narrative,
// stored once per (trade_id, review_version) in append-only trade_reviews. Never signals, never changes rules.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { TRADE_REVIEW_VERSION, complianceChecks, overallStatus, reviewFacts, stateAt, type ReviewState, type ReviewTrade } from "./compliance";

const PROMPT = `PERAN: Performance Analyst untuk paper trade yang SUDAH DITUTUP. Bahasa Indonesia santai, ringkas (≤220 kata), markdown.
ATURAN: pakai HANYA FACTS dan COMPLIANCE di bawah; jangan mengarang angka; jangan hitung indikator; jangan beri sinyal BUY/SELL atau saran entry berikutnya; jangan usulkan perubahan aturan/parameter engine; sistem MONITOR_ONLY.
FORMAT:
1. **Konteks setup** (regime, approach, lokasi/trigger, bias & decision engine saat entry)
2. **Keselarasan timeframe** (H4/H1 state saat entry)
3. **Hasil** (result, R, alasan close)
4. **Faktor sukses/gagal** (dari failure_category, excursion, decision_trace — sebut "tidak tercatat" bila kosong)
5. **Kepatuhan aturan** (ringkas status tiap check)
Tutup dengan: "Review deskriptif, bukan sinyal dan bukan perubahan aturan."`;

export const generateTradeReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tradeId: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isOp } = await supabase.rpc("is_engine_operator", { _user_id: userId });
    if (!isOp) throw new Error("Forbidden");

    const { data: existing } = await supabase.from("trade_reviews").select("id").eq("trade_id", data.tradeId).eq("review_version", TRADE_REVIEW_VERSION).maybeSingle();
    if (existing) return { ok: true as const, alreadyReviewed: true };

    const { data: trade, error } = await supabase.from("engine_trades").select("*").eq("trade_id", data.tradeId).maybeSingle();
    if (error || !trade) throw new Error("Trade tidak ditemukan");
    const t = trade as unknown as ReviewTrade;
    const from = new Date(Date.parse(t.opened_at) - 20 * 60_000).toISOString();
    const { data: mem } = await supabase.from("engine_memory")
      .select("m5_close_at,regime,approach,bias,market_phase,h4_state,h1_state,setup,decision,confidence,risk,support,resistance,reasons,invalidation")
      .eq("symbol", t.symbol).gte("m5_close_at", from).lte("m5_close_at", t.closed_at).limit(1000);
    const rows = (mem ?? []) as ReviewState[];
    const atOpen = stateAt(rows, t.opened_at), atClose = stateAt(rows, t.closed_at);
    const checks = complianceChecks(t, atOpen);
    const status = overallStatus(checks);
    const facts = reviewFacts(t, atOpen, atClose);

    const { selectLlmAdapter } = await import("@/lib/assistant/llm/gateway.server");
    const { streamText } = await import("ai");
    const adapter = selectLlmAdapter();
    if (!adapter) throw new Error("AI belum dikonfigurasi");
    const sel = adapter.create(getRequest(), "reasoning");
    const result = streamText({
      model: sel.model,
      instructions: PROMPT,
      prompt: `FACTS:\n${JSON.stringify(facts)}\n\nCOMPLIANCE (${status}):\n${JSON.stringify(checks)}`,
      ...(sel.providerOptions ? { providerOptions: sel.providerOptions } : {}),
    } as Parameters<typeof streamText>[0]);
    const narrative = (await result.text).trim();
    if (!narrative) throw new Error("AI tidak menghasilkan review");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: insErr } = await supabaseAdmin.from("trade_reviews").insert({
      trade_id: t.trade_id, review_version: TRADE_REVIEW_VERSION, symbol: t.symbol, compliance_status: status,
      compliance: checks as never, facts: facts as never, narrative, model: sel.modelId, created_by: userId,
    });
    if (insErr && insErr.code !== "23505") throw new Error("Gagal menyimpan review");
    return { ok: true as const, alreadyReviewed: false };
  });
