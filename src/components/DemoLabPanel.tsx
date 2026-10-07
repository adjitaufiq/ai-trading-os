import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DemoLabStatus } from "@/core/execution/demo/types";

// Phase 6A Demo Lab: read-only view of the VPS demo executor + operator kill switch. There is no order button.
const engineUrl = (import.meta.env["VITE_ENGINE_HOST_URL"] as string | undefined)?.trim();

export function DemoLabPanel() {
  const lab = useQuery({
    queryKey: ["demo-lab"], refetchInterval: 15_000,
    queryFn: async (): Promise<Partial<DemoLabStatus> | null> => {
      if (!engineUrl) return null;
      const r = await fetch(`${engineUrl.replace(/\/+$/, "")}/v1/engine/demo`);
      if (!r.ok) return null;
      return ((await r.json()) as { data: Partial<DemoLabStatus> }).data;
    },
  });
  const ctl = useQuery({
    queryKey: ["demo-control"],
    queryFn: async () => (await supabase.from("demo_execution_control").select("stopped,reason,updated_at").eq("id", 1).maybeSingle()).data,
  });
  const s = lab.data;
  const stopped = ctl.data?.stopped !== false;
  const lim = (n: number | undefined, d: number) => (n ?? d) >= 1000 ? "∞" : String(n ?? d);
  const c = s?.capital;
  const money = (n: number | null | undefined) => n === null || n === undefined ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${c?.currency ?? ""}`;
  return <section className="mx-auto w-full max-w-3xl space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">Demo Lab (Stage 10 DEMO, akun demo saja)</h2>
      <span className="text-xs text-muted-foreground">Kendali: panel Execution Control</span>
    </div>
    <div className="grid gap-2 text-xs sm:grid-cols-3">
      <div className="rounded border border-border p-2">Saklar: <b>{stopped ? "STOPPED" : "RUNNING"}</b></div>
      <div className="rounded border border-border p-2">Mode VPS: <b>{s?.mode ?? "tidak terbaca"}</b></div>
      <div className="rounded border border-border p-2">Akun: <b>{s?.account ? (s.account.ok ? `DEMO ${s.account.login} · ${s.account.server}` : `BLOCKED ${s.account.reason ?? ""}`) : "—"}</b></div>
      <div className="rounded border border-border p-2">Posisi terbuka: <b>{s?.openPositions ?? "—"}</b> / {lim(s?.profile?.maxOpenPositions, 1)}</div>
      <div className="rounded border border-border p-2">Trade hari ini: <b>{s?.tradesToday ?? "—"}</b> / {lim(s?.profile?.maxTradesPerDay, 5)}</div>
      <div className="rounded border border-border p-2">Loss harian: <b>{s?.dailyLossPercent ?? "—"}%</b> / {s?.profile?.maxDailyLossPercent ?? 2}%</div>
    </div>
    <div className="grid gap-2 text-xs sm:grid-cols-4">
      <div className="rounded border border-border p-2">Modal awal: <b>{money(c?.startBalance)}</b></div>
      <div className="rounded border border-border p-2">Balance: <b>{money(c?.balance)}</b></div>
      <div className="rounded border border-border p-2">Equity: <b>{money(c?.equity)}</b></div>
      <div className="rounded border border-border p-2">Net P/L: <b>{money(c?.netPnl)}</b></div>
    </div>
    <div className="rounded border border-border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Order demo</h3>
      {!s?.records?.length ? <p className="text-xs text-muted-foreground">Belum ada order demo.</p> :
        <table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th>Waktu</th><th>Simbol</th><th>Arah</th><th>Lot</th><th>Eksekusi</th><th>Hasil</th></tr></thead>
          <tbody>{[...s.records].reverse().slice(0, 20).map((r) => <tr key={r.tradeId}>
            <td>{new Date(r.sentAt).toISOString().slice(5, 16).replace("T", " ")}</td><td>{r.symbol}</td><td>{r.direction}</td><td>{r.volume}</td>
            <td>{r.executionResult}</td><td>{r.outcome ? `${r.outcome} ${r.profitLossUSD}` : "terbuka"}</td></tr>)}</tbody></table>}
    </div>
    <div className="rounded border border-border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Log eksekusi</h3>
      {!s?.recentEvents?.length ? <p className="text-xs text-muted-foreground">Belum ada event.</p> :
        <ul className="space-y-1 font-mono text-[11px]">{[...s.recentEvents].reverse().slice(0, 15).map((e, i) =>
          <li key={i}>{new Date(e.at).toISOString().slice(11, 19)} {e.type} {e.symbol ?? ""} {e.detail ?? ""}</li>)}</ul>}
    </div>
    <p className="text-xs text-muted-foreground">Order hanya dikirim otomatis oleh VPS saat engine READY + Risk APPROVED + plan valid, ke akun demo yang di-whitelist. Bukan sinyal untuk akun real. Akun real tetap MONITOR_ONLY.</p>
  </section>;
}
