// Pure: copy an approved paper open + the Engine Host radar context into a demo order intent. No calculation.
import type { ApprovedPaperOpen } from "../../paper/LivePaperLoop";
import type { RadarSnapshot } from "../../radar/types";
import type { DemoOrderIntent } from "./types";

/** v0.5 technical facts copied from the host technical slice (closed-H4 structure primary bias). */
export interface DemoTechFacts { readonly primary_bias?: string | null; readonly counter_trend_condition?: string | null }

export function buildDemoIntent(e: ApprovedPaperOpen, snap: Readonly<RadarSnapshot> | null, tech?: DemoTechFacts | null): DemoOrderIntent {
  const i = snap?.intelligence ?? null;
  return Object.freeze({
    signalId: e.signalId, planId: e.planId, symbol: e.symbol, direction: e.direction,
    plannedEntry: e.entry, stopLoss: e.stopLoss, takeProfit: e.takeProfit, rr: e.rr, closedBarAt: e.closedBarAt,
    context: Object.freeze({
      regime: snap?.regime.type ?? null, h4Bias: i?.h4_state ?? null, h1State: i?.h1_state ?? null,
      setup: i?.setup ?? null, decision: i?.status ?? null, confidence: i?.confidence ?? null,
      primaryBias: tech?.primary_bias ?? null, counterTrendCondition: tech?.counter_trend_condition ?? null,
      reasons: Object.freeze([...(i?.reasons ?? i?.audit_trail ?? [])].slice(0, 12)),
      signalSource: e.signalSource, entryDecision: e.entryDecision ?? null, engineSnapshot: snap ? structuredClone(snap) : null,
    }),
  });
}
