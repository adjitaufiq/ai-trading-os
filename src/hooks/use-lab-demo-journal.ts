import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RunnerTrade } from "@/core/lab/demo/labDemoRunner";

export interface DemoSyncStatus { agent_id: string; runner_version: string | null; armed: boolean | null; phase: string | null; reconciliation_clean: boolean | null; block_reason: string | null; snapshot_at_ms: number; trades_count: number; last_received_at: string }
export interface DemoJournalState { status: "LOADING" | "READY" | "EMPTY" | "LOGIN_REQUIRED" | "ERROR"; trades: RunnerTrade[]; sync: DemoSyncStatus[]; error: string | null; fetchedAt: number | null }

/** Read-only MT5 DEMO journal (operator RLS). Polls only while enabled; no write path. */
export function useLabDemoJournal(enabled: boolean): DemoJournalState {
  const [s, setS] = useState<DemoJournalState>({ status: "LOADING", trades: [], sync: [], error: null, fetchedAt: null });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) { if (alive) setS({ status: "LOGIN_REQUIRED", trades: [], sync: [], error: null, fetchedAt: Date.now() }); return; }
      const [t, st] = await Promise.all([
        supabase.from("lab_demo_trades").select("payload").order("opened_at_ms", { ascending: false }).limit(1000),
        supabase.from("lab_demo_sync_status").select("*"),
      ]);
      if (!alive) return;
      if (t.error || st.error) { setS((p) => ({ ...p, status: "ERROR", error: (t.error ?? st.error)!.message, fetchedAt: Date.now() })); return; }
      const trades = (t.data ?? []).map((r) => r.payload as unknown as RunnerTrade);
      setS({ status: trades.length ? "READY" : "EMPTY", trades, sync: (st.data ?? []) as DemoSyncStatus[], error: null, fetchedAt: Date.now() });
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [enabled]);
  return s;
}
