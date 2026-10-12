import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Expand, Eye, EyeOff, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketCandles } from "@/components/MarketCandles";
import { SnrOverlayLegend } from "@/components/SnrOverlayLegend";
import { selectSnrZones } from "@/lib/snrOverlay";
import { useSnrOverlay } from "@/hooks/use-snr-overlay";
import { useMobileTerminal } from "./MobileTerminalContext";
import { TIMEFRAME_MS, type Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import type { BridgeBar, BridgeHealth, BridgeSymbolInfo, BridgeTick, GatewayResult, TerminalInfoObservation, WireHistoryResult } from "@/core/broker/gateway/types";

export const TERMINAL_MARKETS = ["XAUUSD", "BTCUSD"] as const;
export type TerminalMarket = typeof TERMINAL_MARKETS[number];
export const TERMINAL_TIMEFRAMES: readonly Timeframe[] = ["M5", "M15", "H1", "H4"];
const NAMES: Record<TerminalMarket, string> = { XAUUSD: "Emas vs Dolar AS", BTCUSD: "Bitcoin vs Dolar AS" };
const STALE_AFTER_MS = 60_000; // UI observation policy, not a broker market-hours assertion.
const BAR_COUNT = 200;
/** Same finite source-clock skew tolerance as the canonical runtime (RUNTIME_POLICY.max_source_time_skew_ms). */
export const FRESH_SKEW_TOLERANCE_MS = 10_000;
const TF_S = (tf: Timeframe) => TIMEFRAME_MS[tf] / 1000;

/** FRESH when −skew ≤ age ≤ stale; beyond the skew tolerance in the future the age is UNKNOWN (never clamped). */
export function quoteFreshness(ageMs: number | null, failed: boolean, hasQuote: boolean): "DATA UNAVAILABLE" | "DATA STALE" | "UNKNOWN" | "FRESH" {
  if (!hasQuote) return "DATA UNAVAILABLE";
  if (failed || (ageMs != null && ageMs > STALE_AFTER_MS)) return "DATA STALE";
  if (ageMs == null || ageMs < -FRESH_SKEW_TOLERANCE_MS) return "UNKNOWN";
  return "FRESH";
}
const freshnessLabel = (value: ReturnType<typeof quoteFreshness>) => ({ "DATA UNAVAILABLE": "DATA TIDAK TERSEDIA", "DATA STALE": "DATA KADALUWARSA", UNKNOWN: "TIDAK DIKETAHUI", FRESH: "TERKINI" })[value];

/** Display-only live overlay bar built from canonical LIVE ticks (bid). Not broker evidence; never ingested. */
export type LiveBar = { readonly raw_time_s: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly ticks: number };

/** Apply one LIVE tick to the per-timeframe overlay: update the forming bucket or open a new one at the boundary. */
export function applyLiveTick(live: readonly LiveBar[], tf: Timeframe, eventAtMs: number, bid: number): readonly LiveBar[] {
  const t = Math.floor(eventAtMs / 1000 / TF_S(tf)) * TF_S(tf);
  const last = live.at(-1);
  if (last && t < last.raw_time_s) return live; // late tick for an already-closed bucket: ignore
  if (last && t === last.raw_time_s) return [...live.slice(0, -1), { ...last, high: Math.max(last.high, bid), low: Math.min(last.low, bid), close: bid, ticks: last.ticks + 1 }];
  return [...live, { raw_time_s: t, open: bid, high: bid, low: bid, close: bid, ticks: 1 }].slice(-BAR_COUNT);
}

/** REST broker bars stay the reference; live overlay only extends the newest REST bar or appends newer buckets. */
export function mergeLiveBars(rest: readonly BridgeBar[], live: readonly LiveBar[]): { bars: readonly BridgeBar[]; liveFrom: number | null } {
  const last = rest.at(-1);
  if (!last || live.length === 0) return { bars: rest, liveFrom: null };
  const out = [...rest];
  let liveFrom: number | null = null;
  for (const l of live) {
    const tail = out.at(-1)!;
    if (l.raw_time_s < last.raw_time_s) continue;
    if (l.raw_time_s === tail.raw_time_s) {
      out[out.length - 1] = { ...tail, high: Math.max(tail.high, l.high), low: Math.min(tail.low, l.low), close: l.close };
      liveFrom ??= l.raw_time_s;
    } else if (l.raw_time_s > tail.raw_time_s) {
      out.push({ ...tail, raw_time_s: l.raw_time_s, open: l.open, high: l.high, low: l.low, close: l.close, tick_volume: l.ticks, spread: 0, real_volume: 0 });
      liveFrom ??= l.raw_time_s;
    }
  }
  return { bars: out, liveFrom };
}

type Slot<T> = { value: T | null; error: string | null; failed: boolean };
type SymbolState = {
  quote: Slot<BridgeTick>;
  spec: Slot<BridgeSymbolInfo>;
  bars: Partial<Record<Timeframe, Slot<readonly BridgeBar[]>>>;
};
const blank = <T,>(): Slot<T> => ({ value: null, error: null, failed: false });
const newSymbol = (): SymbolState => ({ quote: blank(), spec: blank(), bars: {} });
const initial = (): Record<TerminalMarket, SymbolState> => ({ XAUUSD: newSymbol(), BTCUSD: newSymbol() });

/** Present only validated REAL Exness observations for the exact product-selected symbol. */
function accepted<T>(r: GatewayResult<T>, symbol: TerminalMarket, delivery: "LIVE" | "BACKFILL", valueSymbol: string): r is Extract<GatewayResult<T>, { ok: true }> {
  return r.ok && r.sequence.disposition !== "QUARANTINE" && r.envelope.source === "EXNESS_MT5" && r.envelope.source_mode === "REAL" && r.envelope.delivery === delivery && valueSymbol === symbol;
}
const errorOf = (r: GatewayResult<unknown>) => r.ok ? "Broker response does not match this market" : `${r.error.kind}: ${r.error.message}`;

export function formatMarketPrice(value: number | null, digits: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : digits == null || digits < 0 || digits > 12 ? String(value) : value.toFixed(digits);
}

export interface RealMarketTerminalProps {
  client: BrokerGatewayClient;
  selectedSymbol: TerminalMarket;
  onSelectedSymbolChange: (symbol: TerminalMarket) => void;
  now?: () => number;
  pollMs?: number;
  /** Canonical runtime readers; their LIVE observations drive the display-only forming candle. */
  liveReaders?: Partial<Record<TerminalMarket, MarketRuntimeReader | null>>;
}

export function RealMarketTerminal({ client, selectedSymbol: selected, onSelectedSymbolChange, now = Date.now, pollMs = 1000, liveReaders }: RealMarketTerminalProps) {
  const mobile = useMobileTerminal();
  const [live, setLive] = useState<Record<string, readonly LiveBar[]>>({});
  const liveSeq = useRef<Record<string, number>>({});
  const [timeframe, setTimeframe] = useState<Timeframe>("M5");
  const [states, setStates] = useState(initial);
  const [health, setHealth] = useState<Slot<BridgeHealth>>(blank);
  const [healthBusy, setHealthBusy] = useState(false);
  const [terminal, setTerminal] = useState<Slot<TerminalInfoObservation>>(blank);
  const [clock, setClock] = useState<number | null>(null);
  const [inspected, setInspected] = useState<BridgeBar | null>(null);
  const [focus, setFocus] = useState(false);
  const [snrAnnotations, setSnrAnnotations] = useState(false);
  const snr = useSnrOverlay(selected);

  const quoteBusy = useRef<Record<TerminalMarket, boolean>>({ XAUUSD: false, BTCUSD: false });
  const barBusy = useRef(new Set<string>());
  const specBusy = useRef(new Set<TerminalMarket>());
  const stateRef = useRef(states);
  stateRef.current = states;

  const patch = useCallback((symbol: TerminalMarket, update: (s: SymbolState) => SymbolState) => {
    setStates((previous) => ({ ...previous, [symbol]: update(previous[symbol]) }));
  }, []);

  const pollQuote = useCallback(async (symbol: TerminalMarket) => {
    if (quoteBusy.current[symbol]) return;
    quoteBusy.current[symbol] = true;
    try {
      const r = await client.getLatestTick(symbol);
      patch(symbol, (s) => ({ ...s, quote: accepted(r, symbol, "LIVE", r.ok ? r.data.broker_symbol : "")
        ? { value: r.data, failed: false, error: null }
        : { ...s.quote, failed: true, error: errorOf(r) } }));
    } catch {
      patch(symbol, (s) => ({ ...s, quote: { ...s.quote, failed: true, error: "Gateway tidak dapat dijangkau" } }));
    } finally { quoteBusy.current[symbol] = false; setClock(now()); }
  }, [client, now, patch]);

  const loadSpec = useCallback(async (symbol: TerminalMarket) => {
    if (specBusy.current.has(symbol) || stateRef.current[symbol].spec.value) return;
    specBusy.current.add(symbol);
    try {
      const r = await client.getSymbol(symbol);
      patch(symbol, (s) => ({ ...s, spec: accepted(r, symbol, "LIVE", r.ok ? r.data.broker_symbol : "")
        ? { value: r.data, failed: false, error: null }
        : { ...s.spec, failed: true, error: errorOf(r) } }));
    } catch {
      patch(symbol, (s) => ({ ...s, spec: { ...s.spec, failed: true, error: "Spesifikasi simbol tidak tersedia" } }));
    } finally { specBusy.current.delete(symbol); }
  }, [client, patch]);

  const loadBars = useCallback(async (symbol: TerminalMarket, tf: Timeframe) => {
    const key = `${symbol}:${tf}`;
    if (barBusy.current.has(key)) return;
    barBusy.current.add(key);
    try {
      const r: GatewayResult<WireHistoryResult<BridgeBar>> = await client.getBars({ symbol, timeframe: tf, mode: "pos", start: 0, count: BAR_COUNT });
      const ordered = r.ok && r.data.items.every((bar, i, list) => bar.broker_symbol === symbol && bar.timeframe === tf && (i === 0 || list[i - 1]!.raw_time_s < bar.raw_time_s));
      patch(symbol, (s) => ({ ...s, bars: { ...s.bars, [tf]: accepted(r, symbol, "BACKFILL", symbol) && ordered
        ? { value: r.data.items, failed: false, error: null }
        : { ...(s.bars[tf] ?? blank<readonly BridgeBar[]>()), failed: true, error: !r.ok ? errorOf(r) : !ordered ? "Candle broker memiliki simbol, timeframe, atau urutan yang tidak sesuai" : errorOf(r) } } }));
    } catch {
      patch(symbol, (s) => ({ ...s, bars: { ...s.bars, [tf]: { ...(s.bars[tf] ?? blank<readonly BridgeBar[]>()), failed: true, error: "Candle tidak tersedia" } } }));
    } finally { barBusy.current.delete(key); }
  }, [client, patch]);

  useEffect(() => {
    let active = true;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      if (active) setHealthBusy(true);
      try {
        const r = await client.getHealth();
        if (active) setHealth((old) => r.ok && r.envelope.source === "EXNESS_MT5" && r.envelope.source_mode === "REAL"
          ? { value: r.data, failed: false, error: null }
          : { ...old, failed: true, error: errorOf(r) });
      } catch { if (active) setHealth((old) => ({ ...old, failed: true, error: "Gateway tidak dapat dijangkau" })); }
      try {
        const t = await client.getTerminal();
        if (active) setTerminal((old) => t.ok && t.envelope.source === "EXNESS_MT5" && t.envelope.source_mode === "REAL" && t.data.authority === "OBSERVATION_ONLY"
          ? { value: t.data, failed: false, error: null }
          : { ...old, failed: true, error: errorOf(t) });
      } catch { if (active) setTerminal((old) => ({ ...old, failed: true, error: "Status terminal tidak dapat dijangkau" })); }
      finally { busy = false; if (active) setHealthBusy(false); }
    };
    void poll();
    const timer = setInterval(poll, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      await loadSpec(selected);
      if (active) await loadBars(selected, timeframe);
    };
    void load();
    const refresh = setInterval(() => {
      void load();
    }, 30_000);
    return () => { active = false; clearInterval(refresh); };
  }, [selected, timeframe, loadSpec, loadBars]);

  useEffect(() => {
    void pollQuote(selected);
    const timer = setInterval(() => { void pollQuote(selected); }, pollMs);
    const clockTimer = setInterval(() => setClock(now()), 1000);
    return () => { clearInterval(timer); clearInterval(clockTimer); };
  }, [selected, pollMs, pollQuote, now]);

  // Realtime forming candle: poll the canonical runtime's latest LIVE observation (no transport here).
  useEffect(() => {
    const reader = liveReaders?.[selected];
    if (!reader) return;
    const step = () => {
      const e = reader.latestLiveObservation();
      if (!e || e.symbol !== selected) return;
      const key = `${selected}:${timeframe}`;
      if (liveSeq.current[key] === e.seq) return;
      liveSeq.current[key] = e.seq;
      setLive((old) => ({ ...old, [key]: applyLiveTick(old[key] ?? [], timeframe, e.event_at, e.bid) }));
    };
    step();
    const t = setInterval(step, 250);
    return () => clearInterval(t);
  }, [liveReaders, selected, timeframe]);

  useEffect(() => { setInspected(null); }, [selected, timeframe]);
  useEffect(() => {
    if (!focus) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setFocus(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focus]);

  const state = states[selected];
  const digits = state.spec.value?.digits ?? null;
  const quote = state.quote.value;
  const snrZones = useMemo(() => selectSnrZones(snr.snapshot, quote?.bid ?? null, timeframe), [snr.snapshot, quote?.bid, timeframe]);
  const snrSwings = useMemo(() => (snr.snapshot?.swings ?? []).filter((s) => s.timeframe === (timeframe === "M5" ? "M15" : timeframe)), [snr.snapshot, timeframe]);
  const bars = state.bars[timeframe];
  const liveBars = live[`${selected}:${timeframe}`];
  const merged = useMemo(() => mergeLiveBars(bars?.value ?? [], liveBars ?? []), [bars?.value, liveBars]);
  const chartBars = merged.bars;
  const candle = inspected && chartBars.includes(inspected) ? inspected : chartBars.at(-1) ?? null;
  const ageMs = quote && clock != null ? clock - quote.raw_time_msc : null;
  const freshness = quoteFreshness(ageMs, state.quote.failed, !!quote);
  // Verified terminal connectivity requires BOTH health.terminal_connected and /v1/terminal connected=true.
  const termOk = !!terminal.value?.connected && !terminal.failed;
  const connection = health.value?.terminal_connected && !health.failed && termOk ? "TERHUBUNG" : health.value?.terminal_connected || terminal.value?.connected ? "DATA TERGANGGU" : health.value || terminal.value ? "TERPUTUS" : healthBusy ? "MENGHUBUNGKAN" : "DATA TIDAK TERSEDIA";
  const terminalLine = terminal.value ? `Terminal MT5 ${terminal.value.connected ? "terhubung" : "terputus"} · ping ${terminal.value.terminal_ping_ms.toFixed(1)} ms · ${terminal.value.authority}${terminal.failed ? " · VALIDASI TERAKHIR" : ""}` : terminal.failed ? `Status terminal MT5 tidak tersedia · ${terminal.error ?? ""}` : "Menunggu status terminal MT5";
  const price = (n: number | null) => formatMarketPrice(n, digits);
  const ohlc = ([{ label: "OPEN", key: "open" }, { label: "HIGH", key: "high" }, { label: "LOW", key: "low" }, { label: "CLOSE", key: "close" }] as const).map(({ label, key }) => ({ label, key, value: candle ? price(candle[key]) : "—" }));
  const publishObservation = mobile?.setObservation;
  const annotationToggle = <Button size="icon" variant={snrAnnotations ? "secondary" : "ghost"} aria-label="Detail SNR" aria-pressed={snrAnnotations} title={snrAnnotations ? "Sembunyikan label SNR" : "Tampilkan label SNR"} onClick={() => setSnrAnnotations((value) => !value)}>{snrAnnotations ? <Eye /> : <EyeOff />}</Button>;
  useEffect(() => {
    publishObservation?.({ symbol: selected, bid: formatMarketPrice(quote?.bid ?? null, digits), ask: formatMarketPrice(quote?.ask ?? null, digits), spread: formatMarketPrice(quote ? quote.ask - quote.bid : null, digits), connected: connection === "TERHUBUNG", fresh: freshness === "FRESH", detail: `${terminalLine} · ${freshnessLabel(freshness)}` });
  }, [publishObservation, selected, quote, digits, connection, freshness, terminalLine]);

  return (
    <div className={`real-market-terminal overflow-x-clip bg-background text-foreground ${mobile?.tab !== "TRADE" || mobile?.accessory ? "mobile-market-hidden" : ""}`}>
      <header className="border-b border-border px-4 py-3 sm:px-8">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-4">
          <div className="min-w-0"><div className="truncate text-sm font-semibold uppercase tracking-widest sm:text-base">PERSONAL AI TRADING OS</div><div className="mt-0.5 text-[11px] text-muted-foreground">TARGET: EXNESS DEMO <span className="text-border">/</span> BACA SAJA</div></div>
          <Button asChild size="icon" variant="ghost" aria-label="Diagnostik pengembang" title="Diagnostik pengembang" className="shrink-0 text-muted-foreground"><Link to="/audit"><Settings2 /></Link></Button>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl space-y-5 px-4 py-5 sm:px-8 sm:py-7">
        <div className="flex gap-2" role="group" aria-label="Pasar">
          {TERMINAL_MARKETS.map((symbol) => <Button key={symbol} type="button" variant={selected === symbol ? "default" : "outline"} onClick={() => onSelectedSymbolChange(symbol)} aria-pressed={selected === symbol} className="h-10 flex-1 font-mono text-sm sm:max-w-36" data-testid={`select-${symbol}`}>{symbol}</Button>)}
        </div>
        <section className="min-w-0" aria-label="Pasar terpilih">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0"><h1 className="text-3xl font-semibold sm:text-4xl" data-testid="market-title">{selected}</h1><p className="mt-1 text-sm text-muted-foreground">{state.spec.value?.description || NAMES[selected]}</p></div>
            <div className="font-mono text-xs text-muted-foreground">{selected === "XAUUSD" ? "GOLD" : "BITCOIN"} / USD</div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2 border-y border-border py-4 sm:gap-8" data-testid="quote-panel">
            {([{ label: "BID", value: quote?.bid ?? null }, { label: "ASK", value: quote?.ask ?? null }, { label: "SPREAD", value: quote ? quote.ask - quote.bid : null }] as const).map(({ label, value }) => <div key={label} className="min-w-0"><div className="text-[10px] font-medium text-muted-foreground sm:text-xs">{label}</div><div className="mt-1 truncate font-mono text-base font-semibold tabular-nums sm:text-3xl" title={price(value)} data-testid={label.toLowerCase()}>{price(value)}</div></div>)}
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs sm:flex sm:gap-6">
            <span className="min-w-0 truncate text-muted-foreground">GATEWAY · <strong className={connection === "TERHUBUNG" ? "text-bull" : "text-warn"} data-testid="connection">{connection}</strong></span>
            <span className={freshness === "FRESH" ? "text-bull" : "text-warn"} data-testid="freshness">{freshnessLabel(freshness)}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground" data-testid="terminal-status" title="Identitas akun/login tidak ditampilkan oleh gateway baca-saja">{terminalLine}</div>
          {state.quote.failed && quote && <div className="mt-2 text-xs text-warn" data-testid="last-validated">DATA VALID TERAKHIR · harga terbaru tidak tersedia</div>}
          {!quote && state.quote.failed && <div className="mt-2 text-xs text-warn" data-testid="quote-error">{selected} · DATA TIDAK TERSEDIA</div>}
        </section>
        <section className="min-w-0" aria-label="Grafik pasar">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex min-w-0 gap-1" role="group" aria-label="Timeframes">{TERMINAL_TIMEFRAMES.map((tf) => <Button type="button" size="sm" key={tf} variant={timeframe === tf ? "secondary" : "ghost"} aria-pressed={timeframe === tf} onClick={() => setTimeframe(tf)} className="h-9 min-w-11 px-2 font-mono text-xs" data-testid={`timeframe-${tf}`}>{tf}</Button>)}</div>
             <div className="flex shrink-0 gap-1">{annotationToggle}<Button size="icon" variant="ghost" aria-label="Fokus grafik" title="Fokus grafik" onClick={() => setFocus(true)}><Expand /></Button></div>
          </div>
          <div className="relative h-[380px] min-w-0 overflow-hidden border-y border-border sm:h-[580px] lg:h-[650px]" data-testid="chart-area">
             {chartBars.length > 0 && digits != null ? <MarketCandles key={`${selected}:${timeframe}`} bars={chartBars} digits={digits} snrZones={snrZones} snrSwings={snrSwings} annotationsVisible={snrAnnotations} onInspect={setInspected} onActivate={() => setFocus(true)} focus={false} /> : <div className="grid h-full place-items-center text-sm text-muted-foreground" data-testid="chart-empty">{bars?.failed ? "DATA GRAFIK TIDAK TERSEDIA" : "Memuat candle broker asli…"}</div>}
          </div>
          <SnrOverlayLegend snapshot={snr.snapshot} zones={snrZones} digits={digits} visible={snrAnnotations || !snr.snapshot?.zones.length} />
          <div className="mt-2 flex min-h-6 items-center justify-between gap-2 text-xs text-muted-foreground"><span>{selected} · {timeframe} · CANDLE BROKER{merged.liveFrom != null ? " + CANDLE AKTIF (dari tick, hanya tampilan)" : ""}</span><span className="text-right">{bars?.failed && chartBars.length ? "DATA VALID TERAKHIR" : bars?.failed ? "DATA TIDAK TERSEDIA" : "DATA ASLI"}</span></div>
          {candle && <div className="mt-1 text-xs text-muted-foreground" data-testid="candle-time">{new Date(candle.raw_time_s * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}{inspected ? " · candle terpilih" : " · candle terbaru"}</div>}
        </section>
        <section aria-label="Ringkasan candle" className="grid grid-cols-4 gap-2 border-t border-border pt-4" data-testid="ohlc-snapshot">{ohlc.map(({ label, key, value }) => <div key={label} className="min-w-0"><div className="text-[10px] text-muted-foreground sm:text-xs">{label}</div><div className="mt-1 truncate font-mono text-xs tabular-nums sm:text-lg" title={value} data-testid={`ohlc-${key}`}>{value}</div></div>)}</section>
      </main>
      {focus && <div role="dialog" aria-label="Mode fokus grafik" aria-modal="true" className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3"><div className="min-w-0 truncate font-mono text-sm">{selected} <span className="text-muted-foreground">/ {timeframe}</span></div><div className="flex gap-1">{annotationToggle}<Button type="button" size="icon" variant="ghost" onClick={() => setFocus(false)} aria-label="Tutup fokus grafik" title="Tutup fokus grafik"><X /></Button></div></div>
         <div className="min-h-0 flex-1" data-testid="focus-chart">{chartBars.length && digits != null ? <MarketCandles key={`${selected}:${timeframe}`} bars={chartBars} digits={digits} snrZones={snrZones} snrSwings={snrSwings} annotationsVisible={snrAnnotations} onInspect={setInspected} onActivate={() => {}} focus /> : <div className="grid h-full place-items-center text-muted-foreground">DATA GRAFIK TIDAK TERSEDIA</div>}</div>
         <div className="max-h-28 shrink-0 overflow-y-auto px-3"><SnrOverlayLegend snapshot={snr.snapshot} zones={snrZones} digits={digits} visible={snrAnnotations || !snr.snapshot?.zones.length} /></div>
        <div className="shrink-0 border-t border-border px-3 py-2"><div className="text-xs text-muted-foreground">{candle ? new Date(candle.raw_time_s * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC") : "Candle tidak tersedia"}</div><div className="mt-1 grid grid-cols-4 gap-2">{ohlc.map(({ label, value }) => <div key={label} className="min-w-0"><div className="text-[10px] text-muted-foreground">{label}</div><div className="truncate font-mono text-xs" title={value}>{value}</div></div>)}</div></div>
        <Button type="button" variant="ghost" className="shrink-0 sm:hidden" onClick={() => setFocus(false)}><ArrowLeft /> Kembali ke pasar</Button>
      </div>}
    </div>
  );
}