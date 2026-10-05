import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, Check, Circle, Minus, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { TechnicalSliceService } from "@/core/technical/TechnicalSliceService";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { Indicator } from "@/core/technical/indicators";
import type { Relation, Structure } from "@/core/technical/indicators";
import { TIMEFRAMES, type TradingSnapshot, type WhyFact } from "@/core/technical/tradingState";
import type { AiWhyResult } from "@/lib/ai-why.functions";

const n = (value: number | null | undefined, digits = 3) => value == null || !Number.isFinite(value) ? "—" : Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(digits);
const indicator = (value: Indicator | undefined, digits = 1) => !value || value.status !== "OK" ? "DATA BELUM CUKUP" : n(value.value, digits);

export type CockpitSignal = "BUY" | "SELL" | "HOLD";
export type ConfirmationTone = "BULL" | "BEAR" | "NEUTRAL";

export function cockpitSignal(snapshot: TradingSnapshot | null): CockpitSignal {
  if (snapshot?.entry.state === "LONG_CANDIDATE") return "BUY";
  if (snapshot?.entry.state === "SHORT_CANDIDATE") return "SELL";
  return "HOLD";
}

export function referenceEntry(snapshot: TradingSnapshot | null): number | null {
  const signal = cockpitSignal(snapshot);
  if (signal === "BUY") return snapshot?.quote?.ask ?? null;
  if (signal === "SELL") return snapshot?.quote?.bid ?? null;
  return null;
}

export interface TechnicalSlicePanelProps {
  runtimes: readonly { readonly symbol: string; readonly reader: MarketRuntimeReader | null }[];
  selectedSymbol: string;
  unmountedReason?: string;
  tickMs?: number;
  explain?: (snapshot: string) => Promise<AiWhyResult>;
}

function trendTone(relation: Relation | undefined): ConfirmationTone {
  return relation === "EMA5_ABOVE_EMA21" ? "BULL" : relation === "EMA5_BELOW_EMA21" ? "BEAR" : "NEUTRAL";
}

function structureTone(structure: Structure["summary"] | undefined): ConfirmationTone {
  return structure === "HH_HL" ? "BULL" : structure === "LH_LL" ? "BEAR" : "NEUTRAL";
}

const toneClass: Record<ConfirmationTone, string> = {
  BULL: "border-bull/35 bg-bull/10 text-bull",
  BEAR: "border-bear/35 bg-bear/10 text-bear",
  NEUTRAL: "border-border bg-muted/35 text-muted-foreground",
};

function ConfirmationLight({ label, value, tone, testId }: { label: string; value: string; tone: ConfirmationTone; testId: string }) {
  return <div className={`min-w-0 border px-3 py-2.5 ${toneClass[tone]}`} data-testid={testId}>
    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase text-muted-foreground">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone === "BULL" ? "bg-bull" : tone === "BEAR" ? "bg-bear" : "bg-muted-foreground"}`} />
      <span className="truncate">{label}</span>
    </div>
    <div className="mt-1 truncate text-sm font-semibold" title={value}>{value}</div>
  </div>;
}

function factTone(fact: WhyFact) {
  return fact.ok === true ? "text-bull" : fact.ok === false ? "text-bear" : "text-muted-foreground";
}

function FactIcon({ value }: { value: boolean | null }) {
  return value === true ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : value === false ? <X className="mt-0.5 h-4 w-4 shrink-0" /> : <Minus className="mt-0.5 h-4 w-4 shrink-0" />;
}

function ActionButton({ side, enabled, onClick }: { side: "BUY" | "SELL"; enabled: boolean; onClick: () => void }) {
  const activeClass = side === "BUY"
    ? "border-bull bg-bull text-primary-foreground hover:bg-bull/90"
    : "border-bear bg-bear text-primary-foreground hover:bg-bear/90";
  return <Button
    type="button"
    size="lg"
    disabled={!enabled}
    aria-label={`${side} rencana acuan`}
    data-testid={`action-${side.toLowerCase()}`}
    className={`h-14 w-full border text-base font-semibold ${enabled ? activeClass : "border-border bg-muted text-muted-foreground"}`}
    onClick={onClick}
  >{side === "BUY" ? <ArrowUpRight /> : <ArrowDownRight />}{side}</Button>;
}

function ReadOnlyPlan({ side, entry, confirmations, onClose }: { side: "BUY" | "SELL"; entry: number | null; confirmations: readonly string[]; onClose: () => void }) {
  return <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-background/80" />
    <Dialog.Content className="fixed inset-x-4 top-1/2 z-50 max-h-[85vh] -translate-y-1/2 overflow-y-auto border border-border bg-card p-5 shadow-2xl sm:left-1/2 sm:right-auto sm:w-full sm:max-w-md sm:-translate-x-1/2" aria-describedby="trade-plan-description">
      <div className="flex items-start justify-between gap-4">
        <div><Dialog.Title className={`text-2xl font-semibold ${side === "BUY" ? "text-bull" : "text-bear"}`}>Rencana acuan {side}</Dialog.Title><Dialog.Description id="trade-plan-description" className="mt-1 text-sm text-muted-foreground">Tinjauan baca-saja berdasarkan sinyal deterministik saat ini.</Dialog.Description></div>
        <Dialog.Close asChild><Button type="button" size="icon" variant="ghost" aria-label="Tutup rencana transaksi"><X /></Button></Dialog.Close>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Sisi</dt><dd className="mt-0.5 font-semibold">{side}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Acuan Entry</dt><dd className="mt-0.5 font-mono font-semibold">{entry == null ? "—" : n(entry)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">SL</dt><dd className="mt-0.5">ATURAN BELUM DITETAPKAN</dd></div>
        <div><dt className="text-xs text-muted-foreground">TP1</dt><dd className="mt-0.5">ATURAN BELUM DITETAPKAN</dd></div>
        <div><dt className="text-xs text-muted-foreground">TP2</dt><dd className="mt-0.5">ATURAN BELUM DITETAPKAN</dd></div>
        <div><dt className="text-xs text-muted-foreground">R:R</dt><dd className="mt-0.5">—</dd></div>
      </dl>
      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Konfirmasi sinyal</div>
        <ul className="mt-2 space-y-1.5 text-sm">{confirmations.map((item) => <li key={item} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span>{item}</span></li>)}</ul>
      </div>
      <div className="mt-5 border border-border bg-muted/40 px-3 py-3 text-center text-sm font-semibold" data-testid="no-order-status">MONITOR SAJA — TIDAK ADA ORDER DIKIRIM</div>
      <Button type="button" variant="outline" className="mt-3 w-full" onClick={onClose}>Tutup</Button>
    </Dialog.Content>
  </Dialog.Portal>;
}

export function TradeActions({ signal, entry, reason, confirmations }: { signal: CockpitSignal; entry: number | null; reason: string; confirmations: readonly string[] }) {
  const [planSide, setPlanSide] = useState<"BUY" | "SELL" | null>(null);
  return <>
    <div className="mt-5 grid grid-cols-2 gap-2" aria-label="Trade actions">
      <ActionButton side="BUY" enabled={signal === "BUY"} onClick={() => setPlanSide("BUY")} />
      <ActionButton side="SELL" enabled={signal === "SELL"} onClick={() => setPlanSide("SELL")} />
    </div>
    {signal === "HOLD" ? <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="action-disabled-reason">{reason}</p> : null}
    <Dialog.Root open={planSide !== null} onOpenChange={(open) => { if (!open) setPlanSide(null); }}>
      {planSide ? <ReadOnlyPlan side={planSide} entry={entry} confirmations={confirmations} onClose={() => setPlanSide(null)} /> : null}
    </Dialog.Root>
  </>;
}

function Cockpit({ service, explain }: { service: TechnicalSliceService; explain?: TechnicalSlicePanelProps["explain"] }) {
  useSyncExternalStore(service.subscribe, service.getVersion, service.getVersion);
  const view = service.view();
  const snapshot = view.current;
  const evidence = snapshot?.evidence;
  const signal = cockpitSignal(snapshot);
  const entry = referenceEntry(snapshot);
  const unavailable = !snapshot || snapshot.availability === "UNAVAILABLE" || snapshot.entry.state === "NOT_EVALUABLE";
  const signalReason = unavailable ? "menunggu bukti teknikal yang valid" : snapshot?.entry.reason ?? "tunggu setup valid";
  const signalTone = signal === "BUY" ? "text-bull" : signal === "SELL" ? "text-bear" : "text-foreground";
  const signalBorder = signal === "BUY" ? "border-bull/45" : signal === "SELL" ? "border-bear/45" : "border-border";
  const [ai, setAi] = useState<AiWhyResult | { status: "PENDING" } | null>(null);

  const runAi = async () => {
    if (!snapshot || !explain) { setAi({ status: "AI_ANALYST_UNAVAILABLE", reason: "Penyedia AI belum dikonfigurasi" }); return; }
    setAi({ status: "PENDING" });
    try {
      setAi(await explain(JSON.stringify({ ...snapshot, evidence: snapshot.evidence ? Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { ...snapshot.evidence?.[tf], structure: { ...snapshot.evidence?.[tf].structure, swings: snapshot.evidence?.[tf].structure.swings.slice(-6) } }])) : null })));
    } catch (error) { setAi({ status: "AI_ANALYST_UNAVAILABLE", reason: (error as Error).message }); }
  };

  const h4Tone = trendTone(evidence?.H4.relation);
  const h1Tone = trendTone(evidence?.H1.relation);
  const h1StructureTone = structureTone(evidence?.H1.structure.summary);
  const triggerTone: ConfirmationTone = snapshot?.engulfing?.bullish ? "BULL" : snapshot?.engulfing?.bearish ? "BEAR" : "NEUTRAL";
  const triggerText = snapshot?.engulfing?.bullish ? "BULLISH TERKONFIRMASI" : snapshot?.engulfing?.bearish ? "BEARISH TERKONFIRMASI" : snapshot?.engulfing ? "BELUM TERKONFIRMASI" : "DATA BELUM CUKUP";
  const snr = evidence?.H1.snr;
  const location = snr ? `S ${n(snr.nearest_support?.price)} · R ${n(snr.nearest_resistance?.price)}` : "DATA BELUM CUKUP";
  const planConfirmations = snapshot?.why.slice(0, 5).map((fact) => fact.text) ?? ["Menunggu bukti teknikal yang valid"];

  return <article className="space-y-4" data-testid={`cockpit-${view.symbol}`}>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
      <section className={`border bg-card p-4 sm:p-5 ${signalBorder}`} data-testid="main-signal-card">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Sinyal saat ini · {view.symbol}</span>
          <span className="border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground">MONITOR SAJA</span>
        </div>
        <div className="mt-4 flex items-end gap-3">
          {signal === "BUY" ? <ArrowUpRight className="mb-2 h-9 w-9 text-bull" /> : signal === "SELL" ? <ArrowDownRight className="mb-2 h-9 w-9 text-bear" /> : <Circle className="mb-2 h-8 w-8 text-muted-foreground" />}
          <div className={`text-5xl font-semibold sm:text-6xl ${signalTone}`} data-testid="cockpit-signal">{signal}</div>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground" data-testid="cockpit-signal-reason">{signalReason}</p>
      </section>

      <section className="border border-border bg-card p-4 sm:p-5" aria-label="Rencana transaksi acuan">
        <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Rencana acuan</h3></div>
        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
          <div><div className="text-xs text-muted-foreground">Acuan Entry</div><div className="mt-0.5 font-mono font-semibold" data-testid="reference-entry">{entry == null ? "—" : n(entry)}</div></div>
          <div><div className="text-xs text-muted-foreground">Status</div><div className="mt-0.5 font-semibold">{signal === "HOLD" ? "TUNGGU SETUP VALID" : "MONITOR SAJA"}</div></div>
          <div><div className="text-xs text-muted-foreground">Stop Loss</div><div className="mt-0.5" data-testid="plan-sl">{signal === "HOLD" ? "—" : "ATURAN BELUM DITETAPKAN"}</div></div>
          <div><div className="text-xs text-muted-foreground">TP1</div><div className="mt-0.5" data-testid="plan-tp1">{signal === "HOLD" ? "—" : "ATURAN BELUM DITETAPKAN"}</div></div>
          <div><div className="text-xs text-muted-foreground">TP2</div><div className="mt-0.5" data-testid="plan-tp2">{signal === "HOLD" ? "—" : "ATURAN BELUM DITETAPKAN"}</div></div>
          <div><div className="text-xs text-muted-foreground">R:R</div><div className="mt-0.5">—</div></div>
        </div>
        <TradeActions signal={signal} entry={entry} reason={signalReason} confirmations={planConfirmations} />
      </section>
    </div>

    <section aria-label="Konfirmasi teknikal">
      <div className="mb-2 flex items-center gap-2"><Activity className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Konfirmasi teknikal</h3></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <ConfirmationLight label="H4 Trend" value={evidence?.H4.relation.replaceAll("_", " ") ?? "Insufficient"} tone={h4Tone} testId="confirm-h4" />
        <ConfirmationLight label="H1 Trend" value={evidence?.H1.relation.replaceAll("_", " ") ?? "Insufficient"} tone={h1Tone} testId="confirm-h1" />
        <ConfirmationLight label="Struktur H1" value={evidence?.H1.structure.summary.replace("_", "/") ?? "DATA BELUM CUKUP"} tone={h1StructureTone} testId="confirm-structure" />
        <ConfirmationLight label="Pemicu M5" value={triggerText} tone={triggerTone} testId="confirm-trigger" />
        <ConfirmationLight label="RSI14" value={indicator(evidence?.M5.rsi14)} tone="NEUTRAL" testId="confirm-rsi" />
        <ConfirmationLight label="S/R Location" value={location} tone="NEUTRAL" testId="confirm-snr" />
        <ConfirmationLight label="ATR / Volatility" value={indicator(evidence?.M5.atr14, 3)} tone="NEUTRAL" testId="confirm-atr" />
      </div>
    </section>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="border-t border-border pt-4" aria-label="Alasan konfirmasi">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">Alasan</h3>
        <ul className="mt-3 space-y-2 text-sm" data-testid="confirmation-list">
          {(snapshot?.why.slice(0, 6) ?? [{ ok: null, text: "Menunggu bukti teknikal yang valid" }]).map((fact, index) => <li key={`${fact.text}-${index}`} className={`flex gap-2 ${factTone(fact)}`}><FactIcon value={fact.ok} /><span className="text-foreground/90">{fact.text}</span></li>)}
        </ul>
      </section>
      <section className="border-t border-border pt-4" aria-label="Penjelasan AI">
        <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Penjelasan AI</h3></div><Button size="sm" variant="outline" onClick={runAi} disabled={ai?.status === "PENDING"}>Jelaskan</Button></div>
        <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground" data-testid={`${view.symbol}-ai`}>{ai == null ? "Penjelasan ringkas opsional. Sinyal deterministik tetap menjadi acuan." : ai.status === "OK" ? ai.narrative : ai.status === "PENDING" ? "Menganalisis…" : `Penjelasan AI tidak tersedia — ${ai.reason}`}</p>
      </section>
    </div>
  </article>;
}

export function TechnicalSlicePanel({ runtimes, selectedSymbol, unmountedReason, tickMs = 2000, explain }: TechnicalSlicePanelProps) {
  const services = useMemo(() => runtimes.map((runtime) => new TechnicalSliceService(runtime.reader, runtime.symbol, new LiveClock(), unmountedReason)), [runtimes, unmountedReason]);
  useEffect(() => {
    const tick = () => { for (const service of services) service.tick(); };
    tick();
    const timer = setInterval(tick, tickMs);
    return () => clearInterval(timer);
  }, [services, tickMs]);
  const selected = services.find((service) => service.symbol === selectedSymbol) ?? null;
  return <section className="bg-background px-4 pb-8 sm:px-8" aria-label="Kokpit trading">
    <div className="mx-auto max-w-screen-2xl">{selected ? <Cockpit service={selected} explain={explain} /> : <div className="border border-border bg-card p-4 text-sm text-muted-foreground">Menunggu pasar terpilih…</div>}</div>
  </section>;
}