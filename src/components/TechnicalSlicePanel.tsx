import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, Check, Circle, Minus, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { TechnicalSliceService } from "@/core/technical/TechnicalSliceService";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { Indicator } from "@/core/technical/indicators";
import type { Relation, Structure } from "@/core/technical/indicators";
import type { TradingSnapshot, WhyFact } from "@/core/technical/tradingState";
import type { AiWhyResult } from "@/lib/ai-why.functions";
import { sharedPaperJournal, type PaperJournalStore } from "@/lib/paperJournal";
import { aiSummaryPayload } from "@/lib/tradeSummary";

const uiClock = new LiveClock();
/** Short Indonesian error for the AI section; never raw validation JSON. */
export function friendlyAiError(reason: string): string {
  if (/^\s*[[{]/.test(reason) || /too_big|validation|zod|max/i.test(reason)) return "Permintaan ke AI ditolak karena format/ukuran data. Coba lagi nanti.";
  return reason.length > 140 ? `${reason.slice(0, 140)}…` : reason;
}

const n = (value: number | null | undefined, digits = 3) => value == null || !Number.isFinite(value) ? "—" : Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(digits);
const indicator = (value: Indicator | undefined, digits = 1) => !value || value.status !== "OK" ? "DATA BELUM CUKUP" : n(value.value, digits);
const technicalCopy = (text: string) => text
  .replaceAll("INSUFFICIENT_HISTORY", "DATA BELUM CUKUP")
  .replaceAll("NOT_EVALUABLE", "BELUM DAPAT DINILAI")
  .replaceAll("MARKET_STATE_UNAVAILABLE", "KONDISI PASAR TIDAK TERSEDIA")
  .replaceAll("EMA5_ABOVE_EMA21", "EMA5 DI ATAS EMA21")
  .replaceAll("EMA5_BELOW_EMA21", "EMA5 DI BAWAH EMA21")
  .replaceAll("EMA_NOT_ALIGNED", "EMA BELUM SELARAS")
  .replaceAll("SETUP_NOT_ACTIVE", "SETUP BELUM AKTIF")
  .replaceAll("NO_CLOSED_M5_TRIGGER", "BELUM ADA PEMICU M5 CLOSED")
  .replaceAll("H1_RSI14_INSUFFICIENT_HISTORY", "RSI14 H1: DATA BELUM CUKUP")
  .replaceAll("H1_RSI14_NEUTRAL_50", "RSI14 H1 NETRAL DI 50")
  .replaceAll("H1_RSI14_CONFLICTS_BUY", "RSI14 H1 BELUM MENDUKUNG BUY")
  .replaceAll("H1_RSI14_CONFLICTS_SELL", "RSI14 H1 BELUM MENDUKUNG SELL")
  .replaceAll("Entry analysis", "Analisis entry")
  .replaceAll("Execution", "Eksekusi")
  .replaceAll("Current market state cannot be established", "Kondisi pasar saat ini belum dapat dipastikan")
  .replaceAll("causal structure", "struktur kausal")
  .replaceAll("nearest support", "support terdekat")
  .replaceAll("resistance", "resistance")
  .replaceAll("location policy", "aturan lokasi")
  .replaceAll("bullish engulfing", "bullish engulfing")
  .replaceAll("bearish engulfing", "bearish engulfing")
  .replaceAll("evidence only", "hanya sebagai bukti");

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

/** Trader-language read of the operator-v2 evidence. Pure presentation mapping; never derives a signal. */
export function operatorSummary(snapshot: TradingSnapshot | null) {
  const op = snapshot?.operator ?? null;
  const dash = "—";
  if (!op) return { mode: "TIDAK JELAS", h4: dash, h1: dash, area: dash, ema: dash, trigger: "belum ada", status: "HOLD", alignment: null as string | null };
  const mode = op.regime === "TREND" ? "TREND" : op.regime === "RANGE" ? "RANGE" : "TIDAK JELAS";
  const h4 = op.h4_primary === "UP" ? "NAIK" : op.h4_primary === "DOWN" ? "TURUN" : op.h4_primary === "MIXED" ? "CAMPURAN" : "DATA BELUM CUKUP";
  const h1 = ({ ALIGNED: "SEARAH", PULLBACK_AGAINST_H4: "PULLBACK", RETURNING_TO_H4: "MULAI KEMBALI", REVERSAL_CANDIDATE: "CAMPURAN", MIXED: "CAMPURAN", NO_PRIMARY_DIRECTION: "CAMPURAN", INSUFFICIENT: "DATA BELUM CUKUP" } as const)[op.h1_context];
  const area = op.location === "AT_SUPPORT" ? "SUPPORT" : op.location === "AT_RESISTANCE" ? "RESISTANCE" : op.location === "MID" ? (op.regime === "RANGE" ? "TENGAH RANGE" : "TENGAH") : op.location === "AMBIGUOUS" ? "CAMPURAN" : dash;
  const ema = ({ BAND: "BAND", NEAR_EMA21: "DEKAT EMA21", NEAR_EMA50: "DEKAT EMA50", NOT_NEAR: "TIDAK DEKAT", INSUFFICIENT: "DATA BELUM CUKUP" } as const)[op.ema_confluence.zone];
  const trigger = op.trigger === "BULLISH" ? "bullish" : op.trigger === "BEARISH" ? "bearish" : op.trigger === "CONFLICT" ? "bertentangan" : "belum ada";
  const status = op.status === "CARI_BUY" ? "CARI BUY" : op.status === "CARI_SELL" ? "CARI SELL" : "HOLD";
  const alignment = ({ WITH_MACRO: "WITH MACRO", COUNTER_MACRO: "COUNTER MACRO", NEUTRAL_MACRO: "NEUTRAL MACRO", NOT_APPLICABLE: null } as const)[op.alignment ?? "NOT_APPLICABLE"];
  return { mode, h4, h1, area, ema, trigger, status, alignment: alignment as string | null };
}

export interface TechnicalSlicePanelProps {
  runtimes: readonly { readonly symbol: string; readonly reader: MarketRuntimeReader | null }[];
  selectedSymbol: string;
  unmountedReason?: string;
  tickMs?: number;
  explain?: (snapshot: string) => Promise<AiWhyResult>;
  /** Paper/journal store (tests inject one; defaults to the shared local store). */
  store?: PaperJournalStore;
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

export type CockpitMode = "SIMULASI" | "MONITOR";

function ActionButton({ side, highlighted, onClick }: { side: "BUY" | "SELL"; highlighted: boolean; onClick: () => void }) {
  const tone = side === "BUY"
    ? highlighted ? "border-bull bg-bull text-primary-foreground hover:bg-bull/90" : "border-bull/50 bg-bull/10 text-bull hover:bg-bull/20"
    : highlighted ? "border-bear bg-bear text-primary-foreground hover:bg-bear/90" : "border-bear/50 bg-bear/10 text-bear hover:bg-bear/20";
  return <Button
    type="button"
    size="lg"
    aria-label={`${side} simulasi`}
    aria-pressed={highlighted}
    data-testid={`action-${side.toLowerCase()}`}
    data-highlighted={highlighted ? "true" : "false"}
    className={`h-14 w-full border text-base font-semibold ${tone}`}
    onClick={onClick}
  >{side === "BUY" ? <ArrowUpRight /> : <ArrowDownRight />}{side}</Button>;
}

type DisplayPlan = { readonly side?: "BUY" | "SELL"; readonly sl: number; readonly tp1: number; readonly tp2: number; readonly rr: string } | null;
export interface TicketQuote { readonly bid: number; readonly ask: number }

function PaperTicket({ symbol, side, signal, quote, plan, confirmations, mode, onConfirm, onClose }: { symbol: string; side: "BUY" | "SELL"; signal: CockpitSignal; quote: TicketQuote | null; plan: DisplayPlan; confirmations: readonly string[]; mode: CockpitMode; onConfirm?: ((side: "BUY" | "SELL") => void) | undefined; onClose: () => void }) {
  const entry = quote ? (side === "BUY" ? quote.ask : quote.bid) : null;
  const sidePlan = plan && (plan.side === undefined || plan.side === side) ? plan : null;
  const manual = signal !== side;
  return <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-background/80" />
    <Dialog.Content className="fixed inset-x-4 top-1/2 z-50 max-h-[85vh] -translate-y-1/2 overflow-y-auto border border-border bg-card p-5 shadow-2xl sm:left-1/2 sm:right-auto sm:w-full sm:max-w-md sm:-translate-x-1/2" aria-describedby="trade-plan-description">
      <div className="flex items-start justify-between gap-4">
        <div><Dialog.Title className={`text-2xl font-semibold ${side === "BUY" ? "text-bull" : "text-bear"}`}>Tiket {mode === "SIMULASI" ? "simulasi" : "monitor"} {side}</Dialog.Title><Dialog.Description id="trade-plan-description" className="mt-1 text-sm text-muted-foreground">{mode === "SIMULASI" ? "Paper trade lokal. Sinyal engine tidak berubah karena klik ini." : "Tinjauan baca-saja."}</Dialog.Description></div>
        <Dialog.Close asChild><Button type="button" size="icon" variant="ghost" aria-label="Tutup tiket"><X /></Button></Dialog.Close>
      </div>
      {manual ? <div className="mt-4 border border-border bg-muted/40 px-3 py-2 text-xs font-semibold" data-testid="manual-label">MANUAL SIMULATION — ENGINE SIGNAL: {signal}</div> : null}
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Simbol</dt><dd className="mt-0.5 font-semibold">{symbol}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Sisi</dt><dd className="mt-0.5 font-semibold">{side}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Entry ({side === "BUY" ? "ASK" : "BID"})</dt><dd className="mt-0.5 font-mono font-semibold" data-testid="ticket-entry">{n(entry)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Sinyal engine</dt><dd className="mt-0.5 font-semibold">{signal}</dd></div>
        <div><dt className="text-xs text-muted-foreground">SL</dt><dd className="mt-0.5 font-mono">{sidePlan ? n(sidePlan.sl) : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">TP1</dt><dd className="mt-0.5 font-mono">{sidePlan ? n(sidePlan.tp1) : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">TP2</dt><dd className="mt-0.5 font-mono">{sidePlan ? n(sidePlan.tp2) : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">R:R</dt><dd className="mt-0.5">{sidePlan?.rr ?? "—"}</dd></div>
      </dl>
      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Konfirmasi sinyal</div>
        <ul className="mt-2 space-y-1.5 text-sm">{confirmations.map((item) => <li key={item} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span>{item}</span></li>)}</ul>
      </div>
      <div className="mt-5 border border-border bg-muted/40 px-3 py-3 text-center text-sm font-semibold" data-testid="no-order-status">{mode === "SIMULASI" ? "SIMULASI — TIDAK ADA ORDER NYATA" : "MONITOR SAJA — TIDAK ADA ORDER DIKIRIM"}</div>
      {mode === "SIMULASI" ? <Button type="button" className={`mt-3 w-full ${side === "BUY" ? "bg-bull hover:bg-bull/90" : "bg-bear hover:bg-bear/90"} text-primary-foreground`} disabled={!quote || !onConfirm} data-testid="confirm-paper" onClick={() => { onConfirm?.(side); onClose(); }}>Konfirmasi Paper Trade</Button> : null}
      <Button type="button" variant="outline" className="mt-2 w-full" onClick={onClose}>Tutup</Button>
    </Dialog.Content>
  </Dialog.Portal>;
}

/** BUY/SELL always clickable; they only open a local paper ticket. There is no broker/order callback. */
export function TradeActions({ symbol = "", signal, quote = null, plan = null, reason, confirmations, mode = "SIMULASI", onConfirm }: { symbol?: string; signal: CockpitSignal; quote?: TicketQuote | null; plan?: DisplayPlan; reason: string; confirmations: readonly string[]; mode?: CockpitMode; onConfirm?: ((side: "BUY" | "SELL") => void) | undefined }) {
  const [planSide, setPlanSide] = useState<"BUY" | "SELL" | null>(null);
  return <>
    <div className="mt-5 grid grid-cols-2 gap-2" aria-label="Aksi simulasi">
      <ActionButton side="BUY" highlighted={signal === "BUY"} onClick={() => setPlanSide("BUY")} />
      <ActionButton side="SELL" highlighted={signal === "SELL"} onClick={() => setPlanSide("SELL")} />
    </div>
    <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="action-disabled-reason">{signal === "HOLD" ? `Engine HOLD — ${reason}` : `Engine merekomendasikan ${signal}`} · SIMULASI — TIDAK ADA ORDER NYATA</p>
    <Dialog.Root open={planSide !== null} onOpenChange={(open) => { if (!open) setPlanSide(null); }}>
      {planSide ? <PaperTicket symbol={symbol} side={planSide} signal={signal} quote={quote} plan={plan} confirmations={confirmations} mode={mode} onConfirm={onConfirm} onClose={() => setPlanSide(null)} /> : null}
    </Dialog.Root>
  </>;
}

function PaperPositions({ store, symbol, quote }: { store: PaperJournalStore; symbol: string; quote: TicketQuote | null }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const open = state.positions.filter((p) => p.symbol === symbol && p.status === "OPEN");
  if (open.length === 0) return null;
  return <section className="border border-border bg-card p-4" aria-label="Posisi paper" data-testid="paper-positions">
    <h3 className="text-xs font-semibold uppercase text-muted-foreground">Posisi paper terbuka · SIMULASI</h3>
    <ul className="mt-2 divide-y divide-border text-sm">{open.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="paper-position">
      <span className={`font-semibold ${p.side === "BUY" ? "text-bull" : "text-bear"}`}>{p.side} @ {n(p.entry)}</span>
      <span className="font-mono text-xs">Mark {n(p.mark)} · PnL <span data-testid="paper-pnl">{n(p.pnl ?? 0)}</span>{p.r_multiple != null ? ` · ${p.r_multiple.toFixed(2)}R` : ""}</span>
      <span className="text-xs text-muted-foreground">SL {n(p.sl)} · TP2 {n(p.tp2)}</span>
      <Button size="sm" variant="outline" disabled={!quote} onClick={() => quote && store.close(p.id, quote, Date.now())}>Tutup</Button>
    </li>)}</ul>
  </section>;
}

function Cockpit({ service, explain, store }: { service: TechnicalSliceService; explain?: TechnicalSlicePanelProps["explain"]; store: PaperJournalStore }) {
  useSyncExternalStore(service.subscribe, service.getVersion, service.getVersion);
  const view = service.view();
  const snapshot = view.current;
  const evidence = snapshot?.evidence;
  const signal = cockpitSignal(snapshot);
  const entry = referenceEntry(snapshot);
  const plan: DisplayPlan = snapshot?.reference_plan.status === "AVAILABLE" ? { side: snapshot.reference_plan.side, sl: snapshot.reference_plan.sl, tp1: snapshot.reference_plan.tp1, tp2: snapshot.reference_plan.tp2, rr: "TP1 1:1 · TP2 1:2" } : null;
  const unavailable = !snapshot || snapshot.availability === "UNAVAILABLE" || snapshot.entry.state === "NOT_EVALUABLE";
  const signalReason = unavailable ? "menunggu bukti teknikal yang valid" : technicalCopy(snapshot?.entry.reason ?? "tunggu setup valid");
  const signalTone = signal === "BUY" ? "text-bull" : signal === "SELL" ? "text-bear" : "text-foreground";
  const signalBorder = signal === "BUY" ? "border-bull/45" : signal === "SELL" ? "border-bear/45" : "border-border";
  const [ai, setAi] = useState<AiWhyResult | { status: "PENDING" } | null>(null);
  const [mode, setMode] = useState<CockpitMode>("SIMULASI");
  // Last live quote seen (snapshot.quote is null on cycles without a new tick).
  const [quote, setQuote] = useState<TicketQuote | null>(null);
  useEffect(() => { if (snapshot?.quote) setQuote({ bid: snapshot.quote.bid, ask: snapshot.quote.ask }); }, [snapshot]);

  const runAi = async () => {
    if (!snapshot || !explain) { setAi({ status: "AI_ANALYST_UNAVAILABLE", reason: "Penyedia AI belum dikonfigurasi" }); return; }
    setAi({ status: "PENDING" });
    try {
      const r = await explain(aiSummaryPayload(snapshot));
      setAi(r.status === "OK" ? r : { status: "AI_ANALYST_UNAVAILABLE", reason: friendlyAiError(r.reason) });
    } catch (error) { setAi({ status: "AI_ANALYST_UNAVAILABLE", reason: friendlyAiError((error as Error).message) }); }
  };

  const h4Tone = trendTone(evidence?.H4.relation);
  const h1Tone = trendTone(evidence?.H1.relation);
  const h1StructureTone = structureTone(evidence?.H1.structure.summary);
  const triggerTone: ConfirmationTone = snapshot?.engulfing?.bullish ? "BULL" : snapshot?.engulfing?.bearish ? "BEAR" : "NEUTRAL";
  const triggerText = snapshot?.engulfing?.bullish ? "BULLISH TERKONFIRMASI" : snapshot?.engulfing?.bearish ? "BEARISH TERKONFIRMASI" : snapshot?.engulfing ? "BELUM TERKONFIRMASI" : "DATA BELUM CUKUP";
  const h1Rsi = evidence?.H1.rsi14;
  const rsiTone: ConfirmationTone = h1Rsi?.status !== "OK" ? "NEUTRAL" : h1Rsi.value > 50 ? "BULL" : h1Rsi.value < 50 ? "BEAR" : "NEUTRAL";
  const snr = evidence?.H1.snr;
  const location = snr ? `S ${n(snr.nearest_support?.price)} · R ${n(snr.nearest_resistance?.price)}` : "DATA BELUM CUKUP";
  const planConfirmations = snapshot?.why.slice(0, 5).map((fact) => technicalCopy(fact.text)) ?? ["Menunggu bukti teknikal yang valid"];

  return <article className="space-y-4" data-testid={`cockpit-${view.symbol}`}>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
      <section className={`border bg-card p-4 sm:p-5 ${signalBorder}`} data-testid="main-signal-card">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Sinyal saat ini · {view.symbol}</span>
          <div className="flex border border-border text-[10px] font-semibold" role="group" aria-label="Mode cockpit">
            {(["SIMULASI", "MONITOR"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} data-testid={`mode-${m.toLowerCase()}`} onClick={() => setMode(m)} className={`px-2 py-1 ${mode === m ? "bg-muted text-foreground" : "text-muted-foreground"}`}>{m}</button>)}
          </div>
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
          <div><div className="text-xs text-muted-foreground">Stop Loss</div><div className="mt-0.5 font-mono" data-testid="plan-sl">{plan ? n(plan.sl) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">TP1</div><div className="mt-0.5 font-mono" data-testid="plan-tp1">{plan ? n(plan.tp1) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">TP2</div><div className="mt-0.5 font-mono" data-testid="plan-tp2">{plan ? n(plan.tp2) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">R:R</div><div className="mt-0.5" data-testid="plan-rr">{plan?.rr ?? "—"}</div></div>
        </div>
        <TradeActions symbol={view.symbol} signal={signal} quote={quote} plan={plan} reason={signalReason} confirmations={planConfirmations} mode={mode}
          onConfirm={(side) => { if (quote) store.open({ symbol: view.symbol, side, quote, now: uiClock.now(), snapshot }); }} />
      </section>
    </div>

    <PaperPositions store={store} symbol={view.symbol} quote={quote} />

    <section aria-label="Ringkasan trader" data-testid="operator-summary">
      {(() => {
        const o = operatorSummary(snapshot);
        const tone = (value: string) => value === "NAIK" || value === "bullish" || value === "CARI BUY" ? "BULL" as const : value === "TURUN" || value === "bearish" || value === "CARI SELL" ? "BEAR" as const : "NEUTRAL" as const;
        const light = ([label, value, id]: readonly [string, string, string]) => <ConfirmationLight key={id} label={label} value={value} tone={tone(value)} testId={id} />;
        return <div className="grid gap-3 lg:grid-cols-[3fr_4fr]">
          <div data-testid="macro-context">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Macro context · H4/H1</h3>
            <div className="grid grid-cols-3 gap-2">{([["Mode", o.mode, "op-mode"], ["H4", o.h4, "op-h4"], ["H1", o.h1, "op-h1"]] as const).map(light)}</div>
          </div>
          <div data-testid="scalp-context">
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Scalp engine · M15/M5</h3>
              {o.alignment && <span data-testid="op-alignment" className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${o.alignment === "COUNTER MACRO" ? "border-destructive/50 text-destructive" : "border-border text-foreground"}`}>{o.alignment}</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{([["Area", o.area, "op-area"], ["EMA", o.ema, "op-ema"], ["Trigger", o.trigger, "op-trigger"], ["Status", o.status, "op-status"]] as const).map(light)}</div>
          </div>
        </div>;
      })()}
    </section>

    <section aria-label="Konfirmasi teknikal">
      <div className="mb-2 flex items-center gap-2"><Activity className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Konfirmasi teknikal</h3></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <ConfirmationLight label="Tren H4" value={technicalCopy(evidence?.H4.relation ?? "DATA BELUM CUKUP")} tone={h4Tone} testId="confirm-h4" />
        <ConfirmationLight label="Tren H1" value={technicalCopy(evidence?.H1.relation ?? "DATA BELUM CUKUP")} tone={h1Tone} testId="confirm-h1" />
        <ConfirmationLight label="Struktur H1" value={evidence?.H1.structure.summary.replace("_", "/") ?? "DATA BELUM CUKUP"} tone={h1StructureTone} testId="confirm-structure" />
        <ConfirmationLight label="Pemicu M5" value={triggerText} tone={triggerTone} testId="confirm-trigger" />
        <ConfirmationLight label="RSI14 H1" value={indicator(evidence?.H1.rsi14)} tone={rsiTone} testId="confirm-rsi" />
        <ConfirmationLight label="Lokasi S/R" value={location} tone="NEUTRAL" testId="confirm-snr" />
        <ConfirmationLight label="ATR14 M15" value={indicator(evidence?.M15.atr14, 3)} tone="NEUTRAL" testId="confirm-atr" />
      </div>
    </section>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="border-t border-border pt-4" aria-label="Alasan konfirmasi">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">Alasan</h3>
        <ul className="mt-3 space-y-2 text-sm" data-testid="confirmation-list">
          {(snapshot?.why.slice(0, 6) ?? [{ ok: null, text: "Menunggu bukti teknikal yang valid" }]).map((fact, index) => <li key={`${fact.text}-${index}`} className={`flex gap-2 ${factTone(fact)}`}><FactIcon value={fact.ok} /><span className="text-foreground/90">{technicalCopy(fact.text)}</span></li>)}
        </ul>
      </section>
      <section className="border-t border-border pt-4" aria-label="Penjelasan AI">
        <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Penjelasan AI</h3></div><Button size="sm" variant="outline" onClick={runAi} disabled={ai?.status === "PENDING"}>Jelaskan</Button></div>
        <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground" data-testid={`${view.symbol}-ai`}>{ai == null ? "Penjelasan ringkas opsional. Sinyal deterministik tetap menjadi acuan." : ai.status === "OK" ? ai.narrative : ai.status === "PENDING" ? "Menganalisis…" : `Penjelasan AI tidak tersedia — ${ai.reason}`}</p>
      </section>
    </div>
  </article>;
}

export function TechnicalSlicePanel({ runtimes, selectedSymbol, unmountedReason, tickMs = 2000, explain, store }: TechnicalSlicePanelProps) {
  const services = useMemo(() => runtimes.map((runtime) => new TechnicalSliceService(runtime.reader, runtime.symbol, new LiveClock(), unmountedReason)), [runtimes, unmountedReason]);
  const journal = useMemo(() => store ?? sharedPaperJournal(), [store]);
  useEffect(() => {
    const tick = () => {
      for (const service of services) {
        const snap = service.tick();
        const now = uiClock.now();
        // Journal: ENGINE signal transitions only (deduplicated per symbol). Paper marks: SIMULATION only.
        journal.recordSignal(snap, service.symbol, now);
        if (snap.quote) journal.mark(service.symbol, snap.quote, now);
      }
    };
    tick();
    const timer = setInterval(tick, tickMs);
    return () => clearInterval(timer);
  }, [services, tickMs, journal]);
  const selected = services.find((service) => service.symbol === selectedSymbol) ?? null;
  return <section className="bg-background px-4 pb-8 sm:px-8" aria-label="Kokpit trading">
    <div className="mx-auto max-w-screen-2xl">{selected ? <Cockpit service={selected} explain={explain} store={journal} /> : <div className="border border-border bg-card p-4 text-sm text-muted-foreground">Menunggu pasar terpilih…</div>}</div>
  </section>;
}