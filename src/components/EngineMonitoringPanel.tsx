import { useQuery } from "@tanstack/react-query";
import type { EngineMonitoring } from "@/core/enginehost/monitoring";

// Phase 2B monitoring: read-only projection of GET /v1/engine/monitoring. No calculation, no order control.
const engineUrl = (import.meta.env["VITE_ENGINE_HOST_URL"] as string | undefined)?.trim();
const t = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(5, 16).replace("T", " ") : "—");
const age = (ms: number | null) => (ms === null ? "—" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}j`);
const STATUS_LABEL: Record<string, string> = { FRESH: "Normal", NO_NEW_CANDLE: "Belum ada candle baru", FEED_STOPPED: "Feed berhenti", NO_DATA: "Tidak ada data" };

export function EngineMonitoringPanel() {
  const q = useQuery({
    queryKey: ["engine-monitoring"], refetchInterval: 15_000,
    queryFn: async (): Promise<EngineMonitoring | null> => {
      if (!engineUrl) return null;
      try {
        const r = await fetch(`${engineUrl.replace(/\/+$/, "")}/v1/engine/monitoring`);
        return r.ok ? ((await r.json()) as { data: EngineMonitoring }).data : null;
      } catch { return null; }
    },
  });
  const m = q.data;
  const sh = m?.shadow as { active?: boolean | null; label?: string; prevented_today?: number } | undefined;
  return <section className="mx-auto w-full max-w-3xl space-y-3">
    <div className="rounded border-2 border-primary p-3 text-center">
      <div className="text-xs uppercase text-muted-foreground">Mode</div>
      <div className="text-lg font-bold">{sh?.label ?? "TIDAK TERBACA"}</div>
      {sh && <div className="text-xs text-muted-foreground">Order dicegah hari ini: {sh.prevented_today ?? 0}</div>}
    </div>
    <div className="grid gap-2 text-xs sm:grid-cols-3">
      <div className="rounded border border-border p-2">Engine: <b>{m ? m.engine_status : "OFFLINE / tidak terbaca"}</b></div>
      <div className="rounded border border-border p-2">Versi: <b>{m?.build.engine_version ?? "—"}</b> · Commit: <b>{m?.build.commit ?? "UNKNOWN"}</b></div>
      <div className="rounded border border-border p-2">Proses terakhir: <b>{t(m?.last_process_at)}</b></div>
      <div className="rounded border border-border p-2 sm:col-span-3">Error terakhir: <b>{m?.last_error ?? "—"}</b></div>
    </div>
    {m?.symbols.map((s) => <div key={s.symbol} className="rounded border border-border p-3 text-xs space-y-2">
      <div className="flex justify-between"><b>{s.symbol}</b><span>{s.engine.state} · feed {s.feed.alive ? "hidup" : "berhenti"}</span></div>
      <table className="w-full"><thead><tr className="text-left text-muted-foreground"><th>TF</th><th>Candle closed terakhir</th><th>Umur</th><th>Status</th></tr></thead>
        <tbody>{s.market_data.map((c) => <tr key={c.timeframe}><td>{c.timeframe}</td><td>{t(c.last_closed_at)}</td><td>{age(c.age_ms)}</td><td>{STATUS_LABEL[c.status] ?? c.status}</td></tr>)}</tbody></table>
      <div className="grid gap-1 sm:grid-cols-3">
        <div>ARENA: <b>{s.decision.arena ?? "—"}</b></div>
        <div>H4 Bias: <b>{s.decision.h4_bias ?? "—"}</b></div>
        <div>M1B: <b>{s.decision.m1b ?? "—"}</b></div>
        <div>Decision: <b>{s.decision.decision ?? "—"}</b></div>
        <div className="sm:col-span-2">Alasan: <b>{s.decision.reason ?? "—"}</b></div>
      </div>
    </div>)}
  </section>;
}
