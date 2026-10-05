import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PaperJournalStore, markPaper, openPaper, type KV } from "@/lib/paperJournal";
import { aiSummaryPayload, compactSummary } from "@/lib/tradeSummary";
import { resolveTrade, runQuickBacktest, visibleAt } from "@/core/technical/backtest";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import type { TechBar } from "@/core/technical/indicators";
import type { TradingSnapshot } from "@/core/technical/tradingState";
import * as tech from "@/core/technical/tradingState";

const snap = (entry: TradingSnapshot["entry"]["state"], plan?: { side: "BUY" | "SELL"; sl: number; tp1: number; tp2: number }): TradingSnapshot => ({
  symbol: "XAUUSD", as_of: 1, label: "CURRENT", availability: "AVAILABLE", availability_reason: "OBSERVED",
  quote: { bid: 100, ask: 101, spread: 1, tick_time_ms: 1, observed_at: 1 }, evidence: null, last3_m5: [], engulfing: null,
  bias: { state: "NEUTRAL", reason: "T" }, setup: { state: "INACTIVE", reason: "T" },
  signal: { state: "WAITING", reason: "T", triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" },
  execution: { state: "BLOCKED", reasons: ["CAPABILITY_UNAUTHORIZED"] }, entry: { state: entry, reason: "T" },
  why: Array.from({ length: 30 }, (_, i) => ({ ok: null, text: `fact ${i} ${"x".repeat(2000)}` })),
  reference_plan: plan ? { status: "AVAILABLE", policy_version: tech.REFERENCE_PLAN_POLICY_VERSION, side: plan.side, entry: 101, anchor_kind: "CONFIRMED_H1_SWING_LOW", anchor_price: 99, atr14_m15: 4, atr_buffer: 1, risk: 3, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2, rr_tp1: 1, rr_tp2: 2, structural: { invalidation_zone: null, structural_sl: null, target_zone: null, structural_target: null, rr_structural: null } } as TradingSnapshot["reference_plan"]
    : { status: "NOT_AVAILABLE", policy_version: tech.REFERENCE_PLAN_POLICY_VERSION, reason: "T" },
  versions: { technical_engine_version: "t", setup_policy_version: "t", signal_policy_version: "t", reference_plan_policy_version: "t", guard_policy_version: "t" },
});

const memKV = (): KV & { data: Map<string, string> } => { const data = new Map<string, string>(); return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } }; };

describe("paper trading (SIMULATION only)", () => {
  it("BUY fills at ASK, SELL at BID, records engine signal and manual flag", () => {
    const b = openPaper({ symbol: "XAUUSD", side: "BUY", quote: { bid: 100, ask: 101 }, now: 1, snapshot: snap("WAIT"), id: "a" });
    const s = openPaper({ symbol: "XAUUSD", side: "SELL", quote: { bid: 100, ask: 101 }, now: 1, snapshot: snap("WAIT"), id: "b" });
    expect(b.entry).toBe(101); expect(s.entry).toBe(100);
    expect(b.engine_signal).toBe("HOLD"); expect(b.manual_against_engine).toBe(true); expect(b.mode).toBe("SIMULATION");
    expect(b.sl).toBeNull();
  });
  it("marks PnL from live quote and auto-closes at SL/TP2 as simulation", () => {
    const p = openPaper({ symbol: "XAUUSD", side: "BUY", quote: { bid: 100, ask: 101 }, now: 1, snapshot: snap("LONG_CANDIDATE", { side: "BUY", sl: 98, tp1: 104, tp2: 107 }), id: "a" });
    expect(p.manual_against_engine).toBe(false);
    const m = markPaper(p, { bid: 103, ask: 104 }, 2);
    expect(m.status).toBe("OPEN"); expect(m.pnl).toBe(2); expect(m.r_multiple).toBeCloseTo(2 / 3);
    const tp = markPaper(m, { bid: 107.5, ask: 108 }, 3);
    expect(tp.status).toBe("CLOSED"); expect(tp.exit_reason).toBe("TP2"); expect(tp.mode).toBe("SIMULATION");
    const sl = markPaper(p, { bid: 97.9, ask: 98.5 }, 3);
    expect(sl.exit_reason).toBe("SL"); expect(sl.r_multiple).toBeCloseTo(-3.1 / 3);
  });
  it("ignores a plan on the opposite side", () => {
    const p = openPaper({ symbol: "XAUUSD", side: "SELL", quote: { bid: 100, ask: 101 }, now: 1, snapshot: snap("LONG_CANDIDATE", { side: "BUY", sl: 98, tp1: 104, tp2: 107 }), id: "a" });
    expect(p.sl).toBeNull(); expect(p.manual_against_engine).toBe(true);
  });
});

describe("journal", () => {
  it("persists compact events and survives reload", () => {
    const kv = memKV();
    const st = new PaperJournalStore(kv);
    st.open({ symbol: "XAUUSD", side: "BUY", quote: { bid: 100, ask: 101 }, now: 1, snapshot: snap("WAIT") });
    const reloaded = new PaperJournalStore(kv);
    expect(reloaded.getState().journal[0]!.type).toBe("TRADE_OPEN");
    expect(JSON.stringify(reloaded.getState().journal[0]).length).toBeLessThan(20_000);
    st.close(st.getState().positions[0]!.id, { bid: 102, ask: 103 }, 2);
    expect(new PaperJournalStore(kv).getState().journal[0]!.type).toBe("TRADE_CLOSE");
  });
  it("records signal transitions once, never per tick", () => {
    const st = new PaperJournalStore(null);
    for (let i = 0; i < 5; i++) st.recordSignal(snap("WAIT"), "XAUUSD", i);
    expect(st.getState().journal).toHaveLength(0);
    for (let i = 0; i < 5; i++) st.recordSignal(snap("LONG_CANDIDATE"), "XAUUSD", 10 + i);
    for (let i = 0; i < 5; i++) st.recordSignal(snap("WAIT"), "XAUUSD", 20 + i);
    const sig = st.getState().journal.filter((e) => e.type === "SIGNAL");
    expect(sig.map((e) => e.type === "SIGNAL" && `${e.from}>${e.to}`)).toEqual(["BUY>HOLD", "HOLD>BUY"]);
  });
  it("auto-close from mark is journaled", () => {
    const st = new PaperJournalStore(null);
    st.open({ symbol: "XAUUSD", side: "BUY", quote: { bid: 100, ask: 101 }, now: 1, snapshot: snap("LONG_CANDIDATE", { side: "BUY", sl: 98, tp1: 104, tp2: 107 }) });
    st.mark("XAUUSD", { bid: 97, ask: 98 }, 2);
    expect(st.getState().journal[0]!.type).toBe("TRADE_CLOSE");
  });
});

describe("AI payload", () => {
  it("stays under 10k even for a huge snapshot", () => {
    const s = snap("WAIT");
    expect(JSON.stringify(s).length).toBeGreaterThan(20_000);
    expect(aiSummaryPayload(s).length).toBeLessThan(10_000);
    expect(compactSummary(s).why.length).toBeLessThanOrEqual(8);
  });
});

const bar = (open_time: number, o: number, h: number, l: number, c: number, len = 300_000): TechBar => ({ open_time, close_time: open_time + len, available_at: open_time + len, open: o, high: h, low: l, close: c });

describe("quick backtest", () => {
  it("same-bar SL+TP is AMBIGUOUS, not a win", () => {
    expect(resolveTrade("BUY", 98, 107, [bar(0, 100, 108, 97, 100)]).outcome).toBe("AMBIGUOUS");
    expect(resolveTrade("SELL", 102, 95, [bar(0, 100, 101, 94, 96)]).outcome).toBe("WIN");
    expect(resolveTrade("BUY", 98, 107, [bar(0, 100, 101, 99, 100)]).outcome).toBe("OPEN_AT_END");
  });
  it("at step T only CLOSED bars available by T are visible (no forming/future bars)", () => {
    const h1 = Array.from({ length: 5 }, (_, i) => bar(i * 3_600_000, 100, 101, 99, 100, 3_600_000));
    const v = visibleAt(h1, 2 * 3_600_000 + 1_800_000); // mid third H1 bar
    expect(v.map((x) => x.open_time)).toEqual([0, 3_600_000]);
    expect(v.every((x) => x.close_time <= 2 * 3_600_000 + 1_800_000)).toBe(true);
  });
  it("does not use future bars (truncating the future does not change past decisions)", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => bar(i * 300_000, 100 + Math.sin(i / 3) * 5, 106 + Math.sin(i / 3) * 5, 94 + Math.sin(i / 3) * 5, 100 + Math.sin(i / 3 + 1) * 5));
    const full = runQuickBacktest({ M5: mk(120), M15: [], H1: [], H4: [] }, "X", { maxSteps: 120 });
    const part = runQuickBacktest({ M5: mk(60), M15: [], H1: [], H4: [] }, "X", { maxSteps: 120 });
    expect(part.evaluated + part.hold).toBeLessThanOrEqual(full.evaluated + full.hold);
    expect(full.disclaimer).toMatch(/spread\/slippage\/latency historis tidak dimodelkan/);
  });
});

describe("safety", () => {
  it("MONITOR_ONLY and no execution path in paper/journal/backtest code", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY"); expect(EXECUTION_ENABLED).toBe(false);
    for (const f of ["src/lib/paperJournal.ts", "src/core/technical/backtest.ts", "src/components/JournalPanel.tsx", "src/components/TechnicalSlicePanel.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/order_send|placeOrder|sendOrder|fetch\(|BrokerGatewayClient|WebSocket\(/);
    }
  });
});
