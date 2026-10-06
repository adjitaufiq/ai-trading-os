import { describe, expect, it } from "vitest";
import { SymbolRegistry, defaultSymbolRegistry } from "../../../core/broker/SymbolRegistry";
import { resolveMarketSession } from "../../../core/temporal/MarketSessionResolver";
import { fromPaperTrade, slippagePoints, TradeJournal } from "../tradeJournal";
import { updatePosition } from "../../execution/positionManager";
import { candle, openTrade, T } from "../../execution/tests/helpers";

const SAT = Date.UTC(2024, 0, 6, 12); // Saturday 12:00 UTC

describe("SymbolRegistry", () => {
  it("BTCUSD is CRYPTO, XAUUSD is COMMODITY", () => {
    expect(defaultSymbolRegistry.require("BTCUSD").assetClass).toBe("CRYPTO");
    expect(defaultSymbolRegistry.require("XAUUSD").assetClass).toBe("COMMODITY");
  });
  it("broker suffix fallback and explicit registration; unknown never guessed", () => {
    const r = new SymbolRegistry();
    expect(r.get("XAUUSDm")?.symbol).toBe("XAUUSD");
    expect(r.get("EURUSD")).toBeUndefined();
    expect(() => r.require("EURUSD")).toThrow("UNREGISTERED_SYMBOL");
    r.register({ symbol: "EURUSD", assetClass: "FOREX", origin: "SYNTHETIC", digits: 5, point: 0.00001, tick_size: 0.00001, contract_size: 100000, broker_utc_offset_ms: 0 });
    expect(r.require("EURUSD").assetClass).toBe("FOREX");
  });
});

describe("MarketSessionResolver", () => {
  it("Saturday: BTCUSD WEEKEND, XAUUSD MARKET_CLOSED", () => {
    expect(resolveMarketSession(SAT, "CRYPTO")).toBe("WEEKEND");
    expect(resolveMarketSession(SAT, "COMMODITY")).toBe("MARKET_CLOSED");
  });
  it("weekday sessions and commodity Friday close / Sunday reopen", () => {
    const wed = (h: number) => Date.UTC(2024, 0, 3, h);
    expect([2, 9, 15, 22].map((h) => resolveMarketSession(wed(h), "COMMODITY"))).toEqual(["ASIA", "LONDON", "NY", "OVERNIGHT"]);
    expect(resolveMarketSession(wed(15), "CRYPTO")).toBe("NY");
    expect(resolveMarketSession(Date.UTC(2024, 0, 5, 22), "COMMODITY")).toBe("MARKET_CLOSED");
    expect(resolveMarketSession(Date.UTC(2024, 0, 7, 21), "COMMODITY")).toBe("MARKET_CLOSED");
    expect(resolveMarketSession(Date.UTC(2024, 0, 7, 23), "COMMODITY")).toBe("OVERNIGHT");
    expect(resolveMarketSession(Date.UTC(2024, 0, 7, 23), "CRYPTO")).toBe("WEEKEND");
  });
});

describe("journal dataset fields", () => {
  it("slippage direction: positive adverse, negative improvement", () => {
    expect(slippagePoints("BUY", 2000, 2000.3, 0.001)).toBe(300);
    expect(slippagePoints("SELL", 2000, 1999.7, 0.001)).toBe(300);
    expect(slippagePoints("BUY", 2000, 1999.9, 0.001)).toBe(-100);
    expect(slippagePoints("SELL", 2000, 2000.1, 0.001)).toBe(-100);
  });
  it("paper row populated from fill, latency 0, stored frozen", () => {
    const closed = updatePosition(openTrade(), candle({ high: 2009 }), T + 300).trade;
    const row = fromPaperTrade(closed, { h1Phase: "PULLBACK", locationTier: "TIER_1", rr: 1.6 })!;
    expect(row).toMatchObject({ assetClass: "COMMODITY", plannedEntryPrice: closed.fill.marketPrice, actualEntryPrice: closed.fill.actualEntry, latencyMs: 0 });
    expect(row.slippagePoints).toBeGreaterThan(0);
    expect(row.session).toBe(resolveMarketSession(closed.openedAt! * 1000, "COMMODITY"));
    expect(row.primaryFailureCategory).toBeUndefined();
    const j = new TradeJournal(); const r = j.saveTrade(row); if (!r.ok) throw new Error();
    expect(() => { (r.trade as { slippagePoints: number }).slippagePoints = 0; }).toThrow();
  });
});
