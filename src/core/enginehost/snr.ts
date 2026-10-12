// Read-only SNR projection: copies zones the technical slice (operator analysis) already computed.
// No recalculation, no scores, no trading state. Display only.
import type { OperatorAnalysis } from "../technical/operator";

const TFS = ["H4", "H1", "M15"] as const;

export function snrPayload(symbol: string, operator: OperatorAnalysis | null | undefined, now: number) {
  if (!operator) return null;
  const zones = TFS.flatMap((tf) => (operator.zones[tf] ?? []).map((z) => ({ type: z.role, low: z.low, high: z.high, status: "ACTIVE" as const, timeframe: tf })));
  const swings = TFS.flatMap((tf) => (operator.per_tf?.[tf]?.events?.recent ?? [])
    .filter((s) => s.confirmed_at <= now && s.available_at <= now)
    .map((s) => ({ kind: s.kind, price: s.price, timeframe: tf, pivot_time: s.pivot_time, confirmed_at: s.confirmed_at, available_at: s.available_at })));
  return { symbol, timeframe: "H4" as const, zones: zones.slice(0, 200), price: operator.price, as_of: now, swings };
}
