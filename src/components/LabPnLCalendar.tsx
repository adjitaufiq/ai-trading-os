import { useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LabTrade } from "@/core/lab/labLedger";
import { getMonthCalendar, wibDay, type HistoryMarket } from "@/core/lab/tradeHistory";

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const DOW = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const short = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}`;

export function LabPnLCalendar({ trades, market, selected, onSelect }: { trades: readonly LabTrade[]; market: HistoryMarket; selected: string | null; onSelect: (d: string | null) => void }) {
  const today = wibDay(Date.now());
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));
  const [open, setOpen] = useState(true);
  const cal = getMonthCalendar(trades, ym.y, ym.m, market);
  const shift = (d: number) => setYm(({ y, m }) => { const n = m + d; return n < 1 ? { y: y - 1, m: 12 } : n > 12 ? { y: y + 1, m: 1 } : { y, m: n }; });
  const wr = cal.wins + cal.losses ? Math.round((cal.wins / (cal.wins + cal.losses)) * 100) : 0;
  return <div data-testid="lab-pnl-calendar" className="mt-3 rounded-lg border border-border bg-card p-2">
    <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-1 text-sm font-semibold">
      <span>🗓️ Kalender P/L · <span className={cal.net >= 0 ? "text-bull" : "text-bear"}>{usd(cal.net)}</span></span>
      <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <>
      <div className="mt-2 flex items-center justify-between">
        <Button size="icon" variant="ghost" aria-label="Bulan sebelumnya" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm font-semibold">{MONTHS[ym.m - 1]} {ym.y}</span>
        <Button size="icon" variant="ghost" aria-label="Bulan berikutnya" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" /></Button>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 text-center text-[11px] sm:grid-cols-4">
        <div className="rounded bg-muted p-1.5"><div className="text-muted-foreground">Net bulan</div><div className={`font-mono font-semibold ${cal.net >= 0 ? "text-bull" : "text-bear"}`}>{usd(cal.net)}</div></div>
        <div className="rounded bg-muted p-1.5"><div className="text-muted-foreground">Hari cuan / rugi</div><div className="font-mono font-semibold"><span className="text-bull">{cal.winDays}</span> / <span className="text-bear">{cal.lossDays}</span></div></div>
        <div className="rounded bg-muted p-1.5"><div className="text-muted-foreground">Total trade</div><div className="font-mono font-semibold">{cal.trades}</div></div>
        <div className="rounded bg-muted p-1.5"><div className="text-muted-foreground">Win rate</div><div className="font-mono font-semibold">{wr}% <span className="text-muted-foreground">({cal.wins}W {cal.losses}L)</span></div></div>
      </div>
      {cal.best && <div className="mt-1 flex justify-between px-1 text-[11px] text-muted-foreground"><span>Terbaik tgl {cal.best.date}: <span className="text-bull">{usd(cal.best.net)}</span></span>{cal.worst && cal.worst.net < 0 && <span>Terburuk tgl {cal.worst.date}: <span className="text-bear">{usd(cal.worst.net)}</span></span>}</div>}
      <div className="mt-2 grid grid-cols-7 gap-1 text-center">
        {DOW.map((d) => <div key={d} className="text-[10px] font-semibold text-muted-foreground">{d}</div>)}
        {Array.from({ length: cal.leading }, (_, i) => <div key={`b${i}`} />)}
        {cal.cells.map((c) => {
          const tone = c.trades === 0 ? "border-border/40 bg-transparent" : c.net > 0 ? "border-bull/40 bg-bull/15" : "border-bear/40 bg-bear/15";
          const ring = selected === c.day ? "ring-2 ring-primary" : c.day === today ? "ring-1 ring-warn" : "";
          return <button key={c.day} type="button" disabled={c.trades === 0} onClick={() => onSelect(selected === c.day ? null : c.day)}
            className={`flex min-h-[52px] flex-col items-center justify-start rounded-md border p-0.5 ${tone} ${ring} disabled:opacity-60`}>
            <span className="self-start pl-0.5 text-[10px] text-muted-foreground">{c.date}</span>
            {c.trades > 0 && <><span className={`font-mono text-[11px] font-bold leading-tight ${c.net > 0 ? "text-bull" : "text-bear"}`}>{short(c.net)}</span><span className="text-[9px] text-muted-foreground">{c.wins}W {c.losses}L</span></>}
          </button>;
        })}
      </div>
    </>}
    {selected && <div className="mt-2 flex items-center justify-between rounded bg-muted px-2 py-1 text-xs">
      <span>Menampilkan: {selected.split("-").reverse().join("/")}</span>
      <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>✕ Semua tanggal</Button>
    </div>}
  </div>;
}
