// Strict structural validation of gateway envelopes against FROZEN 3.0B-1 semantics.
// Malformed data is never coerced into evidence: it becomes CLIENT_PROTOCOL_ERROR.
import { BRIDGE_SCHEMA_VERSION, READ_ONLY_CAPABILITIES, type BridgeCapability, type BridgeDelivery } from "../bridge/types";
import type { WireEnvelope } from "./types";

type V = { ok: true } | { ok: false; reason: string };
const OK: V = { ok: true };
const bad = (reason: string): V => ({ ok: false, reason });

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const numOrNull = (x: unknown) => x === null || isNum(x);
const intOrNull = (x: unknown) => x === null || isInt(x);

function exactKeys(o: Obj, keys: readonly string[], what: string): V {
  const have = Object.keys(o).sort().join(",");
  const want = [...keys].sort().join(",");
  return have === want ? OK : bad(`${what}: unexpected key set [${have}]`);
}

const ENVELOPE_KEYS = ["schema_version", "bridge_instance_id", "connection_epoch", "request_id", "sequence", "delivery",
  "source", "source_mode", "capability", "timing", "latency", "ok", "data", "error"] as const;
const TIMING_KEYS = ["source_event_at", "bridge_received_at", "bridge_sent_at", "client_sent_at", "client_received_at"] as const;
const LATENCY_KEYS = ["source_arrival_delay_observed_ms", "bridge_processing_ms", "bridge_to_client_apparent_delay_ms", "transport_rtt_ms"] as const;
const ERROR_KINDS = ["MT5_ERROR", "CAPABILITY_DENIED", "INVALID_REQUEST", "NOT_FOUND"];

// ---------- payload validators ----------
export function validTick(t: unknown): V {
  if (!isObj(t)) return bad("tick: not an object");
  const k = exactKeys(t, ["broker_symbol", "raw_time_s", "raw_time_msc", "time_precision", "bid", "ask", "last", "volume", "flags"], "tick");
  if (!k.ok) return k;
  if (!isStr(t.broker_symbol) || !isInt(t.raw_time_s) || !isInt(t.raw_time_msc) || t.time_precision !== "ms") return bad("tick: identity/time fields invalid");
  if (![t.bid, t.ask, t.last, t.volume].every(isNum) || !isInt(t.flags)) return bad("tick: numeric fields invalid");
  if (Math.floor((t.raw_time_msc as number) / 1000) !== t.raw_time_s) return bad("tick: raw_time_s and raw_time_msc disagree");
  return OK;
}
export function validBar(b: unknown): V {
  if (!isObj(b)) return bad("bar: not an object");
  const k = exactKeys(b, ["broker_symbol", "timeframe", "raw_time_s", "time_precision", "open", "high", "low", "close", "tick_volume", "spread", "real_volume"], "bar");
  if (!k.ok) return k;
  if (!isStr(b.broker_symbol) || !isStr(b.timeframe) || !isInt(b.raw_time_s) || b.time_precision !== "s") return bad("bar: identity/time fields invalid");
  if (![b.open, b.high, b.low, b.close, b.tick_volume, b.spread, b.real_volume].every(isNum)) return bad("bar: numeric fields invalid");
  return OK;
}
function validCoverage(c: unknown): V {
  if (!isObj(c)) return bad("coverage: not an object");
  const k = exactKeys(c, ["requested_from", "requested_to", "returned_count", "oldest_returned_at", "newest_returned_at", "coverage_status", "reason"], "coverage");
  if (!k.ok) return k;
  if (!intOrNull(c.requested_from) || !intOrNull(c.requested_to) || !isInt(c.returned_count) || (c.returned_count as number) < 0) return bad("coverage: bounds invalid");
  if (!intOrNull(c.oldest_returned_at) || !intOrNull(c.newest_returned_at)) return bad("coverage: returned bounds invalid");
  if (!["COMPLETE", "PARTIAL", "EMPTY", "UNKNOWN"].includes(c.coverage_status as string)) return bad("coverage: status invalid");
  if (!(c.reason === null || isStr(c.reason))) return bad("coverage: reason invalid");
  return OK;
}
function validHistory(d: unknown, item: (x: unknown) => V): V {
  if (!isObj(d)) return bad("history: not an object");
  const k = exactKeys(d, ["items", "coverage"], "history");
  if (!k.ok) return k;
  if (!Array.isArray(d.items)) return bad("history: items not an array");
  for (const it of d.items) {
    const r = item(it);
    if (!r.ok) return r;
  }
  const c = validCoverage(d.coverage);
  if (!c.ok) return c;
  if ((d.coverage as Obj).returned_count !== d.items.length) return bad("history: returned_count != items.length");
  return OK;
}
function validSymbol(s: unknown): V {
  if (!isObj(s)) return bad("symbol: not an object");
  const k = exactKeys(s, ["broker_symbol", "description", "path", "currency_base", "currency_profit", "digits", "point", "trade_contract_size"], "symbol");
  if (!k.ok) return k;
  if (![s.broker_symbol, s.description, s.path, s.currency_base, s.currency_profit].every(isStr)) return bad("symbol: string fields invalid");
  if (!isInt(s.digits) || !isNum(s.point) || !isNum(s.trade_contract_size)) return bad("symbol: numeric fields invalid");
  return OK;
}
function validTerminal(t: unknown): V {
  if (!isObj(t)) return bad("terminal: not an object");
  const k = exactKeys(t, ["connected", "terminal_ping_us", "terminal_ping_ms", "retransmission", "trade_allowed_observed", "tradeapi_disabled_observed", "authority"], "terminal");
  if (!k.ok) return k;
  if (typeof t.connected !== "boolean" || typeof t.trade_allowed_observed !== "boolean" || typeof t.tradeapi_disabled_observed !== "boolean") return bad("terminal: flags invalid");
  if (!isInt(t.terminal_ping_us) || !isNum(t.terminal_ping_ms) || !isNum(t.retransmission)) return bad("terminal: numeric fields invalid");
  if (t.authority !== "OBSERVATION_ONLY") return bad("terminal: authority must be OBSERVATION_ONLY");
  return OK;
}

export type PayloadKind = "HEALTH" | "TERMINAL" | "SYMBOLS" | "SYMBOL" | "TICK" | "TICK_HISTORY" | "BAR_HISTORY";
export const PAYLOAD_CAPABILITY: Record<PayloadKind, BridgeCapability> = {
  HEALTH: "SYSTEM.HEALTH",
  TERMINAL: "SYSTEM.TERMINAL_INFO",
  SYMBOLS: "DISCOVERY.SYMBOLS",
  SYMBOL: "DISCOVERY.SYMBOL_SPEC",
  TICK: "MARKET_DATA.TICKS",
  TICK_HISTORY: "MARKET_DATA.TICKS",
  BAR_HISTORY: "MARKET_DATA.BARS",
};
export const PAYLOAD_DELIVERY: Record<PayloadKind, BridgeDelivery> = {
  HEALTH: "LIVE", TERMINAL: "LIVE", SYMBOLS: "LIVE", SYMBOL: "LIVE", TICK: "LIVE",
  TICK_HISTORY: "BACKFILL", BAR_HISTORY: "BACKFILL",
};

function validPayload(kind: PayloadKind, d: unknown, env: Obj): V {
  switch (kind) {
    case "HEALTH": {
      if (!isObj(d)) return bad("health: not an object");
      const k = exactKeys(d, ["bridge_instance_id", "connection_epoch", "source_mode", "terminal_connected"], "health");
      if (!k.ok) return k;
      if (d.bridge_instance_id !== env.bridge_instance_id || d.connection_epoch !== env.connection_epoch || d.source_mode !== env.source_mode) return bad("health: disagrees with envelope provenance");
      return typeof d.terminal_connected === "boolean" ? OK : bad("health: terminal_connected invalid");
    }
    case "TERMINAL": return validTerminal(d);
    case "SYMBOLS": {
      if (!Array.isArray(d)) return bad("symbols: not an array");
      for (const s of d) { const r = validSymbol(s); if (!r.ok) return r; }
      return OK;
    }
    case "SYMBOL": return validSymbol(d);
    case "TICK": {
      const r = validTick(d);
      if (!r.ok) return r;
      return (env.timing as Obj).source_event_at === (d as Obj).raw_time_msc ? OK : bad("tick: source_event_at != raw_time_msc");
    }
    case "TICK_HISTORY": return validHistory(d, validTick);
    case "BAR_HISTORY": return validHistory(d, validBar);
  }
}

/** Validate a decoded JSON body as a frozen BridgeEnvelope for the expected payload kind. */
export function validateEnvelope<T>(body: unknown, kind: PayloadKind): { ok: true; envelope: WireEnvelope<T> } | { ok: false; reason: string } {
  if (!isObj(body)) return { ok: false, reason: "envelope: not an object" };
  const k = exactKeys(body, ENVELOPE_KEYS, "envelope");
  if (!k.ok) return k;
  if (body.schema_version !== BRIDGE_SCHEMA_VERSION) return { ok: false, reason: `envelope: schema_version ${String(body.schema_version)} != ${BRIDGE_SCHEMA_VERSION}` };
  if (!isStr(body.bridge_instance_id) || body.bridge_instance_id.length === 0 || body.bridge_instance_id.length > 128) return { ok: false, reason: "envelope: bridge_instance_id invalid" };
  if (!isInt(body.connection_epoch) || body.connection_epoch < 0) return { ok: false, reason: "envelope: connection_epoch invalid" };
  if (!isStr(body.request_id) || body.request_id.length === 0 || body.request_id.length > 128) return { ok: false, reason: "envelope: request_id missing/invalid" };
  if (!isInt(body.sequence) || body.sequence < 1) return { ok: false, reason: "envelope: sequence invalid" };
  if (body.source !== "EXNESS_MT5") return { ok: false, reason: "envelope: source invalid" };
  if (body.source_mode !== "SIMULATION" && body.source_mode !== "REAL") return { ok: false, reason: "envelope: source_mode invalid" };
  if (!(READ_ONLY_CAPABILITIES as readonly unknown[]).includes(body.capability)) return { ok: false, reason: "envelope: capability outside read-only whitelist" };
  if (body.capability !== PAYLOAD_CAPABILITY[kind]) return { ok: false, reason: `envelope: capability ${String(body.capability)} unexpected for ${kind}` };
  if (body.delivery !== PAYLOAD_DELIVERY[kind]) return { ok: false, reason: `envelope: delivery ${String(body.delivery)} unexpected for ${kind}` };

  const t = body.timing;
  if (!isObj(t)) return { ok: false, reason: "timing: not an object" };
  const tk = exactKeys(t, TIMING_KEYS, "timing");
  if (!tk.ok) return tk;
  if (!numOrNull(t.source_event_at) || !isNum(t.bridge_received_at) || !isNum(t.bridge_sent_at)) return { ok: false, reason: "timing: bridge fields invalid" };
  if ((t.bridge_sent_at as number) < (t.bridge_received_at as number)) return { ok: false, reason: "timing: bridge_sent_at < bridge_received_at" };
  if (t.client_sent_at !== null || t.client_received_at !== null) return { ok: false, reason: "timing: bridge must not fabricate client-clock fields" };

  const l = body.latency;
  if (!isObj(l)) return { ok: false, reason: "latency: not an object" };
  const lk = exactKeys(l, LATENCY_KEYS, "latency");
  if (!lk.ok) return lk;
  if (l.bridge_processing_ms !== (t.bridge_sent_at as number) - (t.bridge_received_at as number)) return { ok: false, reason: "latency: bridge_processing_ms inconsistent" };
  const expectArrival = t.source_event_at === null ? null : (t.bridge_received_at as number) - (t.source_event_at as number);
  if (l.source_arrival_delay_observed_ms !== expectArrival) return { ok: false, reason: "latency: source_arrival_delay_observed_ms inconsistent" };
  if (l.bridge_to_client_apparent_delay_ms !== null || l.transport_rtt_ms !== null) return { ok: false, reason: "latency: bridge must not fabricate client-side metrics" };

  if (body.ok === true) {
    if (body.error !== null) return { ok: false, reason: "envelope: ok=true with error" };
    const p = validPayload(kind, body.data, body);
    if (!p.ok) return p;
  } else if (body.ok === false) {
    if (body.data !== null) return { ok: false, reason: "envelope: ok=false with data" };
    const e = body.error;
    if (!isObj(e)) return { ok: false, reason: "error: not an object" };
    const ek = exactKeys(e, ["kind", "message", "mt5_error"], "error");
    if (!ek.ok) return ek;
    if (!ERROR_KINDS.includes(e.kind as string) || !isStr(e.message)) return { ok: false, reason: "error: kind/message invalid" };
    const m = e.mt5_error;
    if (m !== null) {
      if (!isObj(m)) return { ok: false, reason: "error: mt5_error invalid" };
      const mk = exactKeys(m, ["code", "description"], "mt5_error");
      if (!mk.ok) return mk;
      if (!isInt(m.code) || !isStr(m.description)) return { ok: false, reason: "error: mt5_error fields invalid" };
    }
  } else {
    return { ok: false, reason: "envelope: ok must be boolean" };
  }
  return { ok: true, envelope: body as unknown as WireEnvelope<T> };
}
