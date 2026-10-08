import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TechnicalSlicePanel, TradeActions, cockpitSignal, referenceEntry, tradeProjection } from "@/components/TechnicalSlicePanel";
import { PaperJournalStore } from "@/lib/paperJournal";
import type { TradingSnapshot } from "@/core/technical/tradingState";

const snapshot = (entry: TradingSnapshot["entry"]["state"]): TradingSnapshot => ({
  symbol: "XAUUSD", as_of: 1, label: "CURRENT", availability: entry === "NOT_EVALUABLE" ? "UNAVAILABLE" : "AVAILABLE", availability_reason: "OBSERVED", primary_bias: null, setup_bias: "WAIT", counter_trend_condition: "NONE",
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
    fireEvent.click(screen.getByTestId("cockpit-tab-analysis"));
    expect(screen.getByRole("button", { name: "Jelaskan" })).toBeInTheDocument();
  });
  it("defaults to TRADE tab with RADAR and ANALYSIS hidden", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("cockpit-tab-trade")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("tab-trade")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("tab-radar")).toHaveAttribute("hidden");
    expect(screen.getByTestId("tab-analysis")).toHaveAttribute("hidden");
    expect(screen.getByTestId("tab-radar")).not.toHaveTextContent("simulasi");
    expect(screen.getByTestId("cockpit-bottom-nav")).toHaveClass("fixed", "bottom-0");
  });
  it("switches the mobile bottom navigation without mixing tab content", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    fireEvent.click(screen.getByTestId("cockpit-tab-radar"));
    expect(screen.getByTestId("tab-radar")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("tab-trade")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByTestId("cockpit-tab-analysis"));
    expect(screen.getByTestId("tab-analysis")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("operator-summary")).toHaveAttribute("open");
  });
  it("renders market, setup, and execution as three separate layers", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("layer-market-condition")).toHaveTextContent("Market Condition");
    expect(screen.getByTestId("layer-setup-condition")).toHaveTextContent("Setup Condition");
    expect(screen.getByTestId("layer-execution-state")).toHaveTextContent("Execution State");
    expect(screen.getByTestId("layer-execution-state")).toHaveTextContent("NOT READY");
    expect(screen.getByTestId("radar-state")).toHaveTextContent(/NO SETUP|NOT EVALUABLE/);
  });
  it("renders market context summary directly between signal and trade plan", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    const summary = screen.getByTestId("market-context-summary");
    expect(summary).toHaveTextContent("Market Trend");
    expect(summary).toHaveTextContent("H4");
    expect(summary).toHaveTextContent("H1");
    expect(summary).toHaveTextContent(/WAITING MARKET DATA/);
    const signal = screen.getByTestId("main-signal-card");
    const plan = screen.getByTestId("radar-card");
    expect(signal.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("keeps HOLD neutral and paper actions disabled around the new market context card", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    expect(screen.getByTestId("cockpit-signal")).toHaveTextContent("HOLD");
    expect(screen.getByTestId("action-buy")).toBeDisabled();
    expect(screen.getByTestId("action-sell")).toBeDisabled();
    expect(screen.getByTestId("mc-trend")).not.toHaveTextContent(/BUY|SELL/);
  });
  it("keeps Signal State, Market Context, and Trade Plan in one ordered lifecycle", () => {
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader: reader("XAUUSD", "WAIT") }]} selectedSymbol="XAUUSD" tickMs={60_000} />);
    const signal = screen.getByTestId("main-signal-card");
    const context = screen.getByTestId("market-context-summary");
    const plan = screen.getByTestId("radar-card");
    expect(signal.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("uses one authoritative projection mapping for signal and plan", () => {
    expect(tradeProjection(snapshot("LONG_CANDIDATE"))).toMatchObject({ headline: "BUY READY", status: "READY SETUP", actionable: true });
    expect(tradeProjection(snapshot("SHORT_CANDIDATE"))).toMatchObject({ headline: "SELL READY", status: "READY SETUP", actionable: true });
    expect(tradeProjection(snapshot("WAIT"))).toMatchObject({ headline: "HOLD", status: "WAIT CONFIRMATION", actionable: false });
  });
});