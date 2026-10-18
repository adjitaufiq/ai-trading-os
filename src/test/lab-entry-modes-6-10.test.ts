import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateLabDetailed, LAB_NEW_STRATEGIES, LAB_RULES, type LabStrategy } from "@/core/lab/strategies";
import { bookMark, bookOpen, bookStats, createBook, upgradeBook } from "@/core/lab/isolatedLedgers";
import type { TechBar } from "@/core/technical/indicators";

const M5 = 300_000, M15 = 900_000, H1 = 3_600_000;
const mk = (i: number, tf: number, o: number, h: number, l: number, c: number): TechBar => ({ open_time: i * tf, close_time: (i + 1) * tf, available_at: (i + 1) * tf, open: o, high: h, low: l, close: c });
/** Flat-ish oscillating series around `base` with amplitude `amp`. */
const series = (n: number, tf: number, base: number, amp: number, drift = 0) =>
  Array.from({ length: n }, (_, i) => { const m = base + drift * i + amp * Math.sin(i / 2); return mk(i, tf, m, m + amp * 0.6, m - amp * 0.6, m + amp * 0.1); });
/** Move a series so its bars sit after `offset` ms (H1 context must be closed before the M5 bar). */
const shift = (bars: TechBar[], offset: number) => bars.map((b) => ({ ...b, open_time: b.open_time + offset, close_time: b.close_time + offset, available_at: b.available_at + offset }));
const AFTER_H1 = 80 * H1;
const fired = (r: ReturnType<typeof evaluateLabDetailed>, s: LabStrategy) => r.signals.filter((x) => x.strategy === s);
const reason = (r: ReturnType<typeof evaluateLabDetailed>, s: LabStrategy) => r.rejects.find((x) => x.strategy === s)?.reason;

describe("lab entry modes 6–10", () => {
  it("every new mode has explicit rule text", () => {
    for (const s of LAB_NEW_STRATEGIES) expect(LAB_RULES[s]?.length).toBeGreaterThan(40);
  });

  it("insufficient history ⇒ every new mode rejects with a reason, no signal", () => {
    const r = evaluateLabDetailed(series(10, M5, 100, 1), series(10, M15, 100, 1));
    expect(r.signals).toHaveLength(0);
    expect(r.rejects.map((x) => x.strategy).sort()).toEqual([...LAB_NEW_STRATEGIES].sort());
  });

  it("missing H1 ⇒ modes 6 and 9 reject H1_HISTORY_INSUFFICIENT", () => {
    const r = evaluateLabDetailed(series(80, M5, 100, 1), series(60, M15, 100, 2));
    expect(reason(r, "TREND_PULLBACK")).toBe("H1_HISTORY_INSUFFICIENT");
    expect(reason(r, "RANGE_REVERSAL")).toBe("H1_HISTORY_INSUFFICIENT");
  });

  it("ATR_EXPANSION BUY on a closed expansion bar beyond the 10-bar high, SELL mirror", () => {
    const base = series(79, M5, 100, 0.5);
    const buy = evaluateLabDetailed([...base, mk(79, M5, 100, 104.1, 99.9, 104)], series(60, M15, 100, 1));
    expect(fired(buy, "ATR_EXPANSION")[0]?.side).toBe("BUY");
    const sell = evaluateLabDetailed([...base, mk(79, M5, 100, 100.1, 95.9, 96)], series(60, M15, 100, 1));
    expect(fired(sell, "ATR_EXPANSION")[0]?.side).toBe("SELL");
    const none = evaluateLabDetailed([...base, mk(79, M5, 100, 100.3, 99.8, 100.2)], series(60, M15, 100, 1));
    expect(reason(none, "ATR_EXPANSION")).toBe("NO_ATR_EXPANSION");
  });

  it("RANGE_REVERSAL rejects mid-range and never fires there", () => {
    const h1 = series(80, H1, 100, 3);
    const r = evaluateLabDetailed(shift(series(80, M5, 100, 0.5), AFTER_H1), shift(series(60, M15, 100, 1), AFTER_H1), h1);
    expect(fired(r, "RANGE_REVERSAL")).toHaveLength(0);
    expect(reason(r, "RANGE_REVERSAL")).toBe("MID_RANGE");
  });

  it("only uses CLOSED inputs: H1 bars closing after the M5 bar are ignored by range", () => {
    const m5 = shift(series(80, M5, 100, 0.5), AFTER_H1), m15 = shift(series(60, M15, 100, 1), AFTER_H1);
    const future = Array.from({ length: 30 }, (_, i) => mk(1000 + i, H1, 500, 600, 400, 500));
    const a = evaluateLabDetailed(m5, m15, series(80, H1, 100, 3));
    const b = evaluateLabDetailed(m5, m15, [...series(80, H1, 100, 3), ...future]);
    expect(reason(a, "RANGE_REVERSAL")).toBe("MID_RANGE");
    expect(reason(b, "RANGE_REVERSAL")).toBe("MID_RANGE");
  });

  it("every signal has a positive finite SL distance", () => {
    const r = evaluateLabDetailed([...series(79, M5, 100, 0.5), mk(79, M5, 100, 104.1, 99.9, 104)], series(60, M15, 100, 1), series(80, H1, 100, 3, 0.2));
    for (const s of r.signals) expect(s.sl_distance > 0 && Number.isFinite(s.sl_distance)).toBe(true);
  });
});

describe("ledgers for modes 6–10", () => {
  it("book has 22 ledgers at $50; upgrading an old 10-ledger book adds 10 without touching existing", () => {
    const fresh = createBook(1);
    expect(bookStats(fresh)).toHaveLength(22);
    const oldLedgers = Object.fromEntries(Object.entries(fresh.ledgers).filter(([, l]) => !(LAB_NEW_STRATEGIES as readonly string[]).includes(l.strategy)));
    const old = { ...fresh, ledgers: oldLedgers };
    const traded = bookOpen(old, "BTCUSD", [{ strategy: "TOUCH_SNR", side: "BUY", why: "t", sl_distance: 200, bar_time: 1 }], { bid: 1000, ask: 1000 }, 2);
    const up = upgradeBook(traded, 5);
    expect(bookStats(up)).toHaveLength(22);
    expect(up.ledgers["TOUCH_SNR:COPET"]!.state).toBe(traded.ledgers["TOUCH_SNR:COPET"]!.state);
    expect(up.ledgers["ATR_EXPANSION:COPET"]!.start_balance).toBe(50);
  });

  it("Mode 1 gets one labelled $50 top-up (capital $100), history kept, never applied twice", () => {
    const up = upgradeBook(upgradeBook(createBook(1), 5), 9);
    const s = bookStats(up).find((x) => x.key === "TOUCH_SNR:COPET")!;
    expect(s.capitalIn).toBe(100);
    expect(s.balance).toBe(100);
    expect(s.topups).toHaveLength(1);
    expect(bookStats(up).find((x) => x.key === "DUAL_WALL:COPET")!.capitalIn).toBe(50);
  });

  it("a mode-10 signal opens only mode-10 ledgers; duplicate bar ignored; COPET trails while NORMAL stays open", () => {
    const s = { strategy: "ATR_EXPANSION" as const, side: "BUY" as const, why: "t", sl_distance: 200, bar_time: 9 };
    let b = bookOpen(createBook(1), "BTCUSD", [s], { bid: 1000, ask: 1000 }, 2);
    b = bookOpen(b, "BTCUSD", [s], { bid: 1000, ask: 1000 }, 3);
    expect(bookStats(b).filter((x) => x.open > 0).map((x) => x.key).sort()).toEqual(["ATR_EXPANSION:COPET", "ATR_EXPANSION:NORMAL"]);
    b = bookMark(b, "BTCUSD", { bid: 1080, ask: 1080 }, 4);
    b = bookMark(b, "BTCUSD", { bid: 1060, ask: 1060 }, 5);
    const st = bookStats(b);
    expect(st.find((x) => x.key === "ATR_EXPANSION:COPET")!.exits.TRAIL).toBe(1);
    expect(st.find((x) => x.key === "ATR_EXPANSION:NORMAL")!.open).toBe(1);
    expect(st.find((x) => x.key === "TREND_PULLBACK:COPET")!.balance).toBe(50);
  });

  it("strategy and ledger code never reach a broker order path", () => {
    for (const f of ["src/core/lab/strategies.ts", "src/core/lab/isolatedLedgers.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/sendOrder|order_send|fetch\(|from "[^"]*(gateway|execution|bridge)/);
    }
  });
});
