import { useMemo, useState, useSyncExternalStore } from "react";
import { FlaskConical, NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { Timeframe } from "@/core/contracts";
import { TIMEFRAMES } from "@/core/technical/tradingState";
import { toTechBar } from "@/core/technical/TechnicalSliceService";
import { runQuickBacktest, BACKTEST_DISCLAIMER, type BacktestResult } from "@/core/technical/backtest";
import { sharedPaperJournal, type JournalEntry, type PaperJournalStore } from "@/lib/paperJournal";

const n = (v: number | null | undefined, d = 3) => (v == null || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(d));
const time = (t: number) => new Date(t).toLocaleString("id-ID", { hour12: false });

function describe(e: JournalEntry): { title: string; detail: string; tone: string } {
  if (e.type === "SIGNAL") return { title: `SINYAL ${e.from} → ${e.to}`, detail: e.context ? `${e.context.regime ?? "—"} · H4 ${e.context.h4 ?? "—"} · H1 ${e.context.h1_context ?? "—"} · ${e.context.location ?? "—"}` : "", tone: e.to === "BUY" ? "text-bull" : e.to === "SELL" ? "text-bear" : "text-foreground" };
  const p = e.position;
  const manual = p.manual_against_engine ? ` · MANUAL (ENGINE: ${p.engine_signal})` : "";
  if (e.type === "TRADE_OPEN") return { title: `PAPER ${p.side} DIBUKA @ ${n(p.entry)}`, detail: `SL ${n(p.sl)} · TP2 ${n(p.tp2)}${manual}`, tone: p.side === "BUY" ? "text-bull" : "text-bear" };
  return { title: `PAPER ${p.side} DITUTUP @ ${n(p.exit_price)} (${p.exit_reason})`, detail: `PnL ${n(p.pnl)} · R ${p.r_multiple == null ? "—" : p.r_multiple.toFixed(2)}${manual}`, tone: (p.pnl ?? 0) >= 0 ? "text-bull" : "text-bear" };
}

export function JournalList({ store, symbols }: { store: PaperJournalStore; symbols: readonly string[] }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [symbol, setSymbol] = useState<string>("ALL");
  const [type, setType] = useState<"ALL" | "SIGNAL" | "TRADE">("ALL");
  const rows = state.journal.filter((e) => (symbol === "ALL" || e.symbol === symbol) && (type === "ALL" || (type === "SIGNAL" ? e.type === "SIGNAL" : e.type !== "SIGNAL")));
  return <section aria-label="Jurnal" className="border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><NotebookPen className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Jurnal</h3></div>
      <div className="flex flex-wrap gap-1">
        {["ALL", ...symbols].map((s) => <Button key={s} size="sm" variant={symbol === s ? "secondary" : "ghost"} onClick={() => setSymbol(s)}>{s === "ALL" ? "Semua" : s}</Button>)}
        {(["ALL", "SIGNAL", "TRADE"] as const).map((t) => <Button key={t} size="sm" variant={type === t ? "secondary" : "ghost"} data-testid={`journal-filter-${t}`} onClick={() => setType(t)}>{t === "ALL" ? "Semua tipe" : t === "SIGNAL" ? "Sinyal" : "Trade"}</Button>)}
      </div>
    </div>
    <ul className="mt-3 divide-y divide-border text-sm" data-testid="journal-list">
      {rows.length === 0 ? <li className="py-3 text-muted-foreground">Belum ada catatan.</li> : rows.slice(0, 200).map((e) => {
        const d = describe(e);
        return <li key={e.id} className="py-2" data-testid="journal-row"><div className="flex justify-between gap-3"><span className={`font-semibold ${d.tone}`}>{e.symbol} · {d.title}</span><span className="shrink-0 text-xs text-muted-foreground">{time(e.at)}</span></div>{d.detail ? <div className="text-xs text-muted-foreground">{d.detail}</div> : null}</li>;
      })}
    </ul>
  </section>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="font-mono font-semibold">{value}</div></div>;
}

export function BacktestView({ result }: { result: BacktestResult }) {
  return <div className="mt-3 space-y-3" data-testid="backtest-result">
    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      <Stat label="Setup dievaluasi" value={String(result.evaluated)} />
      <Stat label="Kandidat BUY / SELL" value={`${result.buy_candidates} / ${result.sell_candidates}`} />
      <Stat label="HOLD" value={String(result.hold)} />
      <Stat label="Trade simulasi" value={String(result.trades.length)} />
      <Stat label="Menang / Kalah" value={`${result.wins} / ${result.losses}`} />
      <Stat label="Ambigu (SL+TP satu bar)" value={String(result.ambiguous)} />
      <Stat label="Win rate" value={result.win_rate == null ? "—" : `${(result.win_rate * 100).toFixed(1)}%`} />
      <Stat label="Gross R / Rata-rata R" value={`${result.gross_r.toFixed(2)} / ${result.avg_r == null ? "—" : result.avg_r.toFixed(2)}`} />
      <Stat label="Max drawdown (R)" value={result.max_drawdown_r.toFixed(2)} />
      <Stat label="Rata-rata hold" value={result.avg_holding_bars == null ? "—" : `${result.avg_holding_bars.toFixed(1)} bar M5 · ${((result.avg_holding_ms ?? 0) / 60_000).toFixed(0)} mnt`} />
      <Stat label="Masih terbuka di akhir" value={String(result.open_at_end)} />
    </div>
    <div className="text-xs text-muted-foreground">Per regime: {Object.entries(result.by_regime).map(([k, v]) => `${k} ${v.trades} trade (${v.wins}W/${v.losses}L, ${v.gross_r.toFixed(1)}R)`).join(" · ") || "—"}</div>
  </div>;
}

export function BacktestPanel({ runtimes, symbol }: { runtimes: readonly { symbol: string; reader: MarketRuntimeReader | null }[]; symbol: string }) {
  const [state, setState] = useState<{ status: "IDLE" } | { status: "DONE"; result: BacktestResult } | { status: "ERROR"; reason: string }>({ status: "IDLE" });
  const reader = runtimes.find((r) => r.symbol === symbol)?.reader ?? null;
  const run = () => {
    if (!reader?.brokerHistoryBars) { setState({ status: "ERROR", reason: "Histori broker belum tersedia untuk simbol ini" }); return; }
    const history = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, reader.brokerHistoryBars!(tf).map(toTechBar)])) as Record<Timeframe, ReturnType<typeof toTechBar>[]>;
    if (history.M5.length === 0) { setState({ status: "ERROR", reason: "Histori M5 broker kosong" }); return; }
    setState({ status: "DONE", result: runQuickBacktest(history, symbol) });
  };
  return <section aria-label="Backtest cepat" className="border border-border bg-card p-4">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Backtest cepat · {symbol}</h3></div>
      <Button size="sm" variant="outline" onClick={run}>BACKTEST</Button>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{BACKTEST_DISCLAIMER} Target TP2 (2R), SL dari rencana acuan; entry pada close M5 CLOSED.</p>
    {state.status === "DONE" ? <BacktestView result={state.result} /> : state.status === "ERROR" ? <p className="mt-3 text-sm text-bear">{state.reason}</p> : null}
  </section>;
}

export function JournalPanel({ runtimes, selectedSymbol, store }: { runtimes: readonly { symbol: string; reader: MarketRuntimeReader | null }[]; selectedSymbol: string; store?: PaperJournalStore }) {
  const s = useMemo(() => store ?? sharedPaperJournal(), [store]);
  return <section className="bg-background px-4 pb-8 sm:px-8"><div className="mx-auto max-w-screen-2xl space-y-4">
    <BacktestPanel runtimes={runtimes} symbol={selectedSymbol} />
    <JournalList store={s} symbols={runtimes.map((r) => r.symbol)} />
  </div></section>;
}
