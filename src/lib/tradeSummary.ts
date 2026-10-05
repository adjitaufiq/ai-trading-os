// Compact, bounded technical summary of a TradingSnapshot. Used for the journal and the AI WHY payload.
// Pure read of existing deterministic state; never derives a signal.
import { SIGNAL_TTL_POLICY_VERSION, type TradingSnapshot } from "@/core/technical/tradingState";
import type { Indicator } from "@/core/technical/indicators";
import type { ScalpTf } from "@/core/technical/operator";

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
  readonly scalp_momentum_combined: string | null;
  readonly momentum_policy_version: string | null;
  readonly momentum: { readonly M5: MomentumCompact | null; readonly M15: MomentumCompact | null };
  readonly local_ema: { readonly M5: string | null; readonly M15: string | null };
  readonly radar_plan_status: string | null;
  readonly radar_side: string | null;
  readonly radar_entry_zone_low: number | null;
  readonly radar_entry_zone_high: number | null;
  readonly radar_reference_entry: number | null;
  readonly projected_sl: number | null;
  readonly projected_tp1: number | null;
  readonly projected_tp2: number | null;
  readonly projected_structural_target: number | null;
  readonly radar_plan_policy_version: string | null;
  readonly signal_lifecycle: { readonly state: string; readonly event: string | null; readonly signal_id: string | null; readonly reason: string | null; readonly origin_entry: number | null; readonly origin_sl: number | null; readonly initial_r: number | null; readonly ttl_remaining: number | null; readonly ttl_policy_version: string } | null;
}
type MomentumCompact = { readonly state: string; readonly cross: string | null; readonly s5: number | null; readonly s21: number | null; readonly gap: number | null; readonly gd: number | null };
const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const mom = (t: ScalpTf | undefined): MomentumCompact | null => t?.momentum ? { state: t.momentum.state, cross: t.momentum.cross, s5: r3(t.momentum.slope5_norm), s21: r3(t.momentum.slope21_norm), gap: r3(t.momentum.gap_norm), gd: r3(t.momentum.gap_delta) } : null;
const localEma = (t: ScalpTf | undefined) => t ? `${t.ema_location}${t.ema_reaction.length ? ` ${t.ema_reaction.map((x) => `${x.kind}_EMA${x.ema}`).join(",")}` : ""}` : null;

const r5 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e5) / 1e5);

export function compactSummary(s: TradingSnapshot): CompactSummary {
  const op = s.operator ?? null, ev = s.evidence, rp = s.radar_plan ?? null;
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
    scalp_momentum_combined: op?.scalp?.combined_momentum ?? null, momentum_policy_version: op?.scalp?.momentum_policy_version ?? null,
    momentum: { M5: mom(op?.scalp?.M5), M15: mom(op?.scalp?.M15) }, local_ema: { M5: localEma(op?.scalp?.M5), M15: localEma(op?.scalp?.M15) },
    radar_plan_status: rp ? `${rp.mode}:${rp.status}` : null, radar_side: rp?.side ?? null,
    radar_entry_zone_low: r5(rp?.zone?.low), radar_entry_zone_high: r5(rp?.zone?.high), radar_reference_entry: r5(rp?.reference_entry),
    projected_sl: r5(rp?.sl), projected_tp1: r5(rp?.tp1), projected_tp2: r5(rp?.tp2), projected_structural_target: r5(rp?.structural_target),
    radar_plan_policy_version: rp?.policy_version ?? null,
    signal_lifecycle: s.signal.lifecycle ? (() => { const o = s.signal.origin ?? s.signal.lifecycle?.last_terminal?.origin ?? null; return {
      state: s.signal.state, event: s.signal.lifecycle.event, signal_id: o?.signal_id ?? null, reason: (s.signal.lifecycle.reason ?? s.signal.lifecycle.last_terminal?.reason ?? null)?.slice(0, 80) ?? null,
      origin_entry: r5(o?.origin_entry), origin_sl: r5(o?.origin_sl), initial_r: r5(o?.initial_r), ttl_remaining: s.signal.ttl_remaining_bars ?? null, ttl_policy_version: SIGNAL_TTL_POLICY_VERSION }; })() : null,
  };
}

export const AI_SUMMARY_MAX_CHARS = 10_000;

/** AI payload: compact JSON, hard-capped below the server's 20k validator. */
export function aiSummaryPayload(s: TradingSnapshot): string {
  const text = JSON.stringify(compactSummary(s));
  return text.length <= AI_SUMMARY_MAX_CHARS ? text : text.slice(0, AI_SUMMARY_MAX_CHARS);
}
