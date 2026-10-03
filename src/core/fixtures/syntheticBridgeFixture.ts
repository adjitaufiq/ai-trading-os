// SYNTHETIC bridge fixture. Symbol names, pings, delays, offsets are placeholders,
// NOT measured Exness characteristics (TRS-03 will measure those in 3.0B-2+).
import type { BridgeBar, BridgeSymbolInfo, BridgeTick } from "../broker/bridge/types";

export const BRIDGE_T0 = Date.UTC(2026, 0, 5, 8, 0, 0); // bridge (VPS) clock origin
export const BRIDGE_T0_S = BRIDGE_T0 / 1000;

export interface SyntheticBridgeScript {
  readonly bridge_instance_id: string;
  readonly terminal_connected: boolean;
  readonly terminal_ping_us: number;
  readonly retransmission: number;
  readonly trade_allowed_observed: boolean;
  readonly tradeapi_disabled_observed: boolean;
  /** client_clock − bridge_clock (synthetic). */
  readonly client_clock_offset_ms: number;
  readonly bridge_processing_ms: number;
  readonly one_way_transit_ms: number;
  /** Synthetic broker-clock lag vs bridge clock for source_arrival_delay. */
  readonly source_to_bridge_ms: number;
  readonly symbols: readonly BridgeSymbolInfo[];
  readonly ticks: Readonly<Record<string, readonly BridgeTick[]>>;
  readonly bars: Readonly<Record<string, readonly BridgeBar[]>>;
  /** Whether terminal history sync can be proven (never true by assumption). */
  readonly history_synced: boolean;
  /** Raw opaque last_error tuples injected per capability (internal provenance). */
  readonly injected_errors: Readonly<Partial<Record<string, readonly [number, string]>>>;
}

const sym = (broker_symbol: string, base: string, profit: string, path: string, digits = 2): BridgeSymbolInfo => ({
  broker_symbol, description: `${base}/${profit} synthetic`, path, currency_base: base, currency_profit: profit,
  digits, point: 10 ** -digits, trade_contract_size: base === "XAU" ? 100 : 1,
});

export const SYNTHETIC_SYMBOLS: readonly BridgeSymbolInfo[] = [
  sym("XAUUSDm", "XAU", "USD", "Metals\\Standard"),
  sym("XAUUSDz", "XAU", "USD", "Metals\\Zero"),
  sym("XAUEURm", "XAU", "EUR", "Metals\\Standard"),
  sym("BTCUSDm", "BTC", "USD", "Crypto\\Standard"),
  sym("EURUSDm", "EUR", "USD", "Forex\\Standard", 5),
];

const tk = (i: number, bid: number): BridgeTick => {
  const msc = BRIDGE_T0 + i * 1250 + 7; // ms precision, intentionally non-round
  return { broker_symbol: "XAUUSDm", raw_time_s: Math.floor(msc / 1000), raw_time_msc: msc, time_precision: "ms",
    bid, ask: +(bid + 0.12).toFixed(2), last: 0, volume: 0, flags: 6 };
};
const bar = (i: number, o: number, h: number, l: number, c: number): BridgeBar => ({
  broker_symbol: "XAUUSDm", timeframe: "M5", raw_time_s: BRIDGE_T0_S + i * 300, time_precision: "s",
  open: o, high: h, low: l, close: c, tick_volume: 10 + i, spread: 12, real_volume: 0,
});

export const SYNTHETIC_TICKS: readonly BridgeTick[] = [tk(0, 2345.1), tk(1, 2345.2), tk(2, 2345.05), tk(3, 2345.3)];
/** M5 bars 08:00, 08:05, 08:10, (08:15 missing), 08:20 — internal gap is deliberate. */
export const SYNTHETIC_BARS: readonly BridgeBar[] = [
  bar(0, 2345.1, 2346, 2345, 2345.8),
  bar(1, 2345.8, 2346.4, 2345.6, 2346.2),
  bar(2, 2346.2, 2346.5, 2345.9, 2346.0),
  bar(4, 2346.0, 2346.8, 2345.7, 2346.6),
];

export const BASE_BRIDGE_SCRIPT: SyntheticBridgeScript = {
  bridge_instance_id: "sim-bridge-01",
  terminal_connected: true,
  terminal_ping_us: 23_456,
  retransmission: 0.4,
  trade_allowed_observed: true, // observed only — grants nothing
  tradeapi_disabled_observed: false,
  client_clock_offset_ms: -40,
  bridge_processing_ms: 3,
  one_way_transit_ms: 25,
  source_to_bridge_ms: 120,
  symbols: SYNTHETIC_SYMBOLS,
  ticks: { XAUUSDm: SYNTHETIC_TICKS },
  bars: { "XAUUSDm:M5": SYNTHETIC_BARS },
  history_synced: false,
  injected_errors: {},
};
