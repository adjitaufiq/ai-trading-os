import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAB_LABELS } from "@/core/lab/strategies";
import { gateState, todayRealized } from "@/core/lab/operatorControl";
import type { LabRuntime } from "@/hooks/use-strategy-lab";

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const GATE_TEXT = { RUNNING: "BOT JALAN", PAUSED: "PAUSE — tidak buka posisi baru", TARGET_HIT: "TARGET HARIAN TERCAPAI — TOKO TUTUP", MAX_LOSS_HIT: "BATAS RUGI HARIAN — REM AKTIF" } as const;

/** Operator console for the PAPER Lab only: closes virtual positions, never a broker order. */
export function LabOperatorConsole({ lab }: { lab: LabRuntime }) {
  const now = Date.now();
  const op = lab.operator;
  const today = todayRealized(lab.state, now);
  const gate = gateState(lab.state, op, now);
  const open = lab.state.trades.filter((t) => t.status === "OPEN");
  const [target, setTarget] = useState(String(op.targetUsd));
  const [loss, setLoss] = useState(String(op.maxLossUsd));
  const save = () => { const t = Number(target), l = Number(loss); if (t > 0 && l > 0) lab.setOperator({ ...op, targetUsd: t, maxLossUsd: l }); };
  const pct = today >= 0 ? Math.min(100, (today / op.targetUsd) * 100) : Math.min(100, (-today / op.maxLossUsd) * 100);
  return <div className="mt-3 rounded border border-border p-3" data-testid="lab-operator">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-semibold uppercase text-muted-foreground">Kendali operator · paper</span>
      <span className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${gate === "RUNNING" ? "bg-bull/15 text-bull" : gate === "TARGET_HIT" ? "bg-bull/25 text-bull" : "bg-bear/15 text-bear"}`}>{GATE_TEXT[gate]}</span>
    </div>
    <div className="mt-2 text-xs">P/L hari ini (WIB): <b className={`font-mono ${today >= 0 ? "text-bull" : "text-bear"}`}>{usd(today)}</b> · target +${op.targetUsd} · rem −${op.maxLossUsd}</div>
    <div className="mt-1 h-1.5 w-full rounded bg-muted"><div className={`h-1.5 rounded ${today >= 0 ? "bg-bull" : "bg-bear"}`} style={{ width: `${pct}%` }} /></div>
    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
      <label className="flex flex-col gap-1">Target profit/hari ($)<input inputMode="decimal" className="rounded border border-border bg-background px-2 py-1 font-mono" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Batas rugi/hari ($)<input inputMode="decimal" className="rounded border border-border bg-background px-2 py-1 font-mono" value={loss} onChange={(e) => setLoss(e.target.value)} /></label>
    </div>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={save}>Simpan target</Button>
      <Button size="sm" variant={op.paused ? "default" : "outline"} onClick={() => lab.setOperator({ ...op, paused: !op.paused })}>{op.paused ? "▶ Resume All" : "🛑 Pause All"}</Button>
      <Button size="sm" variant="destructive" disabled={!open.length} onClick={() => { if (confirm(`Tutup ${open.length} posisi paper sekarang?`)) lab.closeTrades("ALL"); }}>🚨 Close All ({open.length})</Button>
    </div>
    <p className="mt-1 text-[11px] text-muted-foreground">Saat pause/target/rem aktif, bot tidak buka posisi baru; posisi open tetap jalan kecuali ditutup manual. Reset otomatis jam 00.00 WIB.</p>
    {open.length ? <ul className="mt-2 divide-y divide-border text-xs">{open.slice(0, 30).map((t) => <li key={t.id} className="flex items-center justify-between gap-2 py-1.5">
      <span className="min-w-0 break-words"><b className={t.side === "BUY" ? "text-bull" : "text-bear"}>{t.symbol} {t.side}</b> · Mode {LAB_LABELS[t.strategy]} · <span className={`font-mono ${t.pnl_usd >= 0 ? "text-bull" : "text-bear"}`}>{usd(t.pnl_usd)}</span></span>
      <Button size="sm" variant="outline" onClick={() => lab.closeTrades([t.id])}>Close</Button>
    </li>)}</ul> : null}
  </div>;
}
