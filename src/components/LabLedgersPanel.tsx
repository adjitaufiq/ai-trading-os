import { LAB_LABELS } from "@/core/lab/strategies";
import { bookStats, LEDGER_COSTS_NOTE, LEDGER_START_BALANCE, type LedgerBook } from "@/core/lab/isolatedLedgers";

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const time = (t: number) => new Date(t).toLocaleString("id-ID", { hour12: false });

export function LabLedgersPanel({ book }: { book: LedgerBook | null }) {
  if (!book) return null;
  const stats = bookStats(book);
  const tone = (v: number) => (v >= 0 ? "text-bull" : "text-bear");
  return <section aria-label="Ledger terpisah" className="mt-4" data-testid="lab-ledgers">
    <h4 className="text-xs font-semibold uppercase text-muted-foreground">Ledger terpisah · ${LEDGER_START_BALANCE} per mode × exit · VIRTUAL STRATEGY LAB</h4>
    <p className="mt-1 text-xs text-muted-foreground break-words">Bukan akun DEMO broker. Mulai {time(book.started_at)}. {LEDGER_COSTS_NOTE}</p>
    <div className="mt-2 space-y-2">{stats.map((s) => <div key={s.key} className="rounded border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-1"><span className="text-sm font-semibold break-words">Mode {LAB_LABELS[s.strategy]}</span><span className="rounded bg-muted px-2 py-0.5 font-mono">{s.profile}</span></div>
      {s.topupTotal ? <div className="mt-2 rounded bg-warn/15 px-2 py-1 text-warn break-words" data-testid="ledger-topup">TOP-UP · Modal disetor ${s.capitalIn.toFixed(2)} (${s.start_balance.toFixed(0)} ronde 1 + ${s.topupTotal.toFixed(0)} ronde 2 · {time(s.topups[0]!.at)}). Hasil ronde 1 tetap tercatat.</div> : null}
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
        <span>Modal ${s.capitalIn.toFixed(2)} → <b className={tone(s.realized)}>${s.balance.toFixed(2)}</b></span>
        <span>Equity <b className={tone(s.equity - s.start_balance)}>${s.equity.toFixed(2)}</b></span>
        <span>Realized <b className={tone(s.realized)}>{usd(s.realized)}</b></span>
        <span>Floating <b className={tone(s.floating)}>{usd(s.floating)}</b> ({s.open} open)</span>
        <span>Closed {s.closed}: <span className="text-bull">{s.wins}W</span>/<span className="text-bear">{s.losses}L</span>/{s.breakeven}BE</span>
        <span>WR {s.winRate == null ? "—" : `${Math.round(s.winRate * 100)}%`}</span>
        <span>TP {s.exits.TP} · SL {s.exits.SL} · TRAIL {s.exits.TRAIL}{s.exits.OTHER ? ` · lain ${s.exits.OTHER}` : ""}</span>
        <span>Max DD ${s.maxDrawdown.toFixed(2)}</span>
        <span>Lot open {s.openLots.toFixed(2)}</span>
        <span>Eksposur ${s.openNotionalUsd.toFixed(0)}</span>
      </div>
      {s.depletedAt ? <div className="mt-1 text-bear">Saldo habis pada {time(s.depletedAt)} — tidak direset otomatis.</div> : null}
    </div>)}</div>
  </section>;
}
