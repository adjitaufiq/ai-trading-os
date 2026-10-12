// Live paper loop. Composed only inside MarketRuntime; fed by CLOSED M5 bars after CandleStore append.
// Chains the EXISTING engines: M1B.3–7 → M2 lifecycle → M3 plan → M4 risk → M5 paper → M6 journal.
// PAPER ONLY: no broker/gateway import, no order path. Fills use the latest LIVE bid/ask; exits on CLOSED bars, SL-first.
import type { Bar, Timeframe } from "../contracts";
import type { BrokerMarketEvent, SymbolSpecification } from "../broker/types";
import { computeBiasState } from "../../engine/core/bias/biasEngine";
import { computeEMAContext } from "../../engine/core/ema/emaStateEngine";
import { classifyPriceLocation, computeAtr } from "../../engine/core/location/priceLocationEngine";
import type { ArenaCandle } from "../../engine/core/normalizer/types";
import { evaluateReaction } from "../../engine/core/reaction/reactionEvaluator";
import { buildStructure, detectStructureShift } from "../../engine/core/swing/structureEngine";
import { SwingDetector } from "../../engine/core/swing/swingDetector";
import type { SwingTimeframe } from "../../engine/core/swing/types";
import type { DataSource } from "../../engine/contracts/dataSource";
import { createPaperTrade } from "../../engine/execution/paperExecution";
import { updatePosition } from "../../engine/execution/positionManager";
import { openPaperTrade } from "../../engine/execution/tradeLifecycle";
import type { PaperTrade } from "../../engine/execution/types";
import { calculateExcursion } from "../../engine/journal/metricsEngine";
import { fromPaperTrade, TradeJournal } from "../../engine/journal/tradeJournal";
import type { JournalTrade } from "../../engine/journal/types";
import { buildTradePlan } from "../../engine/plan/tradePlanEngine";
import type { TradePlan } from "../../engine/plan/types";
import type { LossStreak } from "../../engine/risk/accountState";
import { evaluateRisk } from "../../engine/risk/riskEngine";
import { DEFAULT_RISK_POLICY, dailyLossPercentOf, riskPercentOf } from "../../engine/risk/riskPolicy";
import type { AccountState } from "../../engine/risk/accountStateProvider";
import type { AccountProfile } from "../../engine/risk/types";
import { evaluateSetup, type EvaluatorInput } from "../../engine/signal/signalEvaluator";
import { createSetup, isTerminal, updateSetup } from "../../engine/signal/signalLifecycle";
import { ActiveSignalRegistry, regimeLabel, signalIdentity, validateSignalContext, type ActiveSignal } from "./signalHardening";
import type { SignalSetup } from "../../engine/signal/types";
import type { EntryDecisionSnapshot, ExcursionMetrics } from "../../engine/journal/types";
import { decideEntry, DECISION_GATE_POLICY_VERSION, type DecisionGateResult } from "./decisionGate";

/** Virtual account environment (not strategy params). */
export const VIRTUAL_ACCOUNT_DEFAULTS = Object.freeze({
  initialBalance: 10_000, riskPercent: riskPercentOf(DEFAULT_RISK_POLICY), currency: "USD" as const, maxDailyLossPercent: dailyLossPercentOf(DEFAULT_RISK_POLICY), maxSlippage: 0.5,
  maxSymbolRiskPercent: 2, maxTotalRiskPercent: 5, spreadHistory: 20,
});
const MIN_M15 = 15;

export interface VirtualAccountView {
  readonly dataSource: DataSource;
  readonly currency: "USD";
  readonly initialBalance: number;
  readonly riskPercent: number;
  readonly balance: number;
  readonly equity: number;
  readonly openPositions: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly peakEquity: number;
  readonly drawdownPercent: number;
  readonly closedTrades: number;
  readonly lastDecision: string | null;
  readonly balanceAfter: readonly { readonly tradeId: string; readonly balance: number }[];
}

/** Emitted once when a READY setup passed plan + M4 APPROVED and the paper trade opened. Read-only copy for observers (demo lab). */
export interface ApprovedPaperOpen {
  readonly signalId: string; readonly planId: string; readonly symbol: string; readonly direction: "BUY" | "SELL";
  readonly entry: number; readonly stopLoss: number; readonly takeProfit: number; readonly rr: number | null;
  readonly riskDecision: "APPROVED"; readonly signalSource: Readonly<Record<string, string>>; readonly closedBarAt: number;
  /** Phase 4B: frozen Decision Gate snapshot copied as-is for the demo evaluation journal (no new decision). */
  readonly entryDecision?: EntryDecisionSnapshot;
}

/** Pipeline observability event (proof of life). Read-only copy; emitting never alters the loop. */
export type PaperPipelineType = "READY" | "BLOCKED" | "EXECUTION" | "EXIT";
export interface PaperPipelineEvent {
  readonly type: PaperPipelineType; readonly stage: "SIGNAL" | "DECISION" | "PLAN" | "RISK" | "PAPER";
  readonly symbol: string; readonly signalId: string | null; readonly direction: "BUY" | "SELL" | null; readonly at: number;
  readonly reason: string; readonly entry: number | null; readonly stopLoss: number | null; readonly takeProfit: number | null;
}

/** H4 primaryBias reading (technical slice, CLOSED H4 only). The ONLY directional authority for paper setups. */
export interface PrimaryBiasReading {
  readonly bias: "BUY" | "SELL" | "NONE"; readonly asOf: number; readonly source: "TECHNICAL_H4_CLOSED";
  /** ARENA operator.status from the SAME evaluation (Decision Gate permission). Missing ⇒ BLOCK_ARENA_INVALID. */
  readonly arenaStatus?: string | null;
}

/** Append-only decision lifecycle record (candidate → gate → order → close). Copies only; never read by decisions. */
export interface PaperDecisionRecord {
  readonly kind: "CANDIDATE" | "GATE" | "ORDER" | "CLOSE" | "REJECTED";
  readonly at: number; readonly symbol: string; readonly signalId: string | null; readonly direction: "BUY" | "SELL" | null;
  readonly arenaStatus: string | null;
  /** REJECTED: SIGNAL_REJECTED/DUPLICATE_BLOCKED (audit only, never READY). CANDIDATE: M1B source; GATE: ALLOW/BLOCK; ORDER: CREATED/REJECTED/FAILED; CLOSE: WIN/LOSS/BREAKEVEN. */
  readonly outcome: string;
  readonly reason: string;
  readonly rr?: number | null;
  readonly excursion?: ExcursionMetrics | null;
  /** CANDIDATE only: copies of the inputs seen at creation (no recomputation). */
  readonly context?: {
    readonly m1bState: string; readonly primaryBias: string | null; readonly priceLocation: string; readonly locationTier: string | null;
    readonly keyLevelPrice: number | null; readonly trigger: string; readonly reactionQuality: string;
    readonly emaPricePosition: string; readonly emaActions: readonly string[];
    /** Regime label frozen at creation (engine M1B.9 regime; UNCERTAIN when absent). */
    readonly regime?: string; readonly signalIdentity?: string;
  };
}
export const DECISION_LOG_RING = 500;
/** Synchronous provider evaluated at every CLOSED M5. Absent (replay without ReplayPrimaryBiasProvider) ⇒ fail closed. */
export type PrimaryBiasProvider = () => PrimaryBiasReading | null;
export type PrimaryBiasGateReason = "BLOCK_COUNTER_PRIMARY_BIAS" | "NO_PRIMARY_BIAS";

/** Read-only copy of the last pipeline outcome per stage (observability only; never read by the loop's decisions). */
export interface PaperReadinessView {
  readonly lastEvaluatedAt: number | null;
  readonly decision: string | null;
  readonly primaryBias: Readonly<PrimaryBiasReading> | null;
  readonly m2: { readonly at: number; readonly state: string; readonly direction: "BUY" | "SELL" | "NONE" | null } | null;
  readonly m3: { readonly at: number; readonly status: string; readonly holdReason: string | null; readonly signalId: string } | null;
  readonly m4: { readonly at: number; readonly decision: string; readonly reasons: readonly string[]; readonly signalId: string } | null;
  readonly openPosition: boolean;
  readonly gate?: DecisionGateResult | null;
}

interface Open { trade: PaperTrade; plan: TradePlan; bars: ArenaCandle[]; h1Phase: string; tier: string; primaryBias?: PrimaryBiasReading; entryDecision?: EntryDecisionSnapshot }

export const PAPER_STATE_VERSION = "paper-state-v1" as const;
/** Persisted virtual-account state (engine host). Plain JSON; setup/open are opaque engine data. */
export interface PaperLoopState {
  readonly version: typeof PAPER_STATE_VERSION;
  readonly symbol: string;
  readonly dataSource: DataSource;
  readonly balance: number; readonly peak: number; readonly dayKey: number; readonly dayStart: number;
  readonly streak: LossStreak;
  readonly lastClose: number | null;
  readonly decision: string | null;
  readonly spreads: readonly number[];
  readonly after: readonly { readonly tradeId: string; readonly balance: number }[];
  readonly setup: unknown;
  readonly open: unknown;
  readonly journal: readonly unknown[];
  /** Hardening V1: active consumed-READY identities (optional for older states). */
  readonly activeSignals?: readonly ActiveSignal[];
}

const toArena = (b: Bar, i: number, spread: number): ArenaCandle => Object.freeze({
  id: `${b.symbol}_${b.timeframe}_${b.open_time / 1000}`, symbol: b.symbol, timeframe: b.timeframe, timestamp: b.open_time / 1000,
  open: b.open, high: b.high, low: b.low, close: b.close, volume: b.tick_count, spread, source: "MT5", isClosed: true, sequence: i + 1,
});

export class LivePaperLoop {
  readonly journal = new TradeJournal();
  private setup: SignalSetup | null = null;
  private readonly active = new ActiveSignalRegistry();
  private open: Open | null = null;
  private balance: number = VIRTUAL_ACCOUNT_DEFAULTS.initialBalance;
  private peak = this.balance;
  private dayKey = -1;
  private dayStart = this.balance;
  private streak: LossStreak = { consecutiveLosses: 0, lastLossAt: null };
  private lastClose = -Infinity;
  private lastMark: number | null = null;
  private decision: string | null = null;
  private readonly spreads: number[] = [];
  private readonly after: { tradeId: string; balance: number }[] = [];
  private obs: { at: number | null; pb: PrimaryBiasReading | null; m2: PaperReadinessView["m2"]; m3: PaperReadinessView["m3"]; m4: PaperReadinessView["m4"]; gate: DecisionGateResult | null } = { at: null, pb: null, m2: null, m3: null, m4: null, gate: null };
  private readonly decisionLog: PaperDecisionRecord[] = [];
  private record(r: Omit<PaperDecisionRecord, "symbol">): void {
    this.decisionLog.push(Object.freeze({ ...r, symbol: this.symbol }));
    if (this.decisionLog.length > DECISION_LOG_RING) this.decisionLog.splice(0, this.decisionLog.length - DECISION_LOG_RING);
  }
  /** Bounded decision lifecycle log (copies only). */
  decisions(): readonly PaperDecisionRecord[] { return Object.freeze([...this.decisionLog]); }

  private readonly openListeners = new Set<(e: ApprovedPaperOpen) => void>();
  /** Observer hook; listeners cannot influence the paper loop (errors are swallowed). */
  onApprovedOpen(cb: (e: ApprovedPaperOpen) => void): () => void { this.openListeners.add(cb); return () => this.openListeners.delete(cb); }

  private readonly pipeListeners = new Set<(e: PaperPipelineEvent) => void>();
  onPipelineEvent(cb: (e: PaperPipelineEvent) => void): () => void { this.pipeListeners.add(cb); return () => this.pipeListeners.delete(cb); }
  private emit(e: Omit<PaperPipelineEvent, "symbol">): void {
    const ev = Object.freeze({ ...e, symbol: this.symbol });
    for (const l of this.pipeListeners) { try { l(ev); } catch { /* observers never affect the loop */ } }
  }

  /** Phase 4A.2: ACCOUNT_MODE=DEMO account state (broker). When set, M4 approval, lot, exposure and daily-loss
   *  use ONLY this state; unavailable ⇒ RISK block (never falls back to the simulated balance). */
  private accountSource: (() => AccountState | null) | null = null;
  private brokerDay = { key: -1, start: 0, peak: 0 };
  setAccountStateSource(fn: (() => AccountState | null) | null): void { this.accountSource = fn; }
  accountSourceLabel(): "PAPER_SIMULATED" | "EXNESS_DEMO" { return this.accountSource ? "EXNESS_DEMO" : "PAPER_SIMULATED"; }
  private readonly sourceByTrade = new Map<string, "PAPER_SIMULATED" | "EXNESS_DEMO">();
  /** Account source that sized/approved this trade (recorded at close in this process; null if before restart). */
  tradeAccountSource(tradeId: string): "PAPER_SIMULATED" | "EXNESS_DEMO" | null { return this.sourceByTrade.get(tradeId) ?? null; }

  constructor(readonly symbol: string, readonly dataSource: DataSource, private readonly spec: SymbolSpecification, private readonly primaryBiasProvider?: PrimaryBiasProvider) {}

  /** Fail closed: no provider, provider error, or malformed reading ⇒ null (treated as NO_PRIMARY_BIAS). */
  private readPrimaryBias(): PrimaryBiasReading | null {
    if (!this.primaryBiasProvider) return null;
    try {
      const r = this.primaryBiasProvider();
      return r && (r.bias === "BUY" || r.bias === "SELL" || r.bias === "NONE") && Number.isFinite(r.asOf) ? r : null;
    } catch { return null; }
  }

  account(): Readonly<VirtualAccountView> {
    const u = this.unrealized();
    const equity = this.balance + u;
    return Object.freeze({
      dataSource: this.dataSource, currency: "USD", initialBalance: VIRTUAL_ACCOUNT_DEFAULTS.initialBalance, riskPercent: VIRTUAL_ACCOUNT_DEFAULTS.riskPercent,
      balance: r2(this.balance), equity: r2(equity), openPositions: this.open ? 1 : 0,
      realizedPnL: r2(this.balance - VIRTUAL_ACCOUNT_DEFAULTS.initialBalance), unrealizedPnL: r2(u), peakEquity: r2(this.peak),
      drawdownPercent: this.peak > 0 ? r2(Math.max(0, ((this.peak - equity) / this.peak) * 100)) : 0,
      closedTrades: this.journal.getAll().length, lastDecision: this.decision, balanceAfter: Object.freeze(this.after.map((x) => Object.freeze({ ...x }))),
    });
  }

  trades(): readonly Readonly<JournalTrade>[] { return this.journal.getAll(); }

  /** Copy of recorded outcomes; no evaluation happens here. */
  readiness(): PaperReadinessView {
    const o = this.obs;
    return Object.freeze({ lastEvaluatedAt: o.at, decision: this.decision, primaryBias: o.pb ? Object.freeze({ ...o.pb }) : null, m2: o.m2, m3: o.m3, m4: o.m4, openPosition: this.open !== null, gate: o.gate });
  }

  /** Plain-data snapshot of the virtual account for host persistence. Journal rows are exported verbatim (append-only). */
  exportState(): PaperLoopState {
    return structuredClone({
      version: PAPER_STATE_VERSION, symbol: this.symbol, dataSource: this.dataSource,
      balance: this.balance, peak: this.peak, dayKey: this.dayKey, dayStart: this.dayStart, streak: this.streak,
      lastClose: Number.isFinite(this.lastClose) ? this.lastClose : null, decision: this.decision,
      spreads: [...this.spreads], after: [...this.after], setup: this.setup, open: this.open,
      journal: this.journal.getAll().map((r) => ({ ...r })), activeSignals: this.active.export(),
    }) as PaperLoopState;
  }

  /** Restores a persisted state once, before any CLOSED bar is processed. Never mixes data sources or symbols. */
  restoreState(s: PaperLoopState): void {
    if (s.version !== PAPER_STATE_VERSION) throw new Error(`paper state version ${String(s.version)} unsupported`);
    if (s.symbol !== this.symbol || s.dataSource !== this.dataSource) throw new Error("paper state symbol/dataSource mismatch");
    if (Number.isFinite(this.lastClose) || this.journal.size > 0) throw new Error("paper state can only be restored on a fresh loop");
    for (const row of s.journal) { const r = this.journal.saveTrade(row as JournalTrade); if (!r.ok) throw new Error(`journal restore ${r.error}`); }
    this.balance = s.balance; this.peak = s.peak; this.dayKey = s.dayKey; this.dayStart = s.dayStart; this.streak = s.streak;
    this.lastClose = s.lastClose ?? -Infinity; this.decision = s.decision;
    this.spreads.push(...s.spreads); this.after.push(...s.after);
    this.setup = s.setup as SignalSetup | null; this.open = s.open as Open | null;
    this.active.restore(s.activeSignals);
  }

  /** Mark-to-market only (no state transition); exits still happen only on CLOSED bars. */
  mark(live: BrokerMarketEvent | null): void { if (live) this.lastMark = this.open?.trade.snapshot.direction === "SELL" ? live.ask : live.bid; }

  onClosedM5(bar: Bar, closed: (tf: Timeframe) => readonly Bar[], live: BrokerMarketEvent | null): void {
    if (bar.status !== "CLOSED" || bar.timeframe !== "M5" || bar.symbol !== this.symbol || bar.close_time <= this.lastClose) return;
    this.lastClose = bar.close_time;
    this.obs.at = bar.close_time;
    try { this.step(bar, closed, live); } catch (e) { this.decision = `ERROR ${(e as Error).message}`; }
  }

  private unrealized(): number {
    const o = this.open; if (!o || this.lastMark === null) return 0;
    const s = o.trade.snapshot, c = o.trade.contract;
    const move = s.direction === "BUY" ? this.lastMark - s.entryPrice : s.entryPrice - this.lastMark;
    return (move / c.tickSize) * c.tickValue * s.lot;
  }

  private step(bar: Bar, closed: (tf: Timeframe) => readonly Bar[], live: BrokerMarketEvent | null): void {
    const sym = this.symbol;
    const spread = live ? live.spread : 0;
    this.spreads.push(spread); if (this.spreads.length > VIRTUAL_ACCOUNT_DEFAULTS.spreadHistory) this.spreads.shift();
    const visible = (tf: Timeframe) => closed(tf).filter((b) => b.status === "CLOSED" && b.close_time <= bar.close_time).map((b, i) => toArena(b, i, spread));
    const m5 = visible("M5"), m15 = visible("M15");
    const c = m5.at(-1); if (!c) return;
    const now = bar.close_time / 1000;
    const day = Math.floor(now / 86400); if (day !== this.dayKey) { this.dayKey = day; this.dayStart = this.balance; }

    if (this.open) {
      const o = this.open;
      if (c.timestamp >= (o.trade.openedAt ?? 0)) o.bars.push(c);
      const u = updatePosition(o.trade, c, now);
      if (u.ok) o.trade = u.trade;
      if (u.ok && u.trade.state === "CLOSED") {
        const t = u.trade;
        const row = fromPaperTrade(t, { h1Phase: o.h1Phase, locationTier: o.tier, rr: o.plan.rr ?? 0, dataSource: this.dataSource, ...(o.primaryBias ? { primaryBias: o.primaryBias } : {}), ...(o.entryDecision ? { entryDecision: o.entryDecision } : {}) }, calculateExcursion(t.snapshot.direction, t.snapshot.entryPrice, o.bars));
        if (row && this.journal.saveTrade(row).ok) {
          this.balance += row.profitLossUSD; this.peak = Math.max(this.peak, this.balance);
          this.after.push({ tradeId: row.tradeId, balance: r2(this.balance) });
          this.sourceByTrade.set(row.tradeId, this.accountSourceLabel());
          this.streak = row.result === "LOSS" ? { consecutiveLosses: this.streak.consecutiveLosses + 1, lastLossAt: row.closedAt } : { consecutiveLosses: 0, lastLossAt: this.streak.lastLossAt };
          this.decision = `CLOSED ${row.result} ${row.closeReason}`;
          this.record({ kind: "CLOSE", at: bar.close_time, signalId: o.plan.signalId ?? null, direction: t.snapshot.direction, arenaStatus: o.entryDecision?.arenaStatus ?? null, outcome: row.result, reason: row.closeReason ?? "", rr: o.plan.rr ?? null, excursion: row.excursion ?? null });
          this.emit({ type: "EXIT", stage: "PAPER", signalId: o.plan.signalId ?? null, direction: t.snapshot.direction, at: bar.close_time, reason: `${row.result} ${row.closeReason ?? ""}`.trim(), entry: t.snapshot.entryPrice, stopLoss: t.snapshot.stopLoss, takeProfit: t.snapshot.takeProfit });
        }
        this.open = null; this.lastMark = null;
      }
      return;
    }
    if (m5.length < 2 || m15.length < MIN_M15) { this.decision = "WARMUP"; return; }
    const det = (tf: SwingTimeframe) => { const d = new SwingDetector(sym, tf); for (const x of tf === "M15" ? m15 : visible(tf)) d.push(x); return d.getSwings(); };
    let m15S = buildStructure(sym, "M15", det("M15"), now);
    m15S = detectStructureShift(m15S, m15.at(-1)!);
    const bias = computeBiasState(sym, buildStructure(sym, "H4", det("H4"), now), buildStructure(sym, "H1", det("H1"), now), now);
    const loc = classifyPriceLocation({ currentPrice: c.close, m15Structure: m15S, m15Candles: m15, bias, now });
    const ema = computeEMAContext(m5, now);
    const atr = computeAtr(m15);
    if (!loc.ok || !ema.ok || atr === null) { this.decision = "NOT_EVALUABLE"; return; }
    const re = evaluateReaction({ previous: m5.at(-2)!, current: c, priceContext: loc.context, emaContext: ema.context, atr });
    const reaction = re.ok ? re.result : null;
    const input: EvaluatorInput = {
      bias, priceContext: loc.context, emaContext: ema.context, reaction, m15Atr: atr,
      m15StructureShift: m15S.structureShift, m15StructureValid: !!m15S.lastConfirmedHigh && !!m15S.lastConfirmedLow,
      m5CandleClosed: true, dataStale: false, now,
    };
    const ev = evaluateSetup(input);
    this.decision = ev.kind === "NO_SETUP" ? `NO_SETUP ${ev.reason}` : ev.kind;
    // PrimaryBias → M2 gate: H4 primaryBias is the only direction authority. S/R location only proposes candidates.
    const pb = this.readPrimaryBias();
    this.obs.pb = pb;
    const side: "BUY" | "SELL" | null = pb && pb.bias !== "NONE" ? pb.bias : null;
    const gate = (dir: "BUY" | "SELL" | "NONE"): PrimaryBiasGateReason | null => side === null ? "NO_PRIMARY_BIAS" : dir !== side ? "BLOCK_COUNTER_PRIMARY_BIAS" : null;
    this.active.prune(c.timestamp);
    if (side) this.active.invalidateDirection(side === "BUY" ? "SELL" : "BUY");
    else { this.active.invalidateDirection("BUY"); this.active.invalidateDirection("SELL"); }
    const ctxReject = () => validateSignalContext({ barCloseMs: bar.close_time, m15LastCloseMs: m15.length ? (m15.at(-1)!.timestamp * 1000) + 900_000 : null, primaryBiasAsOfMs: pb ? pb.asOf : null });
    if (this.setup && !isTerminal(this.setup)) {
      const g = gate(this.setup.direction);
      if (g) { this.decision = `SETUP_INVALIDATED ${g}`; this.setup = null; }
    }
    const evGate = ev.kind === "CANDIDATE" ? gate(ev.direction) : null;
    if (evGate) this.decision = `NO_SETUP ${evGate}`;
    if (this.setup) {
      this.setup = updateSetup(this.setup, { m5: c, m15: m15.at(-1)!, price: c.close, m15Atr: atr, m15StructureShift: m15S.structureShift, emaContext: ema.context, evaluation: ev, now }).setup;
      if (isTerminal(this.setup)) { this.decision = `SETUP ${this.setup.state}`; this.setup = null; }
    }
    if (!this.setup && reaction && !evGate) {
      const raw = createSetup(ev, input, reaction, c, c.close);
      let cr = raw;
      if (raw) {
        const rd = raw.setup.direction === "NONE" ? null : raw.setup.direction;
        const why = ctxReject();
        const dup = why ? null : this.active.activeFor(raw.setup);
        if (why || dup) {
          this.decision = why ? `SIGNAL_REJECTED ${why}` : "DUPLICATE_BLOCKED";
          this.record({ kind: "REJECTED", at: bar.close_time, signalId: raw.setup.id, direction: rd, arenaStatus: pb?.arenaStatus ?? null,
            outcome: why ? "SIGNAL_REJECTED" : "DUPLICATE_BLOCKED", reason: why ?? `DUPLICATE_OF ${dup!.signalId}` });
          cr = null;
        }
      }
      if (cr) {
        this.setup = cr.setup;
        const d = cr.setup.direction === "NONE" ? null : cr.setup.direction;
        this.record({ kind: "CANDIDATE", at: bar.close_time, signalId: cr.setup.id, direction: d, arenaStatus: pb?.arenaStatus ?? null, outcome: "M1B_SETUP", reason: `${loc.context.priceLocation}/${reaction.pattern}`,
          context: Object.freeze({ m1bState: String(cr.setup.state), primaryBias: pb?.bias ?? null, priceLocation: String(loc.context.priceLocation), locationTier: loc.context.locationTier ?? null,
            keyLevelPrice: Number.isFinite(loc.context.keyLevelPrice) ? loc.context.keyLevelPrice : null, trigger: String(reaction.pattern), reactionQuality: String(reaction.quality),
            emaPricePosition: String(ema.context.pricePosition), emaActions: Object.freeze([...(ema.context.actions ?? [])]),
            regime: regimeLabel(cr.setup.marketContext?.regime), signalIdentity: signalIdentity(cr.setup) }) });
      }
    }
    this.obs.m2 = Object.freeze({ at: bar.close_time, state: this.setup ? this.setup.state : (this.decision ?? "NO_SETUP"), direction: this.setup ? this.setup.direction : (ev.kind === "CANDIDATE" ? ev.direction : null) });
    if (!this.setup || this.setup.state !== "READY") return;
    if (!pb || gate(this.setup.direction)) { this.decision = `SETUP_INVALIDATED ${gate(this.setup.direction) ?? "NO_PRIMARY_BIAS"}`; this.setup = null; return; }

    const lost = ctxReject();
    if (lost) { // context lost after the setup became READY ⇒ invalidate, never consume
      this.decision = `SETUP_INVALIDATED ${lost}`;
      this.record({ kind: "REJECTED", at: bar.close_time, signalId: this.setup.id, direction: this.setup.direction === "NONE" ? null : this.setup.direction, arenaStatus: pb.arenaStatus ?? null, outcome: "SIGNAL_REJECTED", reason: `CONTEXT_LOST ${lost}` });
      this.setup = null; return;
    }
    const setup = this.setup; this.setup = null; // consumed by the plan attempt
    this.active.register(setup);
    const base = { signalId: setup.id, direction: setup.direction === "NONE" ? null : setup.direction, at: bar.close_time };
    // Decision Gate: single entry authority. M1B READY is only a request; ARENA operator.status must ALLOW the same side.
    const g = decideEntry(pb.arenaStatus, setup.direction);
    this.obs.gate = g;
    this.record({ kind: "GATE", at: bar.close_time, signalId: setup.id, direction: base.direction, arenaStatus: g.arenaStatus, outcome: g.decision, reason: g.reason });
    if (g.decision !== "ALLOW") {
      this.decision = `GATE_BLOCK ${g.reason}`;
      this.emit({ ...base, type: "BLOCKED", stage: "DECISION", reason: g.reason, entry: null, stopLoss: null, takeProfit: null });
      return;
    }
    this.emit({ ...base, type: "READY", stage: "SIGNAL", reason: `READY ${setup.direction}`, entry: null, stopLoss: null, takeProfit: null });
    const blocked = (stage: "PLAN" | "RISK" | "PAPER", reason: string, p?: TradePlan) => {
      if (stage === "PAPER") this.record({ kind: "ORDER", at: bar.close_time, signalId: setup.id, direction: base.direction, arenaStatus: g.arenaStatus, outcome: reason === "PAPER_OPEN_FAILED" ? "FAILED" : "REJECTED", reason });
      this.emit({ ...base, type: "BLOCKED", stage, reason, entry: p?.entry ?? null, stopLoss: p?.sl ?? null, takeProfit: p?.tp ?? null });
    };
    const bid = live ? live.bid : c.close, ask = live ? live.ask : c.close + spread;
    const plan = buildTradePlan({ setup, entry: setup.direction === "BUY" ? ask : bid, m15Structure: m15S, atrM15: atr, now });
    this.obs.m3 = Object.freeze({ at: bar.close_time, status: plan.status, holdReason: plan.holdReason ?? null, signalId: setup.id });
    if (plan.status !== "PLANNED") { this.decision = `PLAN_HOLD ${plan.holdReason ?? ""}`; blocked("PLAN", this.decision, plan); return; }
    const D = VIRTUAL_ACCOUNT_DEFAULTS;
    const contract = { tickSize: this.spec.tick_size, tickValue: this.spec.tick_size * this.spec.contract_size };
    // Account state: simulated paper balance (PAPER) or broker demo state (DEMO). One base for every check below.
    let acctBase = { equity: this.balance, balance: this.balance, peak: this.peak, dayStart: this.dayStart };
    if (this.accountSource) {
      let st: AccountState | null = null; try { st = this.accountSource(); } catch { st = null; }
      if (!st || !(st.balance > 0) || !(st.equity > 0)) { this.decision = "RISK_REJECTED ACCOUNT_STATE_UNAVAILABLE"; blocked("RISK", this.decision, plan); return; }
      const day = Math.floor(now / 86400);
      if (day !== this.brokerDay.key) this.brokerDay = { key: day, start: st.balance, peak: Math.max(this.brokerDay.peak, st.equity) };
      this.brokerDay.peak = Math.max(this.brokerDay.peak, st.equity);
      acctBase = { equity: Math.min(st.balance, st.equity), balance: st.balance, peak: this.brokerDay.peak, dayStart: this.brokerDay.start };
    }
    const acct: AccountProfile = {
      mode: "STANDARD", state: "NORMAL", equity: acctBase.equity, peakEquity: acctBase.peak, riskType: "PERCENTAGE", riskValue: D.riskPercent,
      maxDailyLossPercent: D.maxDailyLossPercent, currentDailyDDPercent: acctBase.dayStart > 0 ? Math.max(0, ((acctBase.dayStart - acctBase.equity) / acctBase.dayStart) * 100) : 0, recoveryMultiplier: 0.5,
    };
    // marginPerLot 0 = margin not modelled for paper (no broker margin data); documented, not a guess.
    const risk = evaluateRisk(plan, acct, { symbol: sym, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, ...contract, marginPerLot: 0 }, {
      nowSec: now, positions: [], exposureLimits: { maxSymbolRiskUSD: acctBase.balance * D.maxSymbolRiskPercent / 100, maxTotalRiskUSD: acctBase.balance * D.maxTotalRiskPercent / 100 },
      spread: { current: spread, history: [...this.spreads] }, quote: { ask, bid, maxSlippage: D.maxSlippage }, lossStreak: this.streak, strictRiskMode: true,
    });
    this.obs.m4 = Object.freeze({ at: bar.close_time, decision: risk.decision, reasons: Object.freeze([...risk.reasons]), signalId: setup.id });
    if (risk.decision !== "APPROVED") { this.decision = `RISK_${risk.decision} ${risk.reasons.join(",")}`; blocked("RISK", this.decision, plan); return; }
    // fill reference = opposite side; simulateFill adds the real spread (BUY→ask, SELL→bid)
    const pt = createPaperTrade({
      plan, risk, marketPrice: plan.direction === "BUY" ? bid : ask, sim: { spread, slippage: 0, maxSlippage: D.maxSlippage, latencyMs: 0, latencyDriftPerMs: 0 },
      contract, accountEquity: acctBase.equity,
      signalSource: { bias: `H4_${bias.h4.bias}_H1_${bias.h1.phase}`, location: loc.context.priceLocation, trigger: reaction?.pattern ?? "NONE", reactionQuality: reaction?.quality ?? "NONE", emaContext: ema.context.actions.join(",") || ema.context.pricePosition },
      now,
    });
    if (pt.state === "REJECTED") { this.decision = `PAPER_REJECTED ${pt.reason}`; blocked("PAPER", this.decision, plan); return; }
    const o = openPaperTrade(pt.trade, now); // exits evaluated from the NEXT closed M5 bar
    if (!o.ok) { blocked("PAPER", "PAPER_OPEN_FAILED", plan); return; }
    const ss = o.trade.snapshot.signalSource;
    const entryDecision: EntryDecisionSnapshot = Object.freeze({
      gatePolicyVersion: DECISION_GATE_POLICY_VERSION, decision: "ALLOW" as const, reason: g.reason, arenaStatus: g.arenaStatus,
      candidateDirection: plan.direction, signalId: setup.id, decidedAt: bar.close_time, primaryBias: pb.bias,
      m1bBias: ss.bias ?? null, m15Structure: m15S.trend ?? null, m15StructureShift: m15S.structureShift ?? null,
      priceLocation: loc.context.priceLocation ?? null, locationTier: loc.context.locationTier ?? null,
      trigger: ss.trigger ?? null, reactionQuality: ss.reactionQuality ?? null,
      plannedEntry: plan.entry ?? null, stopLoss: plan.sl ?? null, takeProfit: plan.tp ?? null, plannedRr: plan.rr ?? null,
      lot: o.trade.snapshot.lot ?? null, riskUSD: o.trade.snapshot.riskUSD ?? null,
    });
    this.open = { trade: o.trade, plan, bars: [], h1Phase: bias.h1.phase, tier: loc.context.locationTier, primaryBias: pb, entryDecision };
    this.record({ kind: "ORDER", at: bar.close_time, signalId: setup.id, direction: plan.direction, arenaStatus: g.arenaStatus, outcome: "CREATED", reason: `PAPER OPEN ${plan.direction}` });
    this.decision = `OPEN ${plan.direction}`;
    this.emit({ ...base, type: "EXECUTION", stage: "PAPER", reason: `PAPER OPEN ${plan.direction}`, entry: o.trade.snapshot.entryPrice, stopLoss: plan.sl, takeProfit: plan.tp });
    const openEv: ApprovedPaperOpen = Object.freeze({
      signalId: setup.id, planId: plan.id, symbol: sym, direction: plan.direction, entry: plan.entry, stopLoss: plan.sl!, takeProfit: plan.tp!, rr: plan.rr,
      riskDecision: "APPROVED" as const, signalSource: Object.freeze({ ...o.trade.snapshot.signalSource }), closedBarAt: bar.close_time, entryDecision,
    });
    for (const l of this.openListeners) { try { l(openEv); } catch { /* observers never affect the loop */ } }
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
