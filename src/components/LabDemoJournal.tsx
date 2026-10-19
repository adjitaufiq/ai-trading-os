import { LAB_LABELS, type LabStrategy } from "@/core/lab/strategies";
import { demoHourly, demoModeRanking, demoStats, mapRunnerTrade } from "@/core/lab/demo/demoJournal";
import { useLabDemoJournal } from "@/hooks/use-lab-demo-journal";
import { LabTradeHistory } from "./LabTradeHistory";

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const time = (t: number | string) => new Date(t).toLocaleString("id-ID", { hour12: false, timeZone: "Asia/Jakarta" });
const label = (s: string) => LAB_LABELS[s as LabStrategy] ?? s;

/** MT5 DEMO view inside the existing Journal: broker-recorded rows only, separate from Paper. */
export function LabDemoJournal() {
  const j = useLabDemoJournal(true);
  if (j.status === "LOADING") return <p className="mt-2 text-sm text-muted-foreground">Memuat jurnal MT5 DEMO…</p>;
  if (j.status === "LOGIN_REQUIRED") return <p className="mt-2 text-sm text-warn">Masuk sebagai operator untuk melihat jurnal MT5 DEMO.</p>;
  if (j.status === "ERROR") return <p className="mt-2 text-sm text-warn break-words">Jurnal MT5 DEMO gagal dibaca: {j.error}</p>;
  const views = j.trades.map(mapRunnerTrade);
  const rows = views.flatMap((v) => (v.row ? [v.row] : []));
  const meta = Object.fromEntries(views.map((v) => [v.raw.signalId, v.meta]));
  const st = demoStats(j.trades), rank = demoModeRanking(j.trades), hours = demoHourly(j.trades);
  const others = views.filter((v) => !v.row);
  return <div data-testid="lab-demo-journal" className="mt-2 space-y-3">
    <div className="rounded border border-border p-2 text-xs" role="status">
      {j.sync.length === 0 ? <span className="text-warn">Belum ada data dari VPS · sinkronisasi jurnal belum tersambung</span> : j.sync.map((s) => {
        const age = (Date.now() - new Date(s.last_received_at).getTime()) / 60_000;
        return <div key={s.agent_id} className="break-words">
          <span className={age < 5 ? "text-bull" : "text-warn"}>{s.agent_id} · terakhir diterima {time(s.last_received_at)}{age >= 5 ? " · BASI" : ""}</span>
          <span className="text-muted-foreground"> · {s.runner_version} · {s.armed ? "ARMED" : "SHADOW"} · fase {s.phase} · rekonsiliasi {s.reconciliation_clean ? "bersih" : "belum bersih"}{s.block_reason ? ` · blok ${s.block_reason}` : ""} · {s.trades_count} trade</span>
        </div>; })}
    </div>
    {j.status === "EMPTY" ? <p className="text-sm text-muted-foreground">Belum ada transaksi MT5 DEMO tercatat.</p> : <>
      <div className="grid grid-cols-2 gap-1 text-center text-[11px] sm:grid-cols-4">
        {[["Closed final", String(st.closed)], ["Net final (broker)", usd(st.net)], ["Closed sementara", String(st.provisional)], ["P/L sementara", st.provisionalNet == null ? "n/a" : `${usd(st.provisionalNet)} · biaya belum lengkap`], ["Win rate", st.winRate == null ? "—" : `${Math.round(st.winRate * 100)}%`], ["Expectancy", st.expectancy == null ? "—" : usd(st.expectancy)],
          ["Profit factor", st.profitFactor == null ? "—" : st.profitFactor.toFixed(2)], ["Max DD", `$${st.maxDrawdown.toFixed(2)}`], ["Loss beruntun", String(st.maxLossStreak)], ["Slippage rata2", st.avgSlippagePoints == null ? "n/a" : `${st.avgSlippagePoints.toFixed(1)} pt`],
          ["Komisi", usd(st.commission)], ["Swap", usd(st.swap)], ["Open (floating n/a)", String(st.open)], ["Reject / Shadow", `${st.rejected} / ${st.shadow}`]].map(([k, v]) =>
          <div key={k} className="rounded bg-muted p-1.5"><div className="text-muted-foreground">{k}</div><div className="font-mono font-semibold">{v}</div></div>)}
      </div>
      <div className="rounded border border-border p-2 text-xs"><div className="font-semibold uppercase text-muted-foreground">Ranking mode · DEMO · hanya trade final</div>
        {rank.length === 0 ? <div className="text-muted-foreground">Belum ada trade closed.</div> : rank.map((r, i) => <div key={r.strategy} className="flex justify-between gap-2"><span>{i + 1}. {label(r.strategy)} · {r.closed} trade · WR {r.winRate == null ? "—" : `${Math.round(r.winRate * 100)}%`}</span><span className={`font-mono ${r.net >= 0 ? "text-bull" : "text-bear"}`}>{usd(r.net)}</span></div>)}</div>
      <div className="rounded border border-border p-2 text-xs"><div className="font-semibold uppercase text-muted-foreground">Jam (WIB) · golden hours</div>
        {hours.length === 0 ? <div className="text-muted-foreground">Belum ada data.</div> : hours.map((h) => <div key={h.hour} className="flex justify-between"><span>{String(h.hour).padStart(2, "0")}:00 · {h.n} trade{h.conclusive ? "" : " · belum konklusif"}</span><span className={`font-mono ${h.net >= 0 ? "text-bull" : "text-bear"}`}>{usd(h.net)}</span></div>)}</div>
      <LabTradeHistory trades={rows} meta={meta} floatingUnavailable />
      {others.length > 0 && <div className="rounded border border-border p-2 text-xs"><div className="font-semibold uppercase text-muted-foreground">Ditolak / Shadow / Pending / Unknown / Closed sementara ({others.length})</div>
        <ul className="divide-y divide-border">{others.slice(0, 50).map((v) => <li key={v.raw.signalId} className="py-1 break-words"><b>{v.bucket}</b> · {v.raw.symbol} {v.raw.side} · {label(v.raw.strategy)} · {time(v.raw.openedAt)}<div className="text-muted-foreground">{v.meta}</div></li>)}</ul></div>}
    </>}
  </div>;
}
