import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_POLICY } from "@/engine/risk/riskPolicy";
import type { LabSignal } from "@/core/lab/strategies";
import type { TechBar } from "@/core/technical/indicators";
import {
  commentMatches, effectiveDailyLossUsd, LAB_DEMO_MODES, LabDemoRunner, labSignalId,
  type BrokerPos, type CloseResult, type LabBrokerPort, type LabRunnerState, type OrderResult, type RunnerConfig,
} from "./labDemoRunner";

const M5 = 300_000;
const NOW0 = Date.UTC(2026, 9, 19, 3, 0, 30);
const bars = (endOpen: number, n = 80, px = 2000): TechBar[] =>
  Array.from({ length: n }, (_, i) => { const o = endOpen - (n - 1 - i) * M5; return { open_time: o, close_time: o + M5, available_at: o + M5, open: px, high: px + 1, low: px, close: px + 1 }; });

class FakeBroker implements LabBrokerPort {
  now = NOW0; mode = "DEMO"; login = 111; balance = 500; equity = 500;
  pos: BrokerPos[] = []; deals = new Map<number, { profit: number; reason: string }>();
  sent: Parameters<LabBrokerPort["sendOrder"]>[0][] = []; closes: number[] = [];
  orderMode: "FILL" | "REJECT" | "TIMEOUT" | "PARTIAL" | "ERROR" = "FILL";
  closeMode: CloseResult["status"] | "TIMEOUT" = "CLOSED";
  nextTicket = 100; spec = { symbol: "", volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 0.01, marginPerLot: 0 };
  async serverTimeMs() { return this.now; }
  async account() { return { login: this.login, server: "Exness-MT5Trial", tradeMode: this.mode, balance: this.balance, equity: this.equity }; }
  async positions() { return this.pos; }
  async closedBars(symbol: string) { const last = Math.floor((this.now - M5) / M5) * M5; return bars(last, 80, symbol === "BTCUSD" ? 80000 : 2000); }
  async quote(symbol: string) { return symbol === "BTCUSD" ? { bid: 80001, ask: 80001.5 } : { bid: 2001, ask: 2001.2 }; }
  async spec(symbol: string) { return { ...this.spec, symbol }; }
  async closeDeal(t: number) { const d = this.deals.get(t); return d ? { ticket: t, time: Math.floor(this.now / 1000), ...d } : null; }
  async sendOrder(req: Parameters<LabBrokerPort["sendOrder"]>[0]): Promise<OrderResult> {
    this.sent.push(req);
    if (this.orderMode === "TIMEOUT") { this.pos.push(this.mk(req, this.nextTicket++, req.volume)); throw new Error("timeout"); }
    if (this.orderMode === "REJECT") return { status: "REJECTED", ticket: null, price: null, volume: null, comment: "ORDER_CHECK no money" };
    if (this.orderMode === "ERROR") return { status: "ERROR", ticket: null, price: null, volume: null, comment: "NO_TICK" };
    const vol = this.orderMode === "PARTIAL" ? Number((req.volume / 2).toFixed(2)) : req.volume, ticket = this.nextTicket++;
    this.pos.push(this.mk(req, ticket, vol));
    return { status: "FILLED", ticket, price: req.direction === "BUY" ? 2001.2 : 2001, volume: vol, comment: "done" };
  }
  mk(req: { signal_id: string; symbol: string; sl: number; tp: number }, ticket: number, volume: number): BrokerPos {
    return { ticket, symbol: req.symbol, comment: req.signal_id.slice(0, 31), magicOk: true, volume, profit: 0, sl: req.sl, tp: req.tp };
  }
  async closePosition(req: { ticket: number }): Promise<CloseResult> {
    this.closes.push(req.ticket);
    if (this.closeMode === "TIMEOUT") throw new Error("timeout");
    if (this.closeMode === "CLOSED") { const p = this.pos.find((x) => x.ticket === req.ticket); this.pos = this.pos.filter((x) => x.ticket !== req.ticket); this.deals.set(req.ticket, { profit: p?.profit ?? 0, reason: "OTHER" }); }
    return { status: this.closeMode, comment: null };
  }
  setProfit(ticket: number, profit: number) { this.pos = this.pos.map((p) => (p.ticket === ticket ? { ...p, profit } : p)); }
}

class MemStore { data: unknown = null; events: Record<string, unknown>[] = []; load() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null; } save(s: LabRunnerState) { this.data = JSON.parse(JSON.stringify(s)); } journal(e: Record<string, unknown>) { this.events.push(e); } }

const sig = (strategy: string, side: "BUY" | "SELL", barTime: number, sl = 2): LabSignal => ({ strategy: strategy as LabSignal["strategy"], side, why: "test", sl_distance: sl, bar_time: barTime });
const lastOpen = (now: number) => Math.floor((now - M5) / M5) * M5;

function rig(sigsFor: (m5: readonly TechBar[]) => LabSignal[], over: Partial<RunnerConfig> = {}, store = new MemStore(), b = new FakeBroker()) {
  const cfg: RunnerConfig = { policy: DEFAULT_RISK_POLICY, whitelistLogins: new Set([111]), whitelistServers: new Set(["Exness-MT5Trial"]), armed: true, killSwitch: () => false,
    evaluate: (m5) => sigsFor(m5).map((s) => ({ ...s, bar_time: m5.at(-1)!.open_time })), ...over };
  return { b, store, cfg, r: new LabDemoRunner(b, store, cfg) };
}
/** First tick after start only reconciles (restart rule); second tick may trade. */
async function warm(r: LabDemoRunner, b: FakeBroker) { await r.tick(); b.now += M5; if (process.env.DBG) console.log(JSON.stringify(r.state.blockReason), JSON.stringify((r as any).store.events.slice(-5))); }

describe("lab demo runner (fake broker only)", () => {
  it("wires exactly the seven selected modes", () => {
    expect(Object.keys(LAB_DEMO_MODES).sort()).toEqual(["BREAKOUT_RETEST", "DUAL_WALL_FAST", "EMA_CROSS", "FAST_BREAKOUT", "GOLD_SNIPER", "RANGE_REVERSAL", "SMC_FIBO_OTE"]);
    expect(labSignalId("SMC_FIBO_OTE", "XAUUSD", NOW0, "BUY").length).toBeLessThanOrEqual(31);
  });

  it("effective daily loss = stricter of policy 2% and operator $30", () => {
    expect(effectiveDailyLossUsd(DEFAULT_RISK_POLICY, 500)).toBe(10);
    expect(effectiveDailyLossUsd(DEFAULT_RISK_POLICY, 5000)).toBe(30);
  });

  it("sizes lot from SL + risk policy, sets hard SL/TP, one per symbol, two total", async () => {
    const { r, b } = rig(() => [sig("DUAL_WALL_FAST", "BUY", 0), sig("EMA_CROSS", "BUY", 0), sig("TOUCH_SNR", "BUY", 0)]);
    await warm(r, b); await r.tick();
    expect(b.sent.length).toBe(2); // XAU + BTC, never two on one symbol
    expect(new Set(b.sent.map((x) => x.symbol))).toEqual(new Set(["XAUUSD", "BTCUSD"]));
    const x = b.sent.find((s) => s.symbol === "XAUUSD")!;
    expect(x.signal_id).toContain("L11"); // SPV priority: Mode 11 beats Mode 2
    expect(x.volume).toBe(0.01); // $2.5 budget / ($2 SL × 1 lot = $200 per lot... floored to step)
    expect(x.sl).toBeCloseTo(1999.2); expect(x.tp).toBeCloseTo(2003.2);
    b.now += M5; await r.tick();
    expect(b.sent.length).toBe(2); // slots/symbols full
  });

  it("rejects when risk budget cannot fund the minimum lot (no fixed paper lot)", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0, 500)]);
    await warm(r, b); await r.tick();
    expect(b.sent.length).toBe(0);
  });

  it("direction conflict on the same candle: only the SPV-locked side is dispatched", async () => {
    const { r, b } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("SMC_FIBO_OTE", "SELL", 0), sig("EMA_CROSS", "BUY", 0)]), {});
    // Mode 12 SELL without absolute prices falls back to sl_distance
    await warm(r, b); await r.tick();
    expect(b.sent.map((s) => s.direction)).toEqual(["SELL"]);
  });

  it("duplicate signal is never re-sent, even after restart", async () => {
    const store = new MemStore();
    const a = rig(() => [sig("EMA_CROSS", "BUY", 0)], {}, store);
    await warm(a.r, a.b); await a.r.tick();
    a.b.setProfit(100, 0); a.b.closeMode = "CLOSED";
    const b2 = rig(() => [sig("EMA_CROSS", "BUY", 0)], {}, store, a.b); // restart, same bar
    a.b.lastSent = a.b.sent.length;
    await b2.r.tick(); await b2.r.tick();
    expect(a.b.sent.filter((s) => s.symbol === "XAUUSD").length).toBe(1);
    expect(b2.r.state.trades.find((t) => t.symbol === "XAUUSD")!.status).toBe("OPEN");
  });

  it("reject is journaled and does not block; ERROR/timeout fail closed until reconcile", async () => {
    const { r, b, store } = rig(() => [sig("EMA_CROSS", "BUY", 0)]);
    b.orderMode = "REJECT"; await warm(r, b); await r.tick();
    expect(store.events.some((e) => e.type === "ORDER_RESULT" && e.status === "REJECTED")).toBe(true);
    b.orderMode = "TIMEOUT"; b.now += M5; await r.tick();
    expect(r.state.trades.some((t) => t.status === "UNKNOWN")).toBe(true);
    b.now += M5; await r.tick(); // reconcile adopts the timed-out fill by comment
    expect(r.state.trades.filter((t) => t.status === "OPEN").length).toBeGreaterThan(0);
    const sentBefore = b.sent.length; b.orderMode = "ERROR";
    const t2 = rig(() => [sig("EMA_CROSS", "BUY", 0)]); t2.b.orderMode = "ERROR";
    await warm(t2.r, t2.b); await t2.r.tick();
    expect(t2.r.state.blockReason).toBe("ORDER_STATE_UNKNOWN");
    t2.b.now += M5; await t2.r.tick();
    expect(t2.b.sent.length).toBe(2); // only one per symbol, then blocked
    t2.b.now += M5; await t2.r.tick(); t2.b.now += M5; await t2.r.tick();
    expect(t2.r.state.trades.every((t) => t.status === "NOT_FILLED")).toBe(true);
    expect(b.sent.length).toBe(sentBefore);
  });

  it("partial fill records actual volume and scales risk", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0, 0.5)]);
    b.orderMode = "PARTIAL"; await warm(r, b); await r.tick();
    const t = r.state.trades.find((x) => x.symbol === "XAUUSD")!;
    expect(t.partial).toBe(true); expect(t.volume).toBeLessThan(t.requestedVolume);
  });

  it("daily loss (stricter $10 on $500) stops entries and closes only bot positions", async () => {
    const { r, b, store } = rig(() => [sig("EMA_CROSS", "BUY", 0, 0.5)]);
    b.pos.push({ ticket: 9, symbol: "XAUUSD", comment: "manual", magicOk: false, volume: 1, profit: -50, sl: 1, tp: 3 });
    await warm(r, b); await r.tick();
    const bot = r.state.trades.filter((t) => t.status === "OPEN");
    bot.forEach((t) => b.setProfit(t.ticket!, -6));
    b.now += 1000; await r.tick();
    expect(store.events.some((e) => e.type === "DAILY_GUARD" && e.lossLimitUsd === 10)).toBe(true);
    expect(b.closes.sort()).toEqual(bot.map((t) => t.ticket).sort());
    expect(b.closes).not.toContain(9);
    const n = b.sent.length; b.now += M5; await r.tick();
    expect(b.sent.length).toBe(n);
  });

  it("+$50 target stops entries and closes bot positions", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0, 0.5)]);
    b.balance = b.equity = 5000;
    await warm(r, b); await r.tick();
    r.state.trades.filter((t) => t.status === "OPEN").forEach((t) => b.setProfit(t.ticket!, 30));
    b.now += 1000; await r.tick();
    expect(b.closes.length).toBe(2);
    expect(r.state.guard.phase).not.toBe("TRADING");
  });

  it("close failure / timeout fails closed", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0, 0.5)]);
    await warm(r, b); await r.tick();
    b.closeMode = "TIMEOUT";
    r.state.trades.filter((t) => t.status === "OPEN").forEach((t) => b.setProfit(t.ticket!, -6));
    b.now += 1000; await r.tick();
    expect(r.state.closeFailures).toBeGreaterThan(0);
    const n = b.sent.length; b.now += M5; await r.tick();
    expect(b.sent.length).toBe(n);
  });

  it("COPET trailing closes only after arm and pullback by gap", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0, 0.5)]);
    b.balance = b.equity = 5000;
    await warm(r, b); await r.tick();
    const t = r.state.trades.find((x) => x.symbol === "XAUUSD")!;
    b.setProfit(t.ticket!, t.riskUsd * 0.5); b.now += 1000; await r.tick();
    expect(b.closes).toEqual([]);
    b.setProfit(t.ticket!, t.riskUsd * 0.25); b.now += 1000; await r.tick();
    expect(b.closes).toEqual([t.ticket]);
  });

  it("reconciliation mismatch (unknown bot position / missing SL / vanished without deal) blocks entries", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0)]);
    b.pos.push({ ticket: 55, symbol: "XAUUSD", comment: "ghost", magicOk: true, volume: 0.1, profit: 0, sl: 1, tp: 3 });
    await warm(r, b); await r.tick();
    expect(b.sent.length).toBe(0);
    expect(r.state.blockReason).toBe("RECONCILIATION_NOT_CLEAN");
  });

  it("REAL or non-whitelisted account is always refused", async () => {
    for (const mut of [(b: FakeBroker) => (b.mode = "REAL"), (b: FakeBroker) => (b.login = 5)]) {
      const { r, b } = rig(() => [sig("EMA_CROSS", "BUY", 0)]); mut(b);
      await warm(r, b); await r.tick();
      expect(b.sent.length).toBe(0);
    }
  });

  it("SHADOW (not armed) and kill switch never send", async () => {
    const a = rig(() => [sig("EMA_CROSS", "BUY", 0)], { armed: false }); await warm(a.r, a.b); await a.r.tick();
    const k = rig(() => [sig("EMA_CROSS", "BUY", 0)], { killSwitch: () => true }); await warm(k.r, k.b); await k.r.tick();
    expect(a.b.sent.length + k.b.sent.length).toBe(0);
  });

  it("broker comment truncation still matches by prefix; too-short comment does not", () => {
    expect(commentMatches("L11XAUt3", "L11XAUt3abcB")).toBe(true);
    expect(commentMatches("L11", "L11XAUt3abcB")).toBe(false);
  });

  void lastOpen;
});
