import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseSnrSnapshot, selectSnrZones } from "@/lib/snrOverlay";
import { snrPayload } from "@/core/enginehost/snr";
import type { OperatorAnalysis } from "@/core/technical/operator";
import { SnrOverlayLegend } from "@/components/SnrOverlayLegend";
import { SnrZonesPrimitive } from "@/components/SnrZonesPrimitive";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

const zones = () => ["H4", "H1", "M15", "M5"].flatMap((timeframe) => ["SUPPORT", "RESISTANCE"].flatMap((type) =>
  Array.from({ length: 10 }, (_, i) => ({ timeframe, type, low: 100 + i * 10, high: 102 + i * 10, status: "ACTIVE" }))));
const swing = { kind: "HIGH", timeframe: "H4", price: 142, pivot_time: 1000, confirmed_at: 2000, available_at: 2100 } as const;

describe("clean SNR projection", () => {
  it("caps each side per timeframe, keeps nearest ranges, hides M5 and preserves raw snapshot", () => {
    const snapshot = parseSnrSnapshot({ symbol: "XAUUSD", timeframe: "H4", zones: zones(), price: 141 }, "XAUUSD");
    const before = JSON.stringify(snapshot);
    const shown = selectSnrZones(snapshot, null);
    expect(shown).toHaveLength(18);
    expect(shown.some((z) => z.timeframe === "M5")).toBe(false);
    for (const timeframe of ["H4", "H1", "M15"]) for (const type of ["SUPPORT", "RESISTANCE"]) {
      expect(shown.filter((z) => z.timeframe === timeframe && z.type === type).map((z) => z.low)).toEqual([140, 130, 150]);
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(snapshot?.zones).toHaveLength(80);
    expect(selectSnrZones(snapshot, 141, "H4")).toHaveLength(6);
    expect(selectSnrZones(snapshot, 141, "H1")).toHaveLength(12);
  });
  it("does not fabricate a price, render inactive zones or repeat identical ranges", () => {
    const snapshot = parseSnrSnapshot({ symbol: "XAUUSD", timeframe: "H4", zones: [...zones(), ...zones(), { type: "SUPPORT", low: 140, high: 142, status: "INACTIVE" }] }, "XAUUSD");
    expect(selectSnrZones(snapshot, null)).toEqual([]);
    expect(selectSnrZones(snapshot, Infinity)).toEqual([]);
    const shown = selectSnrZones(snapshot, 141);
    expect(shown).toHaveLength(18);
    expect(shown.every((z) => z.status === "ACTIVE")).toBe(true);
  });
  it("copies only engine-confirmed and available swings, with legacy absence remaining empty", () => {
    const base = { symbol: "XAUUSD", timeframe: "H4", zones: [], as_of: 2100, swings: [swing, { ...swing, available_at: 2200 }, { ...swing, confirmed_at: 2200, available_at: 2300 }] };
    expect(parseSnrSnapshot(base, "XAUUSD")?.swings).toEqual([swing]);
    expect(parseSnrSnapshot({ ...base, as_of: undefined }, "XAUUSD")?.swings).toEqual([]);
    expect(parseSnrSnapshot({ ...base, swings: [{ ...swing, confirmed_at: 500 }] }, "XAUUSD")).toBeNull();
    expect(parseSnrSnapshot({ ...base, swings: undefined }, "XAUUSD")?.swings).toEqual([]);
  });
  it("host only projects existing swings and keeps all raw zones", () => {
    const operator = { price: 141, zones: { H4: Array.from({ length: 100 }, (_, i) => ({ role: "SUPPORT", low: i + 1, high: i + 2 })) }, per_tf: { H4: { events: { recent: [swing, { ...swing, available_at: 2200 }] } } } } as unknown as OperatorAnalysis;
    const before = JSON.stringify(operator);
    const payload = snrPayload("XAUUSD", operator, 2100);
    expect(payload?.zones).toHaveLength(100);
    expect(payload?.swings).toEqual([swing]);
    expect(JSON.stringify(operator)).toBe(before);
  });
  it("legend lists only selected exact zones, has no strength labels and is collapsed", () => {
    const snapshot = parseSnrSnapshot({ symbol: "XAUUSD", timeframe: "H4", zones: zones(), price: 141 }, "XAUUSD");
    render(<SnrOverlayLegend snapshot={snapshot} zones={selectSnrZones(snapshot, 141, "H4")} digits={2} />);
    const legend = screen.getByTestId("snr-legend");
    expect(legend).not.toHaveAttribute("open");
    expect(legend).toHaveTextContent("SUPPLY ZONE H4 140.00 - 142.00");
    expect(legend).toHaveTextContent("DEMAND ZONE H4 140.00 - 142.00");
    expect(legend.textContent).not.toMatch(/Strength|HIGH|MEDIUM|LOW|Calibration|RESEARCH_REQUIRED/);
  });
  it("projects swing time/price and suppresses overlapping zone labels, clears markers on toggle", () => {
    const primitive = new SnrZonesPrimitive({ support: "green", resistance: "red", supportFill: "green", resistanceFill: "red" });
    const timeToCoordinate = vi.fn(() => 200);
    primitive.attached({ series: { priceToCoordinate: () => 100 }, chart: { timeScale: () => ({ timeToCoordinate }) }, requestUpdate: vi.fn() } as unknown as SeriesAttachedParameter<Time>);
    const snapshot = parseSnrSnapshot({ symbol: "XAUUSD", timeframe: "H4", price: 141, zones: zones(), as_of: 2100, swings: [swing] }, "XAUUSD");
    primitive.setZones(selectSnrZones(snapshot, 141), 2);
    primitive.setSwings(snapshot?.swings ?? []);
    const context = { save: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 150 }), fillRect: vi.fn(), fillText: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), closePath: vi.fn(), fill: vi.fn() };
    const draw = () => primitive.paneViews()[1]?.renderer()?.draw({ useMediaCoordinateSpace: (cb: (scope: unknown) => void) => cb({ context, mediaSize: { width: 800, height: 600 } }) } as never);
    draw();
    expect(timeToCoordinate).toHaveBeenCalledWith(1);
    expect(context.fillText.mock.calls.filter(([text]) => String(text).includes("ZONE"))).toHaveLength(1);
    expect(context.fillText).toHaveBeenCalledWith("Swing High H4", 160, 83);
    primitive.setZones([]); primitive.setSwings([]); context.fillText.mockClear(); draw();
    expect(context.fillText).not.toHaveBeenCalled();
  });
});