// Session-level DEMO arming (system gate, not per-trade approval). Pure validator of an operator-created
// file on the VPS (engine-host/data/demo-arm.json). The engine host only READS it; there is no write path
// from the dashboard or any HTTP route. Fail-closed: missing, malformed, mode ≠ DEMO, expired, account mismatch or an
// active kill switch ⇒ not armed. Shadow Guard still sits in front of every send.
export interface DemoArmFile { readonly armed: boolean; readonly mode: "DEMO"; readonly expires_at: number; readonly account_hash: string }

export type DemoArmCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "ARM_FILE_MISSING" | "ARM_FILE_INVALID" | "ARM_MODE_NOT_DEMO" | "ARM_EXPIRED" | "ARM_ACCOUNT_MISMATCH" | "KILL_SWITCH" | "NOT_ARMED" };

export function checkDemoArm(i: {
  readonly raw: string | null;
  readonly now: number;
  /** sha256 hex of each whitelisted DEMO login. */
  readonly whitelistHashes: readonly string[];
  readonly killSwitch: boolean;
}): DemoArmCheck {
  if (i.killSwitch) return { ok: false, reason: "KILL_SWITCH" };
  if (i.raw === null) return { ok: false, reason: "ARM_FILE_MISSING" };
  let f: Partial<DemoArmFile>;
  try { f = JSON.parse(i.raw) as Partial<DemoArmFile>; } catch { return { ok: false, reason: "ARM_FILE_INVALID" }; }
  if (!f || typeof f !== "object" || typeof f.expires_at !== "number" || typeof f.account_hash !== "string" || typeof f.armed !== "boolean" || typeof f.mode !== "string") return { ok: false, reason: "ARM_FILE_INVALID" };
  if (f.mode !== "DEMO") return { ok: false, reason: "ARM_MODE_NOT_DEMO" };
  if (f.armed !== true) return { ok: false, reason: "NOT_ARMED" };
  if (!(f.expires_at > i.now)) return { ok: false, reason: "ARM_EXPIRED" };
  const h = f.account_hash.trim().toLowerCase();
  if (!h || !i.whitelistHashes.map((x) => x.toLowerCase()).includes(h)) return { ok: false, reason: "ARM_ACCOUNT_MISMATCH" };
  return { ok: true };
}
