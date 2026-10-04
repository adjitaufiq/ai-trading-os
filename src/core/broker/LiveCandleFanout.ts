import type { Timeframe } from "../contracts";
import { CandleAggregator } from "../temporal/CandleAggregator";
import type { CanonicalClock } from "../temporal/CanonicalClock";
import type { BrokerMarketEvent } from "./types";

export const LIVE_FANOUT_TIMEFRAMES = Object.freeze(["M5", "M15", "H1", "H4"] as const satisfies readonly Timeframe[]);

/**
 * PRE-2D R3: one canonical LIVE observation (already validated, normalized and classified
 * once by BrokerFeedPipeline) fans out unchanged to an independent CandleAggregator per
 * timeframe. Each aggregator owns its own [start, end) interval lifecycle; no aggregator
 * can influence another, and none feeds back into feed classification.
 * Wire this ONLY as the pipeline's live sink.
 */
export class LiveCandleFanout {
  readonly aggregators: Readonly<Record<(typeof LIVE_FANOUT_TIMEFRAMES)[number], CandleAggregator>>;

  constructor(symbol: string, clock: CanonicalClock) {
    this.aggregators = Object.freeze({
      M5: new CandleAggregator(symbol, "M5", clock),
      M15: new CandleAggregator(symbol, "M15", clock),
      H1: new CandleAggregator(symbol, "H1", clock),
      H4: new CandleAggregator(symbol, "H4", clock),
    });
  }

  ingest = (e: BrokerMarketEvent): void => {
    for (const tf of LIVE_FANOUT_TIMEFRAMES) this.aggregators[tf].ingest(e);
  };

  checkBoundary(): void {
    for (const tf of LIVE_FANOUT_TIMEFRAMES) this.aggregators[tf].checkBoundary();
  }
}
