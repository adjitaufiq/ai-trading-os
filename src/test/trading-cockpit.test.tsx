import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TechnicalSlicePanel, TradeActions, cockpitSignal, referenceEntry } from "@/components/TechnicalSlicePanel";
import { PaperJournalStore } from "@/lib/paperJournal";
import type { TradingSnapshot } from "@/core/technical/tradingState";

const snapshot = (entry: TradingSnapshot["entry"]["state"]): TradingSnapshot => ({
  symbol: "XAUUSD", as_of: 1, label: "CURRENT", availability: entry === "NOT_EVALUABLE" ? "UNAVAILABLE" : "AVAILABLE", availability_reason: "OBSERVED",
  quote: { bid: 100, ask: 101, spread: 1, tick_time_ms: 1, observed_at: 1 }, evidence: null, last3_m5: [], engulfing: null,
  bias: { state: "NEUTRAL", reason: "TEST" }, setup: { state: "INACTIVE", reason: "TEST" }, signal: { state: "WAITING", reason: "TEST", triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" },
  execution: { state: "BLOCKED", reasons: ["CAPABILITY_UNAUTHORIZED"] }, entry: { state: entry, reason: "TEST" }, why: [],
  reference_plan: { status: "NOT_AVAILABLE", policy_version: "reference-plan-v3-p0.6-local-swing-structural-clamp", reason: "TEST" },
  versions: { technical_engine_version: "test", setup_policy_version: "test", signal_policy_version: "test", reference_plan_policy_version: "test", guard_policy_version: "test" },
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
    expect(screen.getByRole("button", { name: "BUY simulasi" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SELL simulasi" })).toBeDisabled();
  });
  it("switches cockpit selection without rendering both technical cards", () => {
    const runtimes = [{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }, { symbol: "BTCUSD", reader: reader("BTCUSD", "WAIT") }];
    const { rerender } = render(<TechnicalSlicePanel runtimes={runtimes} selectedSymbol="XAUUSD" tickMs={60_000} />);
    rerender(<TechnicalSlicePanel runtimes={runtimes} selectedSymbol="BTCUSD" tickMs={60_000} />);
    expect(screen.getByTestId("cockpit-BTCUSD")).toBeInTheDocument();
    expect(screen.queryByTestId("cockpit-XAUUSD")).not.toBeInTheDocument();
  });
  it("never fabricates SL/TP when required plan evidence is absent", () => {
    expect(snapshot("LONG_CANDIDATE").execution.state).toBe("BLOCKED");
    expect(snapshot("SHORT_CANDIDATE").execution.state).toBe("BLOCKED");
    expect(snapshot("LONG_CANDIDATE").reference_plan.status).toBe("NOT_AVAILABLE");
  });
  it("locks both paper actions and directional styling while HOLD", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} store={new PaperJournalStore(null)} />);
    expect(screen.getByTestId("action-buy")).toBeDisabled();
    expect(screen.getByTestId("action-sell")).toBeDisabled();
    expect(screen.getByTestId("action-buy")).toHaveAttribute("data-highlighted", "false");
    expect(screen.getByTestId("action-sell")).toHaveAttribute("data-highlighted", "false");
    expect(screen.getByTestId("action-disabled-reason")).toHaveTextContent(/OBSERVE ONLY/);
    fireEvent.click(screen.getByTestId("action-buy"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("HOLD cannot open or confirm a paper ticket", () => {
    const onConfirm = vi.fn();
    render(<TradeActions symbol="XAUUSD" signal="HOLD" quote={{ bid: 100, ask: 101 }} reason="TEST" confirmations={[]} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("action-buy"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("highlights BUY on a BUY signal and shows the same-side plan", () => {
    render(<TradeActions signal="BUY" quote={{ bid: 100, ask: 101 }} plan={{ side: "BUY", sl: 98, tp1: 104, tp2: 107, rr: "TP1 1:1 · TP2 1:2" }} reason="TEST" confirmations={["H4 bullish"]} />);
    expect(screen.getByTestId("action-buy")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByTestId("action-sell")).toHaveAttribute("data-highlighted", "false");
    expect(screen.getByTestId("action-buy")).toBeEnabled();
    expect(screen.getByTestId("action-sell")).toBeDisabled();
    fireEvent.click(screen.getByTestId("action-buy"));
    expect(screen.getByRole("dialog")).toHaveTextContent("107.000");
    expect(screen.queryByTestId("manual-label")).not.toBeInTheDocument();
  });
  it("SELL ticket uses BID; MONITOR mode has no confirm", () => {
    render(<TradeActions signal="SELL" quote={{ bid: 100, ask: 101 }} reason="TEST" confirmations={[]} mode="MONITOR" />);
    fireEvent.click(screen.getByTestId("action-sell"));
    expect(screen.getByTestId("ticket-entry")).toHaveTextContent("100.000");
    expect(screen.queryByTestId("confirm-paper")).not.toBeInTheDocument();
    expect(screen.getByTestId("no-order-status")).toHaveTextContent("MONITOR SAJA");
  });
  it("uses concise Indonesian labels on the main cockpit", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByText(/Signal State/i)).toBeInTheDocument();
    expect(screen.getByText("Rencana acuan")).toBeInTheDocument();
    expect(screen.getByText("Konfirmasi teknikal")).toBeInTheDocument();
    expect(screen.getByText("Alasan")).toBeInTheDocument();
    expect(screen.getByText("Penjelasan AI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jelaskan" })).toBeInTheDocument();
  });
  it("renders market, setup, and execution as three separate layers", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("layer-market-condition")).toHaveTextContent("Market Condition");
    expect(screen.getByTestId("layer-setup-condition")).toHaveTextContent("Setup Condition");
    expect(screen.getByTestId("layer-execution-state")).toHaveTextContent("Execution State");
    expect(screen.getByTestId("layer-execution-state")).toHaveTextContent("NOT READY");
    expect(screen.getByTestId("radar-state")).toHaveTextContent(/NO SETUP|NOT EVALUABLE/);
  });
});