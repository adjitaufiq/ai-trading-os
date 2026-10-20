import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LabSignal } from "../strategies";
import type { TechBar } from "../../technical/indicators";
import {
  commentMatches, LAB_DEMO_MODES, LabDemoRunner, labSignalId, volumeValid,
  type BrokerPos, type CloseResult, type LabBrokerPort, type LabRunnerState, type OrderResult, type RunnerConfig,
} from "./labDemoRunner";
import { LAB_MAGIC, LAB_RISK_POLICY_FILE_CONTENT, parseLabRiskPolicy, type LabRiskPolicy } from "./labRiskPolicy";
import { budgetAllows, computeDayPnl, nextPhase } from "./labPortfolioGuard";
import { parseGatewayBars } from "./gatewayParse";

const M5 = 300_000;
const NOW0 = Date.UTC(2026, 9, 19, 3, 0, 30);
const POLICY = (over: Partial<LabRiskPolicy> = {}): LabRiskPolicy => ({ ...(JSON.parse(JSON.stringify(LAB_RISK_POLICY_FILE_CONTENT)) as LabRiskPolicy), ...over });
const bars = (endOpen: number, n = 80, px = 2000): TechBar[] =>
  Array.from({ length: n }, (_, i) => { const o = endOpen - (n - 1 - i) * M5; return { open_time: o, close_time: o + M5, available_at: o + M5, open: px, high: px + 1, low: px, close: px + 1 }; });
const SPEC = { XAUUSD: { tickSize: 0.01, tickValue: 1 }, BTCUSD: { tickSize: 0.01, tickValue: 0.01 } } as const;

class FakeBroker implements LabBrokerPort {
  now = NOW0; mode = "DEMO"; login = 111;
  pos: BrokerPos[] = []; deals = new Map<number, { profit: number; reason: string }>();
  sent: Parameters<LabBrokerPort["sendOrder"]>[0][] = []; closes: number[] = [];
  orderMode: "FILL" | "REJECT" | "TIMEOUT" | "PARTIAL" | "ERROR" = "FILL";
  closeMode: "CLOSED" | "TIMEOUT" | "TIMEOUT_BUT_CLOSED" | "REJECTED" = "CLOSED";
  nextTicket = 100; specOver: Partial<{ tickValue: number; volumeStep: number }> = {};
  async serverTimeMs() { return this.now; }
  async account() { return { login: this.login, server: "Exness-MT5Trial", tradeMode: this.mode, balance: 500, equity: 500 }; }
  async positions() { return this.pos; }
  async closedBars(symbol: string) { const last = Math.floor((this.now - M5) / M5) * M5; return bars(last, 80, symbol === "BTCUSD" ? 80000 : 2000); }
  async quote(symbol: string) { return symbol === "BTCUSD" ? { bid: 80001, ask: 80001.5 } : { bid: 2001, ask: 2001.2 }; }
  async spec(symbol: string) { const s = SPEC[symbol as keyof typeof SPEC]; return { symbol, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, marginPerLot: 0, ...s, ...this.specOver }; }
  async closeDeal(t: number) { const d = this.deals.get(t); return d ? { ticket: t, time: Math.floor(this.now / 1000), volume: null, commission: -0.1, swap: 0, ...d } : null; }
  async sendOrder(req: Parameters<LabBrokerPort["sendOrder"]>[0]): Promise<OrderResult> {
    this.sent.push(req);
    if (this.orderMode === "TIMEOUT") { this.pos.push(this.mk(req, this.nextTicket++, req.volume)); throw new Error("timeout"); }
    if (this.orderMode === "REJECT") return { status: "REJECTED", ticket: null, price: null, volume: null, comment: "ORDER_CHECK no money" };
    if (this.orderMode === "ERROR") return { status: "ERROR", ticket: null, price: null, volume: null, comment: "NO_TICK" };
    const vol = this.orderMode === "PARTIAL" ? Number((req.volume / 2).toFixed(2)) : req.volume, ticket = this.nextTicket++;
    this.pos.push(this.mk(req, ticket, vol));
    return { status: "FILLED", ticket, price: (await this.quote(req.symbol))[req.direction === "BUY" ? "ask" : "bid"], volume: vol, comment: "done" };
  }
  mk(req: { signal_id: string; symbol: string; sl: number; tp: number; direction: "BUY" | "SELL"; magic: number }, ticket: number, volume: number): BrokerPos {
    const q = req.symbol === "BTCUSD" ? { bid: 80001, ask: 80001.5 } : { bid: 2001, ask: 2001.2 };
    return { ticket, symbol: req.symbol, comment: req.signal_id.slice(0, 31), magic: req.magic, side: req.direction, volume, priceOpen: req.direction === "BUY" ? q.ask : q.bid, profit: 0, swap: 0, sl: req.sl, tp: req.tp };
  }
  async closePosition(req: { ticket: number }): Promise<CloseResult> {
    this.closes.push(req.ticket);
    const gone = () => { const p = this.pos.find((x) => x.ticket === req.ticket); this.pos = this.pos.filter((x) => x.ticket !== req.ticket); this.deals.set(req.ticket, { profit: p?.profit ?? 0, reason: "EXPERT" }); };
    if (this.closeMode === "TIMEOUT") throw new Error("timeout");
    if (this.closeMode === "TIMEOUT_BUT_CLOSED") { gone(); throw new Error("timeout"); }
    if (this.closeMode === "REJECTED") return { status: "REJECTED", comment: "market closed" };
    gone(); return { status: "CLOSED", comment: null };
  }
  setProfit(ticket: number, profit: number) { this.pos = this.pos.map((p) => (p.ticket === ticket ? { ...p, profit } : p)); }
  manualClose(ticket: number, profit: number, withDeal = true) { this.pos = this.pos.filter((p) => p.ticket !== ticket); if (withDeal) this.deals.set(ticket, { profit, reason: "MANUAL" }); }
}

class MemStore { data: unknown = null; events: Record<string, unknown>[] = []; load() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null; } save(s: LabRunnerState) { this.data = JSON.parse(JSON.stringify(s)); } journal(e: Record<string, unknown>) { this.events.push(e); } }

const sig = (strategy: string, side: "BUY" | "SELL", extra: Partial<LabSignal> = {}): LabSignal => ({ strategy: strategy as LabSignal["strategy"], side, why: "test", sl_distance: 2, bar_time: 0, ...extra });
const SIX = ["DUAL_WALL_FAST", "GOLD_SNIPER", "FAST_BREAKOUT", "RANGE_REVERSAL", "BREAKOUT_RETEST", "EMA_CROSS"];
const fiboFor = (m5: readonly TechBar[], side: "BUY" | "SELL" = "BUY") => { const btc = m5[0]!.open > 10000; const px = btc ? 80001.5 : 2001.2; const d = btc ? 400 : 5; return { sl_price: side === "BUY" ? px - d : px + d, tp_price: side === "BUY" ? px + 2 * d : px - 2 * d }; };

function rig(sigsFor: (m5: readonly TechBar[]) => LabSignal[], over: Partial<RunnerConfig> = {}, store = new MemStore(), b = new FakeBroker()) {
  const cfg: RunnerConfig = { policy: POLICY(), whitelistLogins: new Set([111]), whitelistServers: new Set(["Exness-MT5Trial"]), armed: true, killSwitch: () => false,
    evaluate: (m5) => sigsFor(m5).map((s) => ({ ...s, bar_time: m5.at(-1)!.open_time })), ...over };
  return { b, store, cfg, r: new LabDemoRunner(b, store, cfg) };
}
/** First tick after start only reconciles (restart rule); next bar may trade. */
async function warm(r: LabDemoRunner, b: FakeBroker) { await r.tick(); b.now += M5; }
const ev = (s: MemStore, type: string) => s.events.filter((e) => e["type"] === type);

describe("lab risk policy (single source, fail-closed)", () => {
  it("shipped JSON parses and equals the approved values", () => {
    const r = parseLabRiskPolicy(readFileSync(join(process.cwd(), "engine-host/lab-risk-policy.json"), "utf8"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([r.policy.daily_target_usd, r.policy.daily_stop_usd, r.policy.max_active_positions_total, r.policy.max_active_positions_per_mode, r.policy.magic]).toEqual([50, 30, 6, 1, 610007]);
      expect(r.policy.copet.XAUUSD).toEqual({ lot: 0.02, contract_size_assumed: 100, sl_usd: 10, tp_usd: 10, trail_arm_usd: 3, trail_gap_usd: 1 });
      expect(r.policy.copet.BTCUSD).toEqual({ lot: 0.05, contract_size_assumed: 1, sl_usd: 10, tp_usd: 10, trail_arm_usd: 3, trail_gap_usd: 1 });
    }
  });
  it("missing / bad json / extra key / wrong magic are refused", () => {
    const good = JSON.stringify(LAB_RISK_POLICY_FILE_CONTENT);
    expect(parseLabRiskPolicy(null)).toEqual({ ok: false, error: "LAB_RISK_POLICY_MISSING" });
    expect(parseLabRiskPolicy("{").ok).toBe(false);
    expect(parseLabRiskPolicy(JSON.stringify({ ...LAB_RISK_POLICY_FILE_CONTENT, risk_per_trade: 0.005 })).ok).toBe(false);
    expect(parseLabRiskPolicy(JSON.stringify({ ...LAB_RISK_POLICY_FILE_CONTENT, magic: 610006 })).ok).toBe(false);
    expect(parseLabRiskPolicy(good).ok).toBe(true);
  });
  it("runner refuses a non-Lab magic", () => {
    expect(() => rig(() => [], { policy: { ...POLICY(), magic: 610006 as typeof LAB_MAGIC } })).toThrow("LAB_MAGIC_REQUIRED");
  });
});

describe("portfolio guard (signed, baseline)", () => {
  const spec = { XAUUSD: { tickSize: 0.01, tickValue: 1 } };
  const open = (dayBaseUsd = 0) => ({ ticket: 1, symbol: "XAUUSD", side: "BUY" as const, volume: 0.02, dayBaseUsd, closedDay: null, pnlUsd: null, open: true });
  const pos = (profit: number) => ({ ticket: 1, priceOpen: 2000, sl: 1995, profit, swap: 0, volume: 0.02 });
  it("realized +20 with a −$10 hard SL position ⇒ worst-case +10 − friction (no abs())", () => {
    const d = computeDayPnl([{ ticket: 9, symbol: "XAUUSD", side: "BUY", volume: 0.02, dayBaseUsd: 0, closedDay: "2026-10-19", pnlUsd: 20, open: false }, open()], [pos(-3)], spec, "2026-10-19", 2);
    expect(d.realizedUsd).toBe(20); expect(d.dayPnlUsd).toBeCloseTo(17); expect(d.worstCaseUsd).toBeCloseTo(8);
  });
  it("realized −15, open −10 SL, candidate −10 ⇒ rejected; floating loss not double-counted", () => {
    const d = computeDayPnl([{ ticket: 9, symbol: "XAUUSD", side: "BUY", volume: 0.02, dayBaseUsd: 0, closedDay: "2026-10-19", pnlUsd: -15, open: false }, open()], [pos(-7)], spec, "2026-10-19", 0);
    expect(d.worstCaseUsd).toBeCloseTo(-25);
    expect(budgetAllows(d.worstCaseUsd, 10, 0, 30)).toEqual({ ok: false, projectedUsd: -35 });
    expect(budgetAllows(-15, 10, 2, 30).ok).toBe(true);
  });
  it("position crossing midnight: only today's move counts", () => {
    const d = computeDayPnl([open(-8)], [pos(-9)], spec, "2026-10-20", 2);
    expect(d.dayPnlUsd).toBeCloseTo(-1); expect(d.worstCaseUsd).toBeCloseTo(-4);
  });
  it("missing SL / spec ⇒ unmeasurable (null) ⇒ no entries", () => {
    expect(computeDayPnl([open()], [{ ...pos(0), sl: null }], spec, "d", 2).worstCaseUsd).toBeNull();
    expect(budgetAllows(null, 10, 2, 30).ok).toBe(false);
  });
  it("phases: target, stop, sticky desync, reset next day", () => {
    expect(nextPhase({ phase: "TRADING", day: "a" }, "a", 50, 50, 30)).toBe("TARGET_REACHED_HALT");
    expect(nextPhase({ phase: "TARGET_REACHED_HALT", day: "a" }, "a", -30, 50, 30)).toBe("PORTFOLIO_STOP_HIT");
    expect(nextPhase({ phase: "PORTFOLIO_STOP_HIT", day: "a" }, "b", 0, 50, 30)).toBe("TRADING");
    expect(nextPhase({ phase: "STATE_DESYNC_HALT", day: "a" }, "b", 0, 50, 30)).toBe("STATE_DESYNC_HALT");
  });
  it("target +$50 counts realized net only; floating profit does not halt entries", () => {
    expect(nextPhase({ phase: "TRADING", day: "a" }, "a", 60, 50, 30, 40)).toBe("TRADING");
    expect(nextPhase({ phase: "TRADING", day: "a" }, "a", 45, 50, 30, 50)).toBe("TARGET_REACHED_HALT");
    expect(nextPhase({ phase: "TRADING", day: "a" }, "a", -30, 50, 30, 10)).toBe("PORTFOLIO_STOP_HIT");
  });
});

describe("gateway contract", () => {
  it("parses the real MARKET_DATA.BARS envelope (data.items) recorded from vps/mt5_gateway", () => {
    const env = JSON.parse(readFileSync(join(process.cwd(), "src/core/lab/demo/__fixtures__/gateway-bars-m5.json"), "utf8"));
    expect(env.capability).toBe("MARKET_DATA.BARS");
    const b = parseGatewayBars(env, M5)!;
    expect(b.length).toBe(3);
    expect(b[1]!.open_time - b[0]!.open_time).toBe(M5);
    expect(b[0]!.close_time).toBe(b[0]!.open_time + M5);
    expect(parseGatewayBars({ data: { bars: [] } }, M5)).toBeNull();
    expect(parseGatewayBars({ data: { items: [{ raw_time_s: 1, open: "x" }] } }, M5)).toBeNull();
  });
});

describe("lab demo runner v2 (fake broker only)", () => {
  it("wires exactly the six selected modes (no Mode 12); GOLD_SNIPER is XAU-only", async () => {
    expect(Object.keys(LAB_DEMO_MODES).sort()).toEqual([...SIX].sort());
    expect(Object.keys(LAB_DEMO_MODES)).not.toContain("SMC_FIBO_OTE");
    expect(labSignalId("DUAL_WALL_FAST", "XAUUSD", NOW0, "BUY").length).toBeLessThanOrEqual(31);
    const { r, b, store } = rig(() => [sig("GOLD_SNIPER", "BUY")]);
    await warm(r, b); await r.tick();
    expect(b.sent.map((s) => s.symbol)).toEqual(["XAUUSD"]);
    expect(ev(store, "CANDIDATE_SUPPRESSED").some((e) => e["symbol"] === "BTCUSD" && e["reason"] === "INELIGIBLE_SYMBOL")).toBe(true);
  });

  it("COPET v2 nominal: fixed Lab lot, hard SL/TP at $10 XAU / $20 BTC, Lab magic", async () => {
    const { r, b } = rig((m5) => [sig(m5[0]!.open > 10000 ? "FAST_BREAKOUT" : "EMA_CROSS", "BUY")], { policy: POLICY({ daily_stop_usd: 1000 }) });
    await warm(r, b); await r.tick();
    const x = b.sent.find((s) => s.symbol === "XAUUSD")!, y = b.sent.find((s) => s.symbol === "BTCUSD")!;
    expect([x.volume, x.magic]).toEqual([0.02, LAB_MAGIC]);
    expect(x.sl).toBeCloseTo(2001.2 - 5); expect(x.tp).toBeCloseTo(2001.2 + 5);
    expect(y.volume).toBe(0.05); expect(y.sl).toBeCloseTo(80001.5 - 400); expect(y.tp).toBeCloseTo(80001.5 + 400);
    expect(b.sent.every((s) => s.sl > 0 && s.tp > 0)).toBe(true);
  });

  it("budget gate: −$30 stop admits only what worst-case allows (XAU $10 + $2 friction each)", async () => {
    const { r, b, store } = rig((m5) => (m5[0]!.open > 10000 ? [] : SIX.map((s) => sig(s, "BUY"))));
    await warm(r, b); await r.tick();
    expect(b.sent.length).toBe(2); // −12, −24; third would be −36
    expect(b.sent.map((s) => s.signal_id.slice(0, 3))).toEqual(["L11", "L13"]); // SPV rank order
    const rej = ev(store, "ENTRY_REJECTED");
    expect(rej.length).toBeGreaterThanOrEqual(4);
    expect(rej.every((e) => e["reason"] === "REJECTED_BUDGET_EXCEEDED")).toBe(true);
  });

  it("6 is a cap, not a target; one position per mode; every suppression journaled", async () => {
    const { r, b, store } = rig((m5) => SIX.map((s) => sig(s, "BUY")), { policy: POLICY({ daily_stop_usd: 1000 }) });
    await warm(r, b); await r.tick();
    expect(b.sent.length).toBe(6);
    const modes = b.sent.map((s) => s.signal_id.slice(0, 3));
    expect(new Set(modes).size).toBe(6);
    const sup = ev(store, "CANDIDATE_SUPPRESSED").map((e) => e["reason"]);
    expect(sup).toContain("SUPPRESSED_MODE_SLOT_FULL");
    // With exactly six modes the per-mode slot binds before the global cap of 6.
    const intent = ev(store, "ORDER_INTENT").at(-1)!["symbolExposure"] as Record<string, { positions: number; correlated: boolean }>;
    expect(intent["XAUUSD"]!.positions + intent["BTCUSD"]!.positions).toBe(6);
    expect(intent["XAUUSD"]!.correlated).toBe(true);
  });

  it("Mode 12 SMC_FIBO_OTE is excluded: no candidate, no order (even armed)", async () => {
    const { r, b, store } = rig((m5) => [sig("SMC_FIBO_OTE", "BUY", fiboFor(m5))]);
    await warm(r, b); await r.tick(); await r.tick();
    expect(b.sent.length).toBe(0);
    expect(store.events.some((e) => JSON.stringify(e).includes("SMC_FIBO_OTE"))).toBe(false);
  });

  it("same candle opposite sides: SPV direction lock; next candle opposite of an active position is suppressed", async () => {
    let flip = false;
    const { r, b, store } = rig((m5) => (m5[0]!.open > 10000 ? [] : flip ? [sig("RANGE_REVERSAL", "SELL")] : [sig("DUAL_WALL_FAST", "BUY"), sig("EMA_CROSS", "SELL")]));
    await warm(r, b); await r.tick();
    expect(b.sent.map((s) => s.direction)).toEqual(["BUY"]);
    flip = true; b.now += M5; await r.tick();
    expect(b.sent.length).toBe(1);
    const locks = ev(store, "CANDIDATE_SUPPRESSED").filter((e) => e["reason"] === "SUPPRESSED_DIRECTION_LOCK");
    expect(locks.some((e) => e["strategy"] === "EMA_CROSS" && !e["against"])).toBe(true);
    expect(locks.at(-1)!["against"]).toBe("ACTIVE_POSITION");
  });

  it("broker spec mismatch / invalid volume step are rejected, lot never changed", async () => {
    for (const o of [{ tickValue: 2 }, { volumeStep: 0.1 }]) {
      const { r, b, store } = rig(() => [sig("EMA_CROSS", "BUY")]); b.specOver = o;
      await warm(r, b); await r.tick();
      expect(b.sent.length).toBe(0);
      expect(ev(store, "ENTRY_REJECTED").map((e) => e["reason"])).toContain(o.tickValue ? "REJECTED_BROKER_SPEC_MISMATCH" : "REJECTED_BROKER_VOLUME");
    }
    expect(volumeValid(0.02, { symbol: "X", volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01, tickSize: 1, tickValue: 1, marginPerLot: 0 })).toBe(true);
  });

  it("duplicate signal is never re-sent after restart", async () => {
    const store = new MemStore();
    const a = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]), {}, store);
    await warm(a.r, a.b); await a.r.tick();
    const b2 = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]), {}, store, a.b);
    await b2.r.tick(); await b2.r.tick();
    expect(a.b.sent.length).toBe(1);
    expect(b2.r.state.trades[0]!.status).toBe("OPEN");
  });

  it("COPET trailing XAU: arm at +$3, close at peak − $1; peak survives restart and closes on first tick", async () => {
    const store = new MemStore();
    const { r, b } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]), {}, store);
    await warm(r, b); await r.tick();
    const tk = r.state.trades[0]!.ticket!;
    b.setProfit(tk, 2.5); b.now += 1000; await r.tick(); expect(r.state.trades[0]!.trailArmed).toBe(false);
    b.setProfit(tk, 4); b.now += 1000; await r.tick(); expect(r.state.trades[0]!.trailArmed).toBe(true);
    b.setProfit(tk, 3.2); b.now += 1000; await r.tick(); expect(b.closes).toEqual([]);
    // restart while runner was down and price fell below floor (4 − 1 = 3)
    b.setProfit(tk, 2.9); b.now += 60_000;
    const r2 = rig((m5) => (m5[0]!.open > 10000 ? [] : []), {}, store, b).r;
    await r2.tick();
    expect(b.closes).toEqual([tk]);
    await r2.tick();
    expect(r2.state.trades[0]!.status).toBe("CLOSED"); expect(r2.state.trades[0]!.exitReason).toBe("TRAIL");
  });

  it("close timeout: no same-tick retry, re-read before retry, STATE_DESYNC_HALT after max attempts", async () => {
    const { r, b, store } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    await warm(r, b); await r.tick();
    const tk = r.state.trades[0]!.ticket!;
    b.closeMode = "TIMEOUT"; b.setProfit(tk, 4); await r.tick(); b.setProfit(tk, 1); b.now += 1000; await r.tick();
    expect(b.closes).toEqual([tk]);
    b.now += 1000; await r.tick(); expect(b.closes.length).toBe(2);
    b.now += 1000; await r.tick(); expect(b.closes.length).toBe(3);
    b.now += 1000; await r.tick(); expect(b.closes.length).toBe(3);
    expect(r.state.phase).toBe("STATE_DESYNC_HALT");
    expect(ev(store, "STATE_DESYNC_HALT").length).toBe(1);
    b.now += M5; await r.tick(); expect(b.sent.length).toBe(1);
    r.clearDesync(); expect(r.state.phase).toBe("TRADING");
  });

  it("close timeout that actually closed at broker: confirmed via deal, no retry", async () => {
    const { r, b } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    await warm(r, b); await r.tick();
    const tk = r.state.trades[0]!.ticket!;
    b.closeMode = "TIMEOUT_BUT_CLOSED"; b.setProfit(tk, 4); await r.tick(); b.setProfit(tk, 1); b.now += 1000; await r.tick();
    b.now += 1000; await r.tick();
    expect(b.closes).toEqual([tk]);
    expect(r.state.trades[0]!.status).toBe("CLOSED");
  });

  it("manual operator close: only with deal history ⇒ EXIT_MANUAL_OPERATOR and slot freed", async () => {
    const { r, b } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    await warm(r, b); await r.tick();
    const tk = r.state.trades[0]!.ticket!;
    b.manualClose(tk, 0, false); b.now += 1000; await r.tick();
    expect(r.state.trades[0]!.status).toBe("OPEN"); // no deal yet ⇒ not closed, slot occupied
    expect(r.state.blockReason).toBe("RECONCILIATION_NOT_CLEAN");
    b.deals.set(tk, { profit: 3.2, reason: "MANUAL" }); b.now += 1000; await r.tick();
    expect(r.state.trades[0]!.status).toBe("CLOSED"); expect(r.state.trades[0]!.exitReason).toBe("EXIT_MANUAL_OPERATOR");
    expect(r.state.trades[0]!.pnlUsd).toBe(3.2);
  });

  it("partial manual close and partial fill record actual volume", async () => {
    const { r, b, store } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    b.orderMode = "PARTIAL"; await warm(r, b); await r.tick();
    const t = r.state.trades[0]!;
    expect(t.partial).toBe(true); expect(t.volume).toBe(0.01);
    expect(ev(store, "FILL_VS_PLAN").length).toBe(1);
    const p2 = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    await warm(p2.r, p2.b); await p2.r.tick();
    p2.b.pos = p2.b.pos.map((p) => ({ ...p, volume: 0.01 })); p2.b.now += 1000; await p2.r.tick();
    expect(p2.r.state.trades[0]!.status).toBe("OPEN"); expect(p2.r.state.trades[0]!.volume).toBe(0.01);
  });

  it("reject is journaled; order timeout ⇒ UNKNOWN, entries blocked, adopted by comment", async () => {
    const { r, b, store } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    b.orderMode = "REJECT"; await warm(r, b); await r.tick();
    expect(ev(store, "ORDER_RESULT").some((e) => e["status"] === "REJECTED")).toBe(true);
    b.orderMode = "TIMEOUT"; b.now += M5; await r.tick();
    expect(r.state.trades.some((t) => t.status === "UNKNOWN")).toBe(true);
    b.now += 1000; await r.tick();
    expect(r.state.trades.filter((t) => t.status === "OPEN").length).toBe(1);
  });

  it("daily stop −$30 (signed day P/L) closes Lab positions only and blocks entries", async () => {
    const { r, b } = rig((m5) => (m5[0]!.open > 10000 ? [sig("EMA_CROSS", "BUY")] : [sig("EMA_CROSS", "BUY")]), { policy: POLICY({ daily_stop_usd: 30 }) });
    b.pos.push({ ticket: 9, symbol: "XAUUSD", comment: "manual", magic: 0, side: "BUY", volume: 1, priceOpen: 2000, profit: -500, swap: 0, sl: 1, tp: 3 });
    b.pos.push({ ticket: 8, symbol: "XAUUSD", comment: "arena", magic: 610006, side: "SELL", volume: 1, priceOpen: 2000, profit: -500, swap: 0, sl: 3000, tp: 1 });
    await warm(r, b); await r.tick();
    const bot = r.state.trades.filter((t) => t.status === "OPEN");
    expect(bot.length).toBe(1); // XAU −12 + BTC −22 = −34 ⇒ BTC rejected by budget
    b.setProfit(bot[0]!.ticket!, -31); b.now += 1000; await r.tick();
    expect(r.state.phase).toBe("PORTFOLIO_STOP_HIT");
    expect(b.closes).toEqual([bot[0]!.ticket]);
    const n = b.sent.length; b.now += M5; await r.tick();
    expect(b.sent.length).toBe(n);
  });

  it("+$50 target is realized-only: floating +$51 neither halts nor force-closes", async () => {
    const { r, b } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]));
    await warm(r, b); await r.tick();
    const tk = r.state.trades[0]!.ticket!;
    (r.state.trades[0] as { trailArmed: boolean; peakUsd: number }).trailArmed = false;
    (r.state.trades[0] as { peakUsd: number }).peakUsd = 0;
    b.setProfit(tk, 51); b.now += 1000; await r.tick();
    expect(r.state.phase).toBe("TRADING");
  });

  it("day rollover with an open position: new day starts at its mark; old stop day resets", async () => {
    const { r, b, store } = rig((m5) => (m5[0]!.open > 10000 ? [] : [sig("EMA_CROSS", "BUY")]), { policy: POLICY({ daily_stop_usd: 15 }) });
    b.now = Date.UTC(2026, 9, 19, 23, 40, 30);
    await warm(r, b); await r.tick();
    const tk = r.state.trades[0]!.ticket!;
    b.setProfit(tk, -8); b.now = Date.UTC(2026, 9, 20, 0, 0, 10); await r.tick();
    expect(r.state.day).toBe("2026-10-20");
    expect(r.state.trades[0]!.dayBaseUsd).toBe(-8);
    expect(ev(store, "DAY_ROLLOVER_BASELINE").length).toBe(1);
    // day-2 worst-case = (−10 − (−8)) − 2 = −4; without baseline it would be −12 and block the next XAU under stop 15
    b.setProfit(tk, -9); b.now += M5; await r.tick();
    expect(r.state.phase).toBe("TRADING");
    expect(ev(store, "ENTRY_REJECTED").filter((e) => e["reason"] === "REJECTED_BUDGET_EXCEEDED" && (e["worstCaseUsd"] as number) < -10).length).toBe(0);
    b.manualClose(tk, -9); b.now += 1000; await r.tick();
    expect(r.state.trades[0]!.pnlUsd! - r.state.trades[0]!.dayBaseUsd).toBe(-1); // only today's −1 counts for day 2
  });

  it("REAL or non-whitelisted account is always refused", async () => {
    for (const mut of [(b: FakeBroker) => (b.mode = "REAL"), (b: FakeBroker) => (b.login = 5)]) {
      const { r, b } = rig(() => [sig("EMA_CROSS", "BUY")]); mut(b);
      await warm(r, b); await r.tick();
      expect(b.sent.length).toBe(0); expect(b.closes.length).toBe(0);
    }
  });

  it("SHADOW (not armed) and kill switch never send", async () => {
    const a = rig(() => [sig("EMA_CROSS", "BUY")], { armed: false }); await warm(a.r, a.b); await a.r.tick();
    const k = rig(() => [sig("EMA_CROSS", "BUY")], { killSwitch: () => true }); await warm(k.r, k.b); await k.r.tick();
    expect(a.b.sent.length + k.b.sent.length).toBe(0);
  });

  it("untracked Lab position (state lost) ⇒ trailing degraded, never touched, entries blocked; foreign magic ignored", async () => {
    const { r, b } = rig(() => [sig("EMA_CROSS", "BUY")]);
    b.pos.push({ ticket: 55, symbol: "XAUUSD", comment: "ghost", magic: LAB_MAGIC, side: "BUY", volume: 0.02, priceOpen: 2000, profit: -1, swap: 0, sl: 1995, tp: 2005 });
    b.pos.push({ ticket: 56, symbol: "XAUUSD", comment: "arena", magic: 610006, side: "SELL", volume: 0.1, priceOpen: 2000, profit: 0, swap: 0, sl: 2010, tp: 1990 });
    await warm(r, b); await r.tick();
    expect(b.sent.length).toBe(0); expect(b.closes.length).toBe(0);
    expect(r.state.blockReason).toBe("UNTRACKED_TRAILING_DEGRADED");
    expect(r.state.degradedTickets).toEqual([55]);
  });

  it("broker comment truncation still matches by prefix; too-short comment does not", () => {
    expect(commentMatches("L11XAUt3", "L11XAUt3abcB")).toBe(true);
    expect(commentMatches("L11", "L11XAUt3abcB")).toBe(false);
  });
});
