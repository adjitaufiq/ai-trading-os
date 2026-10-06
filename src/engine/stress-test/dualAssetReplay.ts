// M7 BTC/XAU validation: a mixed feed is partitioned by symbol and each symbol runs its OWN pipeline
// (own normalizer chain, candle buffers, swing detectors, event store, regime state and journal).
import type { RawGatewayPayload } from "../core/normalizer/types";
import { runStressTest } from "./simulationRunner";
import type { StressRunResult, StressTestConfig } from "./types";

export function runMultiAssetReplay(feed: readonly RawGatewayPayload[], cfg: Partial<StressTestConfig> = {}): Record<string, StressRunResult> {
  const bySymbol = new Map<string, RawGatewayPayload[]>();
  for (const b of feed) { const k = b.symbol.toUpperCase(); (bySymbol.get(k) ?? bySymbol.set(k, []).get(k)!).push(b); }
  const out: Record<string, StressRunResult> = {};
  for (const [symbol, bars] of [...bySymbol].sort(([a], [b]) => a.localeCompare(b))) {
    out[symbol] = runStressTest({ disableHumanApproval: true, ...cfg, symbol, mode: "HISTORICAL_REPLAY", historicalBars: bars });
  }
  return out;
}
