import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, type Bar } from "@/core/contracts";
import { FIXTURE_START, xauusdTemporalFixture as FX } from "@/core/fixtures/xauusdTemporalFixture";
import { runReplay } from "@/core/replay";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { LiveClock, ReplayClock } from "@/core/temporal/CanonicalClock";
import {
  assertNoFutureEvidence,
  canConsumeBar,
  canConsumeMultiTf,
  canConsumeTick,
  FreshnessPolicy,
  FutureEvidenceError,
} from "@/core/temporal/TemporalPolicy";

const M5 = 5 * 60_000;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("safety invariants", () => {
  it("preserves MONITOR_ONLY and execution disabled", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });

  it("has zero order/execution capability in source", () => {
    const files = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("/test/"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/order_send|order_check|placeOrder|submitOrder|ExecutionIntent/);
    }
  });

  it("core engine has no uncontrolled Date.now()", () => {
    const files = walk("src/core").filter((f) => !f.endsWith("CanonicalClock.ts"));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/Date\.now\(/);
  });
});

describe("CanonicalClock", () => {
  it("REPLAY clock is explicit and monotonic", () => {
    const c = new ReplayClock(100);
    expect(c.mode).toBe("REPLAY");
    c.advanceTo(200);
    expect(c.now()).toBe(200);
    expect(() => c.advanceTo(150)).toThrow();
  });
  it("LIVE clock is monotonic even if source regresses", () => {
    const seq = [1000, 900, 1100];
    const c = new LiveClock(() => seq.shift()!);
    expect(c.mode).toBe("LIVE");
    expect([c.now(), c.now(), c.now()]).toEqual([1000, 1000, 1100]);
  });
});

describe("fixture event semantics", () => {
  it("event_at <= observed_at <= ingested_at", () => {
    for (const e of FX) {
      expect(e.event_at).toBeLessThanOrEqual(e.observed_at);
      expect(e.observed_at).toBeLessThanOrEqual(e.ingested_at);
    }
  });
});

describe("CandleAggregator lifecycle", () => {
  const r = runReplay(FX, "XAUUSD", "M5");

  it("builds FORMING → CLOSED deterministically", () => {
    expect(r.closed).toHaveLength(2);
    expect(r.forming?.status).toBe("FORMING");
    const [b0, b1] = r.closed as [Bar, Bar];
    expect(b0).toMatchObject({ open_time: FIXTURE_START, close_time: FIXTURE_START + M5, open: 2345.1, high: 2346.2, low: 2344.9, close: 2346.0, tick_count: 5 });
    expect(b1).toMatchObject({ open: 2346.4, high: 2347.8, low: 2346.4, close: 2347.8, tick_count: 4 });
    expect(r.emitted.filter((b) => b.open_time === FIXTURE_START).map((b) => b.status)).toEqual([
      "FORMING", "FORMING", "FORMING", "FORMING", "FORMING", "CLOSED",
    ]);
  });

  it("closed_at >= close_time and close_time != closed_at semantics", () => {
    for (const b of r.closed) {
      expect(b.closed_at).not.toBeNull();
      expect(b.closed_at!).toBeGreaterThanOrEqual(b.close_time);
      expect(b.closed_at).not.toBe(b.close_time); // declared on next tick ingestion, not at math boundary
    }
  });

  it("effective_at is last tick event_at, not close_time", () => {
    const b0 = r.closed[0]!;
    expect(b0.effective_at).toBe(FIXTURE_START + 299_000);
    expect(b0.effective_at).not.toBe(b0.close_time);
  });

  it("available_at equals canonical time of computation", () => {
    for (const b of r.emitted) {
      if (b.status === "CLOSED") expect(b.available_at).toBe(b.closed_at);
      expect(b.available_at).toBeGreaterThanOrEqual(b.effective_at);
    }
  });

  it("emitted bars are immutable snapshots", () => {
    expect(Object.isFrozen(r.emitted[0])).toBe(true);
  });

  it("time-driven close via checkBoundary", () => {
    const end = FIXTURE_START + 3 * M5 + 2000;
    const t = runReplay(FX, "XAUUSD", "M5", end);
    expect(t.forming).toBeNull();
    expect(t.closed).toHaveLength(3);
    expect(t.closed[2]!.closed_at).toBe(end);
  });

  it("refuses to close before close_time and rejects late ticks", () => {
    const clock = new ReplayClock(FX[0]!.ingested_at);
    const agg = new CandleAggregator("XAUUSD", "M5", clock);
    agg.ingest(FX[0]!);
    agg.checkBoundary();
    expect(agg.current?.status).toBe("FORMING");
    clock.advanceTo(FX[5]!.ingested_at);
    agg.ingest(FX[5]!);
    expect(() => agg.ingest(FX[4]!)).toThrow(/Late tick/);
  });

  it("rejects events ingested in the clock's future", () => {
    const clock = new ReplayClock(FIXTURE_START);
    const agg = new CandleAggregator("XAUUSD", "M5", clock);
    expect(() => agg.ingest(FX[0]!)).toThrow(/future/);
  });
});

describe("replay equivalence", () => {
  it("two runs are deeply equal", () => {
    expect(runReplay(FX, "XAUUSD", "M5")).toEqual(runReplay(FX, "XAUUSD", "M5"));
    const end = FIXTURE_START + 3 * M5;
    expect(runReplay(FX, "XAUUSD", "M5", end)).toEqual(runReplay(FX, "XAUUSD", "M5", end));
  });
  it("input order does not affect output", () => {
    const shuffled = [...FX].reverse();
    expect(runReplay(shuffled, "XAUUSD", "M5")).toEqual(runReplay(FX, "XAUUSD", "M5"));
  });
});

describe("TemporalPolicy", () => {
  const r = runReplay(FX, "XAUUSD", "M5");
  const closed = r.closed[0]!;
  const forming = r.forming!;

  it("no future evidence consumption", () => {
    expect(() => assertNoFutureEvidence(closed.available_at, [closed])).not.toThrow();
    expect(() => assertNoFutureEvidence(closed.available_at - 1, [closed])).toThrow(FutureEvidenceError);
  });

  it("TICK", () => {
    expect(canConsumeTick(FX[0]!, FX[0]!.ingested_at)).toBe(true);
    expect(canConsumeTick(FX[0]!, FX[0]!.ingested_at - 1)).toBe(false);
  });

  it("FORMING_BAR vs CLOSED_BAR", () => {
    const T = forming.available_at;
    expect(canConsumeBar({ consumer: "x", mode: "FORMING_BAR" }, forming, T)).toBe(true);
    expect(canConsumeBar({ consumer: "x", mode: "CLOSED_BAR" }, forming, T)).toBe(false);
    expect(canConsumeBar({ consumer: "x", mode: "CLOSED_BAR" }, closed, T)).toBe(true);
    expect(canConsumeBar({ consumer: "x", mode: "CLOSED_BAR" }, closed, closed.closed_at! - 1)).toBe(false);
  });

  it("MULTI_TF_CLOSED vs MULTI_TF_PARTIAL", () => {
    const T = forming.available_at;
    const h1 = runReplay(FX, "XAUUSD", "H1").forming!; // H1 still forming
    const bars = { M5: closed, H1: h1 };
    expect(canConsumeMultiTf({ consumer: "x", mode: "MULTI_TF_CLOSED", timeframes: ["M5", "H1"] }, bars, T)).toBe(false);
    expect(canConsumeMultiTf({ consumer: "x", mode: "MULTI_TF_PARTIAL", timeframes: ["M5", "H1"] }, bars, T)).toBe(true);
    expect(canConsumeMultiTf({ consumer: "x", mode: "MULTI_TF_PARTIAL", timeframes: ["H1", "M5"] }, bars, T)).toBe(false);
  });
});

describe("FreshnessPolicy", () => {
  const p = new FreshnessPolicy({ maxTickAgeMs: 10_000, maxGapMs: 60_000 })
    .set({ maxTickAgeMs: 3_000, maxGapMs: 30_000 }, "XAUUSD", "REPLAY_FIXTURE")
    .set({ maxTickAgeMs: 1_000, maxGapMs: 120_000 }, "XAUUSD", "REPLAY_FIXTURE", "H1");
  const key = { symbol: "XAUUSD", source: "REPLAY_FIXTURE" as const };

  it("resolves per asset/source/timeframe", () => {
    expect(p.resolve(key).maxTickAgeMs).toBe(3_000);
    expect(p.resolve({ ...key, timeframe: "H1" }).maxTickAgeMs).toBe(1_000);
    expect(p.resolve({ symbol: "BTCUSD", source: "MOCK" }).maxTickAgeMs).toBe(10_000);
  });

  it("evaluates freshness and gaps", () => {
    const last = FX[0]!;
    expect(p.evaluate(key, null, 0)).toBe("NO_DATA");
    expect(p.evaluate(key, last, last.ingested_at + 2_000)).toBe("FRESH");
    expect(p.evaluate(key, last, last.ingested_at + 4_000)).toBe("STALE");
    expect(p.findGaps(key, [...FX]).length).toBeGreaterThan(0);
    expect(p.findGaps({ ...key, timeframe: "H1" }, [...FX])).toHaveLength(0);
  });
});
