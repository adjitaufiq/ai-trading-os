// Lab DEMO journal read model (pure). Copies RunnerTrade facts recorded by the VPS runner; never
// calculates fills/PnL/costs, never imports broker ports. Paper (LabTrade) data never enters here.
import type { LabTrade } from "../labLedger";
import type { LabStrategy } from "../strategies";
import type { RunnerTrade, TradeStatus } from "./labDemoRunner";

export const DEMO_JOURNAL_VERSION = "lab-demo-journal-v1" as const;

/** Stable content fingerprint (key-sorted JSON → FNV-1a). Same content ⇒ same fingerprint. */
export function tradeFingerprint(t: unknown): string {
  const s = stableJson(t);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}-${h.toString(36)}`;
}
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Idempotent upsert decision: older snapshots never overwrite newer ones; identical content is a no-op. */
export function upsertDecision(existing: { fingerprint: string; snapshot_at_ms: number } | null, incoming: { fingerprint: string; snapshot_at_ms: number }): "INSERT" | "UPDATE" | "SKIP_DUPLICATE" | "SKIP_STALE" {
  if (!existing) return "INSERT";
  if (incoming.snapshot_at_ms < existing.snapshot_at_ms) return "SKIP_STALE";
  if (incoming.fingerprint === existing.fingerprint) return "SKIP_DUPLICATE";
  return "UPDATE";
}

/** Stable event key for a journal.jsonl line: identical line ⇒ identical key (retry-safe). */
export const eventKey = (line: string) => tradeFingerprint(line.trim());

export type DemoBucket = "OPEN" | "CLOSED" | "REJECTED" | "SHADOW" | "PENDING" | "UNKNOWN";
export function demoBucket(s: TradeStatus): DemoBucket {
  if (s === "OPEN" || s === "CLOSING") return "OPEN";
  if (s === "NOT_FILLED") return "SHADOW";
  return s as DemoBucket;
}

export interface DemoTradeView {
  readonly raw: RunnerTrade;
  readonly bucket: DemoBucket;
  /** LabTrade-compatible row for the existing history/calendar; only real broker fills (OPEN/CLOSED with entry). */
  readonly row: LabTrade | null;
  /** Broker metadata line, only fields the runner actually recorded. */
  readonly meta: string;
}

const LAB_EXIT = new Set(["SL", "TP", "TRAIL", "MANUAL"]);
const f = (v: number | null | undefined, d = 2) => (v == null ? "n/a" : v.toFixed(d));

export function mapRunnerTrade(t: RunnerTrade): DemoTradeView {
  const bucket = demoBucket(t.status);
  const filled = t.entry != null && (bucket === "OPEN" || bucket === "CLOSED");
  const closedKnown = bucket === "CLOSED" && t.pnlUsd != null && t.closedAt != null;
  const meta = [
    `ticket ${t.ticket ?? "n/a"}`, `status ${t.status}`,
    `req ${f(t.requestedPrice, 3)} → fill ${f(t.entry, 3)}`, `lot ${f(t.requestedVolume)} → ${f(t.volume)}${t.partial ? " (partial)" : ""}`,
    `slip ${t.slippagePoints == null ? "n/a" : `${t.slippagePoints} pt`}`, `risk $${f(t.plannedRiskUsd)}`,
    `komisi ${f(t.commissionUsd)}`, `swap ${f(t.swapUsd)}`,
    t.exitReason ? `exit ${t.exitReason}` : null, t.closeReason ? `close ${t.closeReason}` : null,
  ].filter(Boolean).join(" · ");
  const row: LabTrade | null = filled && (bucket === "OPEN" || closedKnown) ? {
    id: t.signalId, strategy: t.strategy as LabStrategy, symbol: t.symbol, side: t.side,
    why: `MT5 DEMO · ${t.profile}`, opened_at: t.openedAt, signal_bar_time: t.barTime,
    entry: t.entry!, sl: t.sl, tp: t.tp, lot: t.volume,
    status: bucket === "CLOSED" ? "CLOSED" : "OPEN", mark: t.entry!,
    // Open DEMO trades: runner state holds no broker floating mark ⇒ 0, flagged in meta, never estimated.
    pnl_usd: closedKnown ? netPnl(t)! : 0,
    closed_at: closedKnown ? t.closedAt : null, exit_price: null,
    exit_reason: closedKnown ? ((LAB_EXIT.has(t.exitReason ?? "") ? t.exitReason : "MANUAL") as LabTrade["exit_reason"]) : null,
    version: DEMO_JOURNAL_VERSION,
  } : null;
  return { raw: t, bucket, row, meta: bucket === "OPEN" ? `${meta} · floating broker belum tercatat` : meta };
}

/** Net = broker profit + commission + swap, only when all three are recorded; otherwise gross profit as recorded. */
export function netPnl(t: RunnerTrade): number | null {
  if (t.pnlUsd == null) return null;
  return t.pnlUsd + (t.commissionUsd ?? 0) + (t.swapUsd ?? 0);
}

export interface DemoStats {
  closed: number; wins: number; losses: number; winRate: number | null; expectancy: number | null; profitFactor: number | null;
  net: number; maxDrawdown: number; maxLossStreak: number; commission: number; swap: number; avgSlippagePoints: number | null;
  open: number; rejected: number; shadow: number; pending: number; unknown: number;
}
export function demoStats(trades: readonly RunnerTrade[]): DemoStats {
  const closed = trades.filter((t) => t.status === "CLOSED" && t.pnlUsd != null).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let wins = 0, losses = 0, gp = 0, gl = 0, eq = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0, com = 0, sw = 0;
  for (const t of closed) {
    const n = netPnl(t)!; eq += n; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    if (n > 0) { wins++; gp += n; streak = 0; } else { losses++; gl += -n; streak++; maxStreak = Math.max(maxStreak, streak); }
    com += t.commissionUsd ?? 0; sw += t.swapUsd ?? 0;
  }
  const slips = trades.map((t) => t.slippagePoints).filter((v): v is number => v != null);
  const c = (b: DemoBucket) => trades.filter((t) => demoBucket(t.status) === b).length;
  return {
    closed: closed.length, wins, losses, winRate: closed.length ? wins / closed.length : null,
    expectancy: closed.length ? eq / closed.length : null, profitFactor: gl > 0 ? gp / gl : null,
    net: eq, maxDrawdown: dd, maxLossStreak: maxStreak, commission: com, swap: sw,
    avgSlippagePoints: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null,
    open: c("OPEN"), rejected: c("REJECTED"), shadow: c("SHADOW"), pending: c("PENDING"), unknown: c("UNKNOWN"),
  };
}

export interface DemoModeRank { strategy: string; closed: number; net: number; winRate: number | null }
export function demoModeRanking(trades: readonly RunnerTrade[]): DemoModeRank[] {
  const m = new Map<string, RunnerTrade[]>();
  for (const t of trades) if (t.status === "CLOSED" && t.pnlUsd != null) m.set(t.strategy, [...(m.get(t.strategy) ?? []), t]);
  return [...m].map(([strategy, ts]) => { const s = demoStats(ts); return { strategy, closed: s.closed, net: s.net, winRate: s.winRate }; }).sort((a, b) => b.net - a.net);
}

/** Hourly (WIB) results; a label is conclusive only with ≥ minSample closed trades in that hour. */
export function demoHourly(trades: readonly RunnerTrade[], minSample = 20) {
  const h = new Map<number, number[]>();
  for (const t of trades) if (t.status === "CLOSED" && t.pnlUsd != null) { const hr = (new Date(t.openedAt).getUTCHours() + 7) % 24; h.set(hr, [...(h.get(hr) ?? []), netPnl(t)!]); }
  return [...h].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, n: v.length, net: v.reduce((a, b) => a + b, 0), conclusive: v.length >= minSample }));
}
