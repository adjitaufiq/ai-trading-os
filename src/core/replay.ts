import type { Bar, MarketEvent, Timeframe } from "./contracts";
import { DeterministicReplayAdapter } from "./market/DeterministicReplayAdapter";
import { CandleAggregator } from "./temporal/CandleAggregator";
import { ReplayClock } from "./temporal/CanonicalClock";

export interface ReplayResult {
  emitted: Bar[];
  closed: Bar[];
  forming: Bar | null;
  finalTime: number;
}

/** Runs a full deterministic replay of events through a fresh aggregator. */
export function runReplay(
  events: readonly MarketEvent[],
  symbol: string,
  timeframe: Timeframe,
  endAt?: number,
): ReplayResult {
  const clock = new ReplayClock(events[0]?.ingested_at ?? 0);
  const adapter = new DeterministicReplayAdapter(events, clock);
  const agg = new CandleAggregator(symbol, timeframe, clock);
  const emitted: Bar[] = [];
  agg.onBar((b) => emitted.push(b));
  adapter.subscribe(symbol, (e) => agg.ingest(e));
  if (endAt !== undefined) {
    adapter.advanceTo(endAt);
    agg.checkBoundary();
  }
  return { emitted, closed: [...agg.closedBars], forming: agg.current, finalTime: clock.now() };
}
