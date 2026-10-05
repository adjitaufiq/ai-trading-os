// v1c hermetic rig: real BrokerGatewayClient over an injected transport → MarketRuntime (same rig shape as D2).
// G2: fixture DECLARES its tick times as UTC ms and passes broker_utc_offset_ms = 0 explicitly. Not an Exness claim.
import { BrokerGatewayClient, type FetchLike, type WebSocketLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { MarketRuntime } from "@/core/runtime/MarketRuntime";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";

export const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // Monday, H4-aligned
export const MIN = 60_000;
export const HOUR = 60 * MIN;

class FakeWS implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send() {}
  close() { this.onclose?.({ code: 1000 }); }
}

export interface Tick { ms: number; bid: number }

export function makeRig(symbol: "XAUUSD" | "BTCUSD" = "XAUUSD") {
  const clock = new ReplayClock(T0 + 2 * MIN);
  let seq = 0;
  let ws: FakeWS | null = null;
  const inst = "gw-v1c";
  const tick = (t: Tick) => ({ broker_symbol: symbol, raw_time_s: Math.floor(t.ms / 1000), raw_time_msc: t.ms, time_precision: "ms", bid: t.bid, ask: +(t.bid + 0.2).toFixed(2), last: 0, volume: 0, flags: 6 });
  const env = (capability: string, delivery: string, data: unknown, src: number | null, recv: number) => ({
    schema_version: "3.0B-1", bridge_instance_id: inst, connection_epoch: 1, request_id: `r-${++seq}`, sequence: seq,
    delivery, source: "EXNESS_MT5", source_mode: "SIMULATION", capability,
    timing: { source_event_at: src, bridge_received_at: recv, bridge_sent_at: recv + 1, client_sent_at: null, client_received_at: null },
    latency: { source_arrival_delay_observed_ms: src === null ? null : recv - src, bridge_processing_ms: 1, bridge_to_client_apparent_delay_ms: null, transport_rtt_ms: null },
    ok: true, data, error: null,
  });
  const history: Tick[] = [{ ms: T0 + 1 * MIN, bid: 2000 }];
  const fetchImpl: FetchLike = async (url) => {
    const now = clock.now();
    const res = (b: unknown, status = 200) => ({ status, text: async () => JSON.stringify(b) });
    if (url.includes("/v1/health")) return res(env("SYSTEM.HEALTH", "LIVE", { bridge_instance_id: inst, connection_epoch: 1, source_mode: "SIMULATION", terminal_connected: true }, null, now - 2));
    if (url.includes(`/v1/ticks/${symbol}`)) {
      const q = new URL(url).searchParams;
      const items = history.map(tick);
      return res(env("MARKET_DATA.TICKS", "BACKFILL", { items, coverage: { requested_from: Date.parse(q.get("from")!), requested_to: Date.parse(q.get("to")!), returned_count: items.length,
        oldest_returned_at: items[0]!.raw_time_msc, newest_returned_at: items[items.length - 1]!.raw_time_msc, coverage_status: "COMPLETE", reason: null } }, null, now - 2));
    }
    return res({}, 404);
  };
  let mono = 0;
  const gateway = new BrokerGatewayClient({ config: makeGatewayConfig({}), wallClock: clock, monoClock: { now: () => (mono += 1) }, fetchImpl,
    wsFactory: () => { ws = new FakeWS(); queueMicrotask(() => ws!.onopen?.({})); return ws; } });
  const spec = Object.freeze({ symbol, origin: "SYNTHETIC" as const, digits: 2, point: 0.01, tick_size: 0.01, contract_size: 100, broker_utc_offset_ms: 0 });
  const classifier = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };
  const rt = new MarketRuntime({ gateway, clock, binding: { broker_symbol: symbol, canonical_symbol: symbol }, spec, classifier, maxClosedBarsPerTimeframe: 5000 });
  const live = (t: Tick) => {
    if (clock.now() < t.ms + 30) clock.advanceTo(t.ms + 30);
    ws!.onmessage!({ data: JSON.stringify(env("MARKET_DATA.TICKS", "LIVE", tick(t), t.ms, t.ms + 20)) });
  };
  const start = async () => { const s = await rt.start({ history_from: T0, history_to: T0 + 2 * MIN }); if (s !== "SYNCHRONIZED") throw new Error(`bootstrap ${s}`); };
  return { clock, rt, r: rt.reader, live, start };
}

export interface HourSpec { c: number; w?: number; extra?: boolean }

/** Ticks for hour k: open (prev close) → extreme → extreme → close. Deterministic; `extra` adds an in-range M5-only tick. */
export function hourTicks(k: number, prevClose: number, h: HourSpec): Tick[] {
  const w = h.w ?? 0.5;
  const hi = +(Math.max(prevClose, h.c) + w).toFixed(2), lo = +(Math.min(prevClose, h.c) - w).toFixed(2);
  const base = T0 + k * HOUR;
  const up = h.c >= prevClose;
  const t: Tick[] = [
    { ms: base + 1 * MIN, bid: prevClose },
    { ms: base + 15 * MIN, bid: up ? lo : hi },
    { ms: base + 30 * MIN, bid: up ? hi : lo },
  ];
  if (h.extra) t.push({ ms: base + 40 * MIN, bid: +((hi + lo) / 2).toFixed(2) });
  t.push({ ms: base + 50 * MIN, bid: h.c });
  return t;
}

/** Feeds hours [fromK, fromK+specs.length) skipping `skip` hour indices (explicit missing observation). */
export function feedHours(rig: ReturnType<typeof makeRig>, fromK: number, specs: readonly HourSpec[], startPrice: number, skip: ReadonlySet<number> = new Set(), onHour?: (k: number) => void) {
  let prev = startPrice;
  specs.forEach((h, i) => {
    const k = fromK + i;
    if (!skip.has(k)) for (const t of hourTicks(k, prev, h)) rig.live(t);
    prev = h.c;
    onHour?.(k);
  });
  return prev;
}

export const zig = (k: number) => [0, 1.2, 2, 1.2, 0, -1.2][k % 6]!;
export const bull = (n: number, from = 2000, slope = 1): HourSpec[] => Array.from({ length: n }, (_, i) => ({ c: +(from + slope * (i + 1) + 3 * zig(i)).toFixed(2) }));
export const bear = (n: number, from = 2400, slope = 1): HourSpec[] => Array.from({ length: n }, (_, i) => ({ c: +(from - slope * (i + 1) - 3 * zig(i)).toFixed(2) }));
