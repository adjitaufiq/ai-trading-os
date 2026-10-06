import type { JournalTrade } from "../journal/types";
import {
  biasEvidence, executionEvidence, locationEvidence, sweepEvidence, triggerEvidence, volatilityEvidence,
} from "./evidenceCollector";
import { FAILURE_PRIORITY, type AutopsyEvidence, type AutopsyMarketData, type ConfidenceLevel, type FailureCategory } from "./types";

export interface Classification {
  primaryFailure: FailureCategory;
  secondaryFactors: FailureCategory[];
  confidence: ConfidenceLevel;
  evidence: AutopsyEvidence[];
}

const failed = (e: AutopsyEvidence[]) => e.length > 0 && e.some((x) => !x.passed);

/** Pure. Each category is matched only from its own evidence; no evidence ⇒ not matched. */
export function classifyFailure(t: JournalTrade, m: AutopsyMarketData): Classification {
  const loc = [locationEvidence(t)], bias = [biasEvidence(t)];
  const vol = volatilityEvidence(m), exec = executionEvidence(t, m), sweep = sweepEvidence(t, m), trig = triggerEvidence(t, m);
  const evidence = [...loc, ...bias, ...vol, ...exec, ...sweep, ...trig];
  if (t.result !== "LOSS") return { primaryFailure: "NO_FAILURE", secondaryFactors: [], confidence: "HIGH", evidence };

  const contextOk = loc[0]!.passed && bias[0]!.passed;
  const matched = new Set<FailureCategory>();
  if (!loc[0]!.passed) matched.add("WRONG_LOCATION");
  if (!bias[0]!.passed) matched.add("BIAS_CONFLICT");
  if (failed(vol)) matched.add("VOLATILITY_FAILURE");
  if (failed(exec)) matched.add("EXECUTION_FAILURE");
  if (loc[0]!.passed && sweep.length && !sweep.find((e) => e.metric === "PRICE_RETURN_AFTER_SL")!.passed) matched.add("LIQUIDITY_SWEEP");
  if (contextOk && failed(trig)) matched.add("TRIGGER_FAILURE");

  const ordered = FAILURE_PRIORITY.filter((c) => matched.has(c));
  const primary = ordered[0] ?? "UNCLASSIFIED";
  let confidence: ConfidenceLevel = "LOW";
  if (primary === "EXECUTION_FAILURE") confidence = "HIGH";
  else if (primary === "LIQUIDITY_SWEEP") confidence = sweep.find((e) => e.metric === "RECOVERED_BEYOND_ENTRY")!.passed ? "MEDIUM" : "HIGH";
  else if (primary === "VOLATILITY_FAILURE") confidence = vol.filter((e) => !e.passed).length >= 2 ? "HIGH" : "MEDIUM";
  else if (primary !== "UNCLASSIFIED") confidence = "MEDIUM";
  return { primaryFailure: primary, secondaryFactors: ordered.slice(1), confidence, evidence };
}
