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
import type { AccountProfile } from "../../engine/risk/types";
import { evaluateSetup, type EvaluatorInput } from "../../engine/signal/signalEvaluator";
import { createSetup, isTerminal, updateSetup } from "../../engine/signal/signalLifecycle";
import type { SignalSetup } from "../../engine/signal/types";

/** Virtual account environment (not strategy params). */
export const VIRTUAL_ACCOUNT_DEFAULTS = Object.freeze({
  initialBalance: 10_000, riskPercent: 1, currency: "USD" as const, maxDailyLossPercent: 5, maxSlippage: 0.5,
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

interface Open { trade: PaperTrade; plan: TradePlan; bars: ArenaCandle[]; h1Phase: string; tier: string }

const toArena = (b: Bar, i: number, spread: number): ArenaCandle => Object.freeze({
  id: `${b.symbol}_${b.timeframe}_${b.open_time / 1000}`, symbol: b.symbol, timeframe: b.timeframe, timestamp: b.open_time / 1000,
  open: b.open, high: b.high, low: b.low, close: b.close, volume: b.tick_count, spread, source: "MT5", isClosed: true, sequence: i + 1,
});

export class LivePaperLoop {
  readonly journal = new TradeJournal();
  private setup: SignalSetup | null = null;
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

  constructor(readonly symbol: string, readonly dataSource: DataSource, private readonly spec: SymbolSpecification) {}

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

  /** Mark-to-market only (no state transition); exits still happen only on CLOSED bars. */
  mark(live: BrokerMarketEvent | null): void { if (live) this.lastMark = this.open?.trade.snapshot.direction === "SELL" ? live.ask : live.bid; }

  onClosedM5(bar: Bar, closed: (tf: Timeframe) => readonly Bar[], live: BrokerMarketEvent | null): void {
    if (bar.status !== "CLOSED" || bar.timeframe !== "M5" || bar.symbol !== this.symbol || bar.close_time <= this.lastClose) return;
    this.lastClose = bar.close_time;
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
        const row = fromPaperTrade(t, { h1Phase: o.h1Phase, locationTier: o.tier, rr: o.plan.rr ?? 0, dataSource: this.dataSource }, calculateExcursion(t.snapshot.direction, t.snapshot.entryPrice, o.bars));
        if (row && this.journal.saveTrade(row).ok) {
          this.balance += row.profitLossUSD; this.peak = Math.max(this.peak, this.balance);
          this.after.push({ tradeId: row.tradeId, balance: r2(this.balance) });
          this.streak = row.result === "LOSS" ? { consecutiveLosses: this.streak.consecutiveLosses + 1, lastLossAt: row.closedAt } : { consecutiveLosses: 0, lastLossAt: this.streak.lastLossAt };
          this.decision = `CLOSED ${row.result} ${row.closeReason}`;
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
    if (this.setup) {
      this.setup = updateSetup(this.setup, { m5: c, m15: m15.at(-1)!, price: c.close, m15Atr: atr, m15StructureShift: m15S.structureShift, emaContext: ema.context, evaluation: ev, now }).setup;
      if (isTerminal(this.setup)) { this.decision = `SETUP ${this.setup.state}`; this.setup = null; }
    }
    if (!this.setup && reaction) { const cr = createSetup(ev, input, reaction, c, c.close); if (cr) this.setup = cr.setup; }
    if (!this.setup || this.setup.state !== "READY") return;

    const setup = this.setup; this.setup = null; // consumed by the plan attempt
    const bid = live ? live.bid : c.close, ask = live ? live.ask : c.close + spread;
    const plan = buildTradePlan({ setup, entry: setup.direction === "BUY" ? ask : bid, m15Structure: m15S, atrM15: atr, now });
    if (plan.status !== "PLANNED") { this.decision = `PLAN_HOLD ${plan.holdReason ?? ""}`; return; }
    const D = VIRTUAL_ACCOUNT_DEFAULTS;
    const contract = { tickSize: this.spec.tick_size, tickValue: this.spec.tick_size * this.spec.contract_size };
    const acct: AccountProfile = {
      mode: "STANDARD", state: "NORMAL", equity: this.balance, peakEquity: this.peak, riskType: "PERCENTAGE", riskValue: D.riskPercent,
      maxDailyLossPercent: D.maxDailyLossPercent, currentDailyDDPercent: this.dayStart > 0 ? Math.max(0, ((this.dayStart - this.balance) / this.dayStart) * 100) : 0, recoveryMultiplier: 0.5,
    };
    // marginPerLot 0 = margin not modelled for paper (no broker margin data); documented, not a guess.
    const risk = evaluateRisk(plan, acct, { symbol: sym, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, ...contract, marginPerLot: 0 }, {
      nowSec: now, positions: [], exposureLimits: { maxSymbolRiskUSD: this.balance * D.maxSymbolRiskPercent / 100, maxTotalRiskUSD: this.balance * D.maxTotalRiskPercent / 100 },
      spread: { current: spread, history: [...this.spreads] }, quote: { ask, bid, maxSlippage: D.maxSlippage }, lossStreak: this.streak, strictRiskMode: true,
    });
    if (risk.decision !== "APPROVED") { this.decision = `RISK_${risk.decision} ${risk.reasons.join(",")}`; return; }
    // fill reference = opposite side; simulateFill adds the real spread (BUY→ask, SELL→bid)
    const pt = createPaperTrade({
      plan, risk, marketPrice: plan.direction === "BUY" ? bid : ask, sim: { spread, slippage: 0, maxSlippage: D.maxSlippage, latencyMs: 0, latencyDriftPerMs: 0 },
      contract, accountEquity: this.balance,
      signalSource: { bias: `H4_${bias.h4.bias}_H1_${bias.h1.phase}`, location: loc.context.priceLocation, trigger: reaction?.pattern ?? "NONE", reactionQuality: reaction?.quality ?? "NONE", emaContext: ema.context.actions.join(",") || ema.context.pricePosition },
      now,
    });
    if (pt.state === "REJECTED") { this.decision = `PAPER_REJECTED ${pt.reason}`; return; }
    const o = openPaperTrade(pt.trade, now); // exits evaluated from the NEXT closed M5 bar
    if (!o.ok) return;
    this.open = { trade: o.trade, plan, bars: [], h1Phase: bias.h1.phase, tier: loc.context.locationTier };
    this.decision = `OPEN ${plan.direction}`;
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
