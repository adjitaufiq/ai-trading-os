// Pure: copy an approved paper open + the Engine Host radar context into a demo order intent. No calculation.
import type { ApprovedPaperOpen } from "../../paper/LivePaperLoop";
import type { RadarSnapshot } from "../../radar/types";
import type { DemoOrderIntent } from "./types";

export function buildDemoIntent(e: ApprovedPaperOpen, snap: Readonly<RadarSnapshot> | null): DemoOrderIntent {
  const i = snap?.intelligence ?? null;
  return Object.freeze({
    signalId: e.signalId, planId: e.planId, symbol: e.symbol, direction: e.direction,
    plannedEntry: e.entry, stopLoss: e.stopLoss, takeProfit: e.takeProfit, rr: e.rr, closedBarAt: e.closedBarAt,
    context: Object.freeze({
      regime: snap?.regime.type ?? null, h4Bias: i?.h4_state ?? null, h1State: i?.h1_state ?? null,
      setup: i?.setup ?? null, decision: i?.status ?? null, confidence: i?.confidence ?? null,
      reasons: Object.freeze([...(i?.reasons ?? i?.audit_trail ?? [])].slice(0, 12)),
      signalSource: e.signalSource, engineSnapshot: snap ? structuredClone(snap) : null,
    }),
  });
}
