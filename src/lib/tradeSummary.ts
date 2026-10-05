// Compact, bounded technical summary of a TradingSnapshot. Used for the journal and the AI WHY payload.
// Pure read of existing deterministic state; never derives a signal.
import type { TradingSnapshot } from "@/core/technical/tradingState";
import type { Indicator } from "@/core/technical/indicators";

export type EngineSignal = "BUY" | "SELL" | "HOLD";

export function engineSignalOf(s: TradingSnapshot | null): EngineSignal {
  return s?.entry.state === "LONG_CANDIDATE" ? "BUY" : s?.entry.state === "SHORT_CANDIDATE" ? "SELL" : "HOLD";
}

const ind = (x: Indicator | undefined) => (x && x.status === "OK" ? Number(x.value.toFixed(4)) : null);
const zone = (z: { low: number; high: number; touches: number; source_tf: string } | null | undefined) =>
  z ? `${z.low.toFixed(3)}-${z.high.toFixed(3)} x${z.touches} ${z.source_tf}` : null;

export interface CompactSummary {
  readonly symbol: string;
  readonly as_of: number;
  readonly signal: EngineSignal;
  readonly entry_state: string;
  readonly entry_reason: string;
  readonly regime: string | null;
  readonly h4: string | null;
  readonly h1_context: string | null;
  readonly macro_direction: string | null;
  readonly alignment: string | null;
  readonly location: string | null;
  readonly support: string | null;
  readonly resistance: string | null;
  readonly ema_confluence: string | null;
  readonly rsi: { readonly H1: number | null; readonly M15: number | null; readonly M5: number | null };
  readonly atr_m15: number | null;
  readonly trigger: string | null;
  readonly patterns: { readonly M5: readonly string[]; readonly M15: readonly string[] };
  readonly plan: { readonly side: string; readonly entry: number; readonly sl: number; readonly tp1: number; readonly tp2: number } | { readonly unavailable: string };
  readonly why: readonly string[];
}

export function compactSummary(s: TradingSnapshot): CompactSummary {
  const op = s.operator ?? null, ev = s.evidence;
  const plan = s.reference_plan.status === "AVAILABLE"
    ? { side: s.reference_plan.side, entry: s.reference_plan.entry, sl: s.reference_plan.sl, tp1: s.reference_plan.tp1, tp2: s.reference_plan.tp2 }
    : { unavailable: s.reference_plan.reason.slice(0, 120) };
  return {
    symbol: s.symbol, as_of: s.as_of, signal: engineSignalOf(s), entry_state: s.entry.state, entry_reason: s.entry.reason.slice(0, 200),
    regime: op?.regime ?? null, h4: op?.h4_primary ?? null, h1_context: op?.h1_context ?? null, macro_direction: op?.macro?.macro_direction ?? null, alignment: op?.alignment ?? null, location: op?.location ?? null,
    support: zone(op?.nearest_support), resistance: zone(op?.nearest_resistance),
    ema_confluence: op ? `${op.ema_confluence.zone}${op.ema_confluence.timeframe ? ` ${op.ema_confluence.timeframe}` : ""}` : null,
    rsi: { H1: ind(ev?.H1.rsi14), M15: ind(ev?.M15.rsi14), M5: ind(ev?.M5.rsi14) },
    atr_m15: ind(ev?.M15.atr14), trigger: op?.trigger ?? null,
    patterns: { M5: [...(op?.patterns.M5.bullish ?? []), ...(op?.patterns.M5.bearish ?? [])], M15: [...(op?.patterns.M15.bullish ?? []), ...(op?.patterns.M15.bearish ?? [])] },
    plan, why: s.why.slice(0, 8).map((f) => f.text.slice(0, 240)),
  };
}

export const AI_SUMMARY_MAX_CHARS = 10_000;

/** AI payload: compact JSON, hard-capped below the server's 20k validator. */
export function aiSummaryPayload(s: TradingSnapshot): string {
  const text = JSON.stringify(compactSummary(s));
  return text.length <= AI_SUMMARY_MAX_CHARS ? text : text.slice(0, AI_SUMMARY_MAX_CHARS);
}
