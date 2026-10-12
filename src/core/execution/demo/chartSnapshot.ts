// Hybrid chart snapshot for the demo audit trail (observability only).
// Data snapshot (closed OHLC bars + copied SNR zones + event metadata) at PRE_ENTRY / ENTRY / CLOSE;
// a deterministic SVG image only at ENTRY and CLOSE. Pure read model over the append-only demo event log:
// it never calculates indicators, changes zones, or feeds a decision, risk or execution path.
import type { DemoEvent, DemoOrderIntent } from "./types";
import { tradeIdOf } from "./tradeLifecycle";

export const CHART_SNAPSHOT_SCHEMA = "demo-chart-snapshot-v1" as const;
export type SnapshotPhase = "PRE_ENTRY" | "ENTRY" | "CLOSE";
export const IMAGE_PHASES: readonly SnapshotPhase[] = ["ENTRY", "CLOSE"];
export const SNAPSHOT_BAR_LIMIT = 120;

export interface OhlcBar { readonly t: number; readonly o: number; readonly h: number; readonly l: number; readonly c: number }
export interface SnapshotZone { readonly type: string; readonly low: number; readonly high: number; readonly timeframe: string }

export interface ChartSnapshot {
  readonly schema: typeof CHART_SNAPSHOT_SCHEMA;
  readonly tradeId: string; readonly signalId: string; readonly symbol: string; readonly phase: SnapshotPhase;
  readonly timeframe: string;
  /** Event time the snapshot represents; bars never extend beyond it. */
  readonly event_at: number; readonly captured_at: number;
  readonly bars: readonly OhlcBar[];
  readonly snr: { readonly as_of: number | null; readonly zones: readonly SnapshotZone[] } | null;
  readonly event: { readonly type: DemoEvent["type"]; readonly direction: "BUY" | "SELL"; readonly entry: number; readonly sl: number; readonly tp: number; readonly price: number | null; readonly ticket: number | null; readonly detail: string | null };
  readonly image: "PENDING" | "NOT_REQUIRED";
}

export interface SnapshotSources {
  /** Closed bars for the symbol/timeframe (copied, any order). */
  closedBars(symbol: string): readonly { open_time: number; close_time: number; open: number; high: number; low: number; close: number }[];
  /** Current SNR projection (copy of /v1/analysis/snr) or null. */
  snr(symbol: string): { as_of: number; zones: readonly SnapshotZone[] } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const PHASE_OF: Partial<Record<DemoEvent["type"], SnapshotPhase>> = { SEND_ATTEMPT: "PRE_ENTRY", FILLED: "ENTRY", CLOSED: "CLOSE" };
export const snapshotKey = (signalId: string, phase: SnapshotPhase) => `${tradeIdOf(signalId)}:${phase}`;

/** Snapshots due for events not yet captured (`done` = keys already recorded). Deterministic by event time. */
export function captureChartSnapshots(events: readonly DemoEvent[], done: ReadonlySet<string>, src: SnapshotSources, timeframe: string, now: number): ChartSnapshot[] {
  const intents = new Map<string, DemoOrderIntent>();
  for (const e of events) if (e.type === "SEND_ATTEMPT" && e.signalId && e.data?.["intent"]) intents.set(e.signalId, e.data["intent"] as DemoOrderIntent);
  const out: ChartSnapshot[] = [];
  for (const e of events) {
    const phase = PHASE_OF[e.type];
    if (!phase || !e.signalId) continue;
    const key = snapshotKey(e.signalId, phase);
    const intent = intents.get(e.signalId);
    if (done.has(key) || !intent || out.some((s) => snapshotKey(s.signalId, s.phase) === key)) continue;
    const eventAt = phase === "PRE_ENTRY" ? Math.min(intent.closedBarAt, e.at) : e.at;
    const bars = [...src.closedBars(intent.symbol)].filter((b) => b.close_time <= eventAt).sort((a, b) => a.open_time - b.open_time)
      .slice(-SNAPSHOT_BAR_LIMIT).map((b) => Object.freeze({ t: b.open_time, o: b.open, h: b.high, l: b.low, c: b.close }));
    const s = src.snr(intent.symbol);
    out.push(Object.freeze({
      schema: CHART_SNAPSHOT_SCHEMA, tradeId: tradeIdOf(e.signalId), signalId: e.signalId, symbol: intent.symbol, phase, timeframe,
      event_at: eventAt, captured_at: now, bars: Object.freeze(bars),
      snr: s ? Object.freeze({ as_of: s.as_of, zones: Object.freeze(s.zones.map((z) => Object.freeze({ type: z.type, low: z.low, high: z.high, timeframe: z.timeframe }))) }) : null,
      event: Object.freeze({ type: e.type, direction: intent.direction, entry: intent.plannedEntry, sl: intent.stopLoss, tp: intent.takeProfit,
        price: num(e.data?.["price"]), ticket: num(e.data?.["ticket"]), detail: e.detail ?? null }),
      image: IMAGE_PHASES.includes(phase) ? "PENDING" as const : "NOT_REQUIRED" as const,
    }));
  }
  return out;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Deterministic SVG audit image (ENTRY/CLOSE only). Returns null for PRE_ENTRY or when there is nothing to draw. */
export function renderChartSnapshotSvg(s: ChartSnapshot, w = 900, h = 420): string | null {
  if (!IMAGE_PHASES.includes(s.phase) || !s.bars.length) return null;
  const pad = 40;
  const prices = [...s.bars.flatMap((b) => [b.h, b.l]), s.event.entry, s.event.sl, s.event.tp, ...(s.event.price !== null ? [s.event.price] : [])];
  const lo = Math.min(...prices), hi = Math.max(...prices), span = hi - lo || 1;
  const y = (p: number) => pad + (hi - p) / span * (h - 2 * pad);
  const step = (w - 2 * pad) / s.bars.length, bw = Math.max(1, step * 0.6);
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#0b0f14"/>`];
  for (const z of s.snr?.zones ?? []) {
    if (z.high < lo || z.low > hi) continue;
    const top = y(Math.min(z.high, hi)), bot = y(Math.max(z.low, lo));
    parts.push(`<rect x="${pad}" y="${top.toFixed(1)}" width="${w - 2 * pad}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${z.type === "SUPPLY" || z.type === "RESISTANCE" ? "#ef4444" : "#22c55e"}" fill-opacity="0.12"/>`);
  }
  s.bars.forEach((b, i) => {
    const x = pad + i * step + step / 2, col = b.c >= b.o ? "#22c55e" : "#ef4444";
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${col}"/>`,
      `<rect x="${(x - bw / 2).toFixed(1)}" y="${y(Math.max(b.o, b.c)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(b.o) - y(b.c))).toFixed(1)}" fill="${col}"/>`);
  });
  const line = (p: number, col: string, label: string) => parts.push(`<line x1="${pad}" x2="${w - pad}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="${col}" stroke-dasharray="4 3"/><text x="${w - pad + 2}" y="${(y(p) + 4).toFixed(1)}" fill="${col}" font-size="10" font-family="monospace">${esc(label)}</text>`);
  line(s.event.entry, "#e5e7eb", "ENTRY"); line(s.event.sl, "#ef4444", "SL"); line(s.event.tp, "#22c55e", "TP");
  if (s.event.price !== null) line(s.event.price, "#f59e0b", s.phase === "CLOSE" ? "CLOSE" : "FILL");
  parts.push(`<text x="${pad}" y="20" fill="#e5e7eb" font-size="12" font-family="monospace">${esc(`${s.symbol} ${s.timeframe} ${s.phase} ${s.event.direction} ${s.tradeId} ${new Date(s.event_at).toISOString()}`)}</text></svg>`);
  return parts.join("");
}
