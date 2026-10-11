// Phase 2A Shadow Guard: the last gate before any broker order. Executor-side protection only.
// It never evaluates strategy, bias, risk or SL/TP; it copies the already-approved plan into an append-only
// shadow record and, while shadow is active, guarantees NO broker send — both at the intent gate and again at the
// gateway port (defense in depth: a dashboard bug, wrong config, restart or reconnect cannot reach sendOrder).
import type { DemoExecGatewayPort, DemoOrderIntent, DemoOrderRequest, DemoOrderResponse } from "../demo/types";
import { resolveExecutionPathMode } from "../demo/DemoExecutionLayer";

export const SHADOW_GUARD_VERSION = "shadow-guard-v1" as const;

/** Phase 2D demo safety configuration (operator values; enforced here before the demo bridge). */
export interface ShadowSafetyConfig {
  readonly maxPositions: number;
  readonly maxSymbols: number;
  readonly maxDailyTrades: number;
  readonly duplicateOrderProtection: true;
  readonly slRequired: true;
  readonly tpRequired: true;
  readonly emergencyStop: true;
}
export const DEFAULT_SHADOW_SAFETY: ShadowSafetyConfig = Object.freeze({
  maxPositions: 1, maxSymbols: 1, maxDailyTrades: 5,
  duplicateOrderProtection: true, slRequired: true, tpRequired: true, emergencyStop: true,
});

/** Only MAX_DAILY_TRADE is configurable; protections are fixed ON and cannot be disabled by env. */
export function parseShadowSafety(env: { MAX_DAILY_TRADE?: string | undefined }): ShadowSafetyConfig {
  const n = Number(env.MAX_DAILY_TRADE);
  return Object.freeze({ ...DEFAULT_SHADOW_SAFETY, maxDailyTrades: Number.isInteger(n) && n >= 0 ? n : DEFAULT_SHADOW_SAFETY.maxDailyTrades });
}

/** Phase 3.5 canonical config: EXECUTION_MODE=SHADOW|DEMO is the single source of truth (legacy
 *  DEMO_STRESS_TEST resolves to DEMO; REAL_DISABLED/PAPER_ONLY/unset resolve to SHADOW). Shadow is ON
 *  unless the execution path is DEMO; SHADOW_MODE=ON forces shadow even in DEMO (extra safety override).
 *  Legacy SHADOW_MODE=OFF is no longer required and never widens access. Anything else fails closed. */
export function resolveShadowActive(env: { SHADOW_MODE?: string | undefined; EXECUTION_MODE?: string | undefined }): boolean {
  if (env.SHADOW_MODE?.trim().toUpperCase() === "ON") return true;
  return resolveExecutionPathMode(env) !== "DEMO";
}

export type ShadowBlockReason =
  | "SHADOW_GUARD" | "EMERGENCY_STOP" | "DUPLICATE_ORDER" | "SL_REQUIRED" | "TP_REQUIRED"
  | "MAX_POSITION" | "MAX_SYMBOL" | "MAX_DAILY_TRADE";

export interface ShadowRecord {
  readonly schema: typeof SHADOW_GUARD_VERSION;
  readonly mode: "SHADOW" | "DEMO";
  readonly symbol: string;
  readonly timestamp: string;
  readonly at: number;
  readonly signal_id: string;
  readonly source: "INTENT_GATE" | "GATEWAY_PORT";
  /** Engine decision that reached the guard (approved plans only ⇒ ALLOW). Copied, never re-decided. */
  readonly decision: "ALLOW";
  readonly risk_plan: { readonly direction: "BUY" | "SELL"; readonly entry: number | null; readonly stop_loss: number; readonly take_profit: number; readonly rr: number | null; readonly volume: number | null };
  readonly blocked_by: ShadowBlockReason | null;
  /** First safety rule that would also have blocked (shadow preview), or null if all passed. */
  readonly safety_result: ShadowBlockReason | null;
  readonly market: { readonly timeframe: "M5"; readonly closed_bar_at: number | null; readonly market_state: string | null; readonly bias: string | null; readonly h4_state: string | null; readonly zone: string | null; readonly trigger: Readonly<Record<string, string>> | null } | null;
  readonly decision_snapshot: { readonly result: string | null; readonly reasons: readonly string[]; readonly confidence: number | null } | null;
  readonly execution: { readonly shadow_block: boolean; readonly order_prevented: boolean };
}

export interface ShadowStore { readLines(): readonly string[]; append(line: string): void }

export interface ShadowOpenState { readonly openPositions: number; readonly openSymbols: readonly string[] }

export interface ShadowStatus {
  readonly version: typeof SHADOW_GUARD_VERSION;
  readonly active: boolean;
  readonly label: "SHADOW — NO ORDERS" | "DEMO — GUARDED";
  readonly safety: ShadowSafetyConfig;
  readonly emergency_stop_engaged: boolean;
  readonly blocked_total: number;
  readonly prevented_today: number;
  readonly last_record: ShadowRecord | null;
  readonly recent: readonly ShadowRecord[];
}

const dayOf = (ms: number) => Math.floor(ms / 86_400_000);

export class ShadowGuard {
  private readonly records: ShadowRecord[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly o: {
    active: () => boolean; store: ShadowStore; now: () => number; safety?: ShadowSafetyConfig;
    emergencyStop?: () => boolean; openState?: () => ShadowOpenState; log?: (m: string) => void;
  }) {
    for (const line of o.store.readLines()) {
      try { const r = JSON.parse(line) as ShadowRecord; if (r && typeof r.signal_id === "string") { this.records.push(Object.freeze(r)); this.seen.add(r.signal_id); } }
      catch { /* torn tail line is skipped, never rewritten */ }
    }
  }

  get safety(): ShadowSafetyConfig { return this.o.safety ?? DEFAULT_SHADOW_SAFETY; }
  active(): boolean { try { return this.o.active() !== false; } catch { return true; } }
  private stopEngaged(): boolean { try { return this.o.emergencyStop?.() === true; } catch { return true; } }

  private passedToday(): number {
    const d = dayOf(this.o.now());
    return this.records.filter((r) => r.blocked_by === null && dayOf(r.at) === d).length;
  }

  /** Fixed order, first failure wins. Pure copy checks on the plan; no strategy math. */
  private safetyCheck(intent: { signalId: string; symbol: string; stopLoss: number; takeProfit: number }): ShadowBlockReason | null {
    const s = this.safety;
    if (this.stopEngaged()) return "EMERGENCY_STOP";
    if (this.seen.has(intent.signalId)) return "DUPLICATE_ORDER";
    if (!(intent.stopLoss > 0)) return "SL_REQUIRED";
    if (!(intent.takeProfit > 0)) return "TP_REQUIRED";
    const open = this.o.openState?.() ?? { openPositions: 0, openSymbols: [] };
    if (open.openPositions >= s.maxPositions) return "MAX_POSITION";
    const syms = new Set(open.openSymbols.map((x) => x.toUpperCase()));
    if (!syms.has(intent.symbol.toUpperCase()) && syms.size >= s.maxSymbols) return "MAX_SYMBOL";
    if (this.passedToday() >= s.maxDailyTrades) return "MAX_DAILY_TRADE";
    return null;
  }

  private record(r: Omit<ShadowRecord, "schema" | "timestamp" | "at">): ShadowRecord {
    const at = this.o.now();
    const rec = Object.freeze({ schema: SHADOW_GUARD_VERSION, ...r, timestamp: new Date(at).toISOString(), at }) as ShadowRecord;
    this.o.store.append(JSON.stringify(rec)); // persist first
    this.records.push(rec);
    this.seen.add(rec.signal_id);
    this.o.log?.(`[shadow] ${rec.mode} ${rec.symbol} ${rec.signal_id} blocked_by=${rec.blocked_by ?? "NONE"}`);
    return rec;
  }

  /** Every approved order intent passes here. Returns allow=true only when shadow is OFF and every safety rule passes. */
  gate(intent: DemoOrderIntent): { allow: boolean; record: ShadowRecord } {
    const active = this.active();
    const duplicate = this.seen.has(intent.signalId);
    const safety = this.safetyCheck(intent);
    const blocked_by: ShadowBlockReason | null = duplicate ? "DUPLICATE_ORDER" : active ? "SHADOW_GUARD" : safety;
    const c = intent.context;
    const record = this.record({
      mode: active ? "SHADOW" : "DEMO", symbol: intent.symbol, signal_id: intent.signalId, source: "INTENT_GATE", decision: "ALLOW",
      risk_plan: { direction: intent.direction, entry: intent.plannedEntry, stop_loss: intent.stopLoss, take_profit: intent.takeProfit, rr: intent.rr, volume: null },
      blocked_by, safety_result: safety,
      market: { timeframe: "M5", closed_bar_at: intent.closedBarAt, market_state: c.regime, bias: c.primaryBias ?? null, h4_state: c.h4Bias, zone: c.setup, trigger: c.signalSource },
      decision_snapshot: { result: c.decision, reasons: c.reasons, confidence: c.confidence },
      execution: { shadow_block: active, order_prevented: blocked_by !== null },
    });
    return { allow: blocked_by === null, record };
  }

  /** Port-level check used by the gated gateway: true ⇒ the send must not happen. */
  blockPortSend(req: DemoOrderRequest): ShadowRecord | null {
    if (!this.active()) return null;
    return this.record({
      mode: "SHADOW", symbol: req.symbol, signal_id: `${req.signalId}#port`, source: "GATEWAY_PORT", decision: "ALLOW",
      risk_plan: { direction: req.direction, entry: null, stop_loss: req.stopLoss, take_profit: req.takeProfit, rr: null, volume: req.volume },
      blocked_by: "SHADOW_GUARD", safety_result: null, market: null, decision_snapshot: null,
      execution: { shadow_block: true, order_prevented: true },
    });
  }

  status(): ShadowStatus {
    const active = this.active();
    const d = dayOf(this.o.now());
    return Object.freeze({
      version: SHADOW_GUARD_VERSION, active, label: active ? "SHADOW — NO ORDERS" as const : "DEMO — GUARDED" as const,
      safety: this.safety, emergency_stop_engaged: this.stopEngaged(),
      blocked_total: this.records.filter((r) => r.blocked_by !== null).length,
      prevented_today: this.records.filter((r) => r.execution.order_prevented && dayOf(r.at) === d).length,
      last_record: this.records.at(-1) ?? null, recent: this.records.slice(-30),
    });
  }

  all(): readonly ShadowRecord[] { return [...this.records]; }
}

/** Wraps the demo gateway so sendOrder is physically unreachable while shadow is active. Reads pass through. */
export function shadowGatedGateway(port: DemoExecGatewayPort, guard: ShadowGuard): DemoExecGatewayPort {
  return {
    account: () => port.account(),
    symbol: (s) => port.symbol(s),
    positions: () => port.positions(),
    closeDeal: (t) => port.closeDeal(t),
    sendOrder: async (req): Promise<DemoOrderResponse> => {
      if (guard.blockPortSend(req)) return { status: "REJECTED", ticket: null, price: null, retcode: null, comment: "SHADOW_GUARD" };
      return port.sendOrder(req);
    },
  };
}
