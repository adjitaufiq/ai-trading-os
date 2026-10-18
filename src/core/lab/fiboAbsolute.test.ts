import { describe, expect, it } from "vitest";
import { openSignals } from "./labLedger";
import type { LabSignal } from "./strategies";

const empty = { trades: [], seen: {}, started_at: null };
const sell: LabSignal = { strategy: "SMC_FIBO_OTE", side: "SELL", why: "t", sl_distance: 150, tp_distance: 330, sl_price: 80930, tp_price: 80450, bar_time: 1 };

describe("Mode 12 absolute SL/TP", () => {
  it("locks SL/TP at technical prices even when fill drifts", () => {
    const s = openSignals(empty, "BTCUSD", [sell], { bid: 80743, ask: 80745 }, 10, "COPET");
    expect(s.trades[0]!.sl).toBe(80930);
    expect(s.trades[0]!.tp).toBe(80450);
    expect(s.trades[0]!.risk_usd).toBeCloseTo((80930 - 80743) * 0.05);
  });
  it("voids the signal when fill is already beyond TP", () => {
    const s = openSignals(empty, "BTCUSD", [sell], { bid: 80440, ask: 80442 }, 10, "COPET");
    expect(s.trades).toHaveLength(0);
  });
});
