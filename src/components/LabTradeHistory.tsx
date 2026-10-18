import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAB_LABELS } from "@/core/lab/strategies";
import type { LabTrade } from "@/core/lab/labLedger";
import { LabPnLCalendar } from "./LabPnLCalendar";
import { groupByDay, wibDay, type HistoryMarket, type HistoryResult } from "@/core/lab/tradeHistory";

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const px = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(3));
const time = (t: number) => new Date(t).toLocaleString("id-ID", { hour12: false, timeZone: "Asia/Jakarta" });
const dayLabel = (d: string) => { const [y, m, dd] = d.split("-"); const today = wibDay(Date.now()), yest = wibDay(Date.now() - 86_400_000); return `${dd}/${m}/${y}${d === today ? " · Hari ini" : d === yest ? " · Kemarin" : ""}`; };

const MARKETS: [HistoryMarket, string][] = [["ALL", "Semua market"], ["XAUUSD", "XAU"], ["BTCUSD", "BTC"]];
const RESULTS: [HistoryResult, string][] = [["ALL", "Semua"], ["PROFIT", "Profit"], ["LOSS", "Loss"], ["OPEN", "Masih open"]];

const PAGE = 10;

export function LabTradeHistory({ trades }: { trades: readonly LabTrade[] }) {
  const [market, setMarket] = useState<HistoryMarket>("ALL");
  const [result, setResult] = useState<HistoryResult>("ALL");
  const [day, setDay] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState<Record<string, number>>({});
  const today = wibDay(Date.now());
  const days = groupByDay(trades, market, result).filter((g) => !day || g.day === day);
  const isOpen = (d: string) => openDays[d] ?? (d === today || d === day);
  return <div data-testid="lab-trade-history">
    <div className="mt-2 flex flex-wrap gap-1">{MARKETS.map(([k, l]) => <Button key={k} size="sm" variant={market === k ? "secondary" : "ghost"} onClick={() => setMarket(k)}>{l}</Button>)}</div>
    <div className="mt-1 flex flex-wrap gap-1">{RESULTS.map(([k, l]) => <Button key={k} size="sm" variant={result === k ? "secondary" : "ghost"} className={k === "PROFIT" ? "text-bull" : k === "LOSS" ? "text-bear" : k === "OPEN" ? "text-warn" : ""} onClick={() => setResult(k)}>{l}</Button>)}</div>
    <LabPnLCalendar trades={trades} market={market} selected={day} onSelect={setDay} />
    {days.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Belum ada tembakan untuk filter ini.</p> : days.map((d) => { const open = isOpen(d.day); const n = limit[d.day] ?? PAGE; return <div key={d.day} className="mt-3">
      <button type="button" aria-expanded={open} onClick={() => setOpenDays((s) => ({ ...s, [d.day]: !open }))} className="flex w-full flex-wrap items-center justify-between gap-2 rounded border border-border bg-muted px-3 py-2 text-left">
        <span className="text-xs font-semibold">{open ? "▾" : "▸"} 📅 {dayLabel(d.day)}</span>
        <span className={`rounded px-2 py-0.5 font-mono text-xs font-semibold ${d.net >= 0 ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>{usd(d.net)} {d.net >= 0 ? "PROFIT" : "LOSS"}</span>
        <span className="w-full text-[11px] text-muted-foreground">{d.wins} menang · {d.losses} kalah{d.open ? <span className="text-warn"> · {d.open} open (floating {usd(d.floating)})</span> : null} · total {d.trades.length} trade</span>
      </button>
      {open && <><ul className="divide-y divide-border pr-14 text-sm">{d.trades.slice(0, n).map((t) => <li key={t.id} className="py-2">
        <div className={`font-semibold break-words ${t.side === "BUY" ? "text-bull" : "text-bear"}`}>{t.symbol} {t.side} · {LAB_LABELS[t.strategy]}</div>
        <div className="mt-1"><span className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-semibold ${t.status === "OPEN" ? "bg-warn/15 text-warn" : t.pnl_usd > 0 ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>{t.status === "CLOSED" ? `CLOSED · ${t.exit_reason === "TRAIL" ? "TRAILING LOCK" : t.exit_reason} ${usd(t.pnl_usd)}` : `OPEN · floating ${usd(t.pnl_usd)}${t.trail_floor_usd != null ? ` · kunci ${usd(t.trail_floor_usd)}` : ""}`}</span></div>
        <div className="mt-1 text-xs text-muted-foreground break-words">{t.exit_profile === "FIBO" ? "FIBO SL/TP · " : t.rr_mode === "COPET" ? "COPET 1:1 · " : ""}{t.why} · entry {px(t.entry)} · SL {px(t.sl)} · TP {px(t.tp)}</div>
        <div className="text-xs text-muted-foreground">{time(t.opened_at)}{t.status === "CLOSED" ? ` → @ ${px(t.exit_price!)} ${time(t.closed_at!)}` : ""}</div>
      </li>)}</ul>
      {d.trades.length > n && <Button size="sm" variant="outline" className="mt-1 w-full" onClick={() => setLimit((s) => ({ ...s, [d.day]: n + PAGE }))}>History tracking sebelumnya ({d.trades.length - n} lagi)</Button>}</>}
    </div>; })}
  </div>;
}
