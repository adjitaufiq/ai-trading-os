import type { MarketStructure } from "../core/swing/types";
import type { SignalSetup } from "../signal/types";
import { calculateStopLoss } from "./slCalculator";
import { calculateTakeProfit } from "./tpCalculator";
import { PLAN_PARAMS as P, PLAN_POLICY_VERSION, type HoldReason, type PlanCheck, type TradePlan } from "./types";

export interface PlanInput {
  setup: SignalSetup;
  /** Reference entry (BUY=ASK, SELL=BID) supplied by caller; never fetched here. */
  entry: number;
  m15Structure: MarketStructure;
  atrM15: number;
  now: number;
}

const r = (n: number) => Math.round(n * 1e8) / 1e8;

export function buildTradePlan(i: PlanInput): TradePlan {
  const { setup: s } = i;
  const trace: PlanCheck[] = [];
  const direction = s.direction === "SELL" ? "SELL" : "BUY";
  const base = {
    id: `plan_${s.id}`, signalId: s.id, symbol: s.symbol, direction, entry: i.entry,
    atrM15: i.atrM15, createdAt: i.now, policyVersion: PLAN_POLICY_VERSION,
    audit: Object.freeze({ executable: false, orderSent: false, lotCalculated: false, mode: "PLAN_ONLY" }) as TradePlan["audit"],
    trace,
  } as const;
  const hold = (holdReason: HoldReason, extra: Partial<TradePlan> = {}): TradePlan =>
    Object.freeze({ ...base, status: "HOLD", holdReason, sl: null, tp: null, riskDistance: null, rewardDistance: null, rr: null, slSource: null, tpSource: null, ...extra });

  const ready = s.state === "READY";
  trace.push({ name: "Setup READY", result: ready ? "PASS" : "FAIL", detail: s.state });
  if (!ready) return hold("SETUP_NOT_READY");
  if (s.direction !== "BUY" && s.direction !== "SELL") { trace.push({ name: "Direction", result: "FAIL" }); return hold("INVALID_DIRECTION"); }
  if (!(Number.isFinite(i.entry) && i.entry > 0 && Number.isFinite(i.atrM15) && i.atrM15 > 0)) { trace.push({ name: "Inputs", result: "FAIL" }); return hold("INVALID_INPUT"); }
  if (i.m15Structure.timeframe !== "M15" || i.m15Structure.symbol !== s.symbol) { trace.push({ name: "M15 Structure", result: "FAIL" }); return hold("NOT_M15_STRUCTURE"); }

  const sl = calculateStopLoss({ direction, entry: i.entry, keyLevel: s.keyLevel, m15Structure: i.m15Structure, atr: i.atrM15, now: i.now });
  if (!sl.ok) {
    trace.push({ name: "Stop Loss", result: "FAIL", detail: sl.reason + (sl.distance !== undefined ? ` dist=${r(sl.distance)}` : "") });
    return hold(sl.reason);
  }
  trace.push({ name: "Stop Loss", result: "PASS", detail: `${sl.source} anchor=${sl.anchor} sl=${r(sl.sl)}` });

  const tp = calculateTakeProfit({ direction, entry: i.entry, m15Structure: i.m15Structure, atr: i.atrM15, now: i.now });
  if (!tp.ok) { trace.push({ name: "Take Profit", result: "FAIL", detail: tp.reason }); return hold("NO_TP_TARGET", { sl: r(sl.sl), slSource: sl.source, riskDistance: r(sl.distance) }); }
  trace.push({ name: "Take Profit", result: "PASS", detail: `${tp.source} level=${tp.target} tp=${r(tp.tp)}` });

  const risk = sl.distance, reward = Math.abs(tp.tp - i.entry), rr = reward / risk;
  const levels = { sl: r(sl.sl), tp: r(tp.tp), riskDistance: r(risk), rewardDistance: r(reward), rr: r(rr), slSource: sl.source, tpSource: tp.source };
  const rrOk = rr >= P.MIN_RR;
  trace.push({ name: "Risk Reward", result: rrOk ? "PASS" : "FAIL", detail: `${r(rr)} vs min ${P.MIN_RR}` });
  if (!rrOk) return hold("BAD_RR", levels);
  return Object.freeze({ ...base, status: "PLANNED", ...levels });
}
