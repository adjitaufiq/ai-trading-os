// Read-only RADAR OBSERVABILITY + virtual paper account. Reads only reader.radarSnapshot()/radarHealth()/paperAccount().
import { useEffect, useState } from "react";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";

interface Props { readonly reader: MarketRuntimeReader | null; readonly symbol: string; readonly tickMs?: number }

const fmtTime = (ms: number | null | undefined) => (ms && ms > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Row({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return <div className="flex justify-between gap-3 border-b border-border/50 py-1 text-xs"><span className="text-muted-foreground">{k}</span><span className="text-right font-mono text-foreground" data-testid={testId}>{v}</span></div>;
}

export function RadarObservabilityPanel({ reader, symbol, tickMs = 2000 }: Props) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), tickMs); return () => clearInterval(t); }, [tickMs]);
  const snap = reader?.radarSnapshot() ?? null;
  const health = reader?.radarHealth() ?? null;
  const acct = reader?.paperAccount?.() ?? null;
  const source = snap?.validationSource.dataSource ?? (health ? (health.validationMode === "REAL" ? "REAL_MT5" : "SYNTHETIC") : "—");
  return <section className="mx-auto mb-4 grid max-w-screen-2xl gap-3 px-4 sm:grid-cols-2 sm:px-8" aria-label="Radar observability">
    <div className="border border-border bg-card p-3">
      <h2 className="mb-2 text-xs font-semibold tracking-widest text-muted-foreground">RADAR OBSERVABILITY</h2>
      <Row k="Symbol" v={symbol} />
      <Row k="Data Source" v={source} testId="radar-source" />
      <Row k="Radar Health" v={health?.status ?? "NOT MOUNTED"} testId="radar-health" />
      <Row k="Last M5 Close" v={fmtTime(snap?.lastEvaluatedBarTime)} />
      <Row k="Regime" v={snap?.regime.type ?? "—"} />
      <Row k="Horizon" v={snap ? snap.horizon.compatibleHorizons.join(", ") || "NO_FIT" : "—"} />
      <Row k="Market Approach" v={snap?.horizon.marketApproach ?? "—"} />
      <Row k="Active Events" v={snap ? snap.activeEvents.map((e) => e.type).join(", ") || "none" : "—"} />
      <Row k="Footprint Tags" v={snap ? snap.footprints.activeTags.join(", ") || "none" : "—"} />
      {!snap && <p className="mt-2 text-xs text-muted-foreground">Radar butuh minimal 15 candle M15 live yang sudah close. Belum ada data yang dikarang.</p>}
    </div>
    <div className="border border-border bg-card p-3">
      <h2 className="mb-2 text-xs font-semibold tracking-widest text-muted-foreground">AKUN VIRTUAL — PAPER ONLY, NO ORDER SENT</h2>
      {acct ? <>
        <Row k="Data Source" v={acct.dataSource} testId="account-source" />
        <Row k="Balance" v={usd(acct.balance)} testId="account-balance" />
        <Row k="Equity" v={usd(acct.equity)} />
        <Row k="Open Positions" v={String(acct.openPositions)} />
        <Row k="Realized PnL" v={usd(acct.realizedPnL)} />
        <Row k="Drawdown" v={`${acct.drawdownPercent.toFixed(2)}%`} />
        <Row k="Risk / trade" v={`${acct.riskPercent}%`} />
        <Row k="Closed trades" v={String(acct.closedTrades)} />
        <Row k="Last engine step" v={acct.lastDecision ?? "—"} />
      </> : <p className="text-xs text-muted-foreground">Runtime belum terpasang untuk {symbol}.</p>}
    </div>
  </section>;
}
