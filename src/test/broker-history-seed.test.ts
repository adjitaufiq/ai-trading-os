import { describe, expect, it } from "vitest";
import { mergeClosedHistory } from "@/core/technical/TechnicalSliceService";
import { evaluate, SLICE_ENV } from "@/core/technical/tradingState";
import type { TechBar } from "@/core/technical/indicators";

const H = 3_600_000;
const bar = (i: number, ms: number, c: number, avail = 0, o = c - 0.5): TechBar => ({ open_time: i * ms, close_time: (i + 1) * ms, available_at: avail || (i + 1) * ms, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c });

describe("broker history → technical engine", () => {
  it("merges history then strictly newer canonical bars, excluding partial and not-yet-available bars", () => {
    const hist = [bar(1, H, 1), bar(2, H, 2), bar(3, H, 3)];
    const canon = [bar(3, H, 9), bar(4, H, 4), bar(5, H, 5)];
    const m = mergeClosedHistory(hist, canon, 4 * H, 5 * H);
    expect(m.map((b) => b.close)).toEqual([1, 2, 3, 4]); // bar 5 not available yet at asOf
    expect(mergeClosedHistory(hist, [bar(4, H, 4)], 4 * H + 1, 9 * H).length).toBe(3); // partial canonical excluded
  });

  it("history warmup clears INSUFFICIENT_HISTORY and yields a BUY bias with entry analysis", () => {
    const rising = (ms: number, n: number) => Array.from({ length: n }, (_, i) => bar(i, ms, 100 + i * 0.5 + [0, 1, 2, 3, 4, 3, 2, 1][i % 8]!));
    const m5 = rising(300_000, 60);
    const s = evaluate({ symbol: "XAUUSD", market_current: true, bars_current: true, quote: { bid: 200, ask: 200.2, spread: 0.2, tick_time_ms: 0, observed_at: 0 },
      closed: { M5: m5, M15: rising(900_000, 60), H1: rising(H, 60), H4: rising(4 * H, 60) }, as_of: 1e15, env: SLICE_ENV });
    expect(s.bias.state).toBe("BUY");
    expect(s.evidence!.M5.rsi14.status).toBe("OK");
    expect(["LONG_CANDIDATE", "WAIT", "NOT_EVALUABLE"]).toContain(s.entry.state);
    expect(s.execution.state).toBe("BLOCKED");
  });
});
