import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { journalIntelligence, type Group, type TradeFact } from "@/lib/memory/analytics";

function Table({ title, rows }: { title: string; rows: Group[] }) {
  return (
    <div className="rounded border border-border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Belum ada data.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>Grup</th>
              <th>Trade</th>
              <th>Win%</th>
              <th>Avg R</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 6).map((g) => (
              <tr key={g.key}>
                <td className="truncate pr-2">{g.key}</td>
                <td>{g.trades}</td>
                <td>{Math.round(g.winRate * 100)}%</td>
                <td>{g.avgR ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function JournalIntelligencePanel() {
  const { data } = useQuery({
    queryKey: ["journal-intel"],
    queryFn: async () => {
      void supabase.rpc("log_engine_access", { _scope: "journal_intelligence" });
      const [t, m] = await Promise.all([
        supabase
          .from("engine_trades")
          .select(
            "trade_id,symbol,result,r_multiple,profit_loss_usd,regime,approach,location,trigger_pattern,failure_category,data_source,opened_at",
          )
          .limit(1000),
        supabase.from("engine_memory").select("id", { count: "exact", head: true }),
      ]);
      return {
        intel: journalIntelligence((t.data ?? []) as TradeFact[]),
        memoryCount: m.count ?? 0,
      };
    },
  });
  return <>
          {data && (
            <section className="mx-auto w-full max-w-3xl space-y-3 pb-4">
              <h2 className="text-sm font-semibold">Journal Intelligence (REAL_MT5, deskriptif)</h2>
              <p className="text-xs text-muted-foreground">
                Memory tersimpan: {data.memoryCount} snapshot · Trade:{" "}
                {data.intel.overall?.trades ?? 0} · Avg R: {data.intel.overall?.avgR ?? "—"}
                {data.intel.sample_note ? ` · ${data.intel.sample_note}` : ""}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Table title="Hasil per regime" rows={data.intel.by_regime} />
                <Table title="Hasil per approach" rows={data.intel.by_approach} />
                <Table title="Kualitas setup (lokasi + trigger)" rows={data.intel.by_setup} />
                <div className="rounded border border-border p-3">
                  <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                    Pola kegagalan
                  </h3>
                  {data.intel.failure_patterns.length ? (
                    data.intel.failure_patterns.map((f) => (
                      <p key={f.category} className="text-xs">
                        {f.category}: {f.count}
                      </p>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">Belum ada loss.</p>
                  )}
                </div>
              </div>
            </section>
          )}
  </>;
}
