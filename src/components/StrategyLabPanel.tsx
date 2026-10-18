import { Swords } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { LAB_LABELS, LAB_STRATEGIES } from "@/core/lab/strategies";
import { allSwitches } from "@/core/lab/modeSwitch";
import { LAB_START_BALANCE, LAB_SYMBOLS, leaderboard } from "@/core/lab/labLedger";
import { LabLedgersPanel } from "./LabLedgersPanel";
import { LabLeaderboard } from "./LabLeaderboard";
import { LabOperatorConsole } from "./LabOperatorConsole";
import { LabTradeHistory } from "./LabTradeHistory";
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
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" role="status" data-testid="lab-sync-status">
      <span className={lab.sync.status === "SYNCED" ? "text-bull" : "text-warn"}>Jurnal cloud · {{ LOCAL: "Lokal", LOGIN_REQUIRED: "Belum masuk", SYNCING: "Mengirim", SYNCED: "Tersinkron", RETRY: "Menunggu kirim ulang", ACCOUNT_MISMATCH: "Akun berbeda" }[lab.sync.status]}</span>
      <span className="text-muted-foreground">Antrean {lab.sync.pending}{lab.sync.lastSyncedAt ? ` · terkirim ${time(lab.sync.lastSyncedAt)}` : ""} · pembaruan ±15 dtk</span>
      {lab.sync.status === "LOGIN_REQUIRED" ? <Button asChild variant="outline" size="sm"><Link to="/auth">Masuk untuk sinkron</Link></Button> : null}
      {lab.sync.error ? <span className="w-full break-words text-warn">{lab.sync.error}</span> : null}
    </div>
    <p className="mt-1 text-xs text-muted-foreground">Harga & candle asli MT5, posisi virtual (bukan order MT5). Modal ${LAB_START_BALANCE}, lot XAU {LAB_SYMBOLS["XAUUSD"]!.lot} · BTC {LAB_SYMBOLS["BTCUSD"]!.lot}, batas entry diatur di Setting mode. Jalan selama dashboard terbuka.</p>
    <div className="mt-3 grid grid-cols-2 gap-2">
      <div className="rounded border border-border p-3"><div className="text-xs text-muted-foreground">Balance</div><div className={`font-mono text-lg font-semibold ${tone(board.balance - LAB_START_BALANCE)}`}>${board.balance.toFixed(2)}</div><div className={`text-xs font-mono ${tone(board.balance - LAB_START_BALANCE)}`}>Realized {usd(board.balance - LAB_START_BALANCE)}</div></div>
      <div className="rounded border border-border p-3"><div className="text-xs text-muted-foreground">Equity</div><div className={`font-mono text-lg font-semibold ${tone(board.equity - LAB_START_BALANCE)}`}>${board.equity.toFixed(2)}</div><div className={`text-xs font-mono ${tone(board.equity - board.balance)}`}>Floating {usd(board.equity - board.balance)}</div></div>
    </div>
    {(() => { const t = board.rows.reduce((a, r) => ({ n: a.n + r.trades, w: a.w + r.wins, l: a.l + r.losses, o: a.o + r.open }), { n: 0, w: 0, l: 0, o: 0 }); return <div className="mt-2 flex flex-wrap gap-2 text-xs"><span className="rounded bg-muted px-2 py-1">Tembakan selesai: <b>{t.n}</b></span><span className="rounded bg-bull/15 px-2 py-1 text-bull">Win <b>{t.w}</b></span><span className="rounded bg-bear/15 px-2 py-1 text-bear">Lose <b>{t.l}</b></span><span className="rounded bg-muted px-2 py-1">Masih open: <b>{t.o}</b></span></div>; })()}
    {lab.error ? <p className="mt-2 text-xs text-warn">{lab.error}</p> : null}
    <LabOperatorConsole lab={lab} />
    <h4 className="mt-4 text-xs font-semibold uppercase text-muted-foreground">Log tembakan · semua market</h4>
    <LabTradeHistory trades={lab.state.trades} />
    <LabLeaderboard lab={lab} />
    <div className="mt-3 space-y-2">{board.rows.map((r, i) => <div key={r.strategy} className="rounded border border-border p-3">
      <div className="text-sm font-semibold break-words">Mode {LAB_LABELS[r.strategy]}{lab.switches[r.strategy] ? null : <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">OFF · istirahat</span>}</div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div><div className="text-[11px] text-muted-foreground">Tembakan</div><div className="font-mono text-base font-semibold">{r.trades}</div></div>
        <div><div className="text-[11px] text-muted-foreground">Win / Lose</div><div className="font-mono text-base font-semibold"><span className="text-bull">{r.wins}</span> / <span className="text-bear">{r.losses}</span></div><div className="text-[11px] text-muted-foreground">WR {r.winRate == null ? "—" : `${Math.round(r.winRate * 100)}%`}</div></div>
        <div><div className="text-[11px] text-muted-foreground">Net P/L</div><div className={`inline-block rounded px-2 py-0.5 font-mono text-sm font-semibold ${r.realized >= 0 ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>{usd(r.realized)}</div></div>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">Posisi aktif: {r.open ? <span className={`font-mono ${tone(r.floating)}`}>{r.open} trade · floating {usd(r.floating)}</span> : "—"}</div>
    </div>)}</div>
    <LabLedgersPanel book={lab.book} />
    {(() => { const on = LAB_STRATEGIES.filter((m) => lab.switches[m]).length; const op = lab.operator;
      const openBy = (m: string) => lab.state.trades.filter((t) => t.status === "OPEN" && t.strategy === m).length;
      const openTotal = lab.state.trades.filter((t) => t.status === "OPEN").length;
      const num = (v: string) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? n : null; };
      return <div className="mt-3 rounded border border-border p-3" data-testid="lab-mode-switches">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold uppercase text-muted-foreground">Setting mode · {on} ON · {LAB_STRATEGIES.length - on} OFF</span>
        <span className="flex gap-1"><Button size="sm" variant="outline" onClick={() => lab.setSwitches(allSwitches(true))}>Select All</Button><Button size="sm" variant="outline" onClick={() => lab.setSwitches(allSwitches(false))}>Deselect All</Button></span></div>
      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">Maks entry total bersamaan
        <input type="number" min={1} inputMode="numeric" className="w-16 rounded border border-border bg-background px-2 py-1 font-mono" value={op.maxOpenTotal} onChange={(e) => { const n = num(e.target.value); if (n) lab.setOperator({ ...op, maxOpenTotal: n }); }} />
        <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${openTotal >= op.maxOpenTotal ? "bg-bear/15 text-bear" : "bg-bull/15 text-bull"}`}>Entry aktif {openTotal} / {op.maxOpenTotal}</span></label>
      <p className="mt-1 text-[11px] text-muted-foreground">Mode OFF atau jatah entry penuh tidak buka posisi baru; posisi yang sudah open tetap jalan sampai selesai.</p>
      <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-flow-col sm:grid-cols-2 sm:grid-rows-6">{LAB_STRATEGIES.map((m) => <div key={m} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted">
        <input type="checkbox" aria-label={`Mode ${LAB_LABELS[m]}`} className="h-4 w-4 accent-primary" checked={lab.switches[m]} onChange={(e) => lab.setSwitches({ ...lab.switches, [m]: e.target.checked })} />
        <span className="flex-1 break-words">Mode {LAB_LABELS[m]}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${lab.switches[m] ? "bg-bull/15 text-bull" : "bg-muted text-muted-foreground"}`}>{lab.switches[m] ? "ON" : "OFF"}</span>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">Maks entry
          <input type="number" min={1} inputMode="numeric" disabled={!lab.switches[m]} className="w-12 rounded border border-border bg-background px-1 py-0.5 font-mono text-xs text-foreground disabled:opacity-40" value={op.maxOpenPerMode[m]} onChange={(e) => { const n = num(e.target.value); if (n) lab.setOperator({ ...op, maxOpenPerMode: { ...op.maxOpenPerMode, [m]: n } }); }} />
          <span className="font-mono">{openBy(m)}/{op.maxOpenPerMode[m]}</span></label></div>)}</div>
    </div>; })()}
  </section>;
}
