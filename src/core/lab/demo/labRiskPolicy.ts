/**
 * Lab DEMO risk policy — the SINGLE configuration source of the Lab DEMO runner (engine-host/lab-risk-policy.json).
 * Independent of ARENA risk-policy.json (never read by the Lab runner). Strict schema: any missing/extra/invalid
 * field ⇒ { ok:false } and the runner refuses to start (fail-closed). Values are operator decisions, not defaults.
 */
export const LAB_RISK_POLICY_VERSION = "lab-risk-policy-v1";
export const LAB_MAGIC = 610_007;

export interface LabCopetProfile {
  /** Fixed Lab lot (never resized). */
  readonly lot: number;
  /** Contract size the Lab ledger assumes (XAU 100, BTC 1). SL/TP price distance = usd / (lot × contract). */
  readonly contract_size_assumed: number;
  readonly sl_usd: number;
  readonly tp_usd: number;
  readonly trail_arm_usd: number;
  readonly trail_gap_usd: number;
}
export interface LabRiskPolicy {
  readonly version: typeof LAB_RISK_POLICY_VERSION;
  readonly magic: typeof LAB_MAGIC;
  readonly daily_target_usd: number;
  readonly daily_stop_usd: number;
  readonly max_active_positions_total: number;
  readonly max_active_positions_per_mode: number;
  readonly max_active_positions_per_symbol: number;
  /** null = no daily trade cap (Lab has none). Separate from the active-position caps. */
  readonly max_trades_per_day: number | null;
  /** Reserved per open position (and per candidate) for spread/commission/swap/slippage not yet known. */
  readonly friction_buffer_usd_per_position: number;
  /** Max relative deviation of broker-computed SL risk vs profile sl_usd before REJECTED_BROKER_SPEC_MISMATCH. */
  readonly broker_spec_tolerance: number;
  /** Max close attempts (each preceded by a fresh positions read) before STATE_DESYNC_HALT. */
  readonly max_close_attempts: number;
  readonly copet: Readonly<Record<"XAUUSD" | "BTCUSD", LabCopetProfile>>;
  /** Mode 12 SMC_FIBO_OTE keeps technical SL/TP and an R-based trail; lot per symbol. */
  readonly fibo: { readonly arm_r: number; readonly gap_r: number; readonly min_gap_usd: number; readonly lot: Readonly<Record<"XAUUSD" | "BTCUSD", number>> };
}

const KEYS = ["version", "magic", "daily_target_usd", "daily_stop_usd", "max_active_positions_total", "max_active_positions_per_mode", "max_active_positions_per_symbol", "max_trades_per_day", "friction_buffer_usd_per_position", "broker_spec_tolerance", "max_close_attempts", "copet", "fibo"] as const;
const PKEYS = ["lot", "contract_size_assumed", "sl_usd", "tp_usd", "trail_arm_usd", "trail_gap_usd"] as const;
const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const int = (v: unknown, min = 1) => typeof v === "number" && Number.isInteger(v) && v >= min;
const exact = (o: unknown, keys: readonly string[]) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => k in (o as object));

export function parseLabRiskPolicy(text: string | null | undefined): { ok: true; policy: LabRiskPolicy } | { ok: false; error: string } {
  if (text == null) return { ok: false, error: "LAB_RISK_POLICY_MISSING" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any;
  try { j = JSON.parse(text); } catch { return { ok: false, error: "LAB_RISK_POLICY_BAD_JSON" }; }
  if (!exact(j, KEYS)) return { ok: false, error: "LAB_RISK_POLICY_SCHEMA_KEYS" };
  if (j.version !== LAB_RISK_POLICY_VERSION) return { ok: false, error: "LAB_RISK_POLICY_VERSION" };
  if (j.magic !== LAB_MAGIC) return { ok: false, error: "LAB_RISK_POLICY_MAGIC_MUST_BE_610007" };
  for (const k of ["daily_target_usd", "daily_stop_usd", "friction_buffer_usd_per_position", "broker_spec_tolerance"] as const) if (!pos(j[k]) && !(k === "friction_buffer_usd_per_position" && j[k] === 0)) return { ok: false, error: `LAB_RISK_POLICY_${k}` };
  if ((j.broker_spec_tolerance as number) >= 1) return { ok: false, error: "LAB_RISK_POLICY_broker_spec_tolerance" };
  for (const k of ["max_active_positions_total", "max_active_positions_per_mode", "max_active_positions_per_symbol", "max_close_attempts"] as const) if (!int(j[k])) return { ok: false, error: `LAB_RISK_POLICY_${k}` };
  if (j.max_trades_per_day !== null && !int(j.max_trades_per_day)) return { ok: false, error: "LAB_RISK_POLICY_max_trades_per_day" };
  const c = j.copet;
  if (!exact(c, ["XAUUSD", "BTCUSD"])) return { ok: false, error: "LAB_RISK_POLICY_COPET_SYMBOLS" };
  for (const s of ["XAUUSD", "BTCUSD"]) {
    const p = c[s];
    if (!exact(p, PKEYS) || !PKEYS.every((k) => pos(p[k]))) return { ok: false, error: `LAB_RISK_POLICY_COPET_${s}` };
    if ((p.trail_gap_usd as number) >= (p.trail_arm_usd as number)) return { ok: false, error: `LAB_RISK_POLICY_COPET_${s}_GAP_GE_ARM` };
  }
  const f = j.fibo;
  if (!exact(f, ["arm_r", "gap_r", "min_gap_usd", "lot"]) || !pos(f.arm_r) || !pos(f.gap_r) || !pos(f.min_gap_usd)) return { ok: false, error: "LAB_RISK_POLICY_FIBO" };
  const fl = f.lot;
  if (!exact(fl, ["XAUUSD", "BTCUSD"]) || !pos(fl.XAUUSD) || !pos(fl.BTCUSD)) return { ok: false, error: "LAB_RISK_POLICY_FIBO_LOT" };
  return { ok: true, policy: deepFreeze(j) as unknown as LabRiskPolicy };
}

function deepFreeze<T>(o: T): T { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }

/** Operator-approved values (2026-10-19). Shipped as engine-host/lab-risk-policy.json; tests use this object. */
export const LAB_RISK_POLICY_FILE_CONTENT = {
  version: LAB_RISK_POLICY_VERSION, magic: LAB_MAGIC,
  daily_target_usd: 50, daily_stop_usd: 30,
  max_active_positions_total: 6, max_active_positions_per_mode: 1, max_active_positions_per_symbol: 6,
  max_trades_per_day: null, friction_buffer_usd_per_position: 2, broker_spec_tolerance: 0.1, max_close_attempts: 3,
  copet: {
    XAUUSD: { lot: 0.02, contract_size_assumed: 100, sl_usd: 10, tp_usd: 10, trail_arm_usd: 2, trail_gap_usd: 1 },
    BTCUSD: { lot: 0.05, contract_size_assumed: 1, sl_usd: 10, tp_usd: 10, trail_arm_usd: 2, trail_gap_usd: 1 },
  },
  fibo: { arm_r: 1, gap_r: 0.5, min_gap_usd: 1, lot: { XAUUSD: 0.02, BTCUSD: 0.05 } },
} as const;
