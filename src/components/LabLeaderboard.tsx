import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LAB_LABELS } from "@/core/lab/strategies";
import { buildLabReport, formatLabReport, STACKING_OPEN_THRESHOLD } from "@/core/lab/labReport";
import type { LabRuntime } from "@/hooks/use-strategy-lab";

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const tone = (v: number) => (v >= 0 ? "text-bull" : "text-bear");
const MEDAL = ["🥇", "🥈", "🥉"];

export function LabLeaderboard({ lab }: { lab: LabRuntime }) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const r = buildLabReport(lab.state, lab.switches, now);
  const copy = async () => {
    try { await navigator.clipboard.writeText(formatLabReport(buildLabReport(lab.state, lab.switches, Date.now()))); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { alert("Gagal menyalin — izin clipboard ditolak browser."); }
  };
  return <div className="mt-3 rounded border border-border p-3" data-testid="lab-leaderboard">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><Trophy className="h-4 w-4" />Leaderboard realtime · PAPER</span>
      <Button size="sm" onClick={copy}>{copied ? "Tersalin ✓" : "📋 Salin Laporan untuk AI"}</Button>
    </div>
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      <span className="rounded bg-muted px-2 py-1">Closed <b>{r.closed}</b></span>
      <span className="rounded bg-muted px-2 py-1">Open <b>{r.open}</b></span>
      <span className={`rounded bg-muted px-2 py-1 ${tone(r.recent.pnl)}`}>3 jam: {r.recent.trades} trade · <b>{usd(r.recent.pnl)}</b></span>
    </div>
    <ol className="mt-2 divide-y divide-border">{r.rows.map((x, i) => <li key={x.strategy} className={`py-2 text-xs ${x.on ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="break-words font-semibold">{MEDAL[i] ?? `${i + 1}.`} {LAB_LABELS[x.strategy]}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${x.on ? "bg-bull/15 text-bull" : "bg-muted text-muted-foreground"}`}>{x.on ? "ON" : "OFF"}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-muted-foreground">
        <span>{x.trades} trade · <span className="text-bull">{x.wins}W</span>/<span className="text-bear">{x.losses}L</span> · WR {x.winRate == null ? "—" : `${(x.winRate * 100).toFixed(1)}%`}</span>
        <span className={tone(x.realized)}>{usd(x.realized)}</span>
        <span className={x.open > STACKING_OPEN_THRESHOLD ? "text-warn" : ""}>{x.open} open</span>
        <span className={tone(x.recentPnl)}>3j {usd(x.recentPnl)}</span>
      </div>
    </li>)}</ol>
    <div className="mt-2 space-y-1 rounded bg-muted/50 p-2 text-xs break-words" data-testid="lab-auto-review">
      <div className="font-semibold uppercase text-muted-foreground">Diagnostik otomatis</div>
      <div>Mesin cuan (ON): {r.leaders.length ? r.leaders.map((x) => `${LAB_LABELS[x.strategy]} ${usd(x.realized)}`).join(" & ") : "belum ada"}</div>
      <div>Paling merugikan (ON): {r.worstOn ? `${LAB_LABELS[r.worstOn.strategy]} ${usd(r.worstOn.realized)}` : "tidak ada"}</div>
      <div>Stacking &gt;{STACKING_OPEN_THRESHOLD} open: {r.stacking.length ? r.stacking.map((x) => `${LAB_LABELS[x.strategy]} (${x.open})`).join(", ") : "Tidak"}</div>
      <div>Mode OFF: {r.off.length ? r.off.map((m) => LAB_LABELS[m]).join(", ") : "tidak ada"}</div>
    </div>
  </div>;
}
