import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { RADAR_PLAN_POLICY_VERSION, deriveRadarPlan, planInvariantHolds, type TradingSnapshot } from "@/core/technical/tradingState";
import { PaperJournalStore, openPaper } from "@/lib/paperJournal";
import { compactSummary, engineSignalOf } from "@/lib/tradeSummary";
import { RadarPlanView, TechnicalSlicePanel } from "@/components/TechnicalSlicePanel";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";

const NA = { status: "INSUFFICIENT_HISTORY" };
const zone = (low: number, high: number, role: "SUPPORT" | "RESISTANCE") => ({ source_tf: "M15", low, high, center: (low + high) / 2, touches: 2, role, distance: 1, confluence_tfs: [] });
const evidence = { M5: { rsi14: NA }, M15: { rsi14: NA, atr14: { status: "OK", value: 4 } }, H1: { rsi14: NA, structure: { swings: [{ kind: "LOW", price: 90 }, { kind: "HIGH", price: 120 }] } } } as never;
const op = (status: "CARI_BUY" | "CARI_SELL" | "HOLD", zones: ReturnType<typeof zone>[]) => ({
  status, reason: "TRIGGER_PENDING", ema_confluence: { zone: "NOT_NEAR", timeframe: null }, patterns: { M5: { bullish: [], bearish: [] }, M15: { bullish: [], bearish: [] } }, zones: { M15: zones }, scalp: { local_zones: zones, M15: { ema21: NA, ema50: NA, atr14: NA, ema_location: "NOT_NEAR", ema_reaction: [] }, M5: { ema21: NA, ema50: NA, atr14: NA, ema_location: "NOT_NEAR", ema_reaction: [] } },
}) as never;
const q = (bid: number, ask: number) => ({ bid, ask, spread: ask - bid, tick_time_ms: 1, observed_at: 1 });
const WAIT = { state: "WAIT" as const, reason: "NO_CLOSED_TRIGGER" };
const NOREF = { status: "NOT_AVAILABLE" as const, policy_version: "reference-plan-v2-swing-atr-plus-sr-context" as const, reason: "WAIT" };

const snap = (o: never, quote: ReturnType<typeof q>): TradingSnapshot => ({
  symbol: "BTCUSD", as_of: 1, label: "CURRENT", availability: "AVAILABLE", availability_reason: "OBSERVED", quote, evidence, last3_m5: [], engulfing: null,
  bias: { state: "BUY", reason: "T" }, setup: { state: "INACTIVE", reason: "T" },
  signal: { state: "WAITING", reason: "T", triggered_at: null, trigger_bar: null, trigger_evidence: null, validity_policy: "RESEARCH_REQUIRED" },
  execution: { state: "BLOCKED", reasons: ["CAPABILITY_UNAUTHORIZED"] }, entry: WAIT, why: [], reference_plan: NOREF, operator: o,
  radar_plan: deriveRadarPlan(WAIT, quote, evidence, o, NOREF),
  versions: { technical_engine_version: "t", setup_policy_version: "t", signal_policy_version: "t", reference_plan_policy_version: "t", guard_policy_version: "t" },
});

describe("radar plan (projected, dynamic)", () => {
  it("CARI_BUY + HOLD ⇒ AVAILABLE BUY projection with BUY invariant, projected zone edge when price is above zone", () => {
    const r = deriveRadarPlan(WAIT, q(104.9, 105.1), evidence, op("CARI_BUY", [zone(97, 99, "SUPPORT")]), NOREF);
    expect(r).toMatchObject({ policy_version: RADAR_PLAN_POLICY_VERSION, mode: "RADAR", status: "AVAILABLE", side: "BUY", reference_entry: 99, executable_now: false, sl: 89, tp1: 109, tp2: 119 });
    expect(r.zone).toMatchObject({ low: 97, high: 99, sources: ["M15_SUPPORT"] });
    expect(planInvariantHolds("BUY", r.sl!, r.reference_entry!, r.tp1!, r.tp2!)).toBe(true);
    expect(r.reference_entry).not.toBe(105.1);
  });
  it("price inside BUY zone ⇒ executable ASK", () => {
    const r = deriveRadarPlan(WAIT, q(98, 98.2), evidence, op("CARI_BUY", [zone(97, 99, "SUPPORT")]), NOREF);
    expect(r).toMatchObject({ status: "AVAILABLE", reference_entry: 98.2, executable_now: true });
  });
  it("CARI_SELL mirror with SELL invariant", () => {
    const r = deriveRadarPlan(WAIT, q(105, 105.2), evidence, op("CARI_SELL", [zone(110, 112, "RESISTANCE")]), NOREF);
    expect(r).toMatchObject({ mode: "RADAR", status: "AVAILABLE", side: "SELL", reference_entry: 110, sl: 121, tp1: 99, tp2: 88 });
    expect(planInvariantHolds("SELL", r.sl!, r.reference_entry!, r.tp1!, r.tp2!)).toBe(true);
  });
  it("no zone ⇒ WAITING_FOR_AREA with no numbers; no direction ⇒ NO_DIRECTION", () => {
    const w = deriveRadarPlan(WAIT, q(105, 105.2), evidence, op("CARI_BUY", []), NOREF);
    expect(w).toMatchObject({ status: "WAITING_FOR_AREA", sl: null, tp1: null, reference_entry: null });
    expect(deriveRadarPlan(WAIT, q(105, 105.2), evidence, op("HOLD", []), NOREF)).toMatchObject({ mode: "NONE", status: "NO_DIRECTION", sl: null });
  });
  it("invalid risk ⇒ NOT_AVAILABLE, never fabricated", () => {
    const r = deriveRadarPlan(WAIT, q(85, 85.2), evidence, op("CARI_BUY", [zone(84, 88, "SUPPORT")]), NOREF);
    expect(r.status).toBe("NOT_AVAILABLE"); expect(r.tp1).toBeNull();
  });
});

describe("manual early paper trades freeze a rebased plan", () => {
  it("manual early BUY uses ASK and the same plan builder; engine signal untouched", () => {
    const s = snap(op("CARI_BUY", [zone(97, 99, "SUPPORT")]), q(104.9, 105.1));
    const before = JSON.stringify(s);
    const p = openPaper({ symbol: "BTCUSD", side: "BUY", quote: { bid: 104.9, ask: 105.1 }, now: 1, snapshot: s, id: "x" });
    expect(p.entry).toBe(105.1); expect(p.sl).toBe(89);
    expect(p.tp1).toBeCloseTo(121.2); expect(p.tp2).toBeCloseTo(137.3);
    expect(p).toMatchObject({ action_source: "MANUAL_EARLY", engine_search: "CARI_BUY", engine_actionable_signal: "HOLD", plan_source: "RADAR_REBASED_TO_ACTUAL_ENTRY" });
    expect(JSON.stringify(s)).toBe(before); expect(engineSignalOf(s)).toBe("HOLD");
  });
  it("manual early SELL uses BID; opposite side tagged MANUAL_AGAINST_ENGINE", () => {
    const s = snap(op("CARI_SELL", [zone(110, 112, "RESISTANCE")]), q(105, 105.2));
    const p = openPaper({ symbol: "BTCUSD", side: "SELL", quote: { bid: 105, ask: 105.2 }, now: 1, snapshot: s, id: "y" });
    expect(p.entry).toBe(105); expect(p.sl).toBe(121); expect(p.tp1).toBe(89);
    expect(p.action_source).toBe("MANUAL_EARLY");
    const against = openPaper({ symbol: "BTCUSD", side: "BUY", quote: { bid: 105, ask: 105.2 }, now: 1, snapshot: s, id: "z" });
    expect(against.action_source).toBe("MANUAL_AGAINST_ENGINE");
  });
  it("journal stores tag + frozen plan-at-open; summary carries radar fields", () => {
    const st = new PaperJournalStore(null);
    const s = snap(op("CARI_BUY", [zone(97, 99, "SUPPORT")]), q(104.9, 105.1));
    st.open({ symbol: "BTCUSD", side: "BUY", quote: { bid: 104.9, ask: 105.1 }, now: 1, snapshot: s });
    const e = st.getState().journal[0]!;
    expect(e.type).toBe("TRADE_OPEN");
    if (e.type === "TRADE_OPEN" || e.type === "TRADE_CLOSE") { expect(e.position).toMatchObject({ action_source: "MANUAL_EARLY", sl: 89, entry: 105.1 }); expect(e.position.policy_versions?.['radar_plan_policy_version']).toBe(RADAR_PLAN_POLICY_VERSION); }
    expect(compactSummary(s)).toMatchObject({ radar_plan_status: "RADAR:AVAILABLE", radar_side: "BUY", radar_reference_entry: 99, projected_sl: 89, radar_plan_policy_version: RADAR_PLAN_POLICY_VERSION });
    expect(JSON.stringify(e).length).toBeLessThan(20_000);
  });
});

describe("radar card UI", () => {
  it("RADAR shows dynamic projection label, never 'signal ready'", () => {
    const s = snap(op("CARI_BUY", [zone(97, 99, "SUPPORT")]), q(104.9, 105.1));
    render(<RadarPlanView radar={s.radar_plan!} signal="HOLD" entry={null} />);
    expect(screen.getByTestId("radar-badge")).toHaveTextContent("RADAR DINAMIS");
    expect(screen.getByTestId("radar-projection-label")).toHaveTextContent("PROYEKSI — BELUM SIGNAL ENTRY");
    expect(screen.getByTestId("radar-note")).toHaveTextContent("Proyeksi dapat berubah sampai signal READY.");
    expect(screen.getByTestId("plan-sl")).toHaveTextContent("89.000");
    expect(screen.queryByText(/SIGNAL PLAN|SIAP/)).not.toBeInTheDocument();
  });
  it("no direction ⇒ BELUM ADA ARAH and no targets", () => {
    render(<RadarPlanView radar={null} signal="HOLD" entry={null} />);
    expect(screen.getByTestId("radar-status")).toHaveTextContent("BELUM ADA ARAH");
    expect(screen.getByTestId("plan-tp1")).toHaveTextContent("—");
  });
  it("old H4/H1 EMA5 vs EMA21 cards absent from the main cockpit", () => {
    const reader = { symbol: "XAUUSD", now: () => 1, closedBars: () => [], formingBar: () => null, missingIntervals: () => [], brokerHistoryBars: () => [], firstLiveEventAt: () => null, latestLiveObservation: () => null, snapshot: () => ({ kind: "CANONICAL_MARKET_RUNTIME", operating_mode: "MONITOR_ONLY", execution_enabled: false, symbol: "XAUUSD", lifecycle: "RUNNING", bootstrap_state: "SYNCHRONIZED", active_epoch: 1, degraded_reason: null, history_coverage_status: "PARTIAL", market_coverage_proven_complete: false, route_counts: { LIVE_MUTATION: 1, BACKFILL_HISTORY: 0, RECONCILIATION_CANDIDATE: 0, QUARANTINED: 0, REJECTED: 0 }, held: [], silent_ambiguous_drops: 0, stream_protocol_errors: 0, last_stream_error: null, timeframes: {} }) } as never;
    render(<TechnicalSlicePanel runtimes={[{ symbol: "XAUUSD", reader }]} selectedSymbol="XAUUSD" tickMs={60_000} store={new PaperJournalStore(null)} />);
    expect(screen.queryByText(/Tren H[14]/)).not.toBeInTheDocument();
    expect(screen.getByTestId("radar-card")).toBeInTheDocument();
  });
  it("no broker/order path; safety unchanged", () => {
    for (const f of ["src/core/technical/tradingState.ts", "src/lib/paperJournal.ts", "src/components/TechnicalSlicePanel.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/order_send|BrokerGatewayClient|placeOrder|fetch\(/);
    }
    expect(OPERATING_MODE).toBe("MONITOR_ONLY"); expect(EXECUTION_ENABLED).toBe(false);
  });
});
