import type { Bar, MarketEvent, MarketSource, Timeframe } from "../contracts";

/** How a consumer/primitive is allowed to read temporal data. */
export type ConsumptionMode =
  | "TICK"
  | "FORMING_BAR"
  | "CLOSED_BAR"
  | "MULTI_TF_CLOSED"
  | "MULTI_TF_PARTIAL";

export interface TemporalPolicy {
  consumer: string;
  mode: ConsumptionMode;
  /** Required for MULTI_TF_*: first entry is the primary (lowest) timeframe. */
  timeframes?: Timeframe[];
}

export class FutureEvidenceError extends Error {}

/** Invariant: no state at T may depend on evidence whose available_at > T. */
export function assertNoFutureEvidence(T: number, items: { available_at: number }[]): void {
  for (const it of items) {
    if (it.available_at > T) {
      throw new FutureEvidenceError(`Future evidence: available_at ${it.available_at} > T ${T}`);
    }
  }
}

export function canConsumeTick(e: MarketEvent, T: number): boolean {
  return e.ingested_at <= T;
}

export function canConsumeBar(policy: TemporalPolicy, bar: Bar, T: number): boolean {
  if (bar.available_at > T) return false;
  switch (policy.mode) {
    case "TICK":
      return false;
    case "FORMING_BAR":
      return true;
    case "CLOSED_BAR":
    case "MULTI_TF_CLOSED":
      return bar.status === "CLOSED" && bar.closed_at !== null && bar.closed_at <= T;
    case "MULTI_TF_PARTIAL":
      return true;
  }
}

/**
 * Multi-timeframe consumption.
 * - MULTI_TF_CLOSED: every timeframe's bar must be CLOSED and available.
 * - MULTI_TF_PARTIAL: primary timeframe must be CLOSED; higher timeframes may be FORMING.
 */
export function canConsumeMultiTf(
  policy: TemporalPolicy,
  bars: Partial<Record<Timeframe, Bar>>,
  T: number,
): boolean {
  const tfs = policy.timeframes ?? [];
  if (tfs.length === 0) return false;
  return tfs.every((tf, i) => {
    const b = bars[tf];
    if (!b || b.available_at > T) return false;
    const mustBeClosed = policy.mode === "MULTI_TF_CLOSED" || i === 0;
    return mustBeClosed ? b.status === "CLOSED" && (b.closed_at ?? Infinity) <= T : true;
  });
}

// ---------- Freshness / gap policy (configurable, not universal) ----------

export interface FreshnessRule {
  maxTickAgeMs: number;
  maxGapMs: number;
}

export interface FreshnessKey {
  symbol: string;
  source: MarketSource;
  timeframe?: Timeframe;
}

export type Freshness = "FRESH" | "STALE" | "NO_DATA";

/** Resolution order: symbol+source+tf → symbol+source → symbol → default. */
export class FreshnessPolicy {
  private rules = new Map<string, FreshnessRule>();
  constructor(private readonly fallback: FreshnessRule) {}

  set(rule: FreshnessRule, symbol?: string, source?: MarketSource, timeframe?: Timeframe): this {
    this.rules.set([symbol ?? "*", source ?? "*", timeframe ?? "*"].join("|"), rule);
    return this;
  }

  resolve({ symbol, source, timeframe }: FreshnessKey): FreshnessRule {
    const keys = [
      [symbol, source, timeframe ?? "*"],
      [symbol, source, "*"],
      [symbol, "*", "*"],
    ];
    for (const k of keys) {
      const r = this.rules.get(k.join("|"));
      if (r) return r;
    }
    return this.fallback;
  }

  evaluate(key: FreshnessKey, last: MarketEvent | null, T: number): Freshness {
    if (!last) return "NO_DATA";
    return T - last.ingested_at > this.resolve(key).maxTickAgeMs ? "STALE" : "FRESH";
  }

  /** Returns gaps (between consecutive events by event_at) exceeding maxGapMs. */
  findGaps(key: FreshnessKey, events: MarketEvent[]): { from: number; to: number }[] {
    const { maxGapMs } = this.resolve(key);
    const gaps: { from: number; to: number }[] = [];
    for (let i = 1; i < events.length; i++) {
      const a = events[i - 1]!.event_at;
      const b = events[i]!.event_at;
      if (b - a > maxGapMs) gaps.push({ from: a, to: b });
    }
    return gaps;
  }
}
