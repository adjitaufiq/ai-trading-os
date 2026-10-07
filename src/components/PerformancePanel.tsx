import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { TradeFact } from "@/lib/memory/analytics";
import { performanceIntelligence, type PerfGroup, type ReviewFact } from "@/lib/review/performance";

function GroupTable({ title, rows }: { title: string; rows: PerfGroup[] }) {
  return <div className="rounded border border-border p-3">
    <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
    {rows.length === 0 ? <p className="text-xs text-muted-foreground">Belum ada data.</p> :
      <table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th>Grup</th><th>n</th><th>Win%</th><th>Avg R</th></tr></thead>
        <tbody>{rows.slice(0, 8).map((g) => <tr key={g.key} className={g.sufficient ? "" : "text-muted-foreground"}>
          <td className="truncate pr-2">{g.key}{g.sufficient ? "" : " *"}</td><td>{g.trades}</td><td>{Math.round(g.winRate * 100)}%</td><td>{g.avgR ?? "—"}</td></tr>)}</tbody></table>}
  </div>;
}

// Phase 5B: descriptive performance view over CLOSED paper trades + immutable reviews. No signals, no rule changes.
export function PerformancePanel() {
  const { data, error } = useQuery({
    queryKey: ["performance-intel"],
    queryFn: async () => {
      const [t, r] = await Promise.all([
        supabase.from("engine_trades").select("trade_id,symbol,result,r_multiple,profit_loss_usd,regime,approach,location,trigger_pattern,failure_category,data_source,opened_at").limit(2000),
        supabase.from("trade_reviews").select("trade_id,compliance_status,review_version").limit(5000),
      ]);
      if (t.error) throw t.error;
      return performanceIntelligence((t.data ?? []) as TradeFact[], (r.data ?? []) as ReviewFact[]);
    },
  });
  if (error) return <p className="mx-auto max-w-3xl text-xs text-destructive">Performance data tidak tersedia.</p>;
  if (!data) return null;
  const s = data.summary;
  return <section className="mx-auto w-full max-w-3xl space-y-3">
    <h2 className="text-sm font-semibold">Performance Intelligence ({data.data_source}, historis, deskriptif)</h2>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {[["Trade", s?.trades ?? 0], ["Win rate", s ? `${Math.round(s.winRate * 100)}%` : "—"], ["Avg R", s?.avgR ?? "—"], ["Total R", s?.totalR ?? "—"], ["Direview", `${data.reviewed_trades}/${s?.trades ?? 0}`]].map(([k, v]) =>
        <div key={k} className="rounded border border-border p-2"><p className="text-[10px] uppercase text-muted-foreground">{k}</p><p className="font-mono text-sm">{v}</p></div>)}
    </div>
    <p className="text-xs text-muted-foreground">{data.sample_note ?? "Sampel cukup untuk deskripsi awal."} * = grup di bawah {data.min_sample} trade, belum layak disimpulkan.{data.excluded_other_sources ? ` ${data.excluded_other_sources} trade sumber lain tidak dihitung.` : ""}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <GroupTable title="Regime analysis" rows={data.by_regime} />
      <GroupTable title="Approach analysis" rows={data.by_approach} />
      <GroupTable title="Compliance vs outcome" rows={data.compliance_vs_outcome} />
      <div className="rounded border border-border p-3"><h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Failure analysis</h3>
        {data.failure_distribution.length ? data.failure_distribution.map((f) => <p key={f.category} className="text-xs">{f.category}: {f.count} ({Math.round(f.share * 100)}% dari loss)</p>) : <p className="text-xs text-muted-foreground">Belum ada loss.</p>}</div>
    </div>
    <p className="text-[10px] text-muted-foreground">Data historis paper trade. Bukan sinyal, bukan perubahan aturan engine. MONITOR_ONLY.</p>
  </section>;
}
