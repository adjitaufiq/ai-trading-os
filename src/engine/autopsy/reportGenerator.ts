import type { FailureDistribution, TradeAutopsy } from "./types";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function generateAutopsyReport(a: TradeAutopsy, label: string): string {
  return [
    "TRADE AUTOPSY", `Trade: ${label}`, `Result: ${a.result}`, `Primary Failure: ${a.primaryFailure}`,
    ...(a.secondaryFactors.length ? [`Secondary: ${a.secondaryFactors.join(", ")}`] : []),
    `Confidence: ${a.confidence}`, "Evidence:",
    ...a.evidence.map((e) => `${e.passed ? "✓" : "✗"} ${e.metric}: ${e.actual} (expected ${e.expected})`),
    `Recommendation: ${a.recommendation}`,
  ].join("\n");
}

export function generateDistributionReport(d: FailureDistribution): string {
  const rows = Object.entries(d.breakdown).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => `${k}: ${pct(v ?? 0)}`);
  return ["TRADE AUTOPSY SUMMARY", `Analyzed: ${d.analyzed} trades`, `Losses: ${d.losses}`, "Loss Distribution:", ...rows,
    `Highest Impact Issue: ${d.highestImpact ?? "none"}`].join("\n");
}
