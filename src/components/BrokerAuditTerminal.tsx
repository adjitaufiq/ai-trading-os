// Stage 3 — REAL BROKER OBSERVABILITY / AUDIT TERMINAL.
// Read-only view over BrokerGatewayClient. No mock fallback, no execution
// surface, no data mutation, no synthetic candles. Discrepancies are surfaced.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EXECUTION_ENABLED, OPERATING_MODE, type Timeframe } from "@/core/contracts";
import type { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import type {
  BridgeBar, BridgeHealth, BridgeSymbolInfo, BridgeTick, ClientError, GatewayResult,
  TerminalInfoObservation, WireEnvelope, WireHistoryResult,
} from "@/core/broker/gateway/types";
import { auditBars, spreadPrice, tickAge, utc, type AuditFreshness } from "@/core/broker/audit/brokerAudit";

export const AUDIT_TIMEFRAMES: readonly Timeframe[] = ["M5", "M15", "H1", "H4"];
export const AUDIT_SYMBOL = "XAUUSD";
export const BTC_GROUP = "*BTC*";
const BAR_COUNT = 200;
/** Fields the frozen 3.0B-1 symbol contract does NOT carry. Shown, never approximated. */
export const NOT_EXPOSED_SPEC_FIELDS = ["tick_size", "tick_value", "volume_min", "volume_max", "volume_step", "swap_long", "swap_short", "trade_mode", "trade_stops_level", "trade_freeze_level", "margin_initial", "session_hours"];

type Slot<T> = { result: GatewayResult<T> | null; at: number | null };
const empty = <T,>(): Slot<T> => ({ result: null, at: null });

const H = ({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) => (
  <h2 className="flex justify-between gap-2 border-b border-border px-3 py-1.5 font-mono text-xs tracking-widest text-muted-foreground">
    <span>{children}</span>{right ? <span>{right}</span> : null}
  </h2>
);
const Box = ({ children, testid }: { children: React.ReactNode; testid?: string }) => (
  <section className="border border-border bg-card" data-testid={testid}>{children}</section>
);
const KV = ({ rows, testid }: { rows: [string, React.ReactNode, string?][]; testid?: string }) => (
  <table className="w-full table-fixed font-mono text-xs" data-testid={testid}>
    <tbody>
      {rows.map(([k, v, tid]) => (
        <tr key={k} className="border-t border-border first:border-t-0">
          <td className="w-1/2 break-words px-3 py-0.5 text-muted-foreground">{k}</td>
          <td className="w-1/2 px-3 py-0.5 text-right" data-testid={tid}><div className="overflow-x-auto whitespace-nowrap tabular-nums">{v}</div></td>
        </tr>
      ))}
    </tbody>
  </table>
);
const ErrLine = ({ e }: { e: ClientError }) => (
  <div className="px-3 py-2 font-mono text-xs text-bear" data-testid="audit-error">
    {e.kind}{e.http_status != null ? ` · HTTP ${e.http_status}` : ""} · {e.message} · NO MOCK FALLBACK
  </div>
);
// Raw value and UTC on separate lines so row height stays constant as values change.
const ts = (ms: number | null | undefined) => (ms == null ? "null" : <>{ms} <br /><span className="text-muted-foreground">({utc(ms)})</span></>);
const fTone = (s: AuditFreshness) => (s === "FRESH" ? "text-bull" : s === "STALE" ? "text-bear" : "text-muted-foreground");

function Candles({ bars }: { bars: readonly BridgeBar[] }) {
  // Plotted strictly from returned bars, x = raw_time_s. Gaps stay visible as empty space.
  if (bars.length === 0) return <div className="p-3 font-mono text-xs text-muted-foreground">NO BARS RETURNED</div>;
  const W = 900, Hh = 260, P = 8;
  const t0 = Math.min(...bars.map((b) => b.raw_time_s)), t1 = Math.max(...bars.map((b) => b.raw_time_s));
  const lo = Math.min(...bars.map((b) => b.low)), hi = Math.max(...bars.map((b) => b.high));
  const span = Math.max(1, t1 - t0), pr = hi - lo || 1;
  const x = (t: number) => P + ((t - t0) / span) * (W - 2 * P);
  const y = (p: number) => P + ((hi - p) / pr) * (Hh - 2 * P);
  const cw = Math.max(1, ((W - 2 * P) / Math.max(bars.length, 1)) * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} className="h-64 w-full" data-testid="candle-chart" data-candles={bars.length}>
      {bars.map((b, i) => {
        const up = b.close >= b.open;
        const cls = up ? "stroke-bull fill-bull" : "stroke-bear fill-bear";
        return (
          <g key={`${b.raw_time_s}-${i}`} className={cls}>
            <line x1={x(b.raw_time_s)} x2={x(b.raw_time_s)} y1={y(b.high)} y2={y(b.low)} strokeWidth={1} />
            <rect x={x(b.raw_time_s) - cw / 2} width={cw} y={y(Math.max(b.open, b.close))} height={Math.max(0.5, Math.abs(y(b.open) - y(b.close)))} />
          </g>
        );
      })}
      <text x={P} y={Hh - 2} className="fill-muted-foreground" fontSize={10}>{hi} / {lo} · {utc(t0 * 1000)} → {utc(t1 * 1000)}</text>
    </svg>
  );
}

export interface BrokerAuditTerminalProps {
  client: BrokerGatewayClient;
  now?: () => number;
  pollMs?: number;
  /** Explicit UI audit threshold. null = no policy → UNKNOWN. Not a TRS-03 value. */
  initialStaleAfterMs?: number | null;
}

export function BrokerAuditTerminal({ client, now = () => Date.now(), pollMs = 1000, initialStaleAfterMs = 60_000 }: BrokerAuditTerminalProps) {
  const [tick, setTick] = useState<Slot<BridgeTick>>(empty);
  const [spec, setSpec] = useState<Slot<BridgeSymbolInfo>>(empty);
  const [btc, setBtc] = useState<Slot<readonly BridgeSymbolInfo[]>>(empty);
  const [health, setHealth] = useState<Slot<BridgeHealth>>(empty);
  const [term, setTerm] = useState<Slot<TerminalInfoObservation>>(empty);
  const [bars, setBars] = useState<Partial<Record<Timeframe, Slot<WireHistoryResult<BridgeBar>>>>>({});
  const [tf, setTf] = useState<Timeframe>("M5");
  const [staleAfter, setStaleAfter] = useState<number | null>(initialStaleAfterMs);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [inspect, setInspect] = useState<string>("tick");
  const alive = useRef(true);

  // Keys whose static request already returned a validated observation. Retries
  // only re-request the others, so a later timeout can never replace (blank out)
  // a real observation that was already received.
  const okKeys = useRef(new Set<string>());
  const loadStatic = useCallback(async () => {
    const at = () => now();
    const need = (k: string) => !okKeys.current.has(k);
    const mark = (k: string, r: { ok: boolean }) => { if (r.ok) okKeys.current.add(k); };
    await Promise.all([
      need("health") ? client.getHealth().then((r) => { if (alive.current) { mark("health", r); setHealth({ result: r, at: at() }); } }) : null,
      need("spec") ? client.getSymbol(AUDIT_SYMBOL).then((r) => { if (alive.current) { mark("spec", r); setSpec({ result: r, at: at() }); } }) : null,
      need("btc") ? client.getSymbols(BTC_GROUP).then((r) => { if (alive.current) { mark("btc", r); setBtc({ result: r, at: at() }); } }) : null,
    ]);
    if (!alive.current) return;
    if (need("term")) {
      const t = await client.getTerminal();
      if (!alive.current) return;
      mark("term", t); setTerm({ result: t, at: at() });
    }
    for (const f of AUDIT_TIMEFRAMES) {
      if (!need(`bars:${f}`)) continue;
      const r = await client.getBars({ symbol: AUDIT_SYMBOL, timeframe: f, mode: "pos", start: 0, count: BAR_COUNT });
      if (!alive.current) return;
      mark(`bars:${f}`, r);
      setBars((o) => ({ ...o, [f]: { result: r, at: at() } }));
    }
  }, [client, now]);

  // Last tick that actually passed validation. Shown (explicitly labeled) when a
  // later poll fails, so one timeout doesn't blank the panel. Real data only.
  const [lastGoodTick, setLastGoodTick] = useState<Slot<BridgeTick>>(empty);
  const staticFailed = useRef(false);

  useEffect(() => {
    alive.current = true;
    void loadStatic();
    let busy = false;
    const poll = async () => {
      if (busy) return; busy = true;
      const r = await client.getLatestTick(AUDIT_SYMBOL);
      busy = false;
      if (alive.current) {
        const at = now();
        setTick({ result: r, at });
        if (r.ok) setLastGoodTick({ result: r, at });
        setNowMs(at);
      }
    };
    void poll();
    const id = setInterval(poll, pollMs);
    return () => { alive.current = false; clearInterval(id); };
  }, [client, loadStatic, now, pollMs]);

  // Retry static loads (spec/btc/bars/…) every 15 s only while any of them failed.
  useEffect(() => {
    staticFailed.current =
      [health, spec, btc, term].some((s) => s.result && !s.result.ok) ||
      AUDIT_TIMEFRAMES.some((f) => bars[f]?.result && !bars[f]!.result!.ok);
  }, [health, spec, btc, term, bars]);
  useEffect(() => {
    const id = setInterval(() => { if (staticFailed.current) void loadStatic(); }, 15_000);
    return () => clearInterval(id);
  }, [loadStatic]);

  const t = tick.result?.ok ? tick.result : lastGoodTick.result?.ok ? lastGoodTick.result : null;
  const tickIsLastGood = !!(tick.result && !tick.result.ok && t);
  const env = t?.envelope;
  const age = tickAge(env?.timing.source_event_at ?? null, nowMs ?? 0, nowMs == null ? null : staleAfter);
  const barSlot = bars[tf];
  const barRes = barSlot?.result?.ok ? barSlot.result : null;
  const items = barRes?.data.items ?? [];
  const audit = useMemo(() => auditBars(items, tf), [items, tf]);
  const latestBar = items.length ? items[items.length - 1] : null;
  const digits = spec.result?.ok ? spec.result.data.digits : null;

  const envelopes: Record<string, WireEnvelope<unknown> | ClientError | null> = {
    tick: tick.result ? (tick.result.ok ? tick.result.envelope : tick.result.error) : null,
    health: health.result ? (health.result.ok ? health.result.envelope : health.result.error) : null,
    terminal: term.result ? (term.result.ok ? term.result.envelope : term.result.error) : null,
    symbol: spec.result ? (spec.result.ok ? spec.result.envelope : spec.result.error) : null,
    btc: btc.result ? (btc.result.ok ? btc.result.envelope : btc.result.error) : null,
    ...Object.fromEntries(AUDIT_TIMEFRAMES.map((f) => [`bars ${f}`, bars[f]?.result ? (bars[f]!.result!.ok ? (bars[f]!.result as { envelope: WireEnvelope<unknown> }).envelope : (bars[f]!.result as { error: ClientError }).error) : null])),
  };

  // Audit findings derived from what was actually observed (surfaced, not fixed).
  const findings: string[] = [];
  if (env && env.latency.source_arrival_delay_observed_ms != null && env.latency.source_arrival_delay_observed_ms < 0)
    findings.push(`NEGATIVE source_arrival_delay_observed_ms = ${env.latency.source_arrival_delay_observed_ms} (clock skew between broker and bridge)`);
  if (age.age_ms != null && age.age_ms < 0) findings.push(`NEGATIVE tick age = ${age.age_ms} ms (client vs broker clock skew)`);
  if (t && env?.timing.source_event_at != null && env.timing.source_event_at !== t.data.raw_time_msc)
    findings.push(`timing.source_event_at (${env.timing.source_event_at}) ≠ raw_time_msc (${t.data.raw_time_msc})`);
  if (t && Math.floor(t.data.raw_time_msc / 1000) !== t.data.raw_time_s) findings.push("raw_time_s ≠ floor(raw_time_msc/1000)");
  for (const f of AUDIT_TIMEFRAMES) {
    const r = bars[f]?.result;
    if (r?.ok) {
      if (r.envelope.delivery !== "BACKFILL") findings.push(`bars ${f} delivered as ${r.envelope.delivery}, expected BACKFILL`);
      if (r.data.coverage.coverage_status === "COMPLETE" && r.data.coverage.requested_from == null)
        findings.push(`bars ${f}: coverage_status COMPLETE on count-based request (requested_from/to null) — completeness of the market interval is NOT established`);
      const a = auditBars(r.data.items, f);
      if (a.duplicates || a.out_of_order) findings.push(`bars ${f}: ${a.duplicates} duplicate / ${a.out_of_order} out-of-order timestamps`);
      if (r.data.items.some((b) => !Number.isInteger(b.tick_volume))) findings.push(`bars ${f}: non-integer tick_volume in payload`);
    }
  }
  if (t && t.envelope.delivery !== "LIVE") findings.push(`latest tick delivered as ${t.envelope.delivery}, expected LIVE`);

  return (
    <div className="space-y-4 font-mono" data-testid="audit-terminal">
      {/* SYSTEM STATE BAR */}
      <div className="flex flex-wrap gap-2 text-xs" data-testid="audit-labels">
        {["EXNESS MT5", env?.source_mode ?? (health.result?.ok ? health.result.envelope.source_mode : "SOURCE_MODE ?"), "READ-ONLY", OPERATING_MODE, "EXECUTION ABSENT", "WEBSOCKET DEFERRED"].map((l) => (
          <span key={String(l)} className="border border-border px-2 py-0.5">{String(l)}</span>
        ))}
      </div>

      {/* TOP: XAUUSD broker observation */}
      <Box testid="xau-top">
        <H right={<span className={fTone(age.status)} data-testid="freshness">{age.status}{age.age_ms != null ? ` · age ${age.age_ms} ms` : ""}</span>}>
          {AUDIT_SYMBOL} · BROKER OBSERVATION · delivery <span data-testid="tick-delivery">{env?.delivery ?? "—"}</span>
        </H>
        {/* Fixed-height status slot: poll failures change text, never the layout height. */}
        <div className="h-14 overflow-hidden border-b border-border" data-testid="tick-poll-status">
          {tick.result && !tick.result.ok ? (
            <>
              <ErrLine e={tick.result.error} />
              {tickIsLastGood ? <div className="-mt-1 truncate px-3 font-mono text-xs text-muted-foreground" data-testid="tick-last-good">Showing LAST VALIDATED tick (latest poll failed)</div> : null}
            </>
          ) : (
            <div className="truncate px-3 py-2 font-mono text-xs text-muted-foreground">
              {tick.result ? `latest poll OK · client ${tick.at != null ? utc(tick.at) : "—"}` : "latest poll PENDING"}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 px-3 py-2 text-2xl tabular-nums sm:grid-cols-4">
          <div className="min-w-0 break-all"><div className="text-xs text-muted-foreground">BID</div><span data-testid="top-bid">{t ? String(t.data.bid) : "—"}</span></div>
          <div className="min-w-0 break-all"><div className="text-xs text-muted-foreground">ASK</div><span data-testid="top-ask">{t ? String(t.data.ask) : "—"}</span></div>
          <div className="min-w-0 break-all"><div className="text-xs text-muted-foreground">SPREAD (price, UI-derived)</div><span data-testid="top-spread">{t ? (digits != null ? spreadPrice(t.data.bid, t.data.ask).toFixed(digits) : String(spreadPrice(t.data.bid, t.data.ask))) : "—"}</span></div>
          <div className="text-sm"><div className="text-xs text-muted-foreground">BROKER TIME (raw_time_msc)</div>{t ? utc(t.data.raw_time_msc) : "—"}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground">
          <span>Freshness = client_now − timing.source_event_at. Threshold (explicit UI audit policy, not TRS-03):</span>
          <input aria-label="stale threshold ms" className="w-24 border border-border bg-background px-1" type="number" value={staleAfter ?? ""} onChange={(e) => setStaleAfter(e.target.value === "" ? null : Number(e.target.value))} />
          <span>ms (empty = no policy → UNKNOWN). delivery=LIVE ≠ fresh.</span>
        </div>
      </Box>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* MAIN: chart */}
        <Box testid="bar-audit">
          <H right={<span>delivery <span data-testid="bars-delivery">{barRes?.envelope.delivery ?? "—"}</span></span>}>
            <span className="space-x-1" role="tablist">
              {AUDIT_TIMEFRAMES.map((f) => (
                <button key={f} role="tab" aria-selected={tf === f} onClick={() => setTf(f)} className={`px-2 ${tf === f ? "bg-muted text-primary" : ""}`}>{f}</button>
              ))}
            </span>
          </H>
          {barSlot?.result && !barSlot.result.ok ? <ErrLine e={barSlot.result.error} /> : null}
          <Candles bars={items} />
          <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
            Candles drawn only from returned broker bars. No filler, no interpolation. Latest bar status (forming/closed) NOT EXPOSED BY CURRENT CONTRACT.
          </div>
        </Box>

        {/* SIDE: raw tick + spec */}
        <div className="space-y-4">
          <Box testid="raw-tick">
            <H>RAW TICK · GET /v1/ticks/latest/{AUDIT_SYMBOL}</H>
            <KV rows={[
              ["broker_symbol", t?.data.broker_symbol ?? "—"],
              ["raw_time_s", t ? <>{t.data.raw_time_s} <span className="text-muted-foreground">({utc(t.data.raw_time_s * 1000)})</span></> : "—", "raw-time-s"],
              ["raw_time_msc", t ? ts(t.data.raw_time_msc) : "—", "raw-time-msc"],
              ["bid", t ? String(t.data.bid) : "—", "raw-bid"],
              ["ask", t ? String(t.data.ask) : "—", "raw-ask"],
              ["last", t ? String(t.data.last) : "—"],
              ["volume", t ? String(t.data.volume) : "—"],
              ["flags", t ? String(t.data.flags) : "—"],
              ["spread_price (UI = ask − bid)", t ? String(spreadPrice(t.data.bid, t.data.ask)) : "—", "raw-spread"],
              ["source", env?.source ?? "—"],
              ["source_mode", env?.source_mode ?? "—"],
              ["delivery", env?.delivery ?? "—"],
              ["capability", env?.capability ?? "—"],
            ]} />
            <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">TRANSPORT (not market chronology)</div>
            <KV testid="transport-seq" rows={[
              ["sequence", env?.sequence ?? "—", "tick-sequence"],
              ["request_id", env?.request_id ?? "—"],
              ["connection_epoch", env?.connection_epoch ?? "—"],
              ["bridge_instance_id", env?.bridge_instance_id ?? "—"],
            ]} />
            <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">TEMPORAL (broker / bridge clocks)</div>
            <KV testid="temporal" rows={[
              ["source_event_at", env ? ts(env.timing.source_event_at) : "—", "source-event-at"],
              ["bridge_received_at", env ? ts(env.timing.bridge_received_at) : "—"],
              ["bridge_sent_at", env ? ts(env.timing.bridge_sent_at) : "—"],
              ["source_arrival_delay_observed_ms", env ? String(env.latency.source_arrival_delay_observed_ms) : "—", "arrival-delay"],
              ["bridge_processing_ms", env ? String(env.latency.bridge_processing_ms) : "—"],
              ["client_received_at", t ? ts(t.timing.client_received_at) : "—"],
              ["transport_rtt_ms (client)", t ? String(t.timing.transport_rtt_ms) : "—"],
            ]} />
          </Box>

          <Box testid="symbol-spec">
            <H>SYMBOL SPEC · GET /v1/symbols/{AUDIT_SYMBOL}</H>
            {spec.result && !spec.result.ok ? <ErrLine e={spec.result.error} /> : null}
            <KV rows={[
              ...(["broker_symbol", "description", "path", "currency_base", "currency_profit", "digits", "point", "trade_contract_size"] as const).map(
                (k) => [k, spec.result?.ok ? String(spec.result.data[k]) : "—", `spec-${k}`] as [string, string, string]),
              ...NOT_EXPOSED_SPEC_FIELDS.map((k) => [k, <span className="text-warn">NOT EXPOSED BY CURRENT CONTRACT</span>] as [string, React.ReactNode]),
            ]} />
          </Box>
        </div>
      </div>

      {/* RAW BARS */}
      <Box testid="raw-bars">
        <H right={`${items.length} bars · BACKFILL`}>RAW BROKER BARS · {AUDIT_SYMBOL} {tf} · GET /v1/bars/{AUDIT_SYMBOL}/{tf}?mode=pos&start=0&count={BAR_COUNT}</H>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="text-left">{["#", "broker_symbol", "timeframe", "raw_time_s", "UTC", "open", "high", "low", "close", "tick_volume", "spread", "real_volume", "Δs", "diag"].map((h) => <th key={h} className="px-2 py-0.5 font-normal">{h}</th>)}</tr>
            </thead>
            <tbody data-testid="bar-rows">
              {[...items.keys()].reverse().map((i) => {
                const b = items[i]!, d = audit.diagnostics[i]!;
                return (
                  <tr key={`${b.raw_time_s}-${i}`} className="border-t border-border" data-testid="bar-row">
                    <td className="px-2">{i}</td><td className="px-2">{b.broker_symbol}</td><td className="px-2">{b.timeframe}</td>
                    <td className="px-2">{b.raw_time_s}</td><td className="px-2 text-muted-foreground">{utc(b.raw_time_s * 1000)}</td>
                    <td className="px-2">{String(b.open)}</td><td className="px-2">{String(b.high)}</td><td className="px-2">{String(b.low)}</td><td className="px-2">{String(b.close)}</td>
                    <td className="px-2">{String(b.tick_volume)}</td><td className="px-2">{String(b.spread)}</td><td className="px-2">{String(b.real_volume)}</td>
                    <td className="px-2">{d.actual_delta_s ?? "—"}</td>
                    <td className={`px-2 ${d.kind === "CONTIGUOUS" || d.kind === "FIRST" ? "text-muted-foreground" : "text-warn"}`}>{d.kind}{d.missing_intervals ? ` (${d.missing_intervals} missing)` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Box>

      <div className="grid gap-4 md:grid-cols-2">
        <Box testid="coverage">
          <H>HISTORY COVERAGE · all bar requests</H>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground"><tr className="text-left">{["tf", "request", "req_from", "req_to", "count", "oldest", "newest", "coverage_status", "reason"].map((h) => <th key={h} className="px-2 font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {AUDIT_TIMEFRAMES.map((f) => {
                const r = bars[f]?.result;
                if (!r) return <tr key={f} className="border-t border-border"><td className="px-2">{f}</td><td className="px-2" colSpan={8}>PENDING</td></tr>;
                if (!r.ok) return <tr key={f} className="border-t border-border"><td className="px-2">{f}</td><td className="px-2 text-bear" colSpan={8}>REQUEST FAILED · {r.error.kind}</td></tr>;
                const c = r.data.coverage;
                return (
                  <tr key={f} className="border-t border-border" data-testid={`coverage-${f}`}>
                    <td className="px-2">{f}</td><td className="px-2 text-bull">REQUEST COMPLETED</td>
                    <td className="px-2">{String(c.requested_from)}</td><td className="px-2">{String(c.requested_to)}</td><td className="px-2">{c.returned_count}</td>
                    <td className="px-2">{String(c.oldest_returned_at)}</td><td className="px-2">{String(c.newest_returned_at)}</td>
                    <td className="px-2">{c.coverage_status}</td><td className="px-2">{String(c.reason)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
            REQUEST COMPLETED = the HTTP request returned a valid envelope. It is NOT "OBSERVATION COVERAGE COMPLETE". coverage_status is reported verbatim from the gateway; for count-based (pos) requests requested_from/to are null, so interval completeness is not established by this UI.
          </p>
        </Box>

        <Box testid="gap-audit">
          <H>CANDLE / GAP AUDIT · {tf} (UI diagnostics only)</H>
          <KV rows={[
            ["expected interval (s)", audit.expected_delta_s],
            ["bars", audit.count],
            ["CONTIGUOUS", audit.contiguous, "gap-contiguous"],
            ["INTERVAL GAP", audit.gaps, "gap-gaps"],
            ["DUPLICATE TIMESTAMP", audit.duplicates, "gap-dups"],
            ["OUT-OF-ORDER", audit.out_of_order, "gap-ooo"],
          ]} />
          <div className="max-h-40 overflow-auto border-t border-border text-xs">
            {audit.diagnostics.filter((d) => d.kind !== "CONTIGUOUS" && d.kind !== "FIRST").map((d) => (
              <div key={d.index} className="px-3 text-warn">#{d.index} {d.kind} · Δ {d.actual_delta_s}s vs {d.expected_delta_s}s · {utc(d.raw_time_s * 1000)}{d.missing_intervals ? ` · ${d.missing_intervals} intervals absent` : ""}</div>
            ))}
          </div>
          <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">A gap is not a synthetic candle and not automatically a broker failure (weekend / session close / inactivity may explain it).</p>
        </Box>
      </div>

      <Box testid="mt5-compare">
        <H right={<span className="text-warn" data-testid="compare-status">COMPARISON PENDING</span>}>MT5 COMPARISON / AUDIT · compare manually with MT5 Desktop</H>
        <div className="grid gap-4 p-3 md:grid-cols-2">
          <div className="grid grid-cols-2 gap-2 text-lg">
            <div><div className="text-xs text-muted-foreground">Bid</div>{t ? String(t.data.bid) : "—"}</div>
            <div><div className="text-xs text-muted-foreground">Ask</div>{t ? String(t.data.ask) : "—"}</div>
            <div className="min-w-0 break-all"><div className="text-xs text-muted-foreground">Spread (price)</div>{t ? (digits != null ? spreadPrice(t.data.bid, t.data.ask).toFixed(digits) : String(spreadPrice(t.data.bid, t.data.ask))) : "—"}</div>
            <div className="text-sm"><div className="text-xs text-muted-foreground">Broker timestamp</div>{t ? `${t.data.raw_time_msc} · ${utc(t.data.raw_time_msc)}` : "—"}</div>
          </div>
          <div className="grid grid-cols-4 gap-2 text-sm" data-testid="compare-bar">
            <div className="col-span-4 text-xs text-muted-foreground">Latest returned {tf} bar (forming/closed not exposed)</div>
            {([["Open time", latestBar ? `${latestBar.raw_time_s} · ${utc(latestBar.raw_time_s * 1000)}` : "—"], ["Open", latestBar?.open], ["High", latestBar?.high], ["Low", latestBar?.low], ["Close", latestBar?.close], ["Tick vol", latestBar?.tick_volume], ["Spread", latestBar?.spread], ["Real vol", latestBar?.real_volume]] as [string, unknown][]).map(([k, v]) => (
              <div key={k} className={k === "Open time" ? "col-span-4" : ""}><div className="text-xs text-muted-foreground">{k}</div>{v == null ? "—" : String(v)}</div>
            ))}
          </div>
        </div>
        <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">No automatic MATCH: the system has no MT5-side comparison source. Status stays COMPARISON PENDING.</p>
      </Box>

      <Box testid="btc-discovery">
        <H right={<span className="text-warn" data-testid="btc-resolution">BTC SYMBOL RESOLUTION: AMBIGUOUS</span>}>BTC DISCOVERY · GET /v1/symbols?group={BTC_GROUP}</H>
        {btc.result && !btc.result.ok ? <ErrLine e={btc.result.error} /> : null}
        <table className="w-full text-xs">
          <thead className="text-muted-foreground"><tr className="text-left">{["broker_symbol", "description", "path", "base", "profit", "digits", "point", "contract"].map((h) => <th key={h} className="px-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {(btc.result?.ok ? btc.result.data : []).map((s, i) => (
              <tr key={`${s.broker_symbol}-${i}`} className="border-t border-border" data-testid="btc-row">
                <td className="px-2">{s.broker_symbol}</td><td className="px-2">{s.description}</td><td className="px-2">{s.path}</td>
                <td className="px-2">{s.currency_base}</td><td className="px-2">{s.currency_profit}</td><td className="px-2">{s.digits}</td><td className="px-2">{String(s.point)}</td><td className="px-2">{String(s.trade_contract_size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">{btc.result?.ok ? btc.result.data.length : 0} candidates. None auto-selected — group filter is an optimization, not identity resolution.</p>
      </Box>

      <Box testid="findings">
        <H right={`${findings.length}`}>AUDIT FINDINGS (surfaced, not fixed)</H>
        {findings.length === 0 ? <div className="px-3 py-1 text-xs text-muted-foreground">none observed yet</div> :
          findings.map((f) => <div key={f} className="border-t border-border px-3 py-0.5 text-xs text-warn first:border-t-0">{f}</div>)}
      </Box>

      <Box testid="system-state">
        <H>CONNECTION / SYSTEM STATE</H>
        <KV rows={[
          ["Gateway", health.result ? (health.result.ok ? "REACHABLE · valid 3.0B-1 envelope" : `UNREACHABLE/INVALID · ${health.result.error.kind}`) : "PENDING"],
          ["MT5 terminal connected", health.result?.ok ? String(health.result.data.terminal_connected) : "UNKNOWN"],
          ["terminal.connected (observation)", term.result?.ok ? String(term.result.data.connected) : "UNKNOWN"],
          ["terminal ping (ms)", term.result?.ok ? String(term.result.data.terminal_ping_ms) : "—"],
          ["trade_allowed_observed", term.result?.ok ? `${term.result.data.trade_allowed_observed} (OBSERVATION_ONLY — not execution authority)` : "—"],
          ["source", health.result?.ok ? health.result.envelope.source : "—"],
          ["source_mode", health.result?.ok ? health.result.data.source_mode : "—"],
          ["bridge instance", health.result?.ok ? health.result.data.bridge_instance_id : "—"],
          ["connection epoch", health.result?.ok ? health.result.data.connection_epoch : "—"],
          ["OperatingMode", OPERATING_MODE, "op-mode"],
          ["execution.enabled", String(EXECUTION_ENABLED), "exec-enabled"],
          ["Execution capability", "ABSENT"],
          ["WebSocket", "DEFERRED"],
        ]} />
      </Box>

      <details className="border border-border bg-card" data-testid="envelope-inspector">
        <summary className="cursor-pointer px-3 py-1.5 text-xs tracking-widest text-muted-foreground">RAW WIREENVELOPE INSPECTOR (latest validated)</summary>
        <div className="flex flex-wrap gap-1 px-3 py-1 text-xs">
          {Object.keys(envelopes).map((k) => (
            <button key={k} onClick={() => setInspect(k)} className={`border border-border px-2 ${inspect === k ? "bg-muted text-primary" : ""}`}>{k}</button>
          ))}
        </div>
        <pre className="max-h-96 overflow-auto border-t border-border p-3 text-xs" data-testid="envelope-json">{JSON.stringify(envelopes[inspect] ?? null, null, 2)}</pre>
      </details>
    </div>
  );
}
