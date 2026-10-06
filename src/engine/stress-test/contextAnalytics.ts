// M7 context analytics — descriptive grouping of journal outcomes by the
// m2-context-v1 snapshot. No scores, no thresholds that act, no feedback.
import type { JournalTrade } from "../journal/types";
import type { ContextBucket, ContextCounters, ContextReport } from "./types";

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const rOf = (t: JournalTrade) => { const R = Math.abs(t.entryPrice - t.stopLoss); return R > 0 ? (t.exitPrice - t.entryPrice) * (t.direction === "BUY" ? 1 : -1) / R : 0; };

function bucketize(trades: readonly JournalTrade[], keysOf: (t: JournalTrade) => readonly string[]): ContextBucket[] {
  const m = new Map<string, JournalTrade[]>();
  for (const t of trades) for (const k of keysOf(t)) { const a = m.get(k) ?? []; a.push(t); m.set(k, a); }
  return [...m.entries()].map(([key, ts]) => {
    const wins = ts.filter((t) => t.result === "WIN").length, losses = ts.filter((t) => t.result === "LOSS").length;
    return { key, trades: ts.length, wins, losses, winRate: r4(wins / ts.length), expectancyR: r4(ts.reduce((a, t) => a + rOf(t), 0) / ts.length) };
  }).sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

export function buildContextReport(trades: readonly JournalTrade[], c: ContextCounters): ContextReport {
  const withCtx = trades.filter((t) => t.contextSnapshot);
  const cs = (t: JournalTrade) => t.contextSnapshot!;
  const sweepTrades = withCtx.filter((t) => cs(t).eventReferences.some((e) => e.type === "LIQUIDITY_SWEEP"));
  const created = Object.values(c.eventsCreated).reduce((a, b) => a + b, 0);
  return {
    counters: c,
    byRegime: bucketize(withCtx, (t) => [cs(t).regime ?? "NONE"]),
    byHorizon: bucketize(withCtx, (t) => [cs(t).horizon ?? "NONE"]),
    byFootprint: bucketize(withCtx, (t) => (cs(t).footprintTags.length ? cs(t).footprintTags : ["NO_FOOTPRINT"])),
    byEvent: bucketize(withCtx, (t) => { const ks = [...new Set(cs(t).eventReferences.map((e) => e.type))]; return ks.length ? ks : ["NO_ACTIVE_EVENT"]; }),
    sweepImpact: {
      created: c.eventsCreated["LIQUIDITY_SWEEP"] ?? 0,
      resolved: c.eventsEnded["LIQUIDITY_SWEEP:RESOLVED"] ?? 0,
      expired: c.eventsEnded["LIQUIDITY_SWEEP:EXPIRED"] ?? 0,
      tradesWithActiveSweep: sweepTrades.length,
      avgOutcomeR: sweepTrades.length ? r4(sweepTrades.reduce((a, t) => a + rOf(t), 0) / sweepTrades.length) : 0,
    },
    audit: {
      contextCoverage: trades.length ? r4(withCtx.length / trades.length) : 1,
      eventsPer1000Bars: c.observedBars ? r4((created / c.observedBars) * 1000) : 0,
      regimeFlipsPer1000Bars: c.observedBars ? r4((c.regimeFlips / c.observedBars) * 1000) : 0,
      noFitRate: c.observedBars ? r4((c.horizon["NO_FIT"] ?? 0) / c.observedBars) : 0,
      maxTrackers: c.maxTrackers,
      causalityViolations: c.causalityViolations,
    },
    contextVersion: "m2-context-v1",
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const dist = (m: Record<string, number>) => { const n = Object.values(m).reduce((a, b) => a + b, 0) || 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${pct(v / n)}`); };
const rows = (bs: ContextBucket[]) => (bs.length ? bs.map((b) => `${b.key}: ${b.trades} trades, W${b.wins}/L${b.losses}, WR ${pct(b.winRate)}, ${b.expectancyR >= 0 ? "+" : ""}${b.expectancyR}R`) : ["none"]);

export function generateContextReport(r: ContextReport, environment: string, sample: number): string {
  const s = r.sweepImpact, a = r.audit, c = r.counters;
  const rq = c.eventsCreated["REACTION_CONFIRMED"] ?? 0, wi = c.eventsCreated["WATCH_INVALIDATED"] ?? 0;
  return [
    "ARENA CONTEXT STRESS REPORT", `Environment: ${environment}`, `Sample: ${sample} trades | ${c.observedBars} observed bars`,
    "", "REGIME DISTRIBUTION (bars)", ...dist(c.regime),
    "", "HORIZON DISTRIBUTION (bars)", ...dist(c.horizon),
    "", "FOOTPRINT OBSERVATION", `Sweep: ${s.created} events`, `Resolved: ${s.resolved}`, `Expired: ${s.expired}`,
    "", "EVENT QUALITY", `Reaction Confirmed: ${rq + wi ? pct(rq / (rq + wi)) : "n/a"}`, `Invalidated: ${rq + wi ? pct(wi / (rq + wi)) : "n/a"}`,
    "", "PERFORMANCE BY REGIME", ...rows(r.byRegime),
    "", "PERFORMANCE BY HORIZON", ...rows(r.byHorizon),
    "", "FOOTPRINT CORRELATION (statistics, not a score)", ...rows(r.byFootprint),
    "", "EVENT IMPACT", ...rows(r.byEvent), `Trades with active sweep: ${s.tradesWithActiveSweep}, avg ${s.avgOutcomeR}R`,
    "", "CRITICAL AUDIT",
    `1 Context coverage: ${pct(a.contextCoverage)}`,
    "2 Decision contamination: checked by isolation replay test (context on/off ⇒ identical metrics and counters)",
    `3 Event noise: ${a.eventsPer1000Bars} new events / 1000 bars, max trackers ${a.maxTrackers}`,
    `4 Regime stability: ${a.regimeFlipsPer1000Bars} flips / 1000 bars`,
    `5 Horizon NO_FIT rate: ${pct(a.noFitRate)}`,
    `Causality violations: ${a.causalityViolations}`,
    "", "Note: descriptive only — nothing here changes rules, parameters or trades (M8 scope).",
  ].join("\n");
}
