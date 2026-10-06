import type { JournalTrade } from "../journal/types";
import { deepFreeze } from "../execution/executionSnapshot";
import { classifyFailure } from "./failureClassifier";
import { AUTOPSY_POLICY_VERSION, RECOMMENDATIONS, type AutopsyMarketData, type TradeAutopsy } from "./types";

/** Read-only: journal row is never mutated. analysisTimestamp is injected for determinism. */
export function runAutopsy(t: Readonly<JournalTrade>, m: AutopsyMarketData, analysisTimestamp: number): TradeAutopsy {
  const c = classifyFailure(t, m);
  return deepFreeze({
    tradeId: t.tradeId, result: t.result, primaryFailure: c.primaryFailure, secondaryFactors: [...c.secondaryFactors],
    confidence: c.confidence, evidence: c.evidence, recommendation: RECOMMENDATIONS[c.primaryFailure],
    analysisTimestamp, policyVersion: AUTOPSY_POLICY_VERSION,
  });
}
