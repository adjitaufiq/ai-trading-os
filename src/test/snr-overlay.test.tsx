import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { EngineHostClient } from "@/core/enginehost/client";
import { parseSnrSnapshot, selectSnrZones } from "@/lib/snrOverlay";
import { useSnrOverlay } from "@/hooks/use-snr-overlay";
import { SnrOverlayLegend } from "@/components/SnrOverlayLegend";
import { SnrZonesPrimitive } from "@/components/SnrZonesPrimitive";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";

const payload = () => ({ symbol: "BTCUSD", timeframe: "H4", zones: [
  { type: "SUPPORT", low: 68000, high: 68200, status: "ACTIVE", strength: 85, volume_score: 78 },
  { type: "RESISTANCE", low: 71000, high: 71200, status: "ACTIVE" },
] });
const snapshot = () => parseSnrSnapshot(payload(), "BTCUSD");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("visual-only SNR contract", () => {
  it("copies host ranges/timeframe, freezes results and discards unsupported scores", () => {
    const result = snapshot();
    expect(result?.zones[0]).toEqual({ type: "SUPPORT", low: 68000, high: 68200, status: "ACTIVE", timeframe: "H4" });
    expect(result).toMatchObject({ strength: null, strength_status: "RESEARCH_REQUIRED", volume_score_status: "RESEARCH_REQUIRED" });
    expect(Object.isFrozen(result?.zones)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("volume_score\":78");
  });
  it("rejects wrong symbol, invalid ranges, unsupported classification and nonfinite prices", () => {
    expect(parseSnrSnapshot(payload(), "XAUUSD")).toBeNull();
    for (const patch of [{ low: 80000 }, { high: Infinity }, { type: "MIXED_ZONE" }, { timeframe: "D1" }, { status: "UNKNOWN" }]) {
      const value = payload(); Object.assign(value.zones[0] ?? {}, patch);
      expect(parseSnrSnapshot(value, "BTCUSD")).toBeNull();
    }
  });
  it("does not relabel inactive zones as active or fabricate missing zones", () => {
    const value = payload(); value.zones.forEach((zone) => { zone.status = "INACTIVE"; });
    expect(parseSnrSnapshot(value, "BTCUSD")?.zones).toEqual([]);
    expect(parseSnrSnapshot({}, "BTCUSD")).toBeNull();
  });
  it("requests only the exact GET endpoint and validates raw and standard envelopes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(payload()));
    const client = new EngineHostClient({ baseUrl: "https://host.example", fetchImpl });
    expect((await client.snr("BTCUSD")).ok).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://host.example/v1/analysis/snr/BTCUSD");
    fetchImpl.mockResolvedValueOnce(Response.json({ schema: "engine-host-v1", source: "ENGINE_HOST", generated_at: 1, data: payload() }));
    expect((await client.snr("BTCUSD")).ok).toBe(true);
    fetchImpl.mockResolvedValueOnce(Response.json({ schema: "other", source: "SIMULATION", data: payload() }));
    expect((await client.snr("BTCUSD")).ok).toBe(false);
  });
  it("fails closed on HTTP, invalid JSON, network and symbol mismatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new EngineHostClient({ baseUrl: "https://host.example", fetchImpl });
    fetchImpl.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await client.snr("BTCUSD")).toEqual({ ok: false, error: "HTTP_404" });
    fetchImpl.mockResolvedValueOnce(new Response("not json"));
    expect((await client.snr("BTCUSD")).ok).toBe(false);
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    expect((await client.snr("BTCUSD")).ok).toBe(false);
    fetchImpl.mockResolvedValueOnce(Response.json(payload()));
    expect((await client.snr("XAUUSD")).ok).toBe(false);
  });
  it("displays source timeframe, exact range without strength labels or confidence percentages", () => {
    const { rerender } = render(<SnrOverlayLegend snapshot={snapshot()} digits={2} />);
    expect(screen.getByTestId("snr-legend")).toHaveTextContent("DEMAND ZONE H4 68000.00 - 68200.00");
    expect(screen.getByTestId("snr-legend")).toHaveTextContent("SUPPLY ZONE H4 71000.00 - 71200.00");
    expect(screen.getByTestId("snr-legend").textContent).not.toMatch(/Strength|Calibration|HIGH|MEDIUM|LOW/);
    expect(screen.getByTestId("snr-legend").textContent).not.toMatch(/85%|78%/);
    rerender(<SnrOverlayLegend snapshot={null} digits={2} />);
    expect(screen.getByTestId("snr-unavailable")).toHaveTextContent("SNR unavailable");
  });
  it("removes old ranges on refresh failure and immediately on symbol change", async () => {
    vi.stubEnv("VITE_ENGINE_HOST_URL", "https://host.example");
    const request = vi.spyOn(EngineHostClient.prototype, "snr").mockResolvedValue({ ok: true, data: snapshot() as NonNullable<ReturnType<typeof snapshot>> });
    function View({ symbol }: { symbol: string }) { const state = useSnrOverlay(symbol); return <SnrOverlayLegend snapshot={state.snapshot} digits={2} />; }
    const { rerender } = render(<View symbol="BTCUSD" />);
    await waitFor(() => expect(screen.getByTestId("snr-legend")).toBeInTheDocument());
    request.mockResolvedValue({ ok: false, error: "HTTP_404" });
    vi.useFakeTimers();
    // Re-mount the effect under the controlled timer, preserving the same read-only request path.
    rerender(<View symbol="XAUUSD" />);
    expect(screen.queryByTestId("snr-legend")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByTestId("snr-unavailable")).toBeInTheDocument();
  });
  it("projects zone boundaries through chart coordinates and clears without changing candles", () => {
    const primitive = new SnrZonesPrimitive({ support: "green", resistance: "red", supportFill: "green", resistanceFill: "red" });
    const priceToCoordinate = vi.fn((price: number) => (72000 - price) / 100);
    const requestUpdate = vi.fn();
    primitive.attached({ series: { priceToCoordinate }, requestUpdate } as unknown as SeriesAttachedParameter<Time>);
    primitive.setZones(snapshot()?.zones ?? []);
    const context = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
    const draw = () => primitive.paneViews()[0]?.renderer()?.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context, mediaSize: { width: 800, height: 600 } }) } as never);
    draw();
    expect(context.fillRect).toHaveBeenCalledWith(0, 38, 800, 2);
    expect(context.fillRect).toHaveBeenCalledWith(0, 8, 800, 2);
    context.fillRect.mockClear(); primitive.setZones([]); draw();
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });
});
import { routeEngineRequest } from "@/core/enginehost/api";
describe("engine host SNR endpoint", () => {
  it("copies operator zones and is parseable by the dashboard", () => {
    const operator = { zones: { H4: [{ role: "SUPPORT", low: 68000, high: 68200 }], M15: [{ role: "RESISTANCE", low: 71000, high: 71100 }] } };
    const host = { symbols: ["BTCUSD"], health: () => ({}), reader: () => null, bundle: () => ({ slice: { current: { operator } } }) } as never;
    const res = routeEngineRequest(host, "GET", "/v1/analysis/snr/BTCUSD", 1);
    expect(res.status).toBe(200);
    const parsed = parseSnrSnapshot(JSON.parse(res.body).data, "BTCUSD");
    expect(parsed?.zones.map((z) => z.timeframe)).toEqual(["H4", "M15"]);
    expect(routeEngineRequest(host, "GET", "/v1/analysis/snr/XAUUSD", 1).status).toBe(404);
  });
});
