import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Radar, MessageSquare, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createThread, threadsQueryKey } from "@/lib/assistant/threads";
import { supabase } from "@/integrations/supabase/client";
import { TradeReviewPanel } from "@/components/TradeReviewPanel";
import { PerformancePanel } from "@/components/PerformancePanel";
import { DemoLabPanel } from "@/components/DemoLabPanel";
import { EngineEventsPanel } from "@/components/EngineEventsPanel";
import { ExecutionControlPanel } from "@/components/ExecutionControlPanel";
import { journalIntelligence, type Group, type TradeFact } from "@/lib/memory/analytics";

export const Route = createFileRoute("/_authenticated/assistant/")({
  component: AssistantHome,
  head: () => ({ meta: [
    { title: "Journal & Pengawasan — Personal AI Trading OS" },
    { name: "description", content: "Journal intelligence, review trade, dan pengawasan engine untuk operator Trading OS." },
    { property: "og:title", content: "Journal & Pengawasan — Personal AI Trading OS" },
    { property: "og:description", content: "Ringkasan historis trade, review, dan status engine tanpa keputusan trading dari AI." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
});

function Table({ title, rows }: { title: string; rows: Group[] }) {
  return <div className="rounded border border-border p-3">
    <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
    {rows.length === 0 ? <p className="text-xs text-muted-foreground">Belum ada data.</p> :
      <table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th>Grup</th><th>Trade</th><th>Win%</th><th>Avg R</th></tr></thead>
        <tbody>{rows.slice(0, 6).map((g) => <tr key={g.key}><td className="truncate pr-2">{g.key}</td><td>{g.trades}</td><td>{Math.round(g.winRate * 100)}%</td><td>{g.avgR ?? "—"}</td></tr>)}</tbody></table>}
  </div>;
}

function AssistantHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (scope: string, topic: string) => {
    setBusy(true); setError(null);
    try {
      const thread = await createThread(scope, topic);
      await qc.invalidateQueries({ queryKey: threadsQueryKey });
      await navigate({ to: "/assistant/$threadId", params: { threadId: thread.id } });
    } catch (e) { setError(e instanceof Error ? e.message : "Percakapan belum bisa dibuka."); }
    finally { setBusy(false); }
  };
  const { data } = useQuery({
    queryKey: ["journal-intel"],
    queryFn: async () => {
      void supabase.rpc("log_engine_access", { _scope: "journal_intelligence" });
      const [t, m] = await Promise.all([
        supabase.from("engine_trades").select("trade_id,symbol,result,r_multiple,profit_loss_usd,regime,approach,location,trigger_pattern,failure_category,data_source,opened_at").limit(1000),
        supabase.from("engine_memory").select("id", { count: "exact", head: true }),
      ]);
      return { intel: journalIntelligence((t.data ?? []) as TradeFact[]), memoryCount: m.count ?? 0 };
    },
  });
  return <div className="assistant-reports min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
    <div className="flex flex-col items-center gap-3 py-3 text-center">
      <Radar className="size-10 text-bull" aria-hidden />
      <h2 className="text-lg font-semibold">Cockpit Analis</h2>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {[["XAUUSD", "RADAR_EXPLAIN", "Chat XAUUSD"], ["BTCUSD", "RADAR_EXPLAIN", "Chat BTCUSD"], ["ENGINE", "ENGINE_HEALTH", "Engine Host"], ["KNOWLEDGE", "REGIME", "Knowledge Base"]].map(([scope, topic, label]) =>
          <Button key={scope} variant="outline" className="h-12 justify-start" disabled={busy} onClick={() => start(scope, topic)}><MessageSquare className="text-bull" />{label}</Button>)}
      </div>
      {error && <p role="alert" className="text-sm text-warn">{error}</p>}
    </div>
    <details className="group border-t border-border" open>
      <summary className="flex cursor-pointer list-none items-center justify-between py-4 text-sm font-semibold">Journal Intelligence<ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" /></summary>
    {data && <section className="mx-auto w-full max-w-3xl space-y-3 pb-4">
      <h2 className="text-sm font-semibold">Journal Intelligence (REAL_MT5, deskriptif)</h2>
      <p className="text-xs text-muted-foreground">Memory tersimpan: {data.memoryCount} snapshot · Trade: {data.intel.overall?.trades ?? 0} · Avg R: {data.intel.overall?.avgR ?? "—"}{data.intel.sample_note ? ` · ${data.intel.sample_note}` : ""}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Table title="Hasil per regime" rows={data.intel.by_regime} />
        <Table title="Hasil per approach" rows={data.intel.by_approach} />
        <Table title="Kualitas setup (lokasi + trigger)" rows={data.intel.by_setup} />
        <div className="rounded border border-border p-3"><h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Pola kegagalan</h3>
          {data.intel.failure_patterns.length ? data.intel.failure_patterns.map((f) => <p key={f.category} className="text-xs">{f.category}: {f.count}</p>) : <p className="text-xs text-muted-foreground">Belum ada loss.</p>}</div>
      </div>
    </section>}
    </details>
    {[
      ["Performance Intelligence", <PerformancePanel key="performance" />],
      ["Trade Review", <TradeReviewPanel key="review" />],
      ["Execution Control & Audit", <ExecutionControlPanel key="control" />],
      ["Engine Proof of Life", <EngineEventsPanel key="events" />],
      ["Demo Execution Lab", <DemoLabPanel key="demo" />],
    ].map(([label, panel]) => <details key={String(label)} className="group border-t border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-4 text-sm font-semibold">{label}<ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" /></summary>
      <div className="min-w-0 pb-5">{panel}</div>
    </details>)}
    </div>
  </div>;
}
