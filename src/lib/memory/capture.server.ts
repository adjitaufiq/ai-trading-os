// Phase 4A capture (server-only): copy the current Engine Host snapshot + journal into append-only cloud memory.
// Insert-only with ignoreDuplicates; never updates or deletes. Never writes to the engine host.
import { EngineHostClient } from "@/core/enginehost/client";
import type { JournalTrade } from "@/engine/journal/types";
import { captureEngineEvents } from "@/lib/events/events.server";
import { syncRelayHealth } from "@/lib/engineStatus/relay.server";
import { bundleToMemoryRow, demoRecordToRow, tradeToRow } from "./mappers";
import type { DemoTradeRecord } from "@/core/execution/demo/types";

function engineUrl(): string | null {
  // Private capture URL (server-only). Never the dashboard's VITE_ENGINE_HOST_URL, which may point at the
  // public sanitized view proxy (account/trades stripped) and would silently empty the journal capture.
  const v = process.env["ENGINE_HOST_CAPTURE_URL"];
  return v && v.trim() ? v.trim() : null;
}

export async function captureEngineMemory() {
  // ENGINE ONLINE/OFFLINE alerts come only from the status relay heartbeat (stale threshold = debounce),
  // never from a direct fetch to an Engine Host URL.
  const health = await syncRelayHealth(Date.now());
  const url = engineUrl();
  if (!url) return { ok: false as const, error: "ENGINE_HOST_NOT_CONFIGURED", health };
  const client = new EngineHostClient({ baseUrl: url, timeoutMs: 10_000 });
  const snap = await client.snapshots();
  if (!snap.ok) return { ok: false as const, error: `ENGINE_HOST ${snap.error}`, health };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const rows = snap.envelope.data.bundles.map(bundleToMemoryRow).filter((x) => x !== null);
  const trades: JournalTrade[] = snap.envelope.data.bundles.flatMap((b) => [...b.trades] as JournalTrade[]);
  const tradeRows = [...new Map(trades.map((t) => [t.tradeId, tradeToRow(t)])).values()];
  // Stage 10 demo lab records (closed demo orders only); absent/disabled demo lab ⇒ nothing added.
  let demoEvents: { type: string; signalId: string | null; symbol: string | null; at: number }[] = [];
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/v1/engine/demo`);
    const d = r.ok ? (((await r.json()) as { data?: { records?: DemoTradeRecord[]; recentEvents?: typeof demoEvents } }).data ?? {}) : {};
    const recs = d.records ?? []; demoEvents = d.recentEvents ?? [];
    for (const rec of recs) { const row = demoRecordToRow(rec); if (row) tradeRows.push(row); }
  } catch { /* demo lab unreachable: paper capture continues */ }

  if (rows.length) {
    const { error } = await supabaseAdmin.from("engine_memory").upsert(rows, { onConflict: "symbol,m5_close_at", ignoreDuplicates: true });
    if (error) return { ok: false as const, error: `MEMORY_WRITE ${error.message}` };
  }
  if (tradeRows.length) {
    const { error } = await supabaseAdmin.from("engine_trades").upsert(tradeRows as never, { onConflict: "trade_id", ignoreDuplicates: true });
    if (error) return { ok: false as const, error: `TRADES_WRITE ${error.message}` };
  }
  // Proof-of-life events + notifications: never fails the memory capture.
  let events: unknown = null;
  try { events = await captureEngineEvents(url, snap.envelope.data.bundles, demoEvents); } catch (e) { events = { error: (e as Error).message }; }
  return { ok: true as const, events, memory_rows: rows.length, trades_seen: tradeRows.length };
}
