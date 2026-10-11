// Read-only SNR projection: copies zones the technical slice (operator analysis) already computed.
// No recalculation, no scores, no trading state. Display only.
import type { OperatorAnalysis } from "../technical/operator";

const TFS = ["H4", "H1", "M15"] as const;

export function snrPayload(symbol: string, operator: OperatorAnalysis | null | undefined) {
  if (!operator) return null;
  const zones = TFS.flatMap((tf) => (operator.zones[tf] ?? []).map((z) => ({ type: z.role, low: z.low, high: z.high, status: "ACTIVE" as const, timeframe: tf })));
  return { symbol, timeframe: "H4" as const, zones: zones.slice(0, 200) };
}
