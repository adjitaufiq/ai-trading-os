import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { TechnicalSliceService } from "@/core/technical/TechnicalSliceService";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import { POLICIES, TIMEFRAMES, type TradingSnapshot } from "@/core/technical/tradingState";
import { RSI_CONFIG, RESEARCH_REQUIRED_PATTERNS, type Indicator } from "@/core/technical/indicators";
import type { AiWhyResult } from "@/lib/ai-why.functions";

const n = (v: number | null | undefined, d = 3) => (v == null || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(d));
const ind = (i: Indicator | undefined, d = 3) => (!i ? "—" : i.status === "OK" ? n(i.value, d) : "INSUFFICIENT_HISTORY");
const ts = (ms: number | null | undefined) => (ms == null ? "—" : new Date(ms).toISOString().replace("T", " ").slice(0, 19));

export interface TechnicalSlicePanelProps {
  /** Canonical MarketRuntime readers per symbol; null reader ⇒ runtime not mounted (shown as UNAVAILABLE, never substituted). */
  runtimes: readonly { readonly symbol: string; readonly reader: MarketRuntimeReader | null }[];
  unmountedReason?: string;
  tickMs?: number;
  explain?: (snapshot: string) => Promise<AiWhyResult>;
}

function Cell({ label, value, reason, testId }: { label: string; value: string; reason?: string; testId: string }) {
  return <div className="rounded border border-border bg-card p-2" data-testid={testId}>
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className="font-mono text-sm font-semibold text-foreground">{value}</div>
    {reason ? <div className="break-all font-mono text-[10px] text-muted-foreground">{reason}</div> : null}
  </div>;
}

function Body({ s }: { s: TradingSnapshot }) {
  const e = s.evidence;
  return <div className="space-y-3">
    {e ? <>
      <section><h4 className="mb-1 text-xs font-semibold text-muted-foreground">BIAS · EMA5/EMA21 (CLOSED)</h4>
        <div className="grid grid-cols-2 gap-2 font-mono text-xs">{(["H4", "H1"] as const).map((tf) => <div key={tf} className="rounded border border-border p-2">{tf}: {ind(e[tf].ema5)} / {ind(e[tf].ema21)}<br />{e[tf].relation}</div>)}</div></section>
      <section><h4 className="mb-1 text-xs font-semibold text-muted-foreground">STRUCTURE (causal 2+2) · SNR · RSI/ATR (evidence only)</h4>
        <div className="overflow-x-auto"><table className="w-full font-mono text-[11px]"><thead className="text-muted-foreground"><tr><th className="text-left">TF</th><th>last closed</th><th>structure</th><th>support (dist / ATR)</th><th>resistance (dist / ATR)</th><th>RSI{RSI_CONFIG.period}</th><th>ATR14</th></tr></thead>
          <tbody>{TIMEFRAMES.map((tf) => { const x = e[tf]; return <tr key={tf} className="border-t border-border">
            <td>{tf}</td><td>{ts(x.last_closed_open_time)}</td><td>{x.structure.summary} ({x.structure.latest_high ?? "—"}/{x.structure.latest_low ?? "—"})</td>
            <td>{n(x.snr?.nearest_support?.price)} ({n(x.snr?.distance_to_support)} / {n(x.snr?.distance_atr_support, 2)})</td>
            <td>{n(x.snr?.nearest_resistance?.price)} ({n(x.snr?.distance_to_resistance)} / {n(x.snr?.distance_atr_resistance, 2)})</td>
            <td>{ind(x.rsi14, 1)}</td><td>{ind(x.atr14)}</td></tr>; })}</tbody></table></div></section>
    </> : null}
    <section><h4 className="mb-1 text-xs font-semibold text-muted-foreground">TRIGGER · last 3 CLOSED M5</h4>
      <div className="overflow-x-auto"><table className="w-full font-mono text-[11px]"><thead className="text-muted-foreground"><tr><th className="text-left">open</th><th>O</th><th>H</th><th>L</th><th>C</th><th>body</th><th>range</th><th>up wick</th><th>low wick</th><th>body/range</th></tr></thead>
        <tbody>{s.last3_m5.map((g) => <tr key={g.bar.open_time} className="border-t border-border"><td>{ts(g.bar.open_time)}</td><td>{n(g.bar.open)}</td><td>{n(g.bar.high)}</td><td>{n(g.bar.low)}</td><td>{n(g.bar.close)}</td><td>{n(g.body)}</td><td>{n(g.range)}</td><td>{n(g.upper_wick)}</td><td>{n(g.lower_wick)}</td><td>{n(g.body_to_range, 2)}</td></tr>)}</tbody></table></div>
      <div className="mt-1 font-mono text-[11px]" data-testid="engulfing">BullishEngulfing {s.engulfing ? String(s.engulfing.bullish).toUpperCase() : "INSUFFICIENT_HISTORY"} · BearishEngulfing {s.engulfing ? String(s.engulfing.bearish).toUpperCase() : "INSUFFICIENT_HISTORY"} · {RESEARCH_REQUIRED_PATTERNS.join(", ")}: RESEARCH_REQUIRED</div></section>
    <section><h4 className="mb-1 text-xs font-semibold text-muted-foreground">WHY (deterministic)</h4>
      <ul className="font-mono text-[11px]">{s.why.map((w, i) => <li key={i}>{w.ok === true ? "✓" : w.ok === false ? "✗" : "·"} {w.text}</li>)}</ul></section>
  </div>;
}

function Matrix({ s, prefix }: { s: TradingSnapshot; prefix: string }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
    <Cell testId={`${prefix}-availability`} label="Availability" value={s.availability} reason={s.availability_reason} />
    <Cell testId={`${prefix}-bias`} label="Bias" value={s.bias.state} reason={s.bias.reason} />
    <Cell testId={`${prefix}-setup`} label="Setup" value={s.setup.state} reason={s.setup.reason} />
    <Cell testId={`${prefix}-signal`} label="Signal" value={s.signal.state} reason={s.signal.reason} />
    <Cell testId={`${prefix}-entry`} label="Entry analysis" value={s.entry.state} reason={s.entry.reason} />
    <Cell testId={`${prefix}-execution`} label="Execution" value={s.execution.state} reason={s.execution.reasons.join(" · ")} />
  </div>;
}

function SymbolSlice({ svc, explain }: { svc: TechnicalSliceService; explain?: TechnicalSlicePanelProps["explain"] }) {
  useSyncExternalStore(svc.subscribe, svc.getVersion, svc.getVersion);
  const v = svc.view();
  const s = v.current;
  const [ai, setAi] = useState<AiWhyResult | { status: "PENDING" } | null>(null);
  const runAi = async () => {
    if (!s || !explain) { setAi({ status: "AI_ANALYST_UNAVAILABLE", reason: "No AI provider configured" }); return; }
    setAi({ status: "PENDING" });
    try { setAi(await explain(JSON.stringify({ ...s, last3_m5: s.last3_m5, evidence: s.evidence ? Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...s.evidence![tf], structure: { ...s.evidence![tf].structure, swings: s.evidence![tf].structure.swings.slice(-6) } }])) : null }))); }
    catch (e) { setAi({ status: "AI_ANALYST_UNAVAILABLE", reason: (e as Error).message }); }
  };
  return <article className="space-y-3 rounded-lg border border-border bg-background p-3" data-testid={`slice-${v.symbol}`}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-mono text-base font-bold text-foreground">{v.symbol}</h3>
      <span className="font-mono text-[10px] text-muted-foreground">{s && s.availability !== "UNAVAILABLE" ? "REAL · EXNESS_MT5" : "UNAVAILABLE"} · time axis {v.time_axis}</span>
    </header>
    <div className="grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-5">
      <Cell testId={`${v.symbol}-bid`} label="Bid" value={n(s?.quote?.bid)} />
      <Cell testId={`${v.symbol}-ask`} label="Ask" value={n(s?.quote?.ask)} />
      <Cell testId={`${v.symbol}-spread`} label="Spread" value={n(s?.quote?.spread)} reason={`p50 ${n(v.spread.p50)} p95 ${n(v.spread.p95)} · policy ${v.spread.policy}`} />
      <Cell testId={`${v.symbol}-tick`} label="Last tick (broker time)" value={ts(v.feed.last_tick_event_at)} />
      <Cell testId={`${v.symbol}-age`} label="Feed age (raw, G2 open)" value={v.feed.last_tick_age_ms == null ? "—" : `${Math.round(v.feed.last_tick_age_ms / 1000)}s`} reason={`freshness ${v.feed.freshness_policy}`} />
    </div>
    <div className="break-all font-mono text-[10px] text-muted-foreground" data-testid={`${v.symbol}-canonical`}>source {v.data_source}{v.canonical ? ` · ${v.canonical.lifecycle}/${v.canonical.bootstrap_state} · epoch ${v.canonical.active_epoch ?? "—"} · coverage ${v.canonical.history_coverage_status ?? "—"} · routes ${Object.entries(v.canonical.route_counts).map(([k, c]) => `${k}=${c}`).join(" ")} · held ${v.canonical.held_count} · silent_ambiguous_drops ${v.canonical.silent_ambiguous_drops} · stream_protocol_errors ${v.canonical.stream_protocol_errors} · missing ${Object.entries(v.canonical.missing_intervals).map(([k, c]) => `${k}=${c}`).join(" ")}` : ""} · {v.last_error ?? ""}</div>
    {s ? <Matrix s={s} prefix={v.symbol} /> : <div className="text-xs text-muted-foreground">Waiting for first real observation…</div>}
    {s && s.availability !== "UNAVAILABLE" ? <Body s={s} /> : null}
    {v.last_known ? <section className="rounded border border-dashed border-destructive p-2" data-testid={`${v.symbol}-last-known`}>
      <h4 className="text-xs font-bold text-destructive">LAST KNOWN — STALE · timestamp {ts(v.last_known.as_of)}</h4>
      <Matrix s={v.last_known} prefix={`${v.symbol}-lk`} />
    </section> : null}
    <section><h4 className="mb-1 text-xs font-semibold text-muted-foreground">AI WHY (async · no authority)</h4>
      <Button size="sm" variant="outline" onClick={runAi} disabled={ai?.status === "PENDING"}>Explain state</Button>
      <p className="mt-1 whitespace-pre-wrap text-xs text-foreground" data-testid={`${v.symbol}-ai`}>{ai == null ? "" : ai.status === "OK" ? ai.narrative : ai.status === "PENDING" ? "Analysing…" : `AI ANALYST UNAVAILABLE — ${ai.reason}`}</p></section>
    <details><summary className="cursor-pointer text-xs text-muted-foreground">State transitions ({v.transitions_total}) · latency · policies</summary>
      <ul className="max-h-48 overflow-auto font-mono text-[10px]">{[...v.transitions].reverse().map((t) => <li key={t.seq}>{ts(t.available_at)} {t.domain} {t.from ?? "∅"} → {t.to} [{t.reason_code}]{t.trigger_bar ? ` bar ${ts(t.trigger_bar)}` : ""}</li>)}</ul>
      <div className="font-mono text-[10px] text-muted-foreground">gateway RTT p50 {n(v.latency_ms.gateway_roundtrip.p50, 0)} p95 {n(v.latency_ms.gateway_roundtrip.p95, 0)} p99 {n(v.latency_ms.gateway_roundtrip.p99, 0)} ms · evaluate p95 {n(v.latency_ms.evaluate.p95, 2)} ms · last error {v.last_error ?? "—"}</div>
      <ul className="font-mono text-[10px] text-muted-foreground">{Object.entries(POLICIES).map(([k, p]) => <li key={k}>{k}: {p}</li>)}</ul>
    </details>
  </article>;
}

export function TechnicalSlicePanel({ runtimes, unmountedReason, tickMs = 2000, explain }: TechnicalSlicePanelProps) {
  const services = useMemo(() => runtimes.map((r) => new TechnicalSliceService(r.reader, r.symbol, new LiveClock(), unmountedReason)), [runtimes, unmountedReason]);
  useEffect(() => {
    const ticks = () => { for (const s of services) s.tick(); };
    ticks();
    const t = setInterval(ticks, tickMs);
    return () => clearInterval(t);
  }, [services, tickMs]);
  return <section className="space-y-3 bg-background p-3" aria-label="Technical trading state">
    <h2 className="font-mono text-sm font-bold text-foreground">TECHNICAL STATE · MONITOR_ONLY · EXECUTION ABSENT</h2>
    <div className="grid gap-3 xl:grid-cols-2">{services.map((s) => <SymbolSlice key={s.symbol} svc={s} explain={explain} />)}</div>
  </section>;
}
