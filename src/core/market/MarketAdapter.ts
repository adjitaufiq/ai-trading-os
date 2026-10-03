import type { MarketEvent, MarketSource } from "../contracts";

/** Read-only market data boundary. No order methods exist by design. */
export interface MarketAdapter {
  readonly source: MarketSource;
  subscribe(symbol: string, cb: (e: MarketEvent) => void): () => void;
}
