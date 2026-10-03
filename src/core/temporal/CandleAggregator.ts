import { TIMEFRAME_MS, type Bar, type MarketEvent, type Timeframe } from "../contracts";
import type { CanonicalClock } from "./CanonicalClock";

export type BarListener = (bar: Bar) => void;

/**
 * Deterministic candle construction: ticks → FORMING → boundary crossed → CLOSED.
 * Bucketing uses event_at (market time). Lifecycle timestamps come from the
 * canonical clock only. Emitted bars are frozen snapshots.
 */
export class CandleAggregator {
  private forming: Bar | null = null;
  private readonly closed: Bar[] = [];
  private readonly listeners = new Set<BarListener>();
  private readonly tfMs: number;

  constructor(
    readonly symbol: string,
    readonly timeframe: Timeframe,
    private readonly clock: CanonicalClock,
  ) {
    this.tfMs = TIMEFRAME_MS[timeframe];
  }

  onBar(l: BarListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get current(): Bar | null {
    return this.forming;
  }
  get closedBars(): readonly Bar[] {
    return this.closed;
  }

  ingest(e: MarketEvent): void {
    if (e.symbol !== this.symbol) return;
    if (!(e.event_at <= e.observed_at && e.observed_at <= e.ingested_at)) {
      throw new Error(`Temporal order violated for seq ${e.seq}`);
    }
    if (e.ingested_at > this.clock.now()) {
      throw new Error(`Event seq ${e.seq} ingested in the future of the canonical clock`);
    }
    const open_time = Math.floor(e.event_at / this.tfMs) * this.tfMs;

    if (this.forming && e.event_at < this.forming.open_time) {
      throw new Error(`Late tick seq ${e.seq} for an already-closed bar`);
    }
    if (this.forming && open_time >= this.forming.close_time) this.close();

    const price = e.bid;
    const prev = this.forming;
    const next: Bar =
      prev && prev.open_time === open_time
        ? {
            ...prev,
            high: Math.max(prev.high, price),
            low: Math.min(prev.low, price),
            close: price,
            tick_count: prev.tick_count + 1,
            effective_at: e.event_at,
            available_at: this.clock.now(),
            revision: prev.revision + 1,
          }
        : {
            symbol: this.symbol,
            timeframe: this.timeframe,
            source: e.source,
            open_time,
            close_time: open_time + this.tfMs,
            status: "FORMING",
            closed_at: null,
            effective_at: e.event_at,
            available_at: this.clock.now(),
            open: price,
            high: price,
            low: price,
            close: price,
            tick_count: 1,
            revision: 0,
          };
    this.forming = Object.freeze(next);
    this.emit(this.forming);
  }

  /** Time-driven close: declares the forming bar CLOSED once the clock passes close_time. */
  checkBoundary(): void {
    if (this.forming && this.clock.now() >= this.forming.close_time) this.close();
  }

  private close(): void {
    const f = this.forming!;
    const now = this.clock.now();
    if (now < f.close_time) {
      throw new Error(`Cannot close bar before close_time (${now} < ${f.close_time})`);
    }
    const bar = Object.freeze<Bar>({
      ...f,
      status: "CLOSED",
      closed_at: now,
      available_at: now,
      revision: f.revision + 1,
    });
    this.closed.push(bar);
    this.forming = null;
    this.emit(bar);
  }

  private emit(b: Bar) {
    for (const l of this.listeners) l(b);
  }
}
