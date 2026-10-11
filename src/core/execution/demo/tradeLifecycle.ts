// Phase 4A.1 — one tradeId per trade, reconstructed purely from the append-only demo event log (no new state).
// SIGNAL_CREATED → DECISION_APPROVED → ORDER_REQUESTED → ORDER_FILLED → POSITION_OPEN → POSITION_CLOSED → PERFORMANCE_RESULT
import type { DemoEvent, DemoOrderIntent } from "./types";

export type TradeStage = "SIGNAL_CREATED" | "DECISION_APPROVED" | "ORDER_REQUESTED" | "ORDER_FILLED" | "POSITION_OPEN" | "POSITION_CLOSED" | "PERFORMANCE_RESULT";
export interface TradeLifecycleStep { readonly stage: TradeStage; readonly at: number; readonly data: Readonly<Record<string, unknown>> }
export interface TradeLifecycle {
  readonly tradeId: string; readonly signalId: string; readonly symbol: string;
  readonly steps: readonly TradeLifecycleStep[];
  readonly account: unknown; readonly risk: { readonly risk_percent: number | null; readonly lot: number | null; readonly sl: number; readonly tp: number };
  readonly execution: { readonly response: string | null; readonly fill_price: number | null; readonly filled_at: number | null };
  readonly complete: boolean;
}

export const tradeIdOf = (signalId: string) => `demo_${signalId}`;

export function reconstructTrades(events: readonly DemoEvent[]): TradeLifecycle[] {
  const out: TradeLifecycle[] = [];
  for (const s of events.filter((e) => e.type === "SEND_ATTEMPT" && e.signalId)) {
    const id = s.signalId!; const d = s.data ?? {};
    const intent = d["intent"] as DemoOrderIntent;
    const plan = (d["final_order_plan"] ?? null) as { lot: number; risk_percent: number } | null;
    const res = events.find((e) => e.signalId === id && (e.type === "FILLED" || e.type === "REJECTED" || e.type === "ERROR"));
    const cl = events.find((e) => e.signalId === id && e.type === "CLOSED");
    const steps: TradeLifecycleStep[] = [
      { stage: "SIGNAL_CREATED", at: intent.closedBarAt, data: { setup: intent.context.setup, primaryBias: intent.context.primaryBias ?? null } },
      { stage: "DECISION_APPROVED", at: intent.closedBarAt, data: { decision: intent.context.decision, planId: intent.planId } },
      { stage: "ORDER_REQUESTED", at: s.at, data: { final_order_plan: plan } },
    ];
    if (res?.type === "FILLED") {
      steps.push({ stage: "ORDER_FILLED", at: res.at, data: { ...(res.data ?? {}) } });
      steps.push({ stage: "POSITION_OPEN", at: res.at, data: { ticket: res.data?.["ticket"] ?? null } });
    }
    if (cl) {
      steps.push({ stage: "POSITION_CLOSED", at: cl.at, data: { ...(cl.data ?? {}) } });
      const p = Number(cl.data?.["profit"]);
      steps.push({ stage: "PERFORMANCE_RESULT", at: cl.at, data: { profit: p, outcome: p > 0 ? "WIN" : p < 0 ? "LOSS" : "BREAKEVEN" } });
    }
    out.push(Object.freeze({
      tradeId: tradeIdOf(id), signalId: id, symbol: intent.symbol, steps: Object.freeze(steps),
      account: d["account"] ?? null,
      risk: { risk_percent: plan?.risk_percent ?? null, lot: plan?.lot ?? (Number(d["volume"]) || null), sl: intent.stopLoss, tp: intent.takeProfit },
      execution: { response: res ? `${res.type} ${res.detail ?? ""}`.trim() : null, fill_price: (res?.data?.["price"] as number | null) ?? null, filled_at: res?.type === "FILLED" ? res.at : null },
      complete: steps.some((x) => x.stage === "PERFORMANCE_RESULT"),
    }));
  }
  return out;
}
