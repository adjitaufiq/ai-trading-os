import { describe, expect, it } from "vitest";
import type { Bar, Timeframe } from "@/core/contracts";
import { ALIGNED_REPLAY_KNOWN_GAPS, runAlignedReplay } from "@/core/paper/alignedReplay";

const MS: Record<Timeframe, number> = { M5: 3e5, M15: 9e5, H1: 36e5, H4: 144e5 } as Record<Timeframe, number>;
const T0 = 1_700_000_000_000;
const spec = Object.freeze({ symbol: "XAUUSD", origin: "BROKER_REPORTED" as const, digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
const series = (tf: Timeframe, n: number, sym = "XAUUSD"): Bar[] => Array.from({ length: n }, (_, i) => {
  const o = T0 + i * MS[tf], p = 2000 + Math.sin(i / 7) * 5;
  return { symbol: sym, timeframe: tf, source: "MT5", open_time: o, close_time: o + MS[tf], status: "CLOSED", closed_at: o + MS[tf], effective_at: o + MS[tf], available_at: o + MS[tf], open: p, high: p + 1, low: p - 1, close: p + 0.2, tick_count: 1, revision: 0 } as unknown as Bar;
});
const all = () => ({ M5: series("M5", 120), M15: series("M15", 40), H1: series("H1", 10), H4: series("H4", 3) });

describe("aligned replay (paper path over native CLOSED bars)", () => {
  it.each(["M5", "M15", "H1", "H4"] as const)("missing %s ⇒ DATA_MISSING, no aggregation fallback", (tf) => {
    const b: Partial<Record<Timeframe, Bar[]>> = all(); delete b[tf];
    const r = runAlignedReplay("XAUUSD", spec, b);
    expect(r.status).toBe("DATA_MISSING");
    if (r.status === "DATA_MISSING") expect(r.missing).toContain(`${tf}: no bars`);
  });
  it("non-CLOSED or foreign-symbol bars are rejected", () => {
    const b = all(); b.H1 = [{ ...b.H1[0]!, status: "FORMING" } as Bar]; b.M15 = series("M15", 5, "BTCUSD");
    const r = runAlignedReplay("XAUUSD", spec, b);
    expect(r.status).toBe("DATA_MISSING");
    if (r.status === "DATA_MISSING") expect(r.missing).toEqual(expect.arrayContaining(["H1: non-CLOSED bar", "M15: symbol mismatch"]));
  });
  it("replays every M5 bar through LivePaperLoop, records ARENA reading per bar and reports known gaps", () => {
    const r = runAlignedReplay("XAUUSD", spec, all());
    expect(r.status).toBe("DONE");
    if (r.status !== "DONE") return;
    expect(r.barsReplayed).toBe(120);
    expect(r.rows).toHaveLength(120);
    expect(r.knownGaps).toBe(ALIGNED_REPLAY_KNOWN_GAPS);
    // H4 warmup is insufficient here ⇒ fail closed: no ALLOW and no trade.
    expect(r.summary.gateAllow).toBe(0);
    expect(r.trades).toHaveLength(0);
    expect(r.rows.every((x) => x.primaryBias === null || x.primaryBias === "NONE" || x.decision !== null)).toBe(true);
  });
});
