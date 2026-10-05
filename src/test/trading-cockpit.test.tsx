import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TechnicalSlicePanel, cockpitSignal, referenceEntry } from "@/components/TechnicalSlicePanel";
import type { TradingSnapshot } from "@/core/technical/tradingState";

const snapshot = (entry: TradingSnapshot["entry"]["state"]): TradingSnapshot => ({
  symbol: "XAUUSD", as_of: 1, label: "CURRENT", availability: entry === "NOT_EVALUABLE" ? "UNAVAILABLE" : "AVAILABLE", availability_reason: "OBSERVED",
  quote: { bid: 100, ask: 101, spread: 1, tick_time_ms: 1, observed_at: 1 }, evidence: null, last3_m5: [], engulfing: null,
  bias: { state: "NEUTRAL", reason: "TEST" }, setup: { state: "INACTIVE", reason: "TEST" }, signal: { state: "WAITING", reason: "TEST", triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" },
  execution: { state: "BLOCKED", reasons: ["CAPABILITY_UNAUTHORIZED"] }, entry: { state: entry, reason: "TEST" }, why: [],
  versions: { technical_engine_version: "test", setup_policy_version: "test", signal_policy_version: "test", guard_policy_version: "test" },
});

const reader = (symbol: string, entry: TradingSnapshot["entry"]["state"]) => ({
  symbol, now: () => 1, closedBars: () => [], formingBar: () => null, missingIntervals: () => [], brokerHistoryBars: () => [], firstLiveEventAt: () => null,
  latestLiveObservation: () => ({ seq: 1, symbol, source: "EXNESS_MT5", bid: 100, ask: 101, spread: 1, event_at: 1, observed_at: 1, ingested_at: 1, provenance: {} }),
  snapshot: () => ({ kind: "CANONICAL_MARKET_RUNTIME", operating_mode: "MONITOR_ONLY", execution_enabled: false, symbol, lifecycle: "RUNNING", bootstrap_state: "SYNCHRONIZED", active_epoch: 1, degraded_reason: null, history_coverage_status: "PARTIAL", market_coverage_proven_complete: false, route_counts: { LIVE_MUTATION: 1, BACKFILL_HISTORY: 0, RECONCILIATION_CANDIDATE: 0, QUARANTINED: 0, REJECTED: 0 }, held: [], silent_ambiguous_drops: 0, stream_protocol_errors: 0, last_stream_error: null, timeframes: {} }),
}) as never;

describe("clean trading cockpit", () => {
  it("maps only authoritative entry analysis to cockpit signals and reference sides", () => {
    expect(cockpitSignal(snapshot("LONG_CANDIDATE"))).toBe("BUY");
    expect(referenceEntry(snapshot("LONG_CANDIDATE"))).toBe(101);
    expect(cockpitSignal(snapshot("SHORT_CANDIDATE"))).toBe("SELL");
    expect(referenceEntry(snapshot("SHORT_CANDIDATE"))).toBe(100);
    expect(cockpitSignal(snapshot("WAIT"))).toBe("HOLD");
    expect(cockpitSignal(snapshot("NOT_EVALUABLE"))).toBe("HOLD");
    expect(referenceEntry(snapshot("NOT_EVALUABLE"))).toBeNull();
  });
  it("shows only the selected symbol and keeps diagnostics hidden", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }, { symbol: "BTCUSD", reader: reader("BTCUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("cockpit-XAUUSD")).toBeInTheDocument();
    expect(screen.queryByTestId("cockpit-BTCUSD")).not.toBeInTheDocument();
    expect(screen.queryByText(/CANONICAL_MARKET_RUNTIME|BACKFILL_HISTORY|LIVE_MUTATION|QUARANTINED|protocol errors|state transitions/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BUY reference plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SELL reference plan" })).toBeDisabled();
  });
  it("switches cockpit selection without rendering both technical cards", () => {
    const runtimes = [{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }, { symbol: "BTCUSD", reader: reader("BTCUSD", "WAIT") }];
    const { rerender } = render(<TechnicalSlicePanel runtimes={runtimes} selectedSymbol="XAUUSD" tickMs={60_000} />);
    rerender(<TechnicalSlicePanel runtimes={runtimes} selectedSymbol="BTCUSD" tickMs={60_000} />);
    expect(screen.getByTestId("cockpit-BTCUSD")).toBeInTheDocument();
    expect(screen.queryByTestId("cockpit-XAUUSD")).not.toBeInTheDocument();
  });
  it("never fabricates SL/TP when policy is absent", () => {
    expect(snapshot("LONG_CANDIDATE").execution.state).toBe("BLOCKED");
    expect(snapshot("SHORT_CANDIDATE").execution.state).toBe("BLOCKED");
  });
  it("keeps both actions visible and disabled while HOLD", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("action-buy")).toBeDisabled();
    expect(screen.getByTestId("action-sell")).toBeDisabled();
    expect(screen.getByTestId("action-disabled-reason")).toHaveTextContent(/waiting|test/i);
  });
  it("enables only BUY and opens a read-only plan without execution", () => {
    const brokerOrder = vi.fn();
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "LONG_CANDIDATE") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("action-buy")).toBeEnabled();
    expect(screen.getByTestId("action-sell")).toBeDisabled();
    fireEvent.click(screen.getByTestId("action-buy"));
    expect(screen.getByRole("dialog")).toHaveTextContent("BUY reference plan");
    expect(screen.getByTestId("no-order-status")).toHaveTextContent("MONITOR ONLY — NO ORDER SENT");
    expect(screen.getByRole("dialog")).toHaveTextContent("POLICY PENDING");
    expect(brokerOrder).not.toHaveBeenCalled();
  });
  it("enables only SELL and opens its read-only plan", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "SHORT_CANDIDATE") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("action-buy")).toBeDisabled();
    expect(screen.getByTestId("action-sell")).toBeEnabled();
    fireEvent.click(screen.getByTestId("action-sell"));
    expect(screen.getByRole("dialog")).toHaveTextContent("SELL reference plan");
    expect(screen.getByTestId("no-order-status")).toBeInTheDocument();
  });
});