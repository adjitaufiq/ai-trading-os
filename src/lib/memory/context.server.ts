// Memory context for the assistant (server-only). Reads cloud memory as the signed-in user (RLS) and returns
// labelled, descriptive facts. The LLM compares; it never changes rules or creates signals.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { performanceIntelligence, type ReviewFact } from "../review/performance";
import { journalIntelligence, similarStates, type MemoryFact, type TradeFact } from "./analytics";

export async function buildMemoryContext(sb: SupabaseClient<Database>, scope: string): Promise<string> {
  const symbols = scope === "XAUUSD" || scope === "BTCUSD" ? [scope] : ["XAUUSD", "BTCUSD"];
  const [mem, tr, rv] = await Promise.all([
    sb.from("engine_memory").select("symbol,m5_close_at,regime,approach,decision,setup,bias,market_phase,confidence").in("symbol", symbols).order("m5_close_at", { ascending: false }).limit(2000),
    sb.from("engine_trades").select("trade_id,symbol,result,r_multiple,profit_loss_usd,regime,approach,location,trigger_pattern,failure_category,data_source,opened_at").in("symbol", symbols).order("opened_at", { ascending: false }).limit(1000),
    sb.from("trade_reviews").select("trade_id,compliance_status,review_version").in("symbol", symbols).limit(5000),
  ]);
  if (mem.error || tr.error) return "MEMORY_CONTEXT: UNAVAILABLE";
  const history = (mem.data ?? []) as MemoryFact[];
  const trades = (tr.data ?? []) as TradeFact[];
  const out = symbols.map((sym) => {
    const h = history.filter((x) => x.symbol === sym);
    const t = trades.filter((x) => x.symbol === sym);
    const current = h[0];
    return { symbol: sym, memory_rows: h.length, latest_state_at: current?.m5_close_at ?? null,
      similar_past_states: current ? similarStates(current, h, t) : [], journal: journalIntelligence(t),
      performance: performanceIntelligence(t, rv.error ? [] : ((rv.data ?? []) as ReviewFact[])) };
  });
  return `MEMORY_CONTEXT source=CLOUD_MEMORY (salinan Engine Host tiap M5; deskriptif saja, bukan aturan baru)\n${JSON.stringify(out)}`;
}
