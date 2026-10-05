import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import {
  SIGNAL_TTL_PARAMS, SIGNAL_TTL_POLICY_VERSION, deriveRadarPlan, deriveSignalLifecycle, type EvaluationInput, type TradingSnapshot,
} from "@/core/technical/tradingState";
import type { TechBar } from "@/core/technical/indicators";
import { PaperJournalStore, openPaper, type KV } from "@/lib/paperJournal";
import { SignalAlertStore } from "@/lib/signalAlerts";
import { compactSummary, engineSignalOf } from "@/lib/tradeSummary";
import { SignalSafetyStrip } from "@/components/TechnicalSlicePanel";
import { resolveTrade } from "@/core/technical/backtest";

const M5 = 300_000;
const bar = (k: number, o: Partial<TechBar> = {}): TechBar => ({ open_time: k * M5, close_time: (k + 1) * M5, available_at: (k + 1) * M5, open: 100, high: 101, low: 99, close: 100.5, ...o });
const memKV = (): KV => { const d = new Map<string, string>(); return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => { d.set(k, v); } }; };
const evidence = { M5: {}, M15: { atr14: { status: "OK", value: 4 } }, H1: { structure: { swings: [{ kind: "LOW", price: 90 }, { kind: "HIGH", price: 120 }] } } } as never;
const pat = (direction = "NONE", at: number | null = null) => ({ direction, bar_available_at: at, bar_open_time: at === null ? null : at - M5, bullish: [], bearish: [] });

type OpArgs = { candidate?: "BUY" | "SELL" | null; trigK?: number; momentum?: string; m5?: ReturnType<typeof pat> };
const op = ({ candidate = null, trigK = 10, momentum = "BUY", m5 = pat() }: OpArgs = {}) => ({
  candidate, status: candidate ? `CARI_${candidate}` : "CARI_BUY", reason: "NO_CLOSED_BULLISH_TRIGGER", alignment: "COUNTER_MACRO", location: "AT_SUPPORT",
  trigger_bar: candidate ? { timeframe: "M5", open_time: trigK * M5, available_at: (trigK + 1) * M5, patterns: [candidate === "BUY" ? "BULLISH_ENGULFING" : "BEARISH_ENGULFING"] } : null,
  scalp: { combined_momentum: momentum }, patterns: { M5: m5, M15: pat() },
}) as never;
const ACTIVE = { state: "ACTIVE" as const, reason: "TREND_BUY_LOCATION_RSI" };
const input = (bars: TechBar[], bid: number, ask: number): EvaluationInput => ({
  symbol: "XAUUSD", market_current: true, bars_current: true, quote: { bid, ask, spread: ask - bid, tick_time_ms: 1, observed_at: 1 },
  closed: { M5: bars, M15: [], H1: [], H4: [] }, as_of: bars[bars.length - 1]!.available_at, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false },
});
const upto = (k: number, extra: Record<number, Partial<TechBar>> = {}) => Array.from({ length: k + 1 }, (_, j) => bar(j, extra[j] ?? (j === 10 ? { low: 98, high: 101.5 } : {})));
const step = (prev: TradingSnapshot["signal"] | null, k: number, o: never, bid = 100, ask = 100.2, extra: Record<number, Partial<TechBar>> = {}) =>
  deriveSignalLifecycle(input(upto(k, extra), bid, ask), prev, ACTIVE, o, evidence);
const born = () => step(null, 10, op({ candidate: "BUY" }));

describe("P0.3–P0.5 signal safety lifecycle", () => {
  it("versioned params", () => {
    expect(SIGNAL_TTL_POLICY_VERSION).toBe("signal-ttl-v0.4-p0.3-v1");
    expect(SIGNAL_TTL_PARAMS).toMatchObject({ ttl_m5_bars: 3, chasing_limit_r: 1.0, early_invalidation: true });
  });

  it("1-2. READY origin frozen across ticks; signal_id stable", () => {
    const s0 = born();
    expect(s0.state).toBe("READY");
    expect(s0.origin).toMatchObject({ side: "BUY", origin_entry: 100.2, origin_sl: 89, trigger_low: 98, trigger_high: 101.5, trigger_tf: "M5", ttl_bars: 3, ttl_policy_version: SIGNAL_TTL_POLICY_VERSION });
    expect(s0.origin!.initial_r).toBeCloseTo(11.2);
    const s1 = step(s0, 10, op({ candidate: "BUY" }), 105, 105.2); // same trigger, quote moved
    expect(s1.state).toBe("READY");
    expect(s1.origin).toBe(s0.origin);
    expect(s1.origin!.signal_id).toBe(s0.origin!.signal_id);
  });

  it("3-4. TTL decrements per CLOSED M5 bar and expires after 3", () => {
    let s = born();
    expect(s.ttl_remaining_bars).toBe(3);
    s = step(s, 11, op({ candidate: "BUY" })); expect(s.ttl_remaining_bars).toBe(2);
    s = step(s, 11, op()); expect(s.ttl_remaining_bars).toBe(2); // ticks without new closed bar don't count
    s = step(s, 12, op()); expect(s.ttl_remaining_bars).toBe(1);
    s = step(s, 13, op());
    expect(s).toMatchObject({ state: "EXPIRED", reason: "SIGNAL_TTL_EXPIRED", ttl_remaining_bars: null });
    expect(s.lifecycle!.event).toBe("READY_EXPIRED");
  });

  it("5. BUY invalidates when CLOSED M5 low breaks trigger_low", () => {
    const s = step(born(), 11, op(), 100, 100.2, { 11: { low: 97.5 } });
    expect(s).toMatchObject({ state: "INVALIDATED", reason: "SIGNAL_TRIGGER_LOW_BROKEN" });
  });

  it("6. SELL invalidates when CLOSED M5 high breaks trigger_high", () => {
    const s0 = step(null, 10, op({ candidate: "SELL", momentum: "SELL" }), 110, 110.2);
    expect(s0.state).toBe("READY");
    const s = step(s0, 11, op({ momentum: "SELL" }), 110, 110.2, { 11: { high: 102 } });
    expect(s).toMatchObject({ state: "INVALIDATED", reason: "SIGNAL_TRIGGER_HIGH_BROKEN" });
  });

  it("7. BUY invalidates on momentum flip; CONFLICT also invalidates", () => {
    expect(step(born(), 10, op({ momentum: "STRONG_SELL" })).reason).toBe("SIGNAL_SCALP_MOMENTUM_FLIPPED");
    expect(step(born(), 10, op({ momentum: "CONFLICT" })).reason).toBe("SIGNAL_SCALP_CONFLICT");
  });

  it("8. newer opposing CLOSED trigger invalidates", () => {
    expect(step(born(), 11, op({ m5: pat("BEARISH", 12 * M5) })).reason).toBe("SIGNAL_OPPOSING_TRIGGER");
  });

  it("9-10. chasing expires at ≥1R from frozen origin (BUY ASK, SELL BID)", () => {
    const s0 = born(); const r = s0.origin!.initial_r!;
    expect(step(s0, 10, op({ candidate: "BUY" }), 100, 100.2 + r - 0.01).state).toBe("READY");
    expect(step(s0, 10, op({ candidate: "BUY" }), 100, 100.2 + r)).toMatchObject({ state: "EXPIRED", reason: "CHASING_PRICE_ALREADY_MOVED" });
    const sell = step(null, 10, op({ candidate: "SELL", momentum: "SELL" }), 110, 110.2);
    const rs = sell.origin!.initial_r!;
    expect(step(sell, 10, op({ candidate: "SELL", momentum: "SELL" }), 110 - rs, 110.2 - rs)).toMatchObject({ state: "EXPIRED", reason: "CHASING_PRICE_ALREADY_MOVED" });
  });

  it("11. no initial R ⇒ chasing guard unavailable, no fabricated threshold", () => {
    const noSwing = { ...(evidence as object), H1: { structure: { swings: [] } } } as never;
    const s0 = deriveSignalLifecycle(input(upto(10), 100, 100.2), null, ACTIVE, op({ candidate: "BUY" }), noSwing);
    expect(s0.origin).toMatchObject({ initial_r: null, origin_sl: null, origin_plan_reason: "CONFIRMED_H1_SWING_LOW_UNAVAILABLE" });
    expect(s0.chasing_guard).toBe("UNAVAILABLE_NO_INITIAL_R");
    expect(deriveSignalLifecycle(input(upto(10), 1000, 1000.2), s0, ACTIVE, op({ candidate: "BUY" }), noSwing).state).toBe("READY");
  });

  it("12-13. same trigger never resurrects; a fresh later trigger births a new id", () => {
    const exp = step(born(), 11, op(), 100, 100.2, { 11: { low: 97 } });
    const again = step(exp, 11, op({ candidate: "BUY" })); // same trigger bar 10 still visible
    expect(again.state).not.toBe("READY");
    const fresh = step(again, 14, op({ candidate: "BUY", trigK: 14 }), 100, 100.2, { 11: { low: 97 } });
    expect(fresh.state).toBe("READY");
    expect(fresh.origin!.signal_id).not.toBe(born().origin!.signal_id);
    expect(fresh.lifecycle!.event).toBe("FRESH_READY_CREATED");
  });

  it("14-15. alert once per fresh READY; journal lifecycle recorded once per event", () => {
    const mk = (sig: TradingSnapshot["signal"], k: number) => ({
      symbol: "XAUUSD", availability: "AVAILABLE", quote: { bid: 100, ask: 100.2 }, signal: sig,
      entry: { state: sig.state === "READY" ? "LONG_CANDIDATE" : "WAIT", reason: "T" }, reference_plan: { status: "NOT_AVAILABLE", reason: "x" }, operator: null, as_of: k, why: [], evidence: null,
    }) as unknown as TradingSnapshot;
    const alerts = new SignalAlertStore(memKV()), journal = new PaperJournalStore(memKV());
    const seq: TradingSnapshot["signal"][] = [];
    let s = step(null, 9, op()); seq.push(s);
    s = step(s, 10, op({ candidate: "BUY" })); seq.push(s);
    s = step(s, 10, op({ candidate: "BUY" })); seq.push(s);
    s = step(s, 11, op()); seq.push(s);
    s = step(s, 13, op()); seq.push(s); // expired
    s = step(s, 13, op()); seq.push(s);
    s = step(s, 14, op({ candidate: "BUY", trigK: 14 })); seq.push(s);
    s = step(s, 14, op({ candidate: "BUY", trigK: 14 })); seq.push(s);
    let fired = 0;
    seq.forEach((x, k) => { if (alerts.observe(mk(x, k), "XAUUSD", k)) fired++; journal.recordLifecycle(mk(x, k), "XAUUSD", k); journal.recordLifecycle(mk(x, k), "XAUUSD", k); });
    expect(fired).toBe(2);
    const events = journal.getState().journal.filter((e) => e.type === "LIFECYCLE").map((e) => e.type === "LIFECYCLE" ? e.lifecycle.event : "").reverse();
    expect(events).toEqual(["READY_CREATED", "READY_EXPIRED", "FRESH_READY_CREATED"]);
    expect(engineSignalOf(mk(seq[4]!, 4))).toBe("HOLD");
  });

  it("16-17. radar stays dynamic after expiry; manual paper allowed on HOLD and doesn't change engine", () => {
    const zone = { source_tf: "M15", low: 97, high: 99, center: 98, touches: 2, role: "SUPPORT", distance: 1, confluence_tfs: [] };
    const NA = { status: "INSUFFICIENT_HISTORY" };
    const radarOp = { status: "CARI_BUY", reason: "x", ema_confluence: { zone: "NOT_NEAR", timeframe: null }, patterns: { M5: { bullish: [], bearish: [] }, M15: { bullish: [], bearish: [] } }, zones: { M15: [zone] }, scalp: { local_zones: [zone], M15: { ema21: NA, ema50: NA, atr14: NA }, M5: { ema21: NA, ema50: NA, atr14: NA } } } as never;
    const WAIT = { state: "WAIT" as const, reason: "SIGNAL_TTL_EXPIRED" };
    const NOREF = { status: "NOT_AVAILABLE" as const, policy_version: "reference-plan-v2-swing-atr-plus-sr-context" as const, reason: "x" };
    const q = (b: number) => ({ bid: b, ask: b + 0.2, spread: 0.2, tick_time_ms: 1, observed_at: 1 });
    const a = deriveRadarPlan(WAIT, q(98), evidence, radarOp, NOREF), b = deriveRadarPlan(WAIT, q(98.5), evidence, radarOp, NOREF);
    expect(a).toMatchObject({ mode: "RADAR", status: "AVAILABLE" });
    expect(a.reference_entry).not.toBe(b.reference_entry);
    const expired = step(born(), 13, op());
    const snap = { symbol: "XAUUSD", availability: "AVAILABLE", signal: expired, entry: WAIT, reference_plan: NOREF, operator: radarOp, evidence, why: [], versions: {}, quote: q(98) } as unknown as TradingSnapshot;
    const p = openPaper({ symbol: "XAUUSD", side: "BUY", quote: { bid: 98, ask: 98.2 }, now: 1, snapshot: snap, id: "p" });
    expect(p).toMatchObject({ entry: 98.2, mode: "SIMULATION", action_source: "MANUAL_EARLY", engine_signal_id: null });
    expect(engineSignalOf(snap)).toBe("HOLD");
    expect(snap.signal.state).toBe("EXPIRED");
  });

  it("dashboard strip: READY TTL + frozen entry; expired reason; summary carries lifecycle", () => {
    const s0 = born();
    const { unmount } = render(<SignalSafetyStrip signal={s0} />);
    expect(screen.getByTestId("signal-safety-strip").textContent).toContain("READY · berlaku 3 bar M5 lagi");
    unmount();
    render(<SignalSafetyStrip signal={step(s0, 13, op())} />);
    expect(screen.getByTestId("signal-safety-strip").textContent).toContain("SIGNAL EXPIRED — tunggu trigger baru");
    const snap = { symbol: "X", as_of: 1, signal: s0, entry: { state: "LONG_CANDIDATE", reason: "x" }, reference_plan: { status: "NOT_AVAILABLE", reason: "x" }, why: [], operator: null, evidence: null } as unknown as TradingSnapshot;
    const c = compactSummary(snap);
    expect(c.signal_lifecycle).toMatchObject({ state: "READY", ttl_remaining: 3, ttl_policy_version: SIGNAL_TTL_POLICY_VERSION });
    expect(JSON.stringify(c).length).toBeLessThan(10_000);
  });

  it("18. backtest trades once per signal_id at READY birth only; ambiguous handling unchanged", () => {
    const src = readFileSync("src/core/technical/backtest.ts", "utf8");
    expect(src).toMatch(/traded\.has\(sid\)/);
    expect(src).toMatch(/READY_CREATED/);
    expect(resolveTrade("BUY", 90, 110, [bar(0, { low: 89, high: 111 })]).outcome).toBe("AMBIGUOUS");
  });

  it("no order/broker path in lifecycle code", () => {
    const src = readFileSync("src/core/technical/tradingState.ts", "utf8") + readFileSync("src/lib/paperJournal.ts", "utf8");
    expect(src).not.toMatch(/order_send|placeOrder|BrokerGatewayClient|fetch\(/);
  });
});
