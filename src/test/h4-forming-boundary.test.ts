// Authoritative H4 eligibility boundary (production path: TechnicalSliceService.tick → mergeClosedHistory → evaluate/operator).
// A candidate H4 bar that WOULD change H4 structure/primary_bias if admitted as eligible CLOSED history must not
// affect the authoritative result when it is FORMING (C1), not yet available (C2) or not yet closed in broker history (C3).
import { describe, expect, it } from "vitest";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { TechnicalSliceService } from "@/core/technical/TechnicalSliceService";
import type { Bar, Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { TradingSnapshot } from "@/core/technical/tradingState";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
const START = 1_700_000_000_000;
const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
const up = (k: number) => Array.from({ length: k }, (_, i) => 100 + i * 0.3 + ZIG[i % 8]!);
type Row = { open_time: number; close_time: number; available_at: number; open: number; high: number; low: number; close: number };
const rows = (tf: Timeframe, closes: number[]): Row[] => closes.map((c, i) => {
  const open_time = START + i * TF[tf];
  return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});
const toBar = (tf: Timeframe, r: Row, status: "CLOSED" | "FORMING" = "CLOSED"): Bar => ({
  ...r, symbol: "XAUUSD", timeframe: tf, source: "EXNESS_MT5", status, closed_at: status === "CLOSED" ? r.close_time : null,
  effective_at: r.close_time - 1, tick_count: 3, revision: 0,
} as Bar);

const H4_ROWS = rows("H4", up(60));
const LAST = H4_ROWS[H4_ROWS.length - 1]!;
// Candidate: next H4 bar, a crash bar far below the trend (completes/changes the right window of recent pivots).
const CAND: Row = { open_time: LAST.close_time, close_time: LAST.close_time + TF.H4, available_at: LAST.close_time + TF.H4, open: 120, high: 120.5, low: 60, close: 61 };

function reader(opts: { canonH4: Bar[]; forming?: Bar | null; historyH4?: Row[] }): MarketRuntimeReader {
  const lower: Record<Exclude<Timeframe, "H4">, Bar[]> = {
    M5: rows("M5", up(60)).map((r) => toBar("M5", r)), M15: rows("M15", up(60)).map((r) => toBar("M15", r)), H1: rows("H1", up(60)).map((r) => toBar("H1", r)),
  };
  return {
    symbol: "XAUUSD", now: () => 0,
    closedBars: (tf) => (tf === "H4" ? opts.canonH4 : lower[tf]),
    formingBar: (tf) => (tf === "H4" ? opts.forming ?? null : null),
    missingIntervals: () => [],
    brokerHistoryBars: (tf) => (tf === "H4" ? (opts.historyH4 ?? []) as never : []),
    firstLiveEventAt: () => null,
    radarSnapshot: () => null, radarHealth: () => ({ status: "INITIALIZING", lastSuccessfulEvaluation: 0, validationMode: "SYNTHETIC" }),
    latestLiveObservation: () => ({ seq: 1, symbol: "XAUUSD", source: "EXNESS_MT5", bid: 100, ask: 100.2, spread: 0.2, event_at: 5, observed_at: 6, ingested_at: 7, provenance: {} as never }),
    snapshot: () => ({ kind: "CANONICAL_MARKET_RUNTIME", operating_mode: "MONITOR_ONLY", execution_enabled: false, symbol: "XAUUSD", lifecycle: "RUNNING", bootstrap_state: "SYNCHRONIZED", active_epoch: 1, degraded_reason: null, history_coverage_status: "PARTIAL", market_coverage_proven_complete: false, route_counts: { LIVE_MUTATION: 1, BACKFILL_HISTORY: 0, RECONCILIATION_CANDIDATE: 0, QUARANTINED: 0, REJECTED: 0 }, held: [], silent_ambiguous_drops: 0, stream_protocol_errors: 0, last_stream_error: null, timeframes: {} as never }),
  } as MarketRuntimeReader;
}
const tick = (r: MarketRuntimeReader, asOf: number) => new TechnicalSliceService(r, "XAUUSD", new ReplayClock(asOf)).tick();
const h4 = (s: TradingSnapshot) => ({ structure: s.evidence!.H4.structure, closed_count: s.evidence!.H4.closed_count, h4_primary: s.operator?.h4_primary, primary_bias: s.primary_bias });

const CANON = H4_ROWS.map((r) => toBar("H4", r));
const AS_OF = CAND.close_time + 1; // after the candidate's close: only the boundary under test may exclude it
const baseline = h4(tick(reader({ canonH4: CANON }), AS_OF));
const admitted = h4(tick(reader({ canonH4: [...CANON, toBar("H4", CAND)] }), AS_OF));

describe("authoritative H4 eligibility boundary (TechnicalSliceService.tick)", () => {
  it("control: the candidate materially changes H4 structure/primary_bias when admitted as eligible CLOSED history", () => {
    expect(admitted.closed_count).toBe(baseline.closed_count + 1);
    expect(admitted.structure).not.toEqual(baseline.structure);
    expect(admitted.primary_bias).not.toBe(baseline.primary_bias);
  });
  it("C1 — status boundary: a FORMING H4 candle never reaches authoritative structure/primary_bias", () => {
    const forming = toBar("H4", CAND, "FORMING");
    const withForming = h4(tick(reader({ canonH4: [...CANON, forming], forming }), AS_OF));
    expect(withForming).toEqual(baseline);
  });
  it("C2 — available_at boundary: a CLOSED H4 candle with available_at > asOf cannot change the result", () => {
    const late = toBar("H4", { ...CAND, available_at: AS_OF + 1 });
    const got = h4(tick(reader({ canonH4: [...CANON, late] }), AS_OF));
    expect(got).toEqual(baseline);
  });
  it("C3 — broker history close_time boundary: history bar with close_time > asOf (available_at <= asOf) is excluded", () => {
    const asOf = CAND.close_time - 1;
    // History path only: available_at already <= asOf, so only the close_time filter can exclude it.
    const histCand: Row = { ...CAND, available_at: asOf };
    const histBase = h4(tick(reader({ canonH4: [], historyH4: H4_ROWS }), asOf));
    const histAdmittedControl = h4(tick(reader({ canonH4: [], historyH4: [...H4_ROWS, { ...histCand, close_time: asOf }] }), asOf));
    expect(histAdmittedControl.structure).not.toEqual(histBase.structure);
    expect(histAdmittedControl.primary_bias).not.toBe(histBase.primary_bias);
    const got = h4(tick(reader({ canonH4: [], historyH4: [...H4_ROWS, histCand] }), asOf));
    expect(got).toEqual(histBase);
  });
});
