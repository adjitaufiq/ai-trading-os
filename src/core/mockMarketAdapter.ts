import type { MarketEvent } from "./contracts";

/** Read-only mock adapter. Same interface the ExnessMT5 adapter will satisfy via the API. */
export interface MarketAdapter {
  subscribe(symbol: string, cb: (e: MarketEvent) => void): () => void;
}

const BASE: Record<string, number> = { XAUUSD: 2345.6, BTCUSD: 64250 };

export const mockMarketAdapter: MarketAdapter = {
  subscribe(symbol, cb) {
    let mid = BASE[symbol] ?? 100;
    const id = setInterval(() => {
      mid += (Math.random() - 0.5) * mid * 0.0004;
      const spread = +(mid * 0.00008 + Math.random() * mid * 0.00003).toFixed(2);
      const now = Date.now();
      cb({
        symbol,
        bid: +(mid - spread / 2).toFixed(2),
        ask: +(mid + spread / 2).toFixed(2),
        spread,
        brokerTime: now - Math.floor(Math.random() * 40),
        receivedAt: now,
        source: "MOCK",
      });
    }, 1000);
    return () => clearInterval(id);
  },
};
