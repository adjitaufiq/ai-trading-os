// Central symbol metadata. Pre-registered specs are SYNTHETIC (not measured Exness values) until broker-reported.
import type { SymbolMetadata } from "./types";

const DEFAULTS: readonly SymbolMetadata[] = [
  { symbol: "BTCUSD", assetClass: "CRYPTO", origin: "SYNTHETIC", digits: 2, point: 0.01, tick_size: 0.01, contract_size: 1, broker_utc_offset_ms: 0, minLot: 0.01, maxLot: 100 },
  { symbol: "XAUUSD", assetClass: "COMMODITY", origin: "SYNTHETIC", digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0, minLot: 0.01, maxLot: 200 },
];

export class SymbolRegistry {
  private readonly map = new Map<string, SymbolMetadata>();
  constructor(initial: readonly SymbolMetadata[] = DEFAULTS) { for (const m of initial) this.register(m); }

  register(meta: SymbolMetadata): void {
    if (!(meta.point > 0)) throw new Error(`INVALID_POINT:${meta.symbol}`);
    this.map.set(meta.symbol.toUpperCase(), Object.freeze({ ...meta }));
  }

  /** Exact match first, then broker-suffix fallback (e.g. "XAUUSDm" → XAUUSD). Undefined when unknown; never guesses. */
  get(symbol: string): SymbolMetadata | undefined {
    const s = symbol.toUpperCase();
    const exact = this.map.get(s);
    if (exact) return exact;
    for (const [k, v] of this.map) if (s.startsWith(k) && s.length - k.length <= 3) return v;
    return undefined;
  }

  require(symbol: string): SymbolMetadata {
    const m = this.get(symbol);
    if (!m) throw new Error(`UNREGISTERED_SYMBOL:${symbol}`);
    return m;
  }
}

export const defaultSymbolRegistry = new SymbolRegistry();
