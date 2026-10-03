import type { MarketEvent } from "../contracts";
import type { CanonicalClock } from "../temporal/CanonicalClock";
import type { MarketAdapter } from "./MarketAdapter";

const BASE: Record<string, number> = { XAUUSD: 2345.6, BTCUSD: 64250 };

/** Seeded PRNG so the mock source sequence is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Live-paced mock. Timestamps come from the injected canonical clock. */
export class MockMarketAdapter implements MarketAdapter {
  readonly source = "MOCK" as const;
  constructor(
    private readonly clock: CanonicalClock,
    private readonly seed = 42,
    private readonly intervalMs = 1000,
  ) {}

  subscribe(symbol: string, cb: (e: MarketEvent) => void): () => void {
    const rnd = mulberry32(this.seed + symbol.length);
    let mid = BASE[symbol] ?? 100;
    let seq = 0;
    const id = setInterval(() => {
      mid += (rnd() - 0.5) * mid * 0.0004;
      const spread = +(mid * 0.00008 + rnd() * mid * 0.00003).toFixed(2);
      const ingested_at = this.clock.now();
      const observed_at = ingested_at - Math.floor(rnd() * 5);
      const event_at = observed_at - Math.floor(rnd() * 40);
      cb({
        seq: seq++,
        symbol,
        source: this.source,
        bid: +(mid - spread / 2).toFixed(2),
        ask: +(mid + spread / 2).toFixed(2),
        spread,
        event_at,
        observed_at,
        ingested_at,
      });
    }, this.intervalMs);
    return () => clearInterval(id);
  }
}
