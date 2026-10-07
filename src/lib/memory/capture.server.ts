// Phase 4A capture (server-only): copy the current Engine Host snapshot + journal into append-only cloud memory.
// Insert-only with ignoreDuplicates; never updates or deletes. Never writes to the engine host.
import { EngineHostClient } from "@/core/enginehost/client";
import type { JournalTrade } from "@/engine/journal/types";
import { bundleToMemoryRow, tradeToRow } from "./mappers";

function engineUrl(): string | null {
  const v = (import.meta.env["VITE_ENGINE_HOST_URL"] as string | undefined) ?? process.env["VITE_ENGINE_HOST_URL"];
  return v && v.trim() ? v.trim() : null;
}

export async function captureEngineMemory() {
  const url = engineUrl();
  if (!url) return { ok: false as const, error: "ENGINE_HOST_NOT_CONFIGURED" };
  const client = new EngineHostClient({ baseUrl: url, timeoutMs: 10_000 });
  const snap = await client.snapshots();
  if (!snap.ok) return { ok: false as const, error: `ENGINE_HOST ${snap.error}` };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const rows = snap.envelope.data.bundles.map(bundleToMemoryRow).filter((x) => x !== null);
  const trades: JournalTrade[] = snap.envelope.data.bundles.flatMap((b) => [...b.trades] as JournalTrade[]);
  const tradeRows = [...new Map(trades.map((t) => [t.tradeId, tradeToRow(t)])).values()];

  if (rows.length) {
    const { error } = await supabaseAdmin.from("engine_memory").upsert(rows, { onConflict: "symbol,m5_close_at", ignoreDuplicates: true });
    if (error) return { ok: false as const, error: `MEMORY_WRITE ${error.message}` };
  }
  if (tradeRows.length) {
    const { error } = await supabaseAdmin.from("engine_trades").upsert(tradeRows as never, { onConflict: "trade_id", ignoreDuplicates: true });
    if (error) return { ok: false as const, error: `TRADES_WRITE ${error.message}` };
  }
  return { ok: true as const, memory_rows: rows.length, trades_seen: tradeRows.length };
}
