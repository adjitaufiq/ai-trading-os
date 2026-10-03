import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import {
  assertCapability, CapabilityDeniedError, computeBarCoverage, isWhitelisted, matchesGroup,
  MockMT5BridgeClient, pingUsToMs, toMt5Error,
} from "@/core/broker/bridge/MockMT5BridgeClient";
import { runBridgeSimulation } from "@/core/broker/bridge/simulation";
import { BRIDGE_SCHEMA_VERSION, READ_ONLY_CAPABILITIES, type BridgeEnvelope } from "@/core/broker/bridge/types";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import {
  BASE_BRIDGE_SCRIPT as S, BRIDGE_T0, BRIDGE_T0_S, SYNTHETIC_BARS, SYNTHETIC_TICKS,
  type SyntheticBridgeScript,
} from "@/core/fixtures/syntheticBridgeFixture";

const mk = (over: Partial<SyntheticBridgeScript> = {}) => new MockMT5BridgeClient({ ...S, ...over }, new ReplayClock(BRIDGE_T0));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("3.0B-1 envelope / schema / provenance", () => {
  it("every envelope carries versioned provenance", () => {
    for (const e of runBridgeSimulation().transcript) {
      expect(e.schema_version).toBe(BRIDGE_SCHEMA_VERSION);
      expect(e.bridge_instance_id).toBe(S.bridge_instance_id);
      expect(e.source).toBe("EXNESS_MT5");
      expect(e.source_mode).toBe("SIMULATION");
      expect(e.request_id).toMatch(new RegExp(`^${S.bridge_instance_id}-e${e.connection_epoch}-r\\d+$`));
      expect(["LIVE", "BACKFILL"]).toContain(e.delivery);
      expect(READ_ONLY_CAPABILITIES).toContain(e.capability);
      expect(e.ok ? e.error : e.data).toBeNull();
    }
  });
  it("request ids are unique and envelopes are frozen", () => {
    const t = runBridgeSimulation().transcript;
    expect(new Set(t.map((e) => e.request_id)).size).toBe(t.length);
    expect(Object.isFrozen(t[0])).toBe(true);
    expect(Object.isFrozen(t[0]!.timing)).toBe(true);
  });
});

describe("3.0B-1 sequence / epoch / delivery", () => {
  it("sequence strictly increases", () => {
    const seq = runBridgeSimulation().transcript.map((e) => e.sequence);
    seq.forEach((s, i) => i && expect(s).toBe(seq[i - 1]! + 1));
    expect(seq[0]).toBe(1);
  });
  it("reconnect increments epoch, sequence keeps rising across epochs", () => {
    const c = mk();
    const a = c.health();
    c.reconnect();
    const b = c.health();
    expect(a.connection_epoch).toBe(1);
    expect(b.connection_epoch).toBe(2);
    expect(b.sequence).toBeGreaterThan(a.sequence);
    expect(b.ok && b.data.connection_epoch).toBe(2);
  });
  it("LIVE/BACKFILL delivery is explicit", () => {
    const c = mk();
    expect(c.bars("XAUUSDm", "M5", BRIDGE_T0_S, BRIDGE_T0_S + 900).delivery).toBe("BACKFILL");
    expect(c.bars("XAUUSDm", "M5", BRIDGE_T0_S, BRIDGE_T0_S + 900, "LIVE").delivery).toBe("LIVE");
    expect(c.ticks("XAUUSDm", BRIDGE_T0_S, BRIDGE_T0_S + 60, "LIVE").delivery).toBe("LIVE");
    expect(c.health().delivery).toBe("LIVE");
  });
});

describe("3.0B-1 raw timestamp preservation", () => {
  it("ticks keep raw ms and raw s untouched", () => {
    const e = mk().ticks("XAUUSDm", BRIDGE_T0_S, BRIDGE_T0_S + 60);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.data.items).toEqual(SYNTHETIC_TICKS);
    for (const t of e.data.items) {
      expect(t.time_precision).toBe("ms");
      expect(t.raw_time_s).toBe(Math.floor(t.raw_time_msc / 1000));
      expect(t.raw_time_msc % 1000).not.toBe(0);
    }
  });
  it("bars keep second precision; no ms invented", () => {
    const e = mk().bars("XAUUSDm", "M5", BRIDGE_T0_S, BRIDGE_T0_S + 1500);
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.items).toEqual(SYNTHETIC_BARS);
    for (const b of e.data.items) {
      expect(b.time_precision).toBe("s");
      expect(b).not.toHaveProperty("raw_time_msc");
    }
  });
});

describe("3.0B-1 latency decomposition", () => {
  it("four separate metrics, no generic latency_ms", () => {
    const e = mk().health();
    expect(e.latency).toEqual({
      source_arrival_delay_observed_ms: null,
      bridge_processing_ms: 3,
      bridge_to_client_apparent_delay_ms: 25 - 40, // contaminated by client offset → negative
      transport_rtt_ms: 25 + 3 + 25,
    });
    expect(JSON.stringify(e)).not.toMatch(/"latency_ms"/);
  });
  it("apparent delay ≠ RTT and is offset-contaminated", () => {
    const a = mk({ client_clock_offset_ms: 0 }).health().latency;
    const b = mk({ client_clock_offset_ms: 500 }).health().latency;
    expect(a.transport_rtt_ms).toBe(b.transport_rtt_ms);
    expect(b.bridge_to_client_apparent_delay_ms - a.bridge_to_client_apparent_delay_ms).toBe(500);
  });
  it("source arrival delay = bridge_received − source_event", () => {
    const e = mk().ticks("XAUUSDm", BRIDGE_T0_S, BRIDGE_T0_S + 60);
    const last = SYNTHETIC_TICKS[SYNTHETIC_TICKS.length - 1]!.raw_time_msc;
    expect(e.timing.source_event_at).toBe(last);
    expect(e.latency.source_arrival_delay_observed_ms).toBe(e.timing.bridge_received_at - last);
  });
  it("clock probe estimates offset separately with uncertainty", () => {
    const e = mk().clockProbe();
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.offset_estimate_ms).toBe(40); // bridge − client
    expect(e.data.uncertainty_ms).toBe(e.data.rtt_ms / 2);
  });
});

describe("3.0B-1 terminal info", () => {
  it("ping_last is microseconds; ms = us / 1000", () => {
    const e = mk().terminalInfo();
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.terminal_ping_us).toBe(23_456);
    expect(e.data.terminal_ping_ms).toBe(23.456);
    expect(pingUsToMs(1_000)).toBe(1);
    expect(e.data).not.toHaveProperty("ping_last");
  });
  it("trade_allowed is observation only; grants nothing", () => {
    const e = mk().terminalInfo();
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.trade_allowed_observed).toBe(true);
    expect(e.data.authority).toBe("OBSERVATION_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
  });
});

describe("3.0B-1 structured MT5 errors", () => {
  it("public error is {code, description}; raw tuple kept internally only", () => {
    const c = mk({ injected_errors: { "DISCOVERY.SYMBOLS": [-10005, "IPC timeout"] } });
    const e = c.symbols("*XAU*");
    expect(e.ok).toBe(false);
    if (e.ok) return;
    expect(e.error.kind).toBe("MT5_ERROR");
    expect(e.error.mt5_error).toEqual({ code: -10005, description: "IPC timeout" });
    expect(Array.isArray(e.error.mt5_error)).toBe(false);
    expect(JSON.stringify(e)).not.toMatch(/raw_mt5_error/);
    const prov = c.internalProvenance().find((p) => p.request_id === e.request_id)!;
    expect(prov.raw_mt5_error).toEqual([-10005, "IPC timeout"]);
    expect(e.timing.source_event_at).toBeNull();
    expect(toMt5Error([1, "ok"])).toEqual({ code: 1, description: "ok" });
  });
  it("successful calls record null raw error", () => {
    const c = mk();
    c.health();
    expect(c.internalProvenance()[0]!.raw_mt5_error).toBeNull();
  });
});

describe("3.0B-1 history coverage", () => {
  const cov = (c: MockMT5BridgeClient, from: number, to: number) => {
    const e = c.bars("XAUUSDm", "M5", from, to);
    if (!e.ok) throw new Error("expected ok");
    return e.data.coverage;
  };
  it("synthetic internal gap → PARTIAL", () => {
    const c = cov(mk(), BRIDGE_T0_S, BRIDGE_T0_S + 1500);
    expect(c.coverage_status).toBe("PARTIAL");
    expect(c.returned_count).toBe(4);
    expect(c.reason).toMatch(/gap/);
  });
  it("contiguous but unproven sync → UNKNOWN (not COMPLETE)", () => {
    const c = cov(mk(), BRIDGE_T0_S, BRIDGE_T0_S + 900);
    expect(c.coverage_status).toBe("UNKNOWN");
    expect(c.oldest_returned_at).toBe(BRIDGE_T0_S);
    expect(c.newest_returned_at).toBe(BRIDGE_T0_S + 600);
  });
  it("contiguous + proven sync → COMPLETE", () => {
    expect(cov(mk({ history_synced: true }), BRIDGE_T0_S, BRIDGE_T0_S + 900).coverage_status).toBe("COMPLETE");
  });
  it("range not spanned → PARTIAL even when synced", () => {
    expect(cov(mk({ history_synced: true }), BRIDGE_T0_S - 300, BRIDGE_T0_S + 900).coverage_status).toBe("PARTIAL");
  });
  it("zero bars → EMPTY with nulls", () => {
    const c = cov(mk(), BRIDGE_T0_S + 1500, BRIDGE_T0_S + 1800);
    expect(c).toMatchObject({ coverage_status: "EMPTY", returned_count: 0, oldest_returned_at: null, newest_returned_at: null });
  });
  it("completeness is not inferred from returned_count", () => {
    const three = SYNTHETIC_BARS.slice(0, 3);
    const gapped = [SYNTHETIC_BARS[0]!, SYNTHETIC_BARS[1]!, SYNTHETIC_BARS[3]!];
    expect(computeBarCoverage(three, "M5", BRIDGE_T0_S, BRIDGE_T0_S + 900, true).coverage_status).toBe("COMPLETE");
    expect(computeBarCoverage(gapped, "M5", BRIDGE_T0_S, BRIDGE_T0_S + 900, true).coverage_status).toBe("PARTIAL");
  });
  it("ticks are never COMPLETE", () => {
    const e = mk({ history_synced: true }).ticks("XAUUSDm", BRIDGE_T0_S, BRIDGE_T0_S + 60);
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.coverage.coverage_status).toBe("UNKNOWN");
  });
});

describe("3.0B-1 discovery / resolution", () => {
  it("group filtering supports *, ! and commas", () => {
    expect(matchesGroup("XAUUSDm", "*XAU*")).toBe(true);
    expect(matchesGroup("XAUEURm", "*XAU*,!*EUR*")).toBe(false);
    expect(matchesGroup("BTCUSDm", "*XAU*,*BTC*")).toBe(true);
    const e = mk().symbols("*XAU*");
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.map((s) => s.broker_symbol)).toEqual(["XAUUSDm", "XAUUSDz", "XAUEURm"]);
  });
  it("ambiguous candidates stay UNRESOLVED (no first match)", () => {
    const e = mk().resolveSymbol("XAUUSD", "*XAU*");
    if (!e.ok) throw new Error("expected ok");
    expect(e.data).toMatchObject({ status: "UNRESOLVED", broker_symbol: null, reason: "AMBIGUOUS" });
    expect(e.data.metadata_matches).toEqual(["XAUUSDm", "XAUUSDz"]);
    expect(e.data.candidates).toHaveLength(3);
  });
  it("unique metadata match resolves", () => {
    const e = mk().resolveSymbol("BTCUSD", "*BTC*");
    if (!e.ok) throw new Error("expected ok");
    expect(e.data).toMatchObject({ status: "RESOLVED", broker_symbol: "BTCUSDm", reason: "UNIQUE_METADATA_MATCH" });
  });
  it("filter narrowing to one metadata match resolves", () => {
    const e = mk().resolveSymbol("XAUUSD", "*XAU*,!*z");
    if (!e.ok) throw new Error("expected ok");
    expect(e.data.broker_symbol).toBe("XAUUSDm");
  });
  it("no candidate → UNRESOLVED NO_CANDIDATE", () => {
    const e = mk().resolveSymbol("ETHUSD", "*ETH*");
    if (!e.ok) throw new Error("expected ok");
    expect(e.data).toMatchObject({ status: "UNRESOLVED", reason: "NO_CANDIDATE" });
  });
  it("USER_PINNED resolves only an actual metadata match", () => {
    const e = mk().resolveSymbol("XAUUSD", "*XAU*", "XAUUSDz");
    if (!e.ok) throw new Error("expected ok");
    expect(e.data).toMatchObject({ status: "RESOLVED", broker_symbol: "XAUUSDz", reason: "USER_PINNED" });
  });
  it("PIN_NOT_IN_CANDIDATES stays UNRESOLVED", () => {
    for (const pin of ["XAUEURm", "NOPE"]) {
      const e = mk().resolveSymbol("XAUUSD", "*XAU*", pin);
      if (!e.ok) throw new Error("expected ok");
      expect(e.data).toMatchObject({ status: "UNRESOLVED", broker_symbol: null, reason: "PIN_NOT_IN_CANDIDATES" });
    }
  });
  it("discovery error surfaces as structured error, never a guess", () => {
    const e = mk({ injected_errors: { "DISCOVERY.RESOLVE_SYMBOL": [-1, "generic fail"] } }).resolveSymbol("XAUUSD", "*XAU*");
    expect(e.ok).toBe(false);
    expect(e.data).toBeNull();
  });
});

describe("3.0B-1 capability whitelist", () => {
  const forbidden = ["order_send", "order_check", "EXECUTION.ORDER", "TRADE.SUBMIT", "ACCOUNT.INFO", "POSITIONS.GET", "positions_get"];
  it("whitelist only contains SYSTEM/DISCOVERY/MARKET_DATA", () => {
    for (const c of READ_ONLY_CAPABILITIES) expect(c).toMatch(/^(SYSTEM|DISCOVERY|MARKET_DATA)\./);
  });
  it("execution / non-whitelisted capabilities are rejected", () => {
    const c = mk();
    for (const f of forbidden) {
      expect(isWhitelisted(f)).toBe(false);
      expect(() => assertCapability(f)).toThrow(CapabilityDeniedError);
      expect(() => c.invoke(f)).toThrow(CapabilityDeniedError);
    }
  });
  it("generic invoke is SYSTEM-only; no bypass to typed endpoints", () => {
    const c = mk();
    expect(c.invoke("SYSTEM.HEALTH").capability).toBe("SYSTEM.HEALTH");
    expect(c.invoke("SYSTEM.TERMINAL_INFO").capability).toBe("SYSTEM.TERMINAL_INFO");
    expect(c.invoke("SYSTEM.CLOCK_PROBE").capability).toBe("SYSTEM.CLOCK_PROBE");
    for (const cap of READ_ONLY_CAPABILITIES.filter((x) => !x.startsWith("SYSTEM."))) {
      expect(() => c.invoke(cap)).toThrow(CapabilityDeniedError);
    }
  });
  it("client exposes no execution methods", () => {
    const c = mk() as unknown as Record<string, unknown>;
    for (const m of ["orderSend", "orderCheck", "submitOrder", "placeOrder", "positions", "account", "login"]) expect(c[m]).toBeUndefined();
  });
});

describe("3.0B-1 determinism", () => {
  it("repeated simulation is deep-equal", () => {
    expect(runBridgeSimulation()).toEqual(runBridgeSimulation());
    expect(JSON.stringify(runBridgeSimulation())).toBe(JSON.stringify(runBridgeSimulation()));
  });
  it("reconnect/backfill transcript is deterministic and well-formed", () => {
    const t = runBridgeSimulation().transcript;
    const shape = (x: readonly BridgeEnvelope<unknown>[]) => x.map((e) => [e.sequence, e.connection_epoch, e.capability, e.delivery]);
    expect(shape(t)).toEqual(shape(runBridgeSimulation().transcript));
    const tail = t.slice(-2);
    expect(tail.map((e) => e.connection_epoch)).toEqual([2, 2]);
    expect(tail[1]!.delivery).toBe("BACKFILL");
    expect(t.slice(0, -2).every((e) => e.connection_epoch === 1)).toBe(true);
  });
});

describe("3.0B-1 invariants & safety scan", () => {
  it("MONITOR_ONLY and execution disabled", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
  it("bridge sources contain no live broker or execution surface", () => {
    const files = [...walk("src/core/broker/bridge"), "src/core/fixtures/syntheticBridgeFixture.ts"];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/MetaTrader5|mt5\.initialize|mt5\.login|order_send|order_check|positions_get|account_info|placeOrder|submitOrder|ExecutionIntent/);
      expect(src, f).not.toMatch(/fetch\(|WebSocket\(|XMLHttpRequest|password|credential|Date\.now\(/i);
    }
  });
});
