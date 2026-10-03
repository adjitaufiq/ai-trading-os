import type { MarketEvent } from "../contracts";
import type { ReplayClock } from "../temporal/CanonicalClock";
import type { MarketAdapter } from "./MarketAdapter";

/**
 * Replays a static event list. Before each event is delivered, the replay
 * clock advances to its ingested_at, so consumers see exactly the time they
 * would have seen live.
 */
export class DeterministicReplayAdapter implements MarketAdapter {
  readonly source = "REPLAY_FIXTURE" as const;
  private readonly events: readonly MarketEvent[];

  constructor(
    events: readonly MarketEvent[],
    private readonly clock: ReplayClock,
  ) {
    this.events = [...events].sort((a, b) => a.ingested_at - b.ingested_at || a.seq - b.seq);
  }

  subscribe(symbol: string, cb: (e: MarketEvent) => void): () => void {
    for (const e of this.events) {
      if (e.symbol !== symbol) continue;
      this.clock.advanceTo(e.ingested_at);
      cb(e);
    }
    return () => {};
  }

  /** Advance the clock beyond the last event (e.g. to trigger time-based closes). */
  advanceTo(t: number): void {
    this.clock.advanceTo(t);
  }
}
