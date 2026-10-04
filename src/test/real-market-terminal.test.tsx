import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RealMarketTerminal, formatMarketPrice } from "@/components/RealMarketTerminal";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import type { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import type { BridgeBar } from "@/core/broker/gateway/types";

vi.mock("@/components/MarketCandles", () => ({ MarketCandles: ({ bars }: { bars: readonly BridgeBar[] }) => <div data-testid="mock-chart" data-count={bars.length}>{bars[0]?.broker_symbol}</div> }));
const spec = (symbol: string) => ({ broker_symbol: symbol, description: symbol, path: "Markets", currency_base: symbol.slice(0, 3), currency_profit: "USD", digits: symbol === "BTCUSD" ? 2 : 3, point: 0.001, trade_contract_size: 100 });
const tick = (symbol: string) => ({ broker_symbol: symbol, raw_time_s: 1790974679, raw_time_msc: 1790974679954, time_precision: "ms", bid: symbol === "BTCUSD" ? 85340.34 : 4140.348, ask: symbol === "BTCUSD" ? 85347.34 : 4140.53, last: 0, volume: 0, flags: 6 });
const bar = (symbol: string, tf: string): BridgeBar => ({ broker_symbol: symbol, timeframe: tf, raw_time_s: 1790973900, time_precision: "s", open: symbol === "BTCUSD" ? 85340.34 : 4138.554, high: 85348.71, low: 4135.741, close: 85343.58, tick_volume: 544, spread: 168, real_volume: 0 } as BridgeBar);
const ok = <T,>(data: T, delivery: "LIVE" | "BACKFILL" = "LIVE") => ({ ok: true as const, data, envelope: { source: "EXNESS_MT5", source_mode: "REAL", delivery }, sequence: { disposition: "ACCEPT" as const, observations: [] } });
function fakeClient(fail = false) {
  const getLatestTick = vi.fn(async (symbol: string) => fail ? ({ ok: false as const, error: { kind: "TIMEOUT", message: "request timed out" } }) : ok(tick(symbol)));
  const getSymbol = vi.fn(async (symbol: string) => ok(spec(symbol)));
  const getBars = vi.fn(async ({ symbol, timeframe }: { symbol: string; timeframe: string }) => ok({ items: [bar(symbol, timeframe)], coverage: {} }, "BACKFILL"));
  const getHealth = vi.fn(async () => ok({ terminal_connected: true }));
  return { getLatestTick, getSymbol, getBars, getHealth };
}
const setup = (client = fakeClient(), now = () => 1790974684954) => render(<RealMarketTerminal client={client as unknown as BrokerGatewayClient} now={now} pollMs={60000} />);

describe("real dual-market monitor terminal", () => {
  it("keeps real gold quote, derived spread, broker candles and explicit monitor-only absence of execution", async () => {
    const client = fakeClient(); setup(client);
    await waitFor(() => expect(screen.getByTestId("bid")).toHaveTextContent("4140.348"));
    await waitFor(() => expect(screen.getByTestId("mock-chart")).toHaveTextContent("XAUUSD"));
    expect(screen.getByTestId("ask")).toHaveTextContent("4140.530");
    expect(screen.getByTestId("spread")).toHaveTextContent("0.182");
    expect(screen.getByTestId("ohlc-open")).toHaveTextContent("4138.554");
    expect(screen.getByTestId("freshness")).toHaveTextContent("FRESH");
    expect(screen.getByTestId("candle-time")).toHaveTextContent("UTC");
    expect(client.getBars).toHaveBeenCalledWith({ symbol: "XAUUSD", timeframe: "M5", mode: "pos", start: 0, count: 200 });
    expect(OPERATING_MODE).toBe("MONITOR_ONLY"); expect(EXECUTION_ENABLED).toBe(false);
    expect(screen.getByText(/EXECUTION ABSENT/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(buy|sell|order)/i })).not.toBeInTheDocument();
  });
  it("switches markets and all timeframes without cross-symbol candles; focus is chart-only", async () => {
    const client = fakeClient(); setup(client);
    await waitFor(() => expect(screen.getByTestId("mock-chart")).toHaveTextContent("XAUUSD"));
    fireEvent.click(screen.getByTestId("select-BTCUSD"));
    await waitFor(() => expect(screen.getByTestId("mock-chart")).toHaveTextContent("BTCUSD"));
    expect(screen.getByTestId("bid")).toHaveTextContent("85340.34");
    for (const tf of ["M15", "H1", "H4", "M5"]) {
      fireEvent.click(screen.getByTestId(`timeframe-${tf}`));
      await waitFor(() => expect(client.getBars).toHaveBeenCalledWith({ symbol: "BTCUSD", timeframe: tf, mode: "pos", start: 0, count: 200 }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Focus chart" }));
    expect(screen.getByRole("dialog", { name: "Chart focus mode" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close chart focus" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows unavailable rather than simulated data on gateway failure, and stale broker tick stays stale", async () => {
    setup(fakeClient(true));
    await waitFor(() => expect(screen.getByTestId("quote-error")).toHaveTextContent("DATA UNAVAILABLE"));
    expect(screen.getByTestId("bid")).toHaveTextContent("—");
    expect(screen.queryByText("2347.30")).not.toBeInTheDocument();
  });
  it("preserves precision policy without altering raw market values", () => {
    expect(formatMarketPrice(4140.348, null)).toBe("4140.348");
    expect(formatMarketPrice(4140.53, 3)).toBe("4140.530");
    expect(formatMarketPrice(85340.34, 2)).toBe("85340.34");
  });
});
