import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RadarObservabilityPanel } from "./RadarObservabilityPanel";
import { localCockpitSource, remoteCockpitSource, type CockpitSource, type RuntimeFacts } from "@/lib/cockpitSource";
import type { EngineHostStore } from "@/lib/engineHostStore";
import type { SignalAlert, SignalAlertStore } from "@/lib/signalAlerts";
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, Check, Circle, Minus, Radar, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { TechnicalSliceService, type SliceView } from "@/core/technical/TechnicalSliceService";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { Indicator } from "@/core/technical/indicators";
import type { Relation, Structure } from "@/core/technical/indicators";
import { buildSidePlan, type RadarPlan, type TradingSnapshot, type WhyFact } from "@/core/technical/tradingState";
import type { AiWhyResult } from "@/lib/ai-why.functions";
import { sharedPaperJournal, type PaperJournalStore } from "@/lib/paperJournal";
import { aiSummaryPayload } from "@/lib/tradeSummary";
import { useMobileTerminal } from "./MobileTerminalContext";

const uiClock = new LiveClock();
/** Short Indonesian error for the AI section; never raw validation JSON. */
export function friendlyAiError(reason: string): string {
  if (/^\s*[[{]/.test(reason) || /too_big|validation|zod|max/i.test(reason)) return "Permintaan ke AI ditolak karena format/ukuran data. Coba lagi nanti.";
  return reason.length > 140 ? `${reason.slice(0, 140)}…` : reason;
}

const n = (value: number | null | undefined, digits = 3) => value == null || !Number.isFinite(value) ? "—" : Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(digits);
const indicator = (value: Indicator | undefined, digits = 1) => !value || value.status !== "OK" ? "DATA BELUM CUKUP" : n(value.value, digits);
const technicalCopy = (text: string) => text
  .replaceAll("BAD_RR_AFTER_STRUCTURAL_CLAMP", "BAD R:R — S/R TERLALU DEKAT")
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

export type TradeProjection = {
  readonly direction: "BUY" | "SELL" | null;
  readonly actionable: boolean;
  readonly headline: "BUY READY" | "SELL READY" | "BUY BIAS" | "SELL BIAS" | "HOLD";
  readonly status: "READY SETUP" | "WAIT TRIGGER" | "WAIT CONFIRMATION";
};

/** One presentation projection shared by Signal State and Rencana Acuan. */
export function tradeProjection(snapshot: TradingSnapshot | null): TradeProjection {
  const signal = cockpitSignal(snapshot);
  if (signal === "BUY" || signal === "SELL") return { direction: signal, actionable: true, headline: `${signal} READY`, status: "READY SETUP" };
  const direction = snapshot?.radar_plan?.side ?? (snapshot?.operator?.status === "CARI_BUY" ? "BUY" : snapshot?.operator?.status === "CARI_SELL" ? "SELL" : null);
  if (direction) {
    const status = snapshot?.radar_plan?.status === "WAITING_FOR_AREA" ? "WAIT CONFIRMATION" : "WAIT TRIGGER";
    return { direction, actionable: false, headline: `${direction} BIAS`, status };
  }
  return { direction: null, actionable: false, headline: "HOLD", status: "WAIT CONFIRMATION" };
}

/** Trader-language read of the operator-v2 evidence. Pure presentation mapping; never derives a signal. */
export function operatorSummary(snapshot: TradingSnapshot | null) {
  const op = snapshot?.operator ?? null;
  const dash = "—";
  if (!op) return { mode: "TIDAK JELAS", h4: dash, h1: dash, area: dash, ema: dash, trigger: "belum ada", status: "HOLD", alignment: null as string | null, m15: dash, m5: dash, momentum: dash };
  const mode = op.regime === "TREND" ? "TREND" : op.regime === "RANGE" ? "RANGE" : "TIDAK JELAS";
  const h4 = op.h4_primary === "UP" ? "NAIK" : op.h4_primary === "DOWN" ? "TURUN" : op.h4_primary === "MIXED" ? "CAMPURAN" : "DATA BELUM CUKUP";
  const h1 = ({ ALIGNED: "SEARAH", PULLBACK_AGAINST_H4: "PULLBACK", RETURNING_TO_H4: "MULAI KEMBALI", REVERSAL_CANDIDATE: "CAMPURAN", MIXED: "CAMPURAN", NO_PRIMARY_DIRECTION: "CAMPURAN", INSUFFICIENT: "DATA BELUM CUKUP" } as const)[op.h1_context];
  const area = op.location === "AT_SUPPORT" ? "SUPPORT" : op.location === "AT_RESISTANCE" ? "RESISTANCE" : op.location === "MID" ? (op.regime === "RANGE" ? "TENGAH RANGE" : "TENGAH") : op.location === "AMBIGUOUS" ? "CAMPURAN" : dash;
  const emaBase = ({ BAND: "BAND", NEAR_EMA21: "DEKAT EMA21", NEAR_EMA50: "DEKAT EMA50", NOT_NEAR: "TIDAK DEKAT", INSUFFICIENT: "DATA BELUM CUKUP" } as const)[op.ema_confluence.zone];
  const ema = op.ema_confluence.timeframe ? `${emaBase} ${op.ema_confluence.timeframe}` : emaBase;
  const momCopy = (st: string | undefined) => st ? ({ BULLISH_EXPANDING: "BULLISH EXPANDING", BULLISH: "BULLISH", BEARISH_EXPANDING: "BEARISH EXPANDING", BEARISH: "BEARISH", CROSS_UP: "CROSS UP", CROSS_DOWN: "CROSS DOWN", FLAT_OR_WEAK: "LEMAH", INSUFFICIENT: "DATA BELUM CUKUP" } as Record<string, string>)[st] ?? st : dash;
  const m15 = momCopy(op.scalp?.M15.momentum?.state), m5 = momCopy(op.scalp?.M5.momentum?.state);
  const momentum = op.scalp?.combined_momentum ? op.scalp.combined_momentum.replace("_", " ") : dash;
  const trigger = op.trigger === "BULLISH" ? "bullish" : op.trigger === "BEARISH" ? "bearish" : op.trigger === "CONFLICT" ? "bertentangan" : "belum ada";
  const status = op.status === "CARI_BUY" ? "CARI BUY" : op.status === "CARI_SELL" ? "CARI SELL" : "HOLD";
  const alignment = ({ WITH_MACRO: "WITH MACRO", COUNTER_MACRO: "COUNTER MACRO", NEUTRAL_MACRO: "NEUTRAL MACRO", NOT_APPLICABLE: null } as const)[op.alignment ?? "NOT_APPLICABLE"];
  return { mode, h4, h1, area, ema, trigger, status, alignment: alignment as string | null, m15, m5, momentum };
}

const unavailableCopy = "WAITING MARKET DATA";
const formatUtc = (value: number | null | undefined, includeSeconds = true) => value == null || !Number.isFinite(value)
  ? unavailableCopy
  : new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" } : {}) }).format(value).replaceAll(":", ":") + " UTC";
const trendLabel = (value: string | undefined) => value === "UP" ? "BULLISH" : value === "DOWN" ? "BEARISH" : value === "MIXED" ? "SIDEWAYS" : unavailableCopy;
const structureLabel = (value: string | undefined) => value === "HH_HL" ? "HH → HL" : value === "LH_LL" ? "LH → LL" : value === "MIXED" ? "MIXED STRUCTURE" : unavailableCopy;
const contextLabel = (value: string | undefined) => ({
  ALIGNED: "ALIGNED WITH H4", PULLBACK_AGAINST_H4: "PULLBACK AGAINST H4", RETURNING_TO_H4: "RETURNING TO H4",
  REVERSAL_CANDIDATE: "REVERSAL CANDIDATE", MIXED: "TRANSITION", NO_PRIMARY_DIRECTION: "NO PRIMARY DIRECTION", INSUFFICIENT: unavailableCopy,
} as Record<string, string>)[value ?? ""] ?? unavailableCopy;
const locationLabel = (value: string | undefined) => ({ AT_SUPPORT: "AT SUPPORT", AT_RESISTANCE: "AT RESISTANCE", MID: "MID RANGE", AMBIGUOUS: "CONFLICT ZONE", UNKNOWN: unavailableCopy } as Record<string, string>)[value ?? ""] ?? unavailableCopy;
const reactionLabel = (kind: string) => ({ REJECTED_UP: "REJECTION UP", REJECTED_DOWN: "REJECTION DOWN", BROKE_ABOVE: "BREAK ABOVE", BROKE_BELOW: "BREAK BELOW", TOUCHED: "RETEST" } as Record<string, string>)[kind] ?? kind;
const reasonCopy = (reason: string) => technicalCopy(reason)
  .replaceAll("NOT_AT_SR_OR_EMA_CONFLUENCE", "Price belum berada di S/R atau area EMA yang valid")
  .replaceAll("REGIME_CHOPPY_NO_CLEAR_BOUNDS", "Market choppy tanpa batas range yang jelas")
  .replaceAll("RANGE_LOCATION_AMBIGUOUS", "Price berada di conflict zone")
  .replaceAll("RANGE_MIDDLE", "Price masih di tengah range")
  .replaceAll("NO_CLOSED_BULLISH_TRIGGER", "Trigger bullish M5/M15 CLOSED belum muncul")
  .replaceAll("NO_CLOSED_BEARISH_TRIGGER", "Trigger bearish M5/M15 CLOSED belum muncul");

export interface TechnicalSlicePanelProps {
  runtimes: readonly { readonly symbol: string; readonly reader: MarketRuntimeReader | null }[];
  selectedSymbol: string;
  unmountedReason?: string;
  tickMs?: number;
  explain?: (snapshot: string) => Promise<AiWhyResult>;
  /** Paper/journal store (tests inject one; defaults to the shared local store). */
  store?: PaperJournalStore;
  /** Radar: ENGINE snapshots of EVERY symbol are fed here (fresh BUY/SELL transitions ⇒ onAlert). */
  alerts?: SignalAlertStore;
  onAlert?: (alert: SignalAlert) => void;
  /** ENGINE HOST attach store: when present the panel is a pure view of the engine host (no local evaluation). */
  engine?: EngineHostStore | undefined;
  /** Why the dashboard fell back to BROWSER SESSION (engine host configured but offline). */
  fallbackReason?: string | null;
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

function ActionButton({ side, highlighted, disabled, onClick }: { side: "BUY" | "SELL"; highlighted: boolean; disabled: boolean; onClick: () => void }) {
  const tone = side === "BUY"
    ? highlighted ? "border-bull bg-bull text-primary-foreground hover:bg-bull/90" : "border-border bg-muted/35 text-muted-foreground"
    : highlighted ? "border-bear bg-bear text-primary-foreground hover:bg-bear/90" : "border-border bg-muted/35 text-muted-foreground";
  return <Button
    type="button"
    size="lg"
    aria-label={`${side} simulasi`}
    aria-pressed={highlighted}
    data-testid={`action-${side.toLowerCase()}`}
    data-highlighted={highlighted ? "true" : "false"}
    disabled={disabled}
    className={`h-14 w-full border text-base font-semibold ${tone}`}
    onClick={onClick}
  >{side === "BUY" ? <ArrowUpRight /> : <ArrowDownRight />}{side}</Button>;
}

type DisplayPlan = { readonly side?: "BUY" | "SELL"; readonly sl: number; readonly tp1: number | null; readonly tp2: number | null; readonly rr: string; readonly econ?: string } | null;
const rrText = (p: { final_rr: number; economics_status: string }) => `Final 1:${p.final_rr.toFixed(2)} · ${econLabel(p.economics_status)}`;
const econLabel = (e: string | null | undefined) => e === "OK" ? "RR OK" : e === "BAD_RR" ? "BAD R:R" : e === "NO_STRUCTURAL_TARGET" ? "TANPA TARGET STRUKTURAL" : "—";
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
      {sidePlan?.econ === "BAD_RR" ? <div className="mt-3 border border-border px-3 py-2 text-xs font-semibold" data-testid="ticket-bad-rr">BAD R:R — S/R terlalu dekat. Hanya untuk riset (economic veto).</div> : null}
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

/** Paper actions remain visible, but only the authoritative READY side can open a local paper ticket. */
export function TradeActions({ symbol = "", signal, quote = null, plan = null, planFor, reason, confirmations, mode = "SIMULASI", onConfirm }: { symbol?: string; signal: CockpitSignal; quote?: TicketQuote | null; plan?: DisplayPlan; planFor?: (side: "BUY" | "SELL") => DisplayPlan; reason: string; confirmations: readonly string[]; mode?: CockpitMode; onConfirm?: ((side: "BUY" | "SELL") => void) | undefined }) {
  const [planSide, setPlanSide] = useState<"BUY" | "SELL" | null>(null);
  return <>
    <div className="mt-5 grid grid-cols-2 gap-2" aria-label="Aksi paper">
      <ActionButton side="BUY" highlighted={signal === "BUY"} disabled={signal !== "BUY"} onClick={() => setPlanSide("BUY")} />
      <ActionButton side="SELL" highlighted={signal === "SELL"} disabled={signal !== "SELL"} onClick={() => setPlanSide("SELL")} />
    </div>
    <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="action-disabled-reason">{signal === "HOLD" ? `OBSERVE ONLY · ${reason}` : `${signal} READY · PAPER ONLY`} · TIDAK ADA ORDER NYATA</p>
    <Dialog.Root open={planSide !== null} onOpenChange={(open) => { if (!open) setPlanSide(null); }}>
      {planSide ? <PaperTicket symbol={symbol} side={planSide} signal={signal} quote={quote} plan={planFor ? planFor(planSide) : plan} confirmations={confirmations} mode={mode} onConfirm={onConfirm} onClose={() => setPlanSide(null)} /> : null}
    </Dialog.Root>
  </>;
}

const radarReason = (r: string) => ({ NO_LOCAL_ENTRY_ZONE: "Belum ada area support/resistance atau EMA21/50 lokal yang valid", PRICE_BELOW_BUY_ZONE: "Harga sudah di bawah area BUY", PRICE_ABOVE_SELL_ZONE: "Harga sudah di atas area SELL" } as Record<string, string>)[r] ?? technicalCopy(r);

/** Radar-first plan card: RADAR (dynamic projection) vs SIGNAL (READY) vs no direction. Presentation of engine output only. */
export function RadarPlanView({ radar, signal, entry, projection }: { radar: RadarPlan | null; signal: CockpitSignal; entry: number | null; projection?: TradeProjection }) {
  const mode = radar?.mode ?? "NONE";
  const ready = mode === "SIGNAL";
  const side = projection?.direction ?? radar?.side ?? null;
  const sideTone = side === "BUY" ? "text-bull" : side === "SELL" ? "text-bear" : "text-muted-foreground";
  const ok = radar?.status === "AVAILABLE";
  const val = (x: number | null | undefined) => (ok ? n(x) : "—");
  const badRr = ok && radar?.economics_status === "BAD_RR";
  const status = badRr ? "NO SETUP · BAD R:R" : projection ? projection.status : ready ? (ok ? `${side} READY · PAPER ONLY` : "READY · LEVEL DATA NOT AVAILABLE")
    : mode === "RADAR" ? (radar?.status === "WAITING_FOR_AREA" ? "WAIT CONFIRMATION" : "WAIT TRIGGER") : "NO SETUP";
  const refEntry = ready ? (radar?.reference_entry ?? entry) : radar?.reference_entry ?? null;
  return <div data-testid="radar-plan" data-mode={mode}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-muted-foreground" /><h3 className="text-xs font-semibold uppercase text-muted-foreground">Rencana acuan</h3></div>
      {mode !== "NONE" ? <span data-testid="radar-badge" className={`border px-1.5 py-0.5 text-[10px] font-semibold ${ready ? (side === "BUY" ? "border-bull text-bull" : "border-bear text-bear") : "border-dashed border-border text-foreground"}`}>{ready ? "SIGNAL PLAN" : "RADAR DINAMIS"}</span> : null}
      {ok && radar?.economics_status ? <span data-testid="econ-badge" className={`border px-1.5 py-0.5 text-[10px] font-semibold ${badRr ? "border-bear text-bear" : "border-border text-foreground"}`}>{econLabel(radar.economics_status)}</span> : null}
    </div>
    <div className="mt-3 flex items-baseline justify-between gap-2">
      <span className={`text-2xl font-semibold ${sideTone}`} data-testid="radar-side">{projection?.headline ?? (side ? (ready && signal !== "HOLD" ? side : `${side} BIAS`) : "NO DIRECTION")}</span>
      <span className="text-right text-xs font-semibold" data-testid="radar-status">{status}</span>
    </div>
    {mode === "RADAR" ? <p className="mt-1 text-[11px] font-semibold text-muted-foreground" data-testid="radar-projection-label">PROYEKSI — BELUM SIGNAL ENTRY</p> : null}
    <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
      <div className="col-span-2"><div className="text-xs text-muted-foreground">Area entry</div><div className="mt-0.5 font-mono" data-testid="radar-zone">{radar?.zone ? `${n(radar.zone.low)} – ${n(radar.zone.high)}` : "—"}</div>{radar?.zone ? <div className="mt-0.5 text-[11px] text-muted-foreground" data-testid="radar-sources">{radar.zone.sources.join(" + ")} · {radar.zone.quality}</div> : null}</div>
      <div><div className="text-xs text-muted-foreground">Acuan Entry{mode === "RADAR" && radar?.reference_entry != null ? (radar.executable_now ? " (harga kini)" : " (proyeksi)") : ""}</div><div className="mt-0.5 font-mono font-semibold" data-testid="reference-entry">{refEntry == null ? "—" : n(refEntry)}</div></div>
      <div><div className="text-xs text-muted-foreground">{mode === "RADAR" ? "SL proyeksi" : "Stop Loss"}</div><div className="mt-0.5 font-mono" data-testid="plan-sl">{val(radar?.sl)}</div>{ok && radar?.anchor_timeframe ? <div className="mt-0.5 text-[11px] text-muted-foreground" data-testid="sl-source">{radar.anchor_timeframe} swing {radar.side === "BUY" ? "low −" : "high +"} 0.25 ATR</div> : null}</div>
      <div><div className="text-xs text-muted-foreground">{mode === "RADAR" ? "TP1 proyeksi" : "TP1"}</div><div className="mt-0.5 font-mono" data-testid="plan-tp1">{val(radar?.tp1)}</div></div>
      <div><div className="text-xs text-muted-foreground">{mode === "RADAR" ? "TP2 proyeksi" : "TP2"}</div><div className="mt-0.5 font-mono" data-testid="plan-tp2">{val(radar?.tp2)}</div></div>
      <div><div className="text-xs text-muted-foreground">R:R</div><div className="mt-0.5" data-testid="plan-rr">{ok && radar?.final_rr != null ? `Final 1:${radar.final_rr.toFixed(2)}` : "—"}</div></div>
      <div><div className="text-xs text-muted-foreground">Target S/R (buffer)</div><div className="mt-0.5 font-mono" data-testid="radar-target">{ok && radar?.structural_target_buffered != null ? n(radar.structural_target_buffered) : "—"}</div></div>
      {ok && radar?.raw_tp1 != null ? <div className="col-span-2 text-[11px] text-muted-foreground" data-testid="raw-targets">RAW teoretis (bukan target aksi): 1R {n(radar.raw_tp1)} · 2R {n(radar.raw_tp2)}</div> : null}
    </div>
    <p className="mt-3 text-[11px] text-muted-foreground" data-testid="radar-note">{
      badRr ? "Ruang ke S/R berikutnya kurang dari 1R — tunggu setup baru." : ready ? (ok ? "Gunakan angka signal ini sebagai acuan; paper trade akan membekukan plan saat entry." : radarReason(radar?.reason ?? ""))
      : mode === "RADAR" ? (ok ? "Proyeksi dapat berubah sampai signal READY." : radarReason(radar?.reason ?? ""))
      : signal === "HOLD" ? "Engine belum mencari BUY/SELL; tidak ada target yang ditampilkan." : ""
    }</p>
  </div>;
}

function RadarMetric({ label, value, detail, testId }: { label: string; value: string; detail?: string | undefined; testId: string }) {
  return <div className="min-w-0 border border-border bg-card p-3" data-testid={testId}>
    <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
    <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
  </div>;
}

function TraderRadarView({ snapshot, facts, part }: { snapshot: TradingSnapshot | null; facts: RuntimeFacts; part: CockpitTab }) {
  const op = snapshot?.operator ?? null;
  const radar = facts.radar;
  const radarHealth = facts.radarHealth;
  const live = facts.live;
  const signal = cockpitSignal(snapshot);
  const actionable = signal === "BUY" || signal === "SELL";
  const projected = op?.status === "CARI_BUY" ? "BUY" : op?.status === "CARI_SELL" ? "SELL" : null;
  const radarState = actionable ? `${signal} READY` : projected ? `WAIT ${projected} CONFIRMATION` : snapshot?.entry.state === "NOT_EVALUABLE" ? "NOT EVALUABLE" : "NO SETUP";
  const setupState = actionable ? `SETUP READY ${signal}` : projected ? `WAIT ${projected} CONFIRMATION` : "NO SETUP";
  const executionState = actionable ? "PAPER READY" : "NOT READY";
  const marketTrend = op ? trendLabel(op.h4_primary) : unavailableCopy;
  const regime = op?.regime === "RANGE" ? "RANGE" : op?.regime === "CHOPPY" ? "CHOPPY" : op?.regime === "TREND" ? "TREND" : unavailableCopy;
  const level = (tf: "M5" | "M15", key: "ema5" | "ema21" | "ema50") => indicator(op?.scalp[tf][key], 3);
  const reactions = op ? (["M15", "M5"] as const).flatMap((tf) => op.scalp[tf].ema_reaction.map((r) => `${tf} EMA${r.ema} ${reactionLabel(r.kind)}`)) : [];
  const emaAction = reactions.length ? reactions.join(" · ") : "NO CONFIRMED EMA ACTION";
  const zone = op?.location === "AMBIGUOUS" && op.nearest_support && op.nearest_resistance
    ? `Support ${op.nearest_support.source_tf} ${n(op.nearest_support.low)}–${n(op.nearest_support.high)} · Resistance ${op.nearest_resistance.source_tf} ${n(op.nearest_resistance.low)}–${n(op.nearest_resistance.high)}`
    : op?.nearest_support || op?.nearest_resistance
      ? [op.nearest_support ? `Support ${op.nearest_support.source_tf} ${n(op.nearest_support.low)}–${n(op.nearest_support.high)}` : null, op.nearest_resistance ? `Resistance ${op.nearest_resistance.source_tf} ${n(op.nearest_resistance.low)}–${n(op.nearest_resistance.high)}` : null].filter(Boolean).join(" · ")
      : undefined;
  const structure = (tf: "H4" | "H1" | "M15") => structureLabel(snapshot?.evidence?.[tf].structure.summary);
  const horizons = radar?.horizon.compatibleHorizons ?? [];
  const horizonItem = (name: "SCALPING" | "INTRADAY" | "SWING") => `${name} ${horizons.includes(name) ? "✓ AVAILABLE" : "✕ NOT SUITABLE"}`;
  const lastM5 = snapshot?.evidence?.M5.last_closed_available_at ?? facts.lastM5Close;
  const source = radar?.validationSource.dataSource ?? (live?.source === "EXNESS_MT5" ? "REAL_MT5" : unavailableCopy);
  const freshness = radarHealth?.status === "STALE" || snapshot?.availability === "STALE" ? "STALE DATA" : live ? "LIVE OBSERVATION" : "WAITING LIVE DATA";
  const why = snapshot?.why.slice(0, 5) ?? [];

  const lvl = (label: string, value: string) => <div><div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div><div className="mt-0.5 font-mono text-sm font-semibold">{value}</div></div>;

  if (part === "TRADE") return <section className="border border-border bg-card p-4" aria-label="Quick Status" data-testid="quick-status">
    <h3 className="text-xs font-semibold uppercase text-muted-foreground">Status</h3>
    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
      <div><div className="text-xs text-muted-foreground">Execution</div><div className="mt-0.5 font-semibold" data-testid="quick-execution">{actionable ? "READY" : "NOT READY"}</div></div>
      <div><div className="text-xs text-muted-foreground">Reason</div><div className="mt-0.5 font-semibold">{actionable ? "Valid engine state · paper only" : "Trigger missing"}</div></div>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-3" data-testid="decision-layers">
      <RadarMetric label="Market Condition" value={`${marketTrend} · ${regime}`} detail={structure("H4")} testId="layer-market-condition" />
      <RadarMetric label="Setup Condition" value={setupState} detail={op ? reasonCopy(op.reason) : unavailableCopy} testId="layer-setup-condition" />
      <RadarMetric label="Execution State" value={executionState} detail={actionable ? "Valid engine state · paper only" : "Trigger missing · observe only"} testId="layer-execution-state" />
    </div>
  </section>;

  if (part === "ANALYSIS") return <section className="space-y-3" aria-label="Radar Observability" data-testid="trader-radar-analysis">
    <div className="border border-border bg-card p-4" data-testid="why-radar">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{actionable ? "Why Ready" : "Why Wait"}</h3>
      <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{(why.length ? why : [{ ok: null, text: unavailableCopy }]).map((fact, index) => <li key={`${fact.text}-${index}`} className="flex gap-2"><FactIcon value={fact.ok} /><span>{technicalCopy(fact.text)}</span></li>)}</ul>
    </div>
    <div className="border border-border bg-card p-3" data-testid="real-market-metadata">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Radar Observability</h3>
      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><div className="text-muted-foreground">SOURCE</div><div className="mt-1 font-semibold">{source} · {freshness}</div></div>
        <div><div className="text-muted-foreground">SYMBOL</div><div className="mt-1 font-semibold">{facts.symbol}</div></div>
        <div><div className="text-muted-foreground">LAST UPDATE</div><div className="mt-1 font-mono">{formatUtc(live?.observed_at)}</div></div>
        <div><div className="text-muted-foreground">LAST CLOSED M5</div><div className="mt-1 font-mono">{formatUtc(lastM5, false)}</div></div>
      </div>
    </div>
  </section>;

  return <section className="space-y-3" aria-label="Trader Radar Dashboard" data-testid="trader-radar-v2">
    <div className="border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="text-xs font-semibold uppercase text-muted-foreground">Market Radar · {snapshot?.symbol ?? facts.symbol}</div><div className="mt-2 text-3xl font-semibold" data-testid="radar-state">{radarState}</div></div>
        <span className="border border-border bg-muted/35 px-2 py-1 text-xs font-semibold">OBSERVE ONLY</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground" data-testid="radar-state-reason">{snapshot ? reasonCopy(snapshot.entry.reason) : unavailableCopy}</p>
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      <RadarMetric label="Scalp Engine" value={`M15 Momentum ${op?.scalp.M15.momentum.state ?? unavailableCopy} · M5 Momentum ${op?.scalp.M5.momentum.state ?? unavailableCopy}`} detail={actionable ? "SCALP READY" : projected ? "WAIT TRIGGER" : "NO SCALP SETUP"} testId="scalp-condition-card" />
      <RadarMetric label="Price Location" value={locationLabel(op?.location)} detail={zone} testId="price-location-card" />
      <div className="min-w-0 border border-border bg-card p-3" data-testid="ema-radar-card">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">EMA Radar · M5</div>
        <div className="mt-1 text-xs text-muted-foreground">EMA ACTION</div>
        <div className="text-sm font-semibold">{emaAction}</div>
        <div className="mt-2 grid grid-cols-3 gap-2">{lvl("EMA5", level("M5", "ema5"))}{lvl("EMA21", level("M5", "ema21"))}{lvl("EMA50", level("M5", "ema50"))}</div>
      </div>
      <div className="min-w-0 border border-border bg-card p-3" data-testid="structure-radar-card">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">Structure Radar</div>
        <div className="mt-2 grid grid-cols-3 gap-2">{lvl("H4", structure("H4"))}{lvl("H1", structure("H1"))}{lvl("M15", structure("M15"))}</div>
        <div className="mt-1 text-xs text-muted-foreground">Confirmed CLOSED swings only</div>
      </div>
      <div className="min-w-0 border border-border bg-card p-3 md:col-span-2" data-testid="trading-style-card">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">Trading Style</div>
        <ul className="mt-2 grid gap-1 text-sm font-semibold sm:grid-cols-3">{(["SCALPING", "INTRADAY", "SWING"] as const).map((h) => <li key={h}>{horizonItem(h)}</li>)}</ul>
        <div className="mt-2 text-xs text-muted-foreground">REASON: {radar ? `${radar.horizon.marketApproach}${radar.horizon.vetoReason ? ` · ${radar.horizon.vetoReason}` : ""}` : unavailableCopy}</div>
      </div>
    </div>
  </section>;
}

/** MARKET CONTEXT SUMMARY (v2.5): market trend + H4/H1 bias as trader-readable card. Presentation mapping only — values come from existing operator/runtime fields, never derived in UI. */
function MarketContextSummary({ snapshot, facts }: { snapshot: TradingSnapshot | null; facts: RuntimeFacts }) {
  const op = snapshot?.operator ?? null;
  const toneClass = (value: string | undefined) => value === "BULLISH" ? "text-bull" : value === "BEARISH" ? "text-bear" : "text-muted-foreground";
  const trend = trendLabel(op?.h4_primary);
  const h4 = trendLabel(op?.h4_primary);
  const h1 = trendLabel(op?.per_tf.H1.trend);
  return <section className="border border-border bg-card p-4 sm:p-5" aria-label="Market Context" data-testid="market-context-summary">
    <h3 className="text-xs font-semibold uppercase text-muted-foreground">Market Context</h3>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <div data-testid="mc-trend">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Market Trend</div>
        <div className={`mt-1 flex items-center gap-2 text-sm font-semibold ${toneClass(trend)}`}><span aria-hidden>●</span>{trend}</div>
      </div>
      <div data-testid="mc-h4">
        <div className="text-xs font-semibold uppercase text-muted-foreground">H4</div>
        <div className={`mt-1 flex items-center gap-2 text-sm font-semibold ${toneClass(h4)}`}><span aria-hidden>●</span>{h4}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{structureLabel(snapshot?.evidence?.H4.structure.summary)}</div>
      </div>
      <div data-testid="mc-h1">
        <div className="text-xs font-semibold uppercase text-muted-foreground">H1</div>
        <div className={`mt-1 flex items-center gap-2 text-sm font-semibold ${toneClass(h1)}`}><span aria-hidden>●</span>{h1}</div>
        <div className="mt-0.5 text-xs text-muted-foreground" data-testid="mc-h1-relation">{contextLabel(op?.h1_context)}</div>
      </div>
    </div>
    <IntelligenceBlock facts={facts} />
  </section>;
}

/** Market Intelligence (mtf-intel-v1) projection. Source: ENGINE HOST (VPS) when attached, else BROWSER FALLBACK — never mixed. */
function IntelligenceBlock({ facts }: { facts: RuntimeFacts }) {
  const r = facts.radar?.intelligence ?? null;
  const tone = (v: string | undefined) => v === "BULLISH" ? "text-bull" : v === "BEARISH" ? "text-bear" : "text-muted-foreground";
  const statusCls = r?.status === "READY" ? "border-bull/50 text-bull" : r?.status === "STAND_ASIDE" ? "border-bear/50 text-bear" : "border-border text-warn";
  const Row = ({ k, v, sub }: { k: string; v: string; sub?: string }) => <div className="border-b border-border/50 py-1.5 text-xs"><div className="flex justify-between gap-3"><span className="font-semibold text-muted-foreground">{k}</span><span className="text-right text-foreground">{v}</span></div>{sub && <div className="mt-0.5 text-muted-foreground">{sub}</div>}</div>;
  return <div className="mt-3 border-t border-border pt-3" data-testid="mc-intel">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className={`border px-2 py-1 text-xs font-bold tracking-wider ${statusCls}`} data-testid="mc-intel-status">{(r?.status ?? "NO_DATA").replaceAll("_", " ")}</span>
      <span className="text-[11px] text-muted-foreground" data-testid="mc-intel-source">{facts.source === "ENGINE_HOST" ? "ENGINE HOST VPS (LIVE)" : "BROWSER SESSION (EPHEMERAL) · refresh me-reset runtime state"}</span>
    </div>
    {!r ? <p className="mt-2 text-xs text-muted-foreground">Menunggu evaluasi radar pada M5 close (histori broker). Tidak ada data yang dikarang.</p> : <>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><div className="text-[11px] uppercase text-muted-foreground">Bias</div><div className={`text-sm font-semibold ${tone(r.bias)}`} data-testid="mc-intel-bias">{r.bias}</div></div>
        <div><div className="text-[11px] uppercase text-muted-foreground">Phase</div><div className="text-sm font-semibold">{r.market_phase}</div></div>
        <div><div className="text-[11px] uppercase text-muted-foreground">Confidence</div><div className="font-mono text-sm font-semibold" data-testid="mc-intel-confidence">{r.confidence}%</div></div>
        <div><div className="text-[11px] uppercase text-muted-foreground">Risk</div><div className={`text-sm font-semibold ${r.risk_assessment === "HIGH" ? "text-bear" : r.risk_assessment === "LOW" ? "text-bull" : "text-warn"}`}>{r.risk_assessment}</div></div>
      </div>
      <div className="mt-3">
        <Row k="H4" v={r.bias} sub={`${r.h4_state} · ${r.audit_trail[0] ?? ""}`} />
        <Row k="H1" v={r.h1_state.replaceAll("_", " ")} />
        <Row k="M15" v={r.setup.replaceAll("_", " ")} sub={r.m15_condition} />
        <Row k="M5" v={r.m5_condition} />
      </div>
      {r.confirmation_needed.length > 0 && <div className="mt-3"><div className="text-[11px] font-semibold uppercase text-muted-foreground">Confirmation needed</div>
        <ul className="mt-1 space-y-0.5 text-xs" data-testid="mc-intel-confirm">{r.confirmation_needed.map((c) => <li key={c}>☐ {c}</li>)}</ul></div>}
      <div className="mt-3"><div className="text-[11px] font-semibold uppercase text-muted-foreground">Audit trail</div>
        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">{r.audit_trail.map((a) => <li key={a}>{a}</li>)}</ul></div>
      {r.invalidation_conditions.length > 0 && <div className="mt-3"><div className="text-[11px] font-semibold uppercase text-bear">What invalidates this view</div>
        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground" data-testid="mc-intel-invalid">{r.invalidation_conditions.map((a) => <li key={a}>{a}</li>)}</ul></div>}
      <p className="mt-2 text-[11px] text-muted-foreground">Konteks market saja — MONITOR ONLY, tidak mengirim order. Confidence ≠ kesiapan entry.</p>
    </>}
  </div>;
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
      <span className="text-xs text-muted-foreground">SL {n(p.sl)} · TP2 {n(p.tp2)}{p.action_source ? ` · ${p.action_source.replaceAll("_", " ")}` : ""}</span>
      <Button size="sm" variant="outline" disabled={!quote} onClick={() => quote && store.close(p.id, quote, Date.now())}>Tutup</Button>
    </li>)}</ul>
  </section>;
}

/** P0.3 signal safety strip: READY TTL + frozen origin, or the concise reason the last READY ended. Presentation only. */
export function SignalSafetyStrip({ signal }: { signal: TradingSnapshot["signal"] | null }) {
  if (!signal) return null;
  const o = signal.origin;
  if (signal.state === "READY" && o) return <div className="mt-3 border border-border bg-muted/40 px-3 py-2 text-xs" data-testid="signal-safety-strip">
    <div className="font-semibold">READY · berlaku {signal.ttl_remaining_bars ?? o.ttl_bars} bar M5 lagi</div>
    <div className="mt-1 text-muted-foreground">Entry beku {n(o.origin_entry)} · SL {n(o.origin_sl)} · 1R {n(o.initial_r)} · trigger {o.trigger_tf} {o.trigger_patterns.join("+")}</div>
  </div>;
  const t = signal.lifecycle?.last_terminal;
  if (!t || (signal.state !== "EXPIRED" && signal.state !== "INVALIDATED")) return null;
  const msg = t.reason === "CHASING_PRICE_ALREADY_MOVED" ? "MISSED / CHASING — harga sudah bergerak ≥1R"
    : t.reason === "SIGNAL_TTL_EXPIRED" ? "SIGNAL EXPIRED — tunggu trigger baru"
    : t.reason.includes("TRIGGER_LOW") || t.reason.includes("TRIGGER_HIGH") ? "INVALID — trigger low/high ditembus"
    : t.reason === "SIGNAL_SCALP_MOMENTUM_FLIPPED" ? "INVALID — momentum scalp berbalik"
    : t.reason === "SIGNAL_SCALP_CONFLICT" ? "INVALID — momentum M5/M15 konflik"
    : t.reason === "SIGNAL_OPPOSING_TRIGGER" ? "INVALID — muncul trigger berlawanan" : "INVALID — setup tidak valid lagi";
  return <div className="mt-3 border border-border px-3 py-2 text-xs text-muted-foreground" data-testid="signal-safety-strip">{msg}</div>;
}

type CockpitTab = "TRADE" | "RADAR" | "ANALYSIS";

/** Guarded entry: renders only when the slice view and runtime facts come from the SAME source and symbol. */
function Cockpit({ source, explain, store, fallbackReason }: { source: CockpitSource; explain?: TechnicalSlicePanelProps["explain"]; store: PaperJournalStore; fallbackReason?: string | null }) {
  const sourceVersion = useSyncExternalStore(source.subscribe, source.getVersion, source.getVersion);
  const view = useMemo(() => source.view(), [source, sourceVersion]);
  const facts = useMemo(() => source.facts(), [source, sourceVersion]);
  if (facts.source !== source.source || facts.symbol !== source.symbol || (view && view.symbol !== source.symbol)) return <SourceMismatch detail={`view ${source.source}/${view?.symbol ?? "—"} · facts ${facts.source}/${facts.symbol}`} />;
  if (!view) return <div className="border border-border bg-card p-4 text-sm text-muted-foreground" data-testid="engine-snapshot-pending">ENGINE HOST VPS (LIVE) · menunggu snapshot {source.symbol} dari engine host…</div>;
  return <CockpitBody view={view} facts={facts} explain={explain} store={store} fallbackReason={fallbackReason ?? null} />;
}

function SourceMismatch({ detail }: { detail: string }) {
  return <div role="alert" className="border border-destructive/60 bg-card p-4 text-sm text-destructive" data-testid="state-source-mismatch"><div className="font-semibold">STATE SOURCE MISMATCH</div><div className="mt-1 text-xs text-muted-foreground">{detail}</div></div>;
}

function CockpitBody({ view, facts, explain, store, fallbackReason }: { view: SliceView; facts: RuntimeFacts; explain?: TechnicalSlicePanelProps["explain"]; store: PaperJournalStore; fallbackReason: string | null }) {
  const mobile = useMobileTerminal();
  const snapshot = view.current;
  const publishReport = mobile?.setReport;
  useEffect(() => {
    publishReport?.({ snapshot, facts });
    return () => publishReport?.(null);
  }, [publishReport, snapshot, facts]);
  const evidence = snapshot?.evidence;
  const signal = cockpitSignal(snapshot);
  const projection = tradeProjection(snapshot);
  const entry = referenceEntry(snapshot);
  const plan: DisplayPlan = snapshot?.reference_plan.status === "AVAILABLE" ? { side: snapshot.reference_plan.side, sl: snapshot.reference_plan.sl, tp1: snapshot.reference_plan.tp1, tp2: snapshot.reference_plan.tp2, rr: rrText(snapshot.reference_plan), econ: snapshot.reference_plan.economics_status } : null;
  // Ticket preview: same plan builder rebased to the actual click price (what paper open will freeze).
  const ticketPlan = (side: "BUY" | "SELL"): DisplayPlan => {
    if (signal === side && plan) return plan;
    if (!quote || !snapshot) return null;
    const p = buildSidePlan(side, side === "BUY" ? quote.ask : quote.bid, snapshot.evidence, snapshot.operator ?? null);
    return p.ok ? { side, sl: p.sl, tp1: p.tp1, tp2: p.tp2, rr: rrText(p), econ: p.economics_status } : null;
  };
  const unavailable = !snapshot || snapshot.availability === "UNAVAILABLE" || snapshot.entry.state === "NOT_EVALUABLE";
  const signalReason = unavailable ? "menunggu bukti teknikal yang valid" : technicalCopy(snapshot?.entry.reason ?? "tunggu setup valid");
  const signalTone = projection.direction === "BUY" ? "text-bull" : projection.direction === "SELL" ? "text-bear" : "text-warn";
  const signalBorder = signal === "BUY" ? "border-bull/45" : signal === "SELL" ? "border-bear/45" : "border-border";
  const [ai, setAi] = useState<AiWhyResult | { status: "PENDING" } | null>(null);
  const [mode, setMode] = useState<CockpitMode>("SIMULASI");
  const [tab, setTab] = useState<CockpitTab>("TRADE");
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

  const h1StructureTone = structureTone(evidence?.H1.structure.summary);
  const triggerTone: ConfirmationTone = snapshot?.engulfing?.bullish ? "BULL" : snapshot?.engulfing?.bearish ? "BEAR" : "NEUTRAL";
  const triggerText = snapshot?.engulfing?.bullish ? "BULLISH TERKONFIRMASI" : snapshot?.engulfing?.bearish ? "BEARISH TERKONFIRMASI" : snapshot?.engulfing ? "BELUM TERKONFIRMASI" : "DATA BELUM CUKUP";
  const h1Rsi = evidence?.H1.rsi14;
  const rsiTone: ConfirmationTone = h1Rsi?.status !== "OK" ? "NEUTRAL" : h1Rsi.value > 50 ? "BULL" : h1Rsi.value < 50 ? "BEAR" : "NEUTRAL";
  const snr = evidence?.H1.snr;
  const location = snr ? `S ${n(snr.nearest_support?.price)} · R ${n(snr.nearest_resistance?.price)}` : "DATA BELUM CUKUP";
  const planConfirmations = snapshot?.why.slice(0, 5).map((fact) => technicalCopy(fact.text)) ?? ["Menunggu bukti teknikal yang valid"];

  const tabIcon = { TRADE: ShieldCheck, RADAR: Radar, ANALYSIS: BrainCircuit } as const;
  return <article className="space-y-4 pb-20 md:pb-0" data-testid={`cockpit-${view.symbol}`}>
    <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-border bg-card/95 px-2 pb-[env(safe-area-inset-bottom)] shadow-2xl backdrop-blur md:static md:flex md:border-b md:border-t-0 md:bg-transparent md:px-0 md:shadow-none md:backdrop-blur-none" role="tablist" aria-label="Navigasi utama" data-testid="cockpit-bottom-nav">
      {(["TRADE", "RADAR", "ANALYSIS"] as const).map((t) => {
        const Icon = tabIcon[t];
        return <Button key={t} type="button" role="tab" aria-selected={tab === t} data-testid={`cockpit-tab-${t.toLowerCase()}`} onClick={() => setTab(t)} variant="ghost" className={`h-16 rounded-none border-b-2 px-2 text-[11px] font-semibold md:h-10 md:flex-row md:px-4 ${tab === t ? "border-primary bg-muted/40 text-foreground" : "border-transparent text-muted-foreground"}`}><Icon className="h-4 w-4" />{t}</Button>;
      })}
    </nav>
    <div hidden={tab !== "TRADE"} className="space-y-3" data-testid="tab-trade">
      <section className={`border bg-card p-4 sm:p-5 ${signalBorder}`} data-testid="main-signal-card">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Signal State · {view.symbol}</span>
          <div className="flex border border-border text-[10px] font-semibold" role="group" aria-label="Mode cockpit">
            {(["SIMULASI", "MONITOR"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} data-testid={`mode-${m.toLowerCase()}`} onClick={() => setMode(m)} className={`px-2 py-1 ${mode === m ? "bg-muted text-foreground" : "text-muted-foreground"}`}>{m}</button>)}
          </div>
        </div>
        <div className="mt-4 flex items-end gap-3">
          {projection.direction === "BUY" ? <ArrowUpRight className="mb-2 h-9 w-9 text-bull" /> : projection.direction === "SELL" ? <ArrowDownRight className="mb-2 h-9 w-9 text-bear" /> : <Circle className="mb-2 h-8 w-8 text-warn" />}
          <div className={`text-4xl font-semibold sm:text-6xl ${signalTone}`} data-testid="cockpit-signal" data-engine-signal={signal}>{projection.headline}</div>
        </div>
        <div className="mt-1 text-xs font-semibold uppercase text-muted-foreground" data-testid="cockpit-signal-sub">{projection.status}</div>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground" data-testid="cockpit-signal-reason">{signalReason}</p>
        <SignalSafetyStrip signal={snapshot?.signal ?? null} />
      </section>

      <MarketContextSummary snapshot={snapshot} facts={facts} />
      <section className="border border-border bg-card p-4 sm:p-5" aria-label="Rencana transaksi acuan" data-testid="radar-card">
        <RadarPlanView radar={snapshot?.radar_plan ?? null} signal={signal} entry={entry} projection={projection} />
        <TradeActions symbol={view.symbol} signal={signal} quote={quote} plan={plan} planFor={ticketPlan} reason={signalReason} confirmations={planConfirmations} mode={mode}
          onConfirm={(side) => { if (quote) store.open({ symbol: view.symbol, side, quote, now: uiClock.now(), snapshot }); }} />
      </section>
    <TraderRadarView snapshot={snapshot} facts={facts} part="TRADE" />
    <PaperPositions store={store} symbol={view.symbol} quote={quote} />
    </div>
    <div hidden={tab !== "RADAR"} className="space-y-4" data-testid="tab-radar"><RadarObservabilityPanel facts={facts} symbol={view.symbol} fallbackReason={fallbackReason} /><TraderRadarView snapshot={snapshot} facts={facts} part="RADAR" /></div>
    <div hidden={tab !== "ANALYSIS"} className="space-y-4" data-testid="tab-analysis">
    <TraderRadarView snapshot={snapshot} facts={facts} part="ANALYSIS" />

    <details open className="border-t border-border pt-3" aria-label="Ringkasan engine" data-testid="operator-summary">
      <summary className="cursor-pointer text-xs font-semibold uppercase text-muted-foreground">Detail konteks engine</summary>
      {(() => {
        const o = operatorSummary(snapshot);
        const tone = (value: string) => value === "NAIK" || value === "bullish" || value === "CARI BUY" || value.startsWith("BULLISH") || value === "CROSS UP" || value.endsWith("BUY") ? "BULL" as const : value === "TURUN" || value === "bearish" || value === "CARI SELL" || value.startsWith("BEARISH") || value === "CROSS DOWN" || value.endsWith("SELL") ? "BEAR" as const : "NEUTRAL" as const;
        const light = ([label, value, id]: readonly [string, string, string]) => <ConfirmationLight key={id} label={label} value={value} tone={tone(value)} testId={id} />;
        return <div className="grid gap-3 lg:grid-cols-[3fr_4fr]">
          <div data-testid="macro-context">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Macro context · H4/H1</h3>
            <div className="grid grid-cols-3 gap-2">{([["Market Trend", o.mode, "op-mode"], ["H4", o.h4, "op-h4"], ["H1", o.h1, "op-h1"]] as const).map(light)}</div>
          </div>
          <div data-testid="scalp-context">
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Scalp engine · M15/M5</h3>
              {o.alignment && <span data-testid="op-alignment" className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${o.alignment === "COUNTER MACRO" ? "border-destructive/50 text-destructive" : "border-border text-foreground"}`}>{o.alignment}</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{([["Momentum M15", o.m15, "op-m15-momentum"], ["Momentum M5", o.m5, "op-m5-momentum"], ["Scalp", o.momentum, "op-momentum"], ["Area", o.area, "op-area"], ["EMA", o.ema, "op-ema"], ["Trigger", o.trigger, "op-trigger"], ["Status", o.status, "op-status"]] as const).map(light)}</div>
          </div>
        </div>;
      })()}
    </details>

    <details open className="border-t border-border pt-3" aria-label="Konfirmasi teknikal" data-testid="legacy-confirmations">
      <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><Activity className="h-4 w-4" /><span>Detail teknikal</span><span className="sr-only">Konfirmasi teknikal</span></summary>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        <ConfirmationLight label="Struktur H1" value={evidence?.H1.structure.summary.replace("_", "/") ?? "DATA BELUM CUKUP"} tone={h1StructureTone} testId="confirm-structure" />
        <ConfirmationLight label="Pemicu M5" value={triggerText} tone={triggerTone} testId="confirm-trigger" />
        <ConfirmationLight label="RSI14 H1" value={indicator(evidence?.H1.rsi14)} tone={rsiTone} testId="confirm-rsi" />
        <ConfirmationLight label="Lokasi S/R" value={location} tone="NEUTRAL" testId="confirm-snr" />
        <ConfirmationLight label="ATR14 M15" value={indicator(evidence?.M15.atr14, 3)} tone="NEUTRAL" testId="confirm-atr" />
      </div>
    </details>

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
    </div>
  </article>;
}

export function TechnicalSlicePanel(props: TechnicalSlicePanelProps) {
  // Never Mix State: engine-host mode must not receive any mounted browser runtime.
  if (props.engine && props.runtimes.some((r) => r.reader)) return <section className="bg-background px-4 pb-24 sm:px-8"><div className="mx-auto max-w-screen-2xl"><SourceMismatch detail="ENGINE_HOST store aktif bersamaan dengan BROWSER_SESSION runtime" /></div></section>;
  return props.engine ? <EnginePanel {...props} engine={props.engine} /> : <BrowserPanel {...props} />;
}

function PanelFrame({ children }: { children: import("react").ReactNode }) {
  return <section className="bg-background px-4 pb-24 sm:px-8 md:pb-8" aria-label="Kokpit trading"><div className="mx-auto max-w-screen-2xl">{children}</div></section>;
}
const waiting = <div className="border border-border bg-card p-4 text-sm text-muted-foreground">Menunggu pasar terpilih…</div>;

/** ENGINE HOST mode: zero local evaluation. SSE → store → render; alerts/marks consume the engine's own snapshots. */
function EnginePanel({ runtimes, selectedSymbol, explain, store, alerts, onAlert, engine }: TechnicalSlicePanelProps & { engine: EngineHostStore }) {
  const journal = useMemo(() => store ?? sharedPaperJournal(), [store]);
  const version = useSyncExternalStore(engine.subscribe, engine.getVersion, engine.getVersion);
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  const seen = useRef(new Map<string, number>());
  useEffect(() => {
    for (const b of Object.values(engine.getState().bundles)) {
      const snap = b.slice?.current;
      if (!snap || seen.current.get(b.symbol) === b.timestamp) continue;
      seen.current.set(b.symbol, b.timestamp);
      const now = uiClock.now();
      if (snap.quote) journal.mark(b.symbol, snap.quote, now); // manual SIMULATION positions only
      const alert = alerts?.observe(snap, b.symbol, now);
      if (alert) onAlertRef.current?.(alert);
    }
  }, [version, engine, journal, alerts]);
  const sources = useMemo(() => Object.fromEntries(runtimes.map((r) => [r.symbol, remoteCockpitSource(r.symbol, engine)])), [runtimes, engine]);
  const src = sources[selectedSymbol];
  return <PanelFrame>{src ? <Cockpit source={src} explain={explain} store={journal} /> : waiting}</PanelFrame>;
}

/** BROWSER SESSION mode: the local canonical runtime is the only source. */
function BrowserPanel({ runtimes, selectedSymbol, unmountedReason, tickMs = 2000, explain, store, alerts, onAlert, fallbackReason }: TechnicalSlicePanelProps) {
  const services = useMemo(() => runtimes.map((runtime) => new TechnicalSliceService(runtime.reader, runtime.symbol, new LiveClock(), unmountedReason)), [runtimes, unmountedReason]);
  const journal = useMemo(() => store ?? sharedPaperJournal(), [store]);
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  useEffect(() => {
    const tick = () => {
      for (const service of services) {
        const snap = service.tick();
        const now = uiClock.now();
        // Journal: ENGINE signal transitions only (deduplicated per symbol). Paper marks: SIMULATION only.
        journal.recordSignal(snap, service.symbol, now);
        journal.recordLifecycle(snap, service.symbol, now);
        if (snap.quote) journal.mark(service.symbol, snap.quote, now);
        const alert = alerts?.observe(snap, service.symbol, now);
        if (alert) onAlertRef.current?.(alert);
      }
    };
    tick();
    const timer = setInterval(tick, tickMs);
    return () => clearInterval(timer);
  }, [services, tickMs, journal, alerts]);
  const selected = services.find((service) => service.symbol === selectedSymbol) ?? null;
  const reader = runtimes.find((r) => r.symbol === selectedSymbol)?.reader ?? null;
  const source = useMemo(() => selected && reader ? localCockpitSource(selected, reader) : null, [selected, reader]);
  return <PanelFrame>{source ? <Cockpit source={source} explain={explain} store={journal} fallbackReason={fallbackReason ?? null} /> : waiting}</PanelFrame>;
}
