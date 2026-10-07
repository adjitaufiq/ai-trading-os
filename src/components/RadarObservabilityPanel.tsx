// Read-only RADAR OBSERVABILITY + virtual paper account. Renders ONE RuntimeFacts object: either the persistent
// ENGINE HOST (VPS) or the BROWSER SESSION (resets on refresh). It never polls and never mixes sources.
import type { RuntimeFacts } from "@/lib/cockpitSource";

interface Props { readonly facts: RuntimeFacts | null; readonly symbol: string; readonly fallbackReason?: string | null }

const fmtTime = (ms: number | null | undefined) => (ms && ms > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Row({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return <div className="flex justify-between gap-3 border-b border-border/50 py-1 text-xs"><span className="text-muted-foreground">{k}</span><span className="text-right font-mono text-foreground" data-testid={testId}>{v}</span></div>;
}

export function RadarObservabilityPanel({ facts, symbol, fallbackReason }: Props) {
  const host = facts?.source === "ENGINE_HOST";
  const snap = facts?.radar ?? null;
  const health = facts?.radarHealth ?? null;
  const acct = facts?.account ?? null;
  const eh = facts?.engineHealth ?? null;
  const source = snap?.validationSource.dataSource ?? (health ? (health.validationMode === "REAL" ? "REAL_MT5" : "SYNTHETIC") : "—");
  const engineLabel = host
    ? `ENGINE HOST VPS (LIVE) · ${eh?.state ?? "?"}`
    : `BROWSER SESSION (EPHEMERAL)${fallbackReason ? ` · ENGINE HOST OFFLINE (${fallbackReason})` : ""}`;
  return <section className="mx-auto mb-4 grid max-w-screen-2xl gap-3 px-4 sm:grid-cols-2 sm:px-8" aria-label="Radar observability">
    <div className="border border-border bg-card p-3">
      <h2 className="mb-2 text-xs font-semibold tracking-widest text-muted-foreground">RADAR OBSERVABILITY</h2>
      <Row k="Engine" v={engineLabel} testId="engine-source" />
      {host && <Row k="Engine update" v={`${fmtTime(eh?.last_update_at)}${eh?.latency_ms != null ? ` · ${eh.latency_ms} ms` : ""}`} />}
      {host && eh?.clock && <Row k="Broker clock" v={eh.clock.status === "UNKNOWN" ? "—" : `${eh.clock.status} · drift ${eh.clock.clock_drift_ms} ms`} testId="engine-clock" />}
      {host && eh?.error && <Row k="Engine error" v={eh.error} />}
      {!host && <p className="mb-2 text-xs text-warn" data-testid="ephemeral-warning">Warning: refresh browser akan me-reset runtime state.</p>}
      <Row k="Symbol" v={symbol} />
      <Row k="Data Source" v={source} testId="radar-source" />
      <Row k="Radar Health" v={health?.status ?? "NOT MOUNTED"} testId="radar-health" />
      <Row k="Last M5 Close" v={fmtTime(snap?.lastEvaluatedBarTime)} />
      <Row k="Regime" v={snap?.regime.type ?? "—"} />
      <Row k="Horizon" v={snap ? snap.horizon.compatibleHorizons.join(", ") || "NO_FIT" : "—"} />
      <Row k="Market Approach" v={snap?.horizon.marketApproach ?? "—"} />
      <Row k="Active Events" v={snap ? snap.activeEvents.map((e) => e.type).join(", ") || "none" : "—"} />
      <Row k="Footprint Tags" v={snap ? snap.footprints.activeTags.join(", ") || "none" : "—"} />
      {!snap && <p className="mt-2 text-xs text-muted-foreground">Radar menunggu histori broker / candle M5 close. Belum ada data yang dikarang.</p>}
    </div>
    <div className="border border-border bg-card p-3">
      <h2 className="mb-2 text-xs font-semibold tracking-widest text-muted-foreground">AKUN VIRTUAL — PAPER ONLY, NO ORDER SENT</h2>
      {acct ? <>
        <Row k="Data Source" v={acct.dataSource} testId="account-source" />
        <Row k="Disimpan di" v={host ? "VPS (bertahan saat refresh)" : "Browser (hilang saat refresh)"} testId="account-persistence" />
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
