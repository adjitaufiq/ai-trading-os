import { Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LAB_LABELS } from "@/core/lab/strategies";
import { LAB_START_BALANCE, LAB_SYMBOLS, leaderboard } from "@/core/lab/labLedger";
import type { LabRuntime } from "@/hooks/use-strategy-lab";

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const px = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(3));
const time = (t: number) => new Date(t).toLocaleString("id-ID", { hour12: false });

export function StrategyLabPanel({ lab }: { lab: LabRuntime }) {
  const board = leaderboard(lab.state);
  const tone = (v: number) => (v >= 0 ? "text-bull" : "text-bear");
  return <section aria-label="Arena Lab" className="border border-border bg-card p-4" data-testid="strategy-lab">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><Swords className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Arena Lab · 5 mode · PAPER SIMULASI</h3></div>
      <Button size="sm" variant="ghost" onClick={() => { if (confirm("Reset Arena Lab ke $500?")) lab.reset(); }}>Reset</Button>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">Harga & candle asli MT5, posisi virtual (bukan order MT5). Modal ${LAB_START_BALANCE}, lot XAU {LAB_SYMBOLS.XAUUSD!.lot} · BTC {LAB_SYMBOLS.BTCUSD!.lot}, tanpa batas posisi. Jalan selama dashboard terbuka.</p>
    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
      <div><div className="text-xs text-muted-foreground">Balance</div><div className={`font-mono font-semibold ${tone(board.balance - LAB_START_BALANCE)}`}>${board.balance.toFixed(2)}</div></div>
      <div><div className="text-xs text-muted-foreground">Equity</div><div className={`font-mono font-semibold ${tone(board.equity - LAB_START_BALANCE)}`}>${board.equity.toFixed(2)}</div></div>
    </div>
    {lab.error ? <p className="mt-2 text-xs text-warn">{lab.error}</p> : null}
    <div className="mt-3 overflow-x-auto"><table className="w-full text-xs"><thead className="text-muted-foreground"><tr className="text-left"><th>#</th><th>Mode</th><th>Trade</th><th>W/L</th><th>WR</th><th>Net</th><th>Open</th></tr></thead>
      <tbody>{board.rows.map((r, i) => <tr key={r.strategy} className="border-t border-border/50"><td className="py-1">{i + 1}</td><td className="pr-2">{LAB_LABELS[r.strategy]}</td><td>{r.trades}</td><td>{r.wins}/{r.losses}</td><td>{r.winRate == null ? "—" : `${Math.round(r.winRate * 100)}%`}</td><td className={`font-mono ${tone(r.realized)}`}>{usd(r.realized)}</td><td className={`font-mono ${tone(r.floating)}`}>{r.open ? `${r.open} · ${usd(r.floating)}` : "—"}</td></tr>)}</tbody></table></div>
    <h4 className="mt-4 text-xs font-semibold uppercase text-muted-foreground">Log tembakan</h4>
    <ul className="mt-2 divide-y divide-border text-sm">
      {lab.state.trades.length === 0 ? <li className="py-2 text-muted-foreground">Belum ada tembakan. Mode dievaluasi tiap candle M5 tertutup.</li> : lab.state.trades.slice(0, 60).map((t) => <li key={t.id} className="py-2">
        <div className="flex justify-between gap-2"><span className={`font-semibold ${t.side === "BUY" ? "text-bull" : "text-bear"}`}>{t.symbol} {t.side} · {LAB_LABELS[t.strategy]}</span><span className={`font-mono ${tone(t.pnl_usd)}`}>{usd(t.pnl_usd)}</span></div>
        <div className="text-xs text-muted-foreground">{t.why} · entry {px(t.entry)} · SL {px(t.sl)} · TP {px(t.tp)}</div>
        <div className="text-xs text-muted-foreground">{time(t.opened_at)}{t.status === "CLOSED" ? ` → ${t.exit_reason} @ ${px(t.exit_price!)} ${time(t.closed_at!)}` : " · OPEN"}</div>
      </li>)}
    </ul>
  </section>;
}
