import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bookMark, bookOpen, bookStats, createBook, ledgerKey } from "@/core/lab/isolatedLedgers";
import type { LabSignal } from "@/core/lab/strategies";

const sig = (strategy: LabSignal["strategy"], side: LabSignal["side"], bar = 1, sl = 200): LabSignal => ({ strategy, side, why: "t", sl_distance: sl, bar_time: bar });
const q = (p: number) => ({ bid: p, ask: p });
const get = (b: ReturnType<typeof createBook>, k: string) => bookStats(b).find((s) => s.key === k)!;

describe("isolated lab ledgers", () => {
  it("creates 24 ledgers at $50 each", () => {
    const s = bookStats(createBook(1));
    expect(s.length).toBe(24);
    expect(s.every((x) => x.balance === 50 && x.equity === 50)).toBe(true);
  });
  it("signal opens only in its strategy's NORMAL and COPET ledgers", () => {
    const b = bookOpen(createBook(1), "BTCUSD", [sig("TOUCH_SNR", "BUY")], q(1000), 2);
    expect(get(b, ledgerKey("TOUCH_SNR", "NORMAL")).open).toBe(1);
    expect(get(b, ledgerKey("TOUCH_SNR", "COPET")).open).toBe(1);
    expect(bookStats(b).filter((s) => s.open > 0).length).toBe(2);
  });
  it("dedup per ledger is kept", () => {
    let b = bookOpen(createBook(1), "BTCUSD", [sig("TOUCH_SNR", "BUY")], q(1000), 2);
    b = bookOpen(b, "BTCUSD", [sig("TOUCH_SNR", "BUY")], q(1000), 3);
    expect(get(b, "TOUCH_SNR:COPET").open).toBe(1);
  });
  it("same price closes COPET at TP +$5 while NORMAL stays open; open not counted as win", () => {
    let b = bookOpen(createBook(1), "BTCUSD", [sig("TOUCH_SNR", "BUY")], q(1000), 2);
    b = bookMark(b, "BTCUSD", q(1100), 3);
    const c = get(b, "TOUCH_SNR:COPET"), n = get(b, "TOUCH_SNR:NORMAL");
    expect(c.exits.TP).toBe(1); expect(c.balance).toBeCloseTo(55); expect(c.wins).toBe(1);
    expect(n.closed).toBe(0); expect(n.wins).toBe(0); expect(n.balance).toBe(50); expect(n.floating).toBeCloseTo(5);
    expect(get(b, "EMA_CROSS:COPET").balance).toBe(50);
  });
  it("COPET trailing closes at peak − $1", () => {
    let b = bookOpen(createBook(1), "BTCUSD", [sig("SNR_PA", "BUY")], q(1000), 2);
    b = bookMark(b, "BTCUSD", q(1080), 3); // +$4
    b = bookMark(b, "BTCUSD", q(1060), 4); // +$3 ⇒ trail
    expect(get(b, "SNR_PA:COPET").exits.TRAIL).toBe(1);
    expect(get(b, "SNR_PA:COPET").realized).toBeCloseTo(3);
  });
  it("negative balance is recorded, drawdown tracked, no reset", () => {
    let b = createBook(1);
    for (let i = 0; i < 11; i++) { b = bookOpen(b, "BTCUSD", [sig("EMA_CROSS", "BUY", i)], q(1000), 10 + i); b = bookMark(b, "BTCUSD", q(900), 11 + i); b = bookMark(b, "BTCUSD", q(1000), 12 + i); }
    const c = get(b, "EMA_CROSS:COPET");
    expect(c.balance).toBeCloseTo(-5); expect(c.depletedAt).not.toBeNull(); expect(c.maxDrawdown).toBeCloseTo(55);
  });
  it("ledger module has no broker/execution import", () => {
    const src = readFileSync("src/core/lab/isolatedLedgers.ts", "utf8");
    expect(/gateway|execution|sendOrder|broker\//i.test(src.replace(/\/\/.*$/gm, ""))).toBe(false);
  });
});
