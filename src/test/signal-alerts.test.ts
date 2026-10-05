import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TradingSnapshot } from "@/core/technical/tradingState";
import { PaperJournalStore, type KV } from "@/lib/paperJournal";
import {
  ALERTS_MAX, AlarmController, SignalAlertStore, notificationBody, notifyPermission, requestNotify, showNativeNotification, type NotificationApi,
} from "@/lib/signalAlerts";

const memKV = (): KV => { const d = new Map<string, string>(); return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => { d.set(k, v); } }; };
const snap = (entry: TradingSnapshot["entry"]["state"], symbol = "XAUUSD"): TradingSnapshot => ({
  symbol, availability: "AVAILABLE", quote: { bid: 100, ask: 101, spread: 1, tick_time_ms: 1, observed_at: 1 },
  entry: { state: entry, reason: "T" }, signal: { state: "READY", reason: "M5_CLOSED_BULLISH" },
  reference_plan: { status: "AVAILABLE", side: entry === "SHORT_CANDIDATE" ? "SELL" : "BUY", entry: 101, sl: 98, tp1: 104, tp2: 107 },
  operator: { alignment: "WITH_MACRO", trigger_bar: { timeframe: "M5", patterns: ["HAMMER_LIKE"] } },
} as unknown as TradingSnapshot);

describe("SIGNAL READY radar", () => {
  it("baseline on mount does not alert; HOLD→BUY once; repeated BUY no dup; BUY→SELL new alert", () => {
    const st = new SignalAlertStore(memKV());
    expect(st.observe(snap("LONG_CANDIDATE"), "XAUUSD", 1)).toBeNull(); // existing signal at mount
    expect(st.observe(snap("WAIT"), "XAUUSD", 2)).toBeNull();
    const a = st.observe(snap("LONG_CANDIDATE"), "XAUUSD", 3)!;
    expect(a).toMatchObject({ side: "BUY", from: "HOLD", alignment: "WITH MACRO", entry: 101, sl: 98, tp1: 104, tp2: 107, read: false });
    expect(notificationBody(a)).toBe("BUY SCALP · WITH MACRO · Entry 101.00 · SL 98.00 · TP2 107.00");
    for (let t = 4; t < 20; t++) expect(st.observe(snap("LONG_CANDIDATE"), "XAUUSD", t)).toBeNull();
    expect(st.observe(snap("SHORT_CANDIDATE"), "XAUUSD", 30)!.side).toBe("SELL");
    expect(st.getAlerts()).toHaveLength(2);
    expect(st.unreadCount()).toBe(2);
    st.markAllRead(); expect(st.unreadCount()).toBe(0);
  });

  it("both symbols alert independently (selection irrelevant)", () => {
    const st = new SignalAlertStore(memKV());
    st.observe(snap("WAIT", "XAUUSD"), "XAUUSD", 1); st.observe(snap("WAIT", "BTCUSD"), "BTCUSD", 1);
    expect(st.observe(snap("LONG_CANDIDATE", "BTCUSD"), "BTCUSD", 2)?.symbol).toBe("BTCUSD");
    expect(st.observe(snap("SHORT_CANDIDATE", "XAUUSD"), "XAUUSD", 2)?.symbol).toBe("XAUUSD");
  });

  it("manual paper trades never produce an engine alert", () => {
    const st = new SignalAlertStore(memKV()), journal = new PaperJournalStore(memKV());
    st.observe(snap("WAIT"), "XAUUSD", 1);
    journal.open({ symbol: "XAUUSD", side: "BUY", quote: { bid: 100, ask: 101 }, now: 2, snapshot: snap("WAIT") });
    expect(st.observe(snap("WAIT"), "XAUUSD", 3)).toBeNull();
    expect(st.getAlerts()).toHaveLength(0);
  });

  it("persisted history is bounded and survives reload, but baseline does not", () => {
    const kv = memKV(), st = new SignalAlertStore(kv);
    for (let i = 0; i < 130; i++) { st.observe(snap("WAIT"), "XAUUSD", i * 2); st.observe(snap("LONG_CANDIDATE"), "XAUUSD", i * 2 + 1); }
    expect(st.getAlerts()).toHaveLength(ALERTS_MAX);
    const reloaded = new SignalAlertStore(kv);
    expect(reloaded.getAlerts()).toHaveLength(ALERTS_MAX);
    expect(reloaded.observe(snap("LONG_CANDIDATE"), "XAUUSD", 999)).toBeNull();
  });

  it("audio requires explicit enable; suspended context ⇒ needs re-unlock, never throws", async () => {
    const osc = () => ({ type: "", frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() });
    const gain = () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() });
    const ctx = { state: "suspended", currentTime: 0, destination: {}, resume: vi.fn(async () => { ctx.state = "running"; }), createOscillator: vi.fn(osc), createGain: vi.fn(gain) };
    const make = vi.fn(() => ctx);
    const alarm = new AlarmController(make, memKV());
    expect(alarm.status()).toBe("OFF");
    expect(alarm.play("BUY")).toBe(false);
    expect(make).not.toHaveBeenCalled(); // no AudioContext before a user gesture
    expect(await alarm.enable()).toBe("ACTIVE");
    expect(alarm.play("BUY")).toBe(true);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3); // short pattern, no loop
    alarm.setMuted(true); expect(alarm.play("SELL")).toBe(false);
    alarm.setMuted(false); ctx.state = "suspended";
    expect(alarm.play("SELL")).toBe(false);
    expect(alarm.status()).toBe("NEEDS_REUNLOCK");
    const broken = new AlarmController(() => { throw new Error("no audio"); }, memKV());
    expect(await broken.enable()).toBe("NEEDS_REUNLOCK");
    expect(new AlarmController(null, null).status()).toBe("UNAVAILABLE");
  });

  it("Notification denial/failure never breaks the app", async () => {
    const st = new SignalAlertStore(memKV()); st.observe(snap("WAIT"), "XAUUSD", 1);
    const a = st.observe(snap("LONG_CANDIDATE"), "XAUUSD", 2)!;
    expect(notifyPermission(null)).toBe("UNAVAILABLE");
    expect(showNativeNotification(null, a)).toBe(false);
    const denied = Object.assign(function () { throw new Error("x"); }, { permission: "denied", requestPermission: async () => { throw new Error("blocked"); } }) as unknown as NotificationApi;
    expect(await requestNotify(denied)).toBe("DENIED");
    expect(showNativeNotification(denied, a)).toBe(false);
    const throwing = Object.assign(function () { throw new Error("ctor"); }, { permission: "granted", requestPermission: async () => "granted" }) as unknown as NotificationApi;
    expect(showNativeNotification(throwing, a)).toBe(false);
    const shown: string[] = [];
    const ok = Object.assign(function (this: { onclick: null }, title: string) { shown.push(title); this.onclick = null; }, { permission: "granted", requestPermission: async () => "granted" }) as unknown as NotificationApi;
    expect(showNativeNotification(ok, a)).toBe(true);
    expect(shown).toEqual(["SIGNAL READY · XAUUSD"]);
  });

  it("no broker/order execution path", () => {
    for (const f of ["src/lib/signalAlerts.ts", "src/components/AlertCenter.tsx"])
      expect(readFileSync(f, "utf8")).not.toMatch(/order_send|placeOrder|submitOrder|BrokerGatewayClient|gateway|WebSocket\(|fetch\(/);
  });
});
