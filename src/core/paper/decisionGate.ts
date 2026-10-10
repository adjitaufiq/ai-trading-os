// Decision Gate: the single entry authority for paper (and therefore demo) opens.
// ARENA operator.status grants market permission; M1B only proposes a candidate side. Pure, no calculation.

export type ArenaPermissionStatus = "CARI_BUY" | "CARI_SELL" | "HOLD";
export type DecisionGateReason =
  | "ALLOW_ARENA_BUY_MATCH" | "ALLOW_ARENA_SELL_MATCH"
  | "BLOCK_ARENA_HOLD" | "BLOCK_ARENA_INVALID" | "BLOCK_DIRECTION_MISMATCH";

export interface DecisionGateResult {
  readonly decision: "ALLOW" | "BLOCK";
  readonly reason: DecisionGateReason;
  /** Copied ARENA status; null when missing or unknown. */
  readonly arenaStatus: ArenaPermissionStatus | null;
  readonly candidate: "BUY" | "SELL" | "NONE";
}

export const DECISION_GATE_POLICY_VERSION = "decision-gate-v1-arena-operator-status" as const;

const KNOWN = new Set<string>(["CARI_BUY", "CARI_SELL", "HOLD"]);

/** Missing, unknown or non-string status ⇒ BLOCK_ARENA_INVALID (fail closed). */
export function decideEntry(arenaStatus: unknown, candidate: "BUY" | "SELL" | "NONE"): DecisionGateResult {
  const status = typeof arenaStatus === "string" && KNOWN.has(arenaStatus) ? (arenaStatus as ArenaPermissionStatus) : null;
  const out = (decision: "ALLOW" | "BLOCK", reason: DecisionGateReason) => Object.freeze({ decision, reason, arenaStatus: status, candidate });
  if (status === null) return out("BLOCK", "BLOCK_ARENA_INVALID");
  if (status === "HOLD") return out("BLOCK", "BLOCK_ARENA_HOLD");
  if (candidate === "NONE") return out("BLOCK", "BLOCK_DIRECTION_MISMATCH");
  if (status === "CARI_BUY") return candidate === "BUY" ? out("ALLOW", "ALLOW_ARENA_BUY_MATCH") : out("BLOCK", "BLOCK_DIRECTION_MISMATCH");
  return candidate === "SELL" ? out("ALLOW", "ALLOW_ARENA_SELL_MATCH") : out("BLOCK", "BLOCK_DIRECTION_MISMATCH");
}
