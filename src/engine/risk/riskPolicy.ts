// Phase 4A — single auditable risk policy (risk-policy.json). The ONLY home of risk_per_trade and execution limits.
// Pure: parsing/validation only, no I/O. Environment variables never override these values (env only locates the file).
export const RISK_POLICY_VERSION_4A = "risk-policy-v1" as const;

export interface RiskPolicy {
  /** Fraction of account (0.005 = 0.5%). */
  readonly risk_per_trade: number;
  readonly max_position: number;
  readonly max_symbol: number;
  readonly max_daily_trade: number;
  /** Fraction of day-start balance (0.02 = 2%). Phase 4A.2: locked here, cloud/env never override. */
  readonly max_daily_loss: number;
  readonly emergency_stop: boolean;
}

/** Locked operator values (Phase 4A decision; position/symbol caps raised to 2 by operator decision 2026-10-13). risk-policy.json must match the schema; these are the shipped values. */
export const DEFAULT_RISK_POLICY: RiskPolicy = Object.freeze({
  risk_per_trade: 0.005, max_position: 2, max_symbol: 2, max_daily_trade: 5, max_daily_loss: 0.02, emergency_stop: false,
});

/** Percent form (0.5) for M4 AccountProfile.riskValue. Derived, never a second value. */
/** Percent form (2) of the daily loss limit. */
export const dailyLossPercentOf = (p: RiskPolicy): number => Math.round(p.max_daily_loss * 100 * 1e6) / 1e6;

export const riskPercentOf = (p: RiskPolicy): number => Math.round(p.risk_per_trade * 100 * 1e6) / 1e6;

export type RiskPolicyParse = { ok: true; policy: RiskPolicy } | { ok: false; error: string };

const KEYS = ["risk_per_trade", "max_position", "max_symbol", "max_daily_trade", "max_daily_loss", "emergency_stop"] as const;

/** Strict: every key required, no unknown keys, bounded values. Invalid ⇒ error (caller fails closed). */
export function parseRiskPolicy(json: string): RiskPolicyParse {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { ok: false, error: "INVALID_JSON" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "NOT_OBJECT" };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(KEYS as readonly string[]).includes(k)) return { ok: false, error: `UNKNOWN_KEY ${k}` };
  for (const k of KEYS) if (!(k in o)) return { ok: false, error: `MISSING_KEY ${k}` };
  const r = o["risk_per_trade"], mp = o["max_position"], ms = o["max_symbol"], md = o["max_daily_trade"], dl = o["max_daily_loss"], es = o["emergency_stop"];
  if (typeof r !== "number" || !(r > 0 && r <= 0.02)) return { ok: false, error: "risk_per_trade must be in (0, 0.02]" };
  const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(mp, 1, 10)) return { ok: false, error: "max_position must be integer 1..10" };
  if (!int(ms, 1, 10)) return { ok: false, error: "max_symbol must be integer 1..10" };
  if (!int(md, 0, 100)) return { ok: false, error: "max_daily_trade must be integer 0..100" };
  if (typeof dl !== "number" || !(dl > 0 && dl <= 0.1)) return { ok: false, error: "max_daily_loss must be in (0, 0.1]" };
  if (typeof es !== "boolean") return { ok: false, error: "emergency_stop must be boolean" };
  return { ok: true, policy: Object.freeze({ risk_per_trade: r, max_position: mp as number, max_symbol: ms as number, max_daily_trade: md as number, max_daily_loss: dl, emergency_stop: es }) };
}
