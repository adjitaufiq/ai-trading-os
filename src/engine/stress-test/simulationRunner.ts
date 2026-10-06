// M7 — Unattended pipeline runner. Wires the EXISTING engines only:
// M1B.1 normalize → M1B.3 swings/structure → M1B.4 bias → M1B.5 location → M1B.6 EMA
// → M1B.7 reaction → M2 signal → M3 plan → M4 risk → M5 paper → M6 journal → M6.5 autopsy.
// No manual step, no override, no parameter change. Paper simulation only.
import { runAutopsy } from "../autopsy/autopsyEngine";
import { analyzeFailureDistribution } from "../autopsy/patternAnalyzer";
import type { TradeAutopsy } from "../autopsy/types";
import { computeBiasState } from "../core/bias/biasEngine";
import { computeEMAContext } from "../core/ema/emaStateEngine";
import { classifyPriceLocation, computeAtr } from "../core/location/priceLocationEngine";
import { validateAndNormalize } from "../core/normalizer/normalizer";
import { TIMEFRAME_SECONDS, type ArenaCandle, type RawGatewayPayload, type Timeframe } from "../core/normalizer/types";
import { evaluateReaction } from "../core/reaction/reactionEvaluator";
import { buildStructure, detectStructureShift } from "../core/swing/structureEngine";
import { SwingDetector } from "../core/swing/swingDetector";
import type { SwingTimeframe } from "../core/swing/types";
import { createPaperTrade } from "../execution/paperExecution";
import { updatePosition } from "../execution/positionManager";
import { openPaperTrade } from "../execution/tradeLifecycle";
import type { PaperTrade } from "../execution/types";
import { calculateExcursion } from "../journal/metricsEngine";
import { fromPaperTrade, TradeJournal } from "../journal/tradeJournal";
import type { JournalTrade } from "../journal/types";
import { buildTradePlan } from "../plan/tradePlanEngine";
import type { TradePlan } from "../plan/types";
import type { LossStreak } from "../risk/accountState";
import { evaluateRisk } from "../risk/riskEngine";
import type { AccountProfile } from "../risk/types";
import { evaluateSetup, type EvaluatorInput } from "../signal/signalEvaluator";
import { createSetup, isTerminal, updateSetup } from "../signal/signalLifecycle";
import type { SignalSetup } from "../signal/types";
import { ContextObserver, emptyContextCounters } from "./contextObserver";
import { buildContextReport } from "./contextAnalytics";
import type { ContextCounters } from "./types";
import { bump, computeStressMetrics, emptyCounters, scenarioStats } from "./performanceMonitor";
import { generatePath, mulberry32 } from "./scenarioGenerator";
import { buildHealthChecks, snapshotParams } from "./stressReport";
import {
  DEFAULT_STRESS_CONFIG, STRESS_ENV as E, STRESS_POLICY_VERSION,
  type MarketScenario, type PipelineCounters, type StressRunResult, type StressTestConfig,
} from "./types";

interface Shared {
  cfg: StressTestConfig;
  target: number;
  journal: TradeJournal;
  autopsies: TradeAutopsy[];
  counters: PipelineCounters;
  scenarioOf: Map<string, string>;
  setupIds: Set<string>;
  terminalRevivals: number;
  riskViolations: number;
  equity: number;
  peak: number;
  dayKey: number;
  dayStartEquity: number;
  streak: LossStreak;
  minEquity: number;
  ctx: ContextCounters | null;
}

interface OpenCtx {
  trade: PaperTrade; plan: TradePlan; bars: ArenaCandle[]; scenario: string;
  atr: number; spread: number; normalSpread: number; h1Phase: string; tier: string;
}

const HTF: readonly Timeframe[] = ["M15", "H1", "H4"];

function account(s: Shared): AccountProfile {
  const dd = s.dayStartEquity > 0 ? Math.max(0, ((s.dayStartEquity - s.equity) / s.dayStartEquity) * 100) : 0;
  return {
    mode: "STANDARD", state: "NORMAL", equity: s.equity, peakEquity: s.peak, riskType: "PERCENTAGE", riskValue: E.RISK_PERCENT,
    maxDailyLossPercent: E.MAX_DAILY_LOSS_PERCENT, currentDailyDDPercent: dd, recoveryMultiplier: 0.5,
  };
}

/** Run one continuous path; stops when the shared trade target is reached. */
function runPath(s: Shared, bars: readonly { raw: RawGatewayPayload; scenario: string }[]): void {
  const sym = s.cfg.symbol;
  const m5: ArenaCandle[] = [];
  const htf: Record<string, ArenaCandle[]> = { M15: [], H1: [], H4: [] };
  const bucket: Record<string, RawGatewayPayload | null> = { M15: null, H1: null, H4: null };
  const det: Record<SwingTimeframe, SwingDetector> = { M15: new SwingDetector(sym, "M15"), H1: new SwingDetector(sym, "H1"), H4: new SwingDetector(sym, "H4") };
  const observer = s.ctx ? new ContextObserver(s.ctx) : null;
  let setup: SignalSetup | null = null;
  let open: OpenCtx | null = null;
  const pending: { row: JournalTrade; ctx: OpenCtx; future: ArenaCandle[] }[] = [];

  const finishAutopsy = (p: (typeof pending)[number]) => {
    const a = runAutopsy(p.row, {
      tradeBars: p.ctx.bars, futureCandles: p.future, atr: p.ctx.atr, spreadAtEntry: p.ctx.spread, normalSpread: p.ctx.normalSpread,
      execution: { plannedEntry: p.ctx.plan.entry, actualEntry: p.ctx.trade.snapshot.entryPrice, latencyMs: 0 },
    }, p.row.closedAt);
    s.autopsies.push(a);
  };

  for (const b of bars) {
    if (s.journal.getAll().length >= s.target && !open && !pending.length) return;
    const norm = validateAndNormalize(b.raw, "M5", m5.at(-1));
    if (!norm.isValid || !norm.candle) continue; // invalid/gap: never fabricated
    const c: ArenaCandle = Object.freeze({ ...norm.candle, isClosed: true });
    m5.push(c); if (m5.length > E.EMA_WINDOW_M5) m5.shift();
    s.counters.barsProcessed++;
    const now = c.timestamp + 300;

    // aggregate HTF; a bar is emitted only once its bucket has fully closed
    for (const tf of HTF) {
      const sec = TIMEFRAME_SECONDS[tf];
      const start = Math.floor(c.timestamp / sec) * sec;
      const cur = bucket[tf];
      bucket[tf] = cur && cur.time === start
        ? { ...cur, high: Math.max(cur.high!, c.high), low: Math.min(cur.low!, c.low), close: c.close, spread: c.spread }
        : { symbol: sym, timeframe: tf, time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0, spread: c.spread, source: "MOCK" };
      if (now % sec === 0) {
        const n = validateAndNormalize(bucket[tf]!, tf, htf[tf]!.at(-1));
        if (n.isValid && n.candle) {
          const hc = Object.freeze({ ...n.candle, isClosed: true });
          htf[tf]!.push(hc); if (htf[tf]!.length > E.M15_WINDOW) htf[tf]!.shift();
          det[tf as SwingTimeframe].push(hc);
        }
        bucket[tf] = null;
      }
    }

    // pending autopsies collect post-trade bars
    for (const p of pending) p.future.push(c);
    while (pending.length && pending[0]!.future.length >= E.AUTOPSY_LOOKAHEAD_BARS) finishAutopsy(pending.shift()!);

    // day roll
    const day = Math.floor(c.timestamp / 86400);
    if (day !== s.dayKey) { s.dayKey = day; s.dayStartEquity = s.equity; }

    // manage open trade on this CLOSED bar
    if (open) {
      if (c.timestamp >= (open.trade.openedAt ?? 0)) open.bars.push(c);
      const u = updatePosition(open.trade, c, now);
      if (u.ok && u.trade.state === "CLOSED") {
        const t = u.trade;
        const row = fromPaperTrade(t, { h1Phase: open.h1Phase, locationTier: open.tier, rr: open.plan.rr ?? 0 }, calculateExcursion(t.snapshot.direction, t.snapshot.entryPrice, open.bars));
        if (row && s.journal.saveTrade(row).ok) {
          s.counters.tradesClosed++;
          s.scenarioOf.set(row.tradeId, open.scenario);
          s.equity += row.profitLossUSD; s.peak = Math.max(s.peak, s.equity); s.minEquity = Math.min(s.minEquity, s.equity);
          s.streak = row.result === "LOSS" ? { consecutiveLosses: s.streak.consecutiveLosses + 1, lastLossAt: row.closedAt } : { consecutiveLosses: 0, lastLossAt: s.streak.lastLossAt };
          pending.push({ row: s.journal.getAll().at(-1)! as JournalTrade, ctx: open, future: [] });
        }
        open = null;
      }
      continue;
    }
    if (s.journal.getAll().length >= s.target) continue;

    // ---- analysis (closed data only, as of `now`)
    const m15 = htf["M15"]!;
    if (m5.length < 2 || m15.length < 15) continue;
    const swings = (tf: SwingTimeframe) => det[tf].getSwings().slice(-E.SWING_WINDOW);
    let m15S = buildStructure(sym, "M15", swings("M15"), now);
    m15S = detectStructureShift(m15S, m15.at(-1)!);
    const bias = computeBiasState(sym, buildStructure(sym, "H4", swings("H4"), now), buildStructure(sym, "H1", swings("H1"), now), now);
    const loc = classifyPriceLocation({ currentPrice: c.close, m15Structure: m15S, m15Candles: m15, bias, now });
    const ema = computeEMAContext(m5, now);
    const atr = computeAtr(m15);
    if (!loc.ok || !ema.ok || atr === null) continue;
    const prev = m5.at(-2)!;
    const re = evaluateReaction({ previous: prev, current: c, priceContext: loc.context, emaContext: ema.context, atr });
    const reaction = re.ok ? re.result : null;
    const input: EvaluatorInput = {
      bias, priceContext: loc.context, emaContext: ema.context, reaction, m15Atr: atr,
      m15StructureShift: m15S.structureShift, m15StructureValid: !!m15S.lastConfirmedHigh && !!m15S.lastConfirmedLow,
      m5CandleClosed: true, dataStale: false, now,
    };
    const ev = evaluateSetup(input);
    // passive context sensors (M1B.8–11): observe only, never fed to evaluate/update/plan/risk
    observer?.observe({ symbol: sym, now, m15, m15Structure: m15S, h4Structure: buildStructure(sym, "H4", swings("H4"), now), h1Structure: buildStructure(sym, "H1", swings("H1"), now), atr, ema: ema.context, price: loc.context, reactionConfirmed: !!reaction?.isValid });
    s.counters.evaluations++;
    if (ev.kind === "NO_SETUP") bump(s.counters.noSetup, ev.reason);

    if (setup) {
      setup = updateSetup(setup, { m5: c, m15: m15.at(-1)!, price: c.close, m15Atr: atr, m15StructureShift: m15S.structureShift, emaContext: ema.context, evaluation: ev, now }).setup;
      if (setup.state === "INVALIDATED") s.counters.setupsInvalidated++;
      if (setup.state === "EXPIRED") s.counters.setupsExpired++;
      if (isTerminal(setup)) setup = null;
    }
    if (!setup && reaction) {
      const cr = createSetup(ev, input, reaction, c, c.close, observer?.sources(sym));
      if (cr) {
        if (s.setupIds.has(cr.setup.id)) s.terminalRevivals++;
        s.setupIds.add(cr.setup.id); s.counters.setupsCreated++; setup = cr.setup;
      }
    }
    if (!setup || setup.state !== "READY") continue;

    // ---- M3 plan → M4 risk → M5 paper (automatic, no approval step)
    const bid = c.close, ask = c.close + c.spread;
    const entry = setup.direction === "BUY" ? ask : bid;
    const plan = buildTradePlan({ setup, entry, m15Structure: m15S, atrM15: atr, now });
    setup = null; // signal consumed by plan attempt (no re-use of same id)
    if (plan.status !== "PLANNED") { bump(s.counters.planHolds, plan.holdReason ?? "UNKNOWN"); continue; }
    s.counters.plansPlanned++;
    const spreadHist = m5.slice(-E.SPREAD_HISTORY).map((x) => x.spread);
    const normalSpread = spreadHist.reduce((a, x) => a + x, 0) / spreadHist.length;
    const acct = account(s);
    const risk = evaluateRisk(plan, acct, { symbol: sym, ...E.BROKER }, {
      nowSec: now, positions: [], exposureLimits: { maxSymbolRiskUSD: s.equity * 0.02, maxTotalRiskUSD: s.equity * 0.05 },
      spread: { current: c.spread, history: spreadHist }, quote: { ask, bid, maxSlippage: E.MAX_SLIPPAGE },
      lossStreak: s.streak, strictRiskMode: true,
    });
    if (risk.decision !== "APPROVED") { for (const r of risk.reasons.length ? risk.reasons : [risk.decision]) bump(s.counters.riskBlocked, r); continue; }
    s.counters.riskApproved++;
    const pt = createPaperTrade({
      plan, risk, marketPrice: plan.direction === "BUY" ? bid : ask, sim: { spread: c.spread, slippage: 0, maxSlippage: E.MAX_SLIPPAGE, latencyMs: 0, latencyDriftPerMs: 0 },
      contract: { tickSize: E.BROKER.tickSize, tickValue: E.BROKER.tickValue }, accountEquity: s.equity,
      signalSource: { bias: `H4_${bias.h4.bias}_H1_${bias.h1.phase}`, location: loc.context.priceLocation, trigger: reaction?.pattern ?? "NONE", reactionQuality: reaction?.quality ?? "NONE", emaContext: ema.context.actions.join(",") || ema.context.pricePosition },
      now,
    });
    if (pt.state === "REJECTED") { bump(s.counters.paperRejected, pt.reason); continue; }
    // invariant check: an opened trade must carry an APPROVED risk with risk ≤ budget
    if (risk.positionSize!.actualRiskUSD > s.equity * (E.RISK_PERCENT / 100) * 1.0001) s.riskViolations++;
    const o = openPaperTrade(pt.trade, now);
    if (!o.ok) continue;
    s.counters.tradesOpened++;
    open = { trade: o.trade, plan, bars: [], scenario: b.scenario, atr, spread: c.spread, normalSpread, h1Phase: bias.h1.phase, tier: loc.context.locationTier };
  }
  // path ended: autopsy remaining with whatever post-trade bars exist (never fabricated)
  for (const p of pending) finishAutopsy(p);
}

export function runStressTest(partial: Partial<StressTestConfig>): StressRunResult {
  const cfg: StressTestConfig = { ...DEFAULT_STRESS_CONFIG, ...partial };
  const counters = emptyCounters();
  const base = (error?: StressRunResult["error"]): StressRunResult => ({
    ok: !error, ...(error ? { error } : {}), config: cfg, dataLabel: cfg.mode === "HISTORICAL_REPLAY" ? "HISTORICAL_REPLAY" : "SIMULATION_SYNTHETIC",
    metrics: computeStressMetrics([], [], counters, cfg.initialEquity), counters, health: [], byScenario: [], highestImpact: null,
    sampleReached: false, policyVersion: STRESS_POLICY_VERSION, context: null,
  });
  if (!cfg.disableHumanApproval) return base("HUMAN_APPROVAL_NOT_AUTOMATABLE");
  if (!(cfg.sampleSize > 0 && cfg.maxTrades > 0 && cfg.initialEquity > 0)) return base("INVALID_CONFIG");
  if (cfg.mode === "HISTORICAL_REPLAY" && !cfg.historicalBars?.length) return base("HISTORICAL_BARS_REQUIRED");

  const paramsBefore = snapshotParams();
  const target = Math.min(cfg.sampleSize, cfg.maxTrades);
  const s: Shared = {
    cfg, target, journal: new TradeJournal(), autopsies: [], counters, scenarioOf: new Map(), setupIds: new Set(),
    terminalRevivals: 0, riskViolations: 0, equity: cfg.initialEquity, peak: cfg.initialEquity, dayKey: -1,
    ctx: cfg.captureContext === false ? null : emptyContextCounters(),
    dayStartEquity: cfg.initialEquity, streak: { consecutiveLosses: 0, lastLossAt: null }, minEquity: cfg.initialEquity,
  };
  const budget = cfg.maxBars ?? target * E.BAR_BUDGET_PER_TRADE;
  const seed = cfg.seed ?? 1;

  if (cfg.mode === "HISTORICAL_REPLAY") {
    runPath(s, cfg.historicalBars!.slice(0, budget).map((raw) => ({ raw, scenario: "HISTORICAL" })));
  } else if (cfg.mode === "RANDOM") {
    runPath(s, generatePath(cfg.symbol, seed, budget));
  } else {
    const seeds = mulberry32(seed);
    // independent price paths, but the clock keeps moving forward (time never rewinds between paths)
    for (let used = 0; used < budget && s.journal.getAll().length < target; used += E.MONTE_CARLO_PATH_BARS) {
      runPath(s, generatePath(cfg.symbol, Math.floor(seeds() * 2 ** 31), Math.min(E.MONTE_CARLO_PATH_BARS, budget - used), undefined, E.START_TS + used * 300));
    }
  }

  const trades = s.journal.getAll() as JournalTrade[];
  const journalHash = JSON.stringify(trades);
  const metrics = computeStressMetrics(trades, s.autopsies, counters, cfg.initialEquity);
  const dist = analyzeFailureDistribution(s.autopsies);
  const health = buildHealthChecks({
    terminalRevivals: s.terminalRevivals, riskViolations: s.riskViolations, minEquity: s.minEquity,
    counters, trades, autopsies: s.autopsies, journalHashBefore: journalHash, journalHashAfter: JSON.stringify(s.journal.getAll()),
    paramsBefore, paramsAfter: snapshotParams(), ctx: s.ctx,
  });
  return {
    ...base(), metrics, health, byScenario: scenarioStats(trades, s.scenarioOf), highestImpact: dist.highestImpact,
    sampleReached: trades.length >= target,
    context: s.ctx ? buildContextReport(trades, s.ctx) : null,
  };
}

export type { MarketScenario };
