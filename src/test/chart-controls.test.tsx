import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MarketCandles } from "@/components/MarketCandles";
import { preserveChartRange, zoomChartRange } from "@/lib/chartViewport";
import type { BridgeBar } from "@/core/broker/gateway/types";

const sdk = vi.hoisted(() => {
  let range = { from: 0, to: 100 };
  const scale = { fitContent: vi.fn(() => { range = { from: 0, to: 100 }; }), getVisibleLogicalRange: vi.fn(() => range), setVisibleLogicalRange: vi.fn((r: typeof range) => { range = r; }) };
  const series = { applyOptions: vi.fn(), setData: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn() };
  return { scale, series, chart: { timeScale: () => scale, priceScale: () => ({ applyOptions: vi.fn() }), addSeries: () => series, subscribeCrosshairMove: vi.fn(), subscribeClick: vi.fn(), unsubscribeCrosshairMove: vi.fn(), unsubscribeClick: vi.fn(), resize: vi.fn(), remove: vi.fn() } };
});
vi.mock("lightweight-charts", () => ({ createChart: () => sdk.chart, CandlestickSeries: {}, ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 } }));
const bars = (start = 0, count = 100): BridgeBar[] => Array.from({ length: count }, (_, i) => ({ broker_symbol: "XAUUSD", timeframe: "M15", raw_time_s: 1700000000 + (start + i) * 900, open: 100, high: 102, low: 99, close: 101 } as BridgeBar));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });

describe("chart controls and persistent viewport", () => {
  it("zooms recent candles, preserves refresh focus, and resets only explicitly", () => {
    const input = bars();
    const props = { bars: input, digits: 2, onInspect: vi.fn(), onActivate: vi.fn(), focus: false };
    const { rerender } = render(<MarketCandles {...props} />);
    expect(sdk.scale.fitContent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("market-chart")).toHaveAttribute("data-snr-annotations", "false");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = sdk.scale.getVisibleLogicalRange();
    expect(zoomed.to - zoomed.from).toBe(70);
    rerender(<MarketCandles {...props} bars={input.map((b, i) => i === 99 ? { ...b, close: 102 } : b)} focus annotationsVisible />);
    expect(sdk.scale.getVisibleLogicalRange()).toEqual(zoomed);
    expect(sdk.scale.fitContent).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(sdk.scale.getVisibleLogicalRange().to - sdk.scale.getVisibleLogicalRange().from).toBeCloseTo(100);
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(sdk.scale.fitContent).toHaveBeenCalledTimes(2);
  });
  it("keeps candle anchors when history rolls or prepends", () => {
    expect(preserveChartRange({ from: 10, to: 30 }, bars(), bars(1))).toEqual({ from: 9, to: 29 });
    expect(preserveChartRange({ from: 10, to: 30 }, bars(), bars(-5, 105))).toEqual({ from: 15, to: 35 });
    expect(zoomChartRange({ from: 0, to: 8 }, 100, "in").to - zoomChartRange({ from: 0, to: 8 }, 100, "in").from).toBeCloseTo(8);
  });
});