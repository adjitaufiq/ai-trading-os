// PRE-2D Patch C — R7 bounded CLOSED canonical candle store (Candle Store owns bounded history).
// Append-only for CLOSED candles; existing CLOSED candles are never mutated (closed_canonical_mutations == 0).
// Truncation is always explicit; consumer history requirements are never silently shortened.
import type { Bar, Timeframe } from "../contracts";
import type { CandleAggregator } from "../temporal/CandleAggregator";

export interface HistoryRequirement {
  readonly consumer_id: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly required_bars: number;
  readonly warmup_bars: number;
}

export type HistoryStatus = "SATISFIED" | "WARMUP_UNSATISFIED" | "HISTORY_TRUNCATED" | "INSUFFICIENT_HISTORY";

export interface HistoryResult {
  readonly status: HistoryStatus;
  readonly requirement: HistoryRequirement;
  /** Exactly what is retained. Never padded, never fabricated. */
  readonly bars: readonly Bar[];
  readonly needed: number;
  readonly available: number;
  /** true when retention evicted bars this request would otherwise have needed. */
  readonly truncated_by_retention: boolean;
  readonly evicted_total: number;
  /** "ALL_REQUESTED" only when status is SATISFIED. */
  readonly delivery: "ALL_REQUESTED" | "RETAINED_SUBSET_ONLY";
}

export type LateEvidenceRoute = "RECONCILIATION_CANDIDATE";
export interface LateEvidenceRecord {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly interval_open_time: number;
  readonly arrived_at: number;
  readonly route: LateEvidenceRoute;
  readonly beyond_retention_horizon: boolean;
  readonly reason: string;
}

export interface CandleStoreMetrics {
  readonly retained: number;
  readonly max_bars: number;
  readonly evicted_total: number;
  /** Must stay 0: attempts to overwrite a CLOSED candle are refused and counted separately. */
  readonly closed_canonical_mutations: 0;
  readonly refused_closed_overwrites: number;
  readonly late_evidence: number;
}

export class CandleStore {
  private bars: Bar[] = [];
  private evicted = 0;
  private refused = 0;
  private everEvicted = false;
  private readonly late: LateEvidenceRecord[] = [];

  constructor(readonly symbol: string, readonly timeframe: Timeframe, private maxBars: number) {
    if (!(maxBars > 0)) throw new Error("maxBars must be > 0");
  }

  /** Subscribe to an aggregator. Only CLOSED snapshots are stored; FORMING stays aggregator-owned. */
  attach(agg: CandleAggregator): () => void {
    if (agg.symbol !== this.symbol || agg.timeframe !== this.timeframe) throw new Error("aggregator/store mismatch");
    return agg.onBar((b) => { if (b.status === "CLOSED") this.append(b); });
  }

  append(b: Bar): void {
    if (b.status !== "CLOSED") throw new Error("CandleStore accepts CLOSED candles only");
    if (b.symbol !== this.symbol || b.timeframe !== this.timeframe) throw new Error("bar/store mismatch");
    const last = this.bars[this.bars.length - 1];
    if (last && b.open_time <= last.open_time) {
      // Never overwrite or reorder CLOSED history.
      this.refused++;
      this.late.push(Object.freeze({ symbol: b.symbol, timeframe: b.timeframe, interval_open_time: b.open_time, arrived_at: b.available_at,
        route: "RECONCILIATION_CANDIDATE", beyond_retention_horizon: this.isBeyondHorizon(b.open_time), reason: "CLOSED candle already exists or is older; overwrite refused" }));
      return;
    }
    this.bars.push(Object.freeze({ ...b }));
    this.enforce();
  }

  /** Mutable horizon = newest retained CLOSED open_time. Anything at or before it is immutable. */
  private isBeyondHorizon(open_time: number): boolean {
    const oldest = this.bars[0];
    return oldest === undefined ? this.everEvicted : open_time < oldest.open_time;
  }

  /** R7.6: late/backfilled evidence for a closed/old interval → reconciliation/audit, never mutation. */
  routeLateEvidence(interval_open_time: number, arrived_at: number, reason: string): LateEvidenceRecord {
    const r = Object.freeze<LateEvidenceRecord>({ symbol: this.symbol, timeframe: this.timeframe, interval_open_time, arrived_at,
      route: "RECONCILIATION_CANDIDATE", beyond_retention_horizon: this.isBeyondHorizon(interval_open_time), reason });
    this.late.push(r);
    return r;
  }

  /** R7.5: memory pressure lowers the retention cap; evictions are counted and surface as truncation. */
  applyPressure(newMaxBars: number): void {
    if (!(newMaxBars > 0)) throw new Error("maxBars must be > 0");
    this.maxBars = newMaxBars;
    this.enforce();
  }

  private enforce(): void {
    while (this.bars.length > this.maxBars) {
      this.bars.shift();
      this.evicted++;
      this.everEvicted = true;
    }
  }

  history(req: HistoryRequirement): HistoryResult {
    if (req.symbol !== this.symbol || req.timeframe !== this.timeframe) throw new Error("requirement/store mismatch");
    const needed = req.required_bars + req.warmup_bars;
    const available = this.bars.length;
    const bars = Object.freeze(this.bars.slice(Math.max(0, available - needed)));
    let status: HistoryStatus;
    if (available >= needed) status = "SATISFIED";
    else if (this.everEvicted) status = "HISTORY_TRUNCATED";
    else if (available >= req.required_bars) status = "WARMUP_UNSATISFIED";
    else status = "INSUFFICIENT_HISTORY";
    return Object.freeze({
      status, requirement: req, bars, needed, available,
      truncated_by_retention: status !== "SATISFIED" && this.everEvicted,
      evicted_total: this.evicted,
      delivery: status === "SATISFIED" ? "ALL_REQUESTED" : "RETAINED_SUBSET_ONLY",
    });
  }

  get closed(): readonly Bar[] { return this.bars; }
  get lateEvidence(): readonly LateEvidenceRecord[] { return this.late; }
  get metrics(): CandleStoreMetrics {
    return Object.freeze({ retained: this.bars.length, max_bars: this.maxBars, evicted_total: this.evicted,
      closed_canonical_mutations: 0 as const, refused_closed_overwrites: this.refused, late_evidence: this.late.length });
  }
}
