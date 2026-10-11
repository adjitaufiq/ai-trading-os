// Phase 4B — Evaluation Readiness. Pure read model over the append-only demo event log.
// Copies facts already recorded (intent context, frozen Decision Gate snapshot, FINAL_ORDER_PLAN, broker response,
// broker close deal). Counters are descriptive only and never feed a decision, risk or execution path.
import type { DemoEvent, DemoOrderIntent } from "./types";
import { tradeIdOf } from "./tradeLifecycle";

export const EVALUATION_JOURNAL_VERSION = "eval-journal-v1" as const;
export const EVALUATION_BUILD_LABEL = "EVALUATION_BUILD" as const;

export interface EvaluationVersions { readonly engine_version: string; readonly strategy_version: string; readonly journal_version: string }

export type EvalStage =
  | "SIGNAL_CREATED" | "ANALYSIS_COMPLETED" | "DECISION_APPROVED" | "RISK_VALIDATED" | "ORDER_REQUESTED"
  | "ORDER_FILLED" | "POSITION_MONITORING" | "POSITION_CLOSED" | "PERFORMANCE_RECORDED";
export const EVAL_STAGES: readonly EvalStage[] = ["SIGNAL_CREATED", "ANALYSIS_COMPLETED", "DECISION_APPROVED", "RISK_VALIDATED", "ORDER_REQUESTED", "ORDER_FILLED", "POSITION_MONITORING", "POSITION_CLOSED", "PERFORMANCE_RECORDED"];

export type LifecycleViolation = "NO_DECISION" | "NO_RISK" | "NO_RESULT";

export interface TradeSnapshot {
  readonly label: typeof EVALUATION_BUILD_LABEL;
  readonly tradeId: string; readonly signalId: string; readonly timestamp: string;
  readonly symbol: string; readonly direction: "BUY" | "SELL";
  readonly account_balance: number | null; readonly equity: number | null; readonly account_source: string | null;
  readonly risk_percent: number | null; readonly lot_size: number | null; readonly risk_usd: number | null;
  readonly entry_price: number; readonly stop_loss: number; readonly take_profit: number;
  readonly market: { readonly h4_bias: string | null; readonly h1_state: string | null; readonly m15_structure: string | null; readonly m5_trigger: string | null };
  readonly technical: { readonly arena_state: string | null; readonly m1b_state: string | null; readonly snr_location: string | null; readonly key_level: string | null; readonly trigger_reason: string | null; readonly setup_type: string | null };
  readonly decision: { readonly decision_status: "APPROVED" | "MISSING"; readonly approval_reason: string | null; readonly rejection_reason: string | null; readonly gate_policy_version: string | null };
  readonly execution: { readonly order_request_time: string; readonly broker_response: string | null; readonly fill_price: number | null; readonly execution_status: "FILLED" | "REJECTED" | "ERROR" | "PENDING"; readonly broker_ticket: number | null; readonly slippage: number | null; readonly latency_ms: number | null };
  readonly result: { readonly close_time: string | null; readonly close_price: number | null; readonly close_reason: string | null; readonly close_source: string | null; readonly profit_loss: number | null; readonly rr_result: number | null; readonly outcome: "WIN" | "LOSS" | "BREAKEVEN" | "OPEN" | "NOT_FILLED" };
  readonly holding_ms: number | null;
  readonly lifecycle: readonly { readonly stage: EvalStage; readonly at: string }[];
  readonly lifecycle_complete: boolean; readonly violations: readonly LifecycleViolation[];
  readonly versions: EvaluationVersions;
}

const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function buildTradeSnapshots(events: readonly DemoEvent[], versions: EvaluationVersions): TradeSnapshot[] {
  const out: TradeSnapshot[] = [];
  const seen = new Set<string>();
  for (const s of events) {
    if (s.type !== "SEND_ATTEMPT" || !s.signalId || seen.has(s.signalId)) continue; // one trade per signal_id
    seen.add(s.signalId);
    const id = s.signalId; const d = s.data ?? {};
    const intent = d["intent"] as DemoOrderIntent;
    const ctx = intent.context; const ed = ctx.entryDecision ?? null;
    const plan = (d["final_order_plan"] ?? null) as { lot?: number; risk_percent?: number; entry?: number; sl?: number; tp?: number } | null;
    const acct = (d["account"] ?? null) as { balance?: number; equity?: number; source?: string } | null;
    const res = events.find((e) => e.signalId === id && (e.type === "FILLED" || e.type === "REJECTED" || e.type === "ERROR"));
    const cl = events.find((e) => e.signalId === id && e.type === "CLOSED");
    const sl = plan?.sl ?? intent.stopLoss; const tp = plan?.tp ?? intent.takeProfit;
    const fill = res?.type === "FILLED" ? num(res.data?.["price"]) : null;
    const closePrice = cl ? num(cl.data?.["price"]) : null;
    const profit = cl ? num(cl.data?.["profit"]) : null;
    const riskDist = Math.abs((fill ?? intent.plannedEntry) - sl);
    const rr = fill !== null && closePrice !== null && riskDist > 0 ? r4((intent.direction === "BUY" ? closePrice - fill : fill - closePrice) / riskDist) : null;
    const closeAt = cl ? (num(cl.data?.["time"]) ?? cl.at) : null;
    const closeAtMs = closeAt !== null && closeAt < 1e12 ? closeAt * 1000 : closeAt;
    const execStatus: TradeSnapshot["execution"]["execution_status"] = res ? (res.type as "FILLED" | "REJECTED" | "ERROR") : "PENDING";
    const decisionOk = ctx.decision !== null || ed !== null;
    const riskOk = plan !== null && (plan.lot ?? 0) > 0 && typeof plan.risk_percent === "number";

    const stages: { stage: EvalStage; at: number }[] = [{ stage: "SIGNAL_CREATED", at: intent.closedBarAt }];
    if (ed || ctx.engineSnapshot || ctx.primaryBias) stages.push({ stage: "ANALYSIS_COMPLETED", at: intent.closedBarAt });
    if (decisionOk) stages.push({ stage: "DECISION_APPROVED", at: ed?.decidedAt ?? intent.closedBarAt });
    if (riskOk) stages.push({ stage: "RISK_VALIDATED", at: s.at });
    stages.push({ stage: "ORDER_REQUESTED", at: s.at });
    if (res?.type === "FILLED") { stages.push({ stage: "ORDER_FILLED", at: res.at }, { stage: "POSITION_MONITORING", at: res.at }); }
    if (cl) { stages.push({ stage: "POSITION_CLOSED", at: closeAtMs ?? cl.at }, { stage: "PERFORMANCE_RECORDED", at: cl.at }); }

    const filled = res?.type === "FILLED";
    const violations: LifecycleViolation[] = [];
    if (!decisionOk) violations.push("NO_DECISION");
    if (!riskOk) violations.push("NO_RISK");
    // A trade that never filled has nothing to close; a filled trade without a broker close is still OPEN (not a violation).
    if (filled && cl && profit === null) violations.push("NO_RESULT");

    const snap: TradeSnapshot = {
      label: EVALUATION_BUILD_LABEL, tradeId: tradeIdOf(id), signalId: id, timestamp: iso(s.at)!,
      symbol: intent.symbol, direction: intent.direction,
      account_balance: num(acct?.balance), equity: num(acct?.equity), account_source: str(acct?.source),
      risk_percent: num(plan?.risk_percent), lot_size: num(plan?.lot) ?? num(d["volume"]), risk_usd: num(d["riskUSD"]),
      entry_price: plan?.entry ?? intent.plannedEntry, stop_loss: sl, take_profit: tp,
      market: { h4_bias: ed?.primaryBias ?? str(ctx.primaryBias) ?? str(ctx.h4Bias), h1_state: str(ctx.h1State), m15_structure: ed?.m15Structure ?? null, m5_trigger: ed?.trigger ?? str(ctx.signalSource["trigger"]) },
      technical: { arena_state: ed?.arenaStatus ?? null, m1b_state: str(ctx.decision), snr_location: ed?.priceLocation ?? str(ctx.signalSource["location"]), key_level: ed?.locationTier ?? null, trigger_reason: ed?.reactionQuality ? `${ed.trigger ?? "NONE"}/${ed.reactionQuality}` : str(ctx.signalSource["trigger"]), setup_type: str(ctx.setup) },
      decision: { decision_status: (decisionOk ? "APPROVED" : "MISSING") as "APPROVED" | "MISSING", approval_reason: ed?.reason ?? (ctx.reasons.length ? ctx.reasons.join("; ") : null), rejection_reason: null, gate_policy_version: ed?.gatePolicyVersion ?? null },
      execution: { order_request_time: iso(s.at)!, broker_response: res ? `${res.type} ${res.detail ?? ""}`.trim() : null, fill_price: fill, execution_status: execStatus, broker_ticket: num(res?.data?.["ticket"]), slippage: num(res?.data?.["slippage"]), latency_ms: num(res?.data?.["latencyMs"]) },
      result: { close_time: iso(closeAtMs), close_price: closePrice, close_reason: cl ? (str(cl.detail) ?? str(cl.data?.["reason"])) : null, close_source: cl ? (str(cl.data?.["source"]) ?? "RECONCILIATION") : null, profit_loss: profit, rr_result: rr,
        outcome: (!filled ? "NOT_FILLED" : profit === null ? "OPEN" : profit > 0 ? "WIN" : profit < 0 ? "LOSS" : "BREAKEVEN") as TradeSnapshot["result"]["outcome"] },
      holding_ms: filled && closeAtMs !== null ? Math.max(0, closeAtMs - res!.at) : null,
      lifecycle: Object.freeze(stages.map((x) => ({ stage: x.stage, at: iso(x.at) ?? "" }))),
      lifecycle_complete: EVAL_STAGES.every((st) => stages.some((x) => x.stage === st)) && violations.length === 0,
      violations: Object.freeze(violations), versions,
    };
    out.push(Object.freeze(snap));
  }
  return out;
}

export const EVAL_CSV_COLUMNS = ["Trade ID", "Date", "Symbol", "Direction", "Market Bias", "Setup Type", "Entry", "SL", "TP", "Lot", "Risk %", "Balance", "Result", "Profit/Loss", "RR", "Win/Loss", "Close Reason", "Decision Reason", "Execution Status", "Engine Version", "Strategy Version", "Journal Version"] as const;

const cell = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export function toEvaluationCsv(rows: readonly TradeSnapshot[]): string {
  const lines = [EVAL_CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push([
    r.tradeId, r.timestamp, r.symbol, r.direction, r.market.h4_bias, r.technical.setup_type, r.execution.fill_price ?? r.entry_price, r.stop_loss, r.take_profit,
    r.lot_size, r.risk_percent, r.account_balance, r.result.outcome, r.result.profit_loss, r.result.rr_result,
    r.result.outcome === "WIN" || r.result.outcome === "LOSS" ? r.result.outcome : "", r.result.close_reason, r.decision.approval_reason, r.execution.execution_status,
    r.versions.engine_version, r.versions.strategy_version, r.versions.journal_version,
  ].map(cell).join(","));
  return `${lines.join("\n")}\n`;
}

export interface StressCounters {
  readonly label: typeof EVALUATION_BUILD_LABEL; readonly descriptive_only: true;
  readonly total_demo_trades: number; readonly completed_trades: number; readonly open_trades: number; readonly not_filled: number;
  readonly win_rate: number | null; readonly loss_rate: number | null; readonly average_rr: number | null; readonly profit_factor: number | null;
  readonly max_drawdown: number; readonly average_holding_ms: number | null; readonly incomplete_lifecycles: number; readonly target_trades: 100;
}

export function stressCounters(rows: readonly TradeSnapshot[]): StressCounters {
  const done = rows.filter((r) => r.result.profit_loss !== null);
  const wins = done.filter((r) => r.result.profit_loss! > 0); const losses = done.filter((r) => r.result.profit_loss! < 0);
  const gw = wins.reduce((a, r) => a + r.result.profit_loss!, 0); const gl = -losses.reduce((a, r) => a + r.result.profit_loss!, 0);
  const rrs = done.map((r) => r.result.rr_result).filter((x): x is number => x !== null);
  const holds = done.map((r) => r.holding_ms).filter((x): x is number => x !== null);
  let eq = 0, peak = 0, dd = 0;
  for (const r of [...done].sort((a, b) => (a.result.close_time ?? "").localeCompare(b.result.close_time ?? ""))) { eq += r.result.profit_loss!; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return Object.freeze({
    label: EVALUATION_BUILD_LABEL, descriptive_only: true as const,
    total_demo_trades: rows.length, completed_trades: done.length,
    open_trades: rows.filter((r) => r.result.outcome === "OPEN").length, not_filled: rows.filter((r) => r.result.outcome === "NOT_FILLED").length,
    win_rate: done.length ? r4(wins.length / done.length) : null, loss_rate: done.length ? r4(losses.length / done.length) : null,
    average_rr: rrs.length ? r4(rrs.reduce((a, b) => a + b, 0) / rrs.length) : null,
    profit_factor: gl > 0 ? r4(gw / gl) : null, max_drawdown: r4(dd),
    average_holding_ms: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null,
    incomplete_lifecycles: rows.filter((r) => r.violations.length > 0).length, target_trades: 100 as const,
  });
}
