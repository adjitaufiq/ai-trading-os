// Signal Lifecycle Hardening V1 — pure audit helpers for the paper loop.
// Authority: only refuses to RECORD a READY (context freshness, active duplicate). Never changes strategy,
// indicators, Decision Gate, risk, SL/TP or execution. Thresholds are context-freshness limits, not strategy params.
import type { MarketRegimeSnapshot } from "../../engine/core/market/regime/types";

export const SIGNAL_HARDENING_VERSION = "signal-hardening-v1" as const;

export const HARDENING_LIMITS = {
  /** Last CLOSED M15 must be at most this old at the M5 close (setup validation context). */
  MAX_M15_AGE_MS: 3_600_000,
  /** Previous CLOSED M5 must be at most this old (trigger validation; catches feed gaps). */
  MAX_M5_AGE_MS: 15 * 60_000,
  /** H4 primaryBias reading must be at most this old (macro context, ≤ 3 H4 bars). */
  MAX_PRIMARY_BIAS_AGE_MS: 12 * 3_600_000,
} as const;

export type SignalRejectReason =
  | "CONTEXT_PRIMARY_BIAS_MISSING"
  | "CONTEXT_PRIMARY_BIAS_STALE"
  | "CONTEXT_PRIMARY_BIAS_FUTURE"
  | "CONTEXT_M15_MISSING"
  | "CONTEXT_M15_STALE"
  | "CONTEXT_M5_STALE"
  | "DUPLICATE_BLOCKED";

export interface ContextCheckInput {
  readonly barCloseMs: number;
  readonly m15LastCloseMs: number | null;
  readonly primaryBiasAsOfMs: number | null;
  /** Close time of the M5 bar BEFORE the triggering one; absent ⇒ M5 freshness not checked. */
  readonly m5PrevCloseMs?: number | null;
}

/** Pre-READY context validation. Returns null when the context is available and fresh. */
export function validateSignalContext(i: ContextCheckInput): Exclude<SignalRejectReason, "DUPLICATE_BLOCKED"> | null {
  if (i.primaryBiasAsOfMs === null || !Number.isFinite(i.primaryBiasAsOfMs)) return "CONTEXT_PRIMARY_BIAS_MISSING";
  if (i.primaryBiasAsOfMs > i.barCloseMs) return "CONTEXT_PRIMARY_BIAS_FUTURE";
  if (i.barCloseMs - i.primaryBiasAsOfMs > HARDENING_LIMITS.MAX_PRIMARY_BIAS_AGE_MS) return "CONTEXT_PRIMARY_BIAS_STALE";
  if (i.m15LastCloseMs === null || !Number.isFinite(i.m15LastCloseMs)) return "CONTEXT_M15_MISSING";
  if (i.barCloseMs - i.m15LastCloseMs > HARDENING_LIMITS.MAX_M15_AGE_MS) return "CONTEXT_M15_STALE";
  if (i.m5PrevCloseMs != null && Number.isFinite(i.m5PrevCloseMs) && i.barCloseMs - i.m5PrevCloseMs > HARDENING_LIMITS.MAX_M5_AGE_MS) return "CONTEXT_M5_STALE";
  return null;
}

/** Identity = symbol + direction + setup type (trigger) + key level. */
export function signalIdentity(s: { symbol?: string; direction?: string; triggerPattern?: string; keyLevel?: number }): string {
  const lvl = typeof s.keyLevel === "number" && Number.isFinite(s.keyLevel) ? s.keyLevel.toFixed(5) : "NA";
  return `${s.symbol ?? "NA"}|${s.direction ?? "NA"}|${s.triggerPattern ?? "NA"}|${lvl}`;
}

export interface ActiveSignal { readonly identity: string; readonly signalId: string; readonly direction: string; readonly expiryTimestamp: number }

/** Active consumed-READY signals. An entry stops being active at TTL expiry or explicit invalidation. */
export class ActiveSignalRegistry {
  private readonly m = new Map<string, ActiveSignal>();
  register(s: { id: string; symbol?: string; direction?: string; triggerPattern?: string; keyLevel?: number; expiryTimestamp?: number }): void {
    if (typeof s.expiryTimestamp !== "number" || !Number.isFinite(s.expiryTimestamp)) return; // no lifecycle ⇒ nothing to dedup
    const identity = signalIdentity(s);
    this.m.set(identity, Object.freeze({ identity, signalId: s.id, direction: String(s.direction), expiryTimestamp: s.expiryTimestamp }));
  }
  /** Drops entries whose TTL passed (EXPIRED) at the given M5 bar timestamp (seconds). */
  prune(barTs: number): void { for (const [k, v] of this.m) if (barTs >= v.expiryTimestamp) this.m.delete(k); }
  /** Explicit invalidation (e.g. primary-bias flip against the direction). */
  invalidateDirection(direction: string): void { for (const [k, v] of this.m) if (v.direction === direction) this.m.delete(k); }
  activeFor(s: { symbol?: string; direction?: string; triggerPattern?: string; keyLevel?: number }): ActiveSignal | null { return this.m.get(signalIdentity(s)) ?? null; }
  export(): ActiveSignal[] { return [...this.m.values()].map((v) => ({ ...v })); }
  restore(rows: readonly ActiveSignal[] | undefined): void { for (const r of rows ?? []) if (r && typeof r.identity === "string") this.m.set(r.identity, Object.freeze({ ...r })); }
}

export type RegimeLabel = "TREND" | "RANGE" | "HIGH_VOLATILITY" | "UNCERTAIN";

/** Maps the engine's M1B.9 regime; anything missing or not cleanly mappable ⇒ UNCERTAIN. */
export function regimeLabel(r: MarketRegimeSnapshot | null | undefined): RegimeLabel {
  switch (r?.regime) {
    case "TREND_CONTINUATION": case "TREND_EXHAUSTION": return "TREND";
    case "RANGE_COMPRESSION": return "RANGE";
    case "VOLATILITY_EXPANSION": return "HIGH_VOLATILITY";
    default: return "UNCERTAIN";
  }
}
