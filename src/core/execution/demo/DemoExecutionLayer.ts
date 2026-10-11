// Phase 3 — Demo Execution Readiness. Pathway: Decision Gate → Risk Validation → Demo Execution Layer → Broker Demo API.
// Executor only: it never evaluates strategy, bias, entry, SL/TP or risk math. It receives an already-approved intent plus
// the risk validation outcome (copied), runs broker order safety preflight, records every order lifecycle state append-only,
// and reconciles internal state vs broker demo positions. Disabled by default (EXECUTION_MODE=SHADOW).
// Phase 3.5 wired in engine-host; Phase 4A adds MAX_SYMBOL on real broker positions + PositionReconciler.
import { validateDemoAccount } from "./guards";
import type { DemoExecGatewayPort, DemoOrderIntent, DemoOrderRequest, DemoOrderResponse, DemoPosition, DemoWhitelist } from "./types";

export const DEMO_EXECUTION_LAYER_VERSION = "demo-exec-layer-v1" as const;

export type ExecutionPathMode = "SHADOW" | "DEMO";

/** SHADOW unless EXECUTION_MODE is explicitly "DEMO" (legacy "DEMO_STRESS_TEST" accepted). Anything else fails closed. */
export function resolveExecutionPathMode(env: { EXECUTION_MODE?: string | undefined }): ExecutionPathMode {
  const v = env.EXECUTION_MODE?.trim();
  return v === "DEMO" || v === "DEMO_STRESS_TEST" ? "DEMO" : "SHADOW";
}

/** Risk Validation outcome produced upstream (copied, never computed here). */
export interface RiskValidation { readonly approved: boolean; readonly volume: number | null; readonly reason?: string }

export type PreflightBlock =
  | "EXECUTION_MODE_SHADOW" | "SYMBOL_INVALID" | "ACCOUNT_NOT_CONNECTED" | "POSITION_LIMIT"
  | "DUPLICATE_ORDER" | "SL_MISSING" | "TP_MISSING" | "RISK_NOT_APPROVED" | "SYMBOL_LIMIT" | "DUPLICATE_SYMBOL" | "RECONCILE_MISMATCH";

export type OrderState = "REQUESTED" | "ACCEPTED" | "REJECTED" | "FILLED" | "CANCELLED" | "CLOSED" | "BLOCKED";

const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  REQUESTED: ["ACCEPTED", "REJECTED", "FILLED", "CANCELLED"],
  ACCEPTED: ["FILLED", "CANCELLED", "REJECTED"],
  FILLED: ["CLOSED"],
  REJECTED: [], CANCELLED: [], CLOSED: [], BLOCKED: [],
};

export interface OrderLifecycleRecord {
  readonly schema: typeof DEMO_EXECUTION_LAYER_VERSION;
  readonly signal_id: string; readonly symbol: string; readonly mode: ExecutionPathMode;
  readonly state: OrderState; readonly at: number; readonly timestamp: string;
  readonly detail: string | null; readonly data: Readonly<Record<string, unknown>> | null;
}

export interface LifecycleStore { readLines(): readonly string[]; append(line: string): void }

export class OrderLifecycleLog {
  private readonly records: OrderLifecycleRecord[] = [];
  private readonly current = new Map<string, OrderState>();
  constructor(private readonly store: LifecycleStore, private readonly now: () => number) {
    for (const line of store.readLines()) {
      try { const r = JSON.parse(line) as OrderLifecycleRecord; if (r && typeof r.signal_id === "string") { this.records.push(Object.freeze(r)); this.current.set(r.signal_id, r.state); } }
      catch { /* torn line skipped, never rewritten */ }
    }
  }
  state(signalId: string): OrderState | null { return this.current.get(signalId) ?? null; }
  has(signalId: string): boolean { return this.current.has(signalId); }
  /** Append a state. Initial must be REQUESTED or BLOCKED; later states must follow TRANSITIONS. Invalid → throws. */
  record(signalId: string, symbol: string, mode: ExecutionPathMode, state: OrderState, detail: string | null = null, data: Record<string, unknown> | null = null): OrderLifecycleRecord {
    const prev = this.current.get(signalId);
    const ok = prev === undefined ? state === "REQUESTED" || state === "BLOCKED" : TRANSITIONS[prev].includes(state);
    if (!ok) throw new Error(`INVALID_TRANSITION ${prev ?? "NONE"}→${state}`);
    const at = this.now();
    const rec = Object.freeze({ schema: DEMO_EXECUTION_LAYER_VERSION, signal_id: signalId, symbol, mode, state, at, timestamp: new Date(at).toISOString(), detail, data }) as OrderLifecycleRecord;
    this.store.append(JSON.stringify(rec)); // persist before in-memory
    this.records.push(rec); this.current.set(signalId, state);
    return rec;
  }
  all(): readonly OrderLifecycleRecord[] { return [...this.records]; }
  /** signal ids whose latest state is FILLED (internal open positions). */
  openSignals(): readonly { signalId: string; symbol: string }[] {
    const out: { signalId: string; symbol: string }[] = [];
    for (const [id, s] of this.current) if (s === "FILLED") out.push({ signalId: id, symbol: [...this.records].reverse().find((r) => r.signal_id === id)!.symbol });
    return out;
  }
}

export interface DemoLayerOptions {
  readonly mode: ExecutionPathMode;
  readonly gateway: DemoExecGatewayPort;
  readonly whitelist: DemoWhitelist;
  readonly lifecycle: OrderLifecycleLog;
  readonly maxPositions?: number;
  /** Phase 4A: max distinct symbols across actual broker positions (risk-policy.json max_symbol). */
  readonly maxSymbols?: number;
  /** Phase 4A: post-order + periodic reconciliation; a mismatch blocks new orders. */
  readonly reconciler?: PositionReconciler;
}

export type ExecuteResult =
  | { readonly sent: false; readonly blocked_by: PreflightBlock }
  | { readonly sent: true; readonly state: OrderState; readonly ticket: number | null };

export class DemoExecutionLayer {
  constructor(private readonly o: DemoLayerOptions) {}

  /** Fixed order; first failure wins. Mode check first, so SHADOW never touches the broker (no reads either). */
  async preflight(intent: DemoOrderIntent, risk: RiskValidation): Promise<PreflightBlock | null> {
    if (this.o.mode !== "DEMO") return "EXECUTION_MODE_SHADOW";
    if (this.o.lifecycle.has(intent.signalId)) return "DUPLICATE_ORDER";
    if (!(intent.stopLoss > 0)) return "SL_MISSING";
    if (!(intent.takeProfit > 0)) return "TP_MISSING";
    if (!risk.approved || !(risk.volume !== null && risk.volume > 0)) return "RISK_NOT_APPROVED";
    if (this.o.reconciler?.blocked()) return "RECONCILE_MISMATCH";
    let info = null; try { info = await this.o.gateway.symbol(intent.symbol); } catch { info = null; }
    if (!info || info.symbol.toUpperCase() !== intent.symbol.toUpperCase()) return "SYMBOL_INVALID";
    let acct = null; try { acct = await this.o.gateway.account(); } catch { acct = null; }
    if (!validateDemoAccount(acct, this.o.whitelist).ok) return "ACCOUNT_NOT_CONNECTED";
    let positions: readonly DemoPosition[] = [];
    try { positions = await this.o.gateway.positions(); } catch { return "ACCOUNT_NOT_CONNECTED"; }
    if (positions.some((p) => p.comment.includes(intent.signalId))) return "DUPLICATE_ORDER";
    if (positions.length >= (this.o.maxPositions ?? 1)) return "POSITION_LIMIT";
    // Phase 4A MAX_SYMBOL on actual broker positions: one position per symbol, and a cap on distinct symbols.
    const syms = new Set(positions.map((p) => p.symbol.toUpperCase()));
    if (syms.has(intent.symbol.toUpperCase())) return "DUPLICATE_SYMBOL";
    if (syms.size >= (this.o.maxSymbols ?? 1)) return "SYMBOL_LIMIT";
    return null;
  }

  /** Shared core: preflight → lifecycle REQUESTED → broker send → lifecycle FILLED/REJECTED. */
  private async run(intent: DemoOrderIntent, risk: RiskValidation): Promise<{ block: PreflightBlock | null; response: DemoOrderResponse | null }> {
    const block = await this.preflight(intent, risk);
    const lc = this.o.lifecycle;
    if (block) {
      if (block !== "DUPLICATE_ORDER") lc.record(intent.signalId, intent.symbol, this.o.mode, "BLOCKED", block);
      return { block, response: null };
    }
    lc.record(intent.signalId, intent.symbol, "DEMO", "REQUESTED", null, { direction: intent.direction, volume: risk.volume, sl: intent.stopLoss, tp: intent.takeProfit });
    try {
      const r = await this.o.gateway.sendOrder({ signalId: intent.signalId, symbol: intent.symbol, direction: intent.direction, volume: risk.volume!, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit });
      lc.record(intent.signalId, intent.symbol, "DEMO", r.status === "FILLED" ? "FILLED" : "REJECTED", r.comment, { ticket: r.ticket, price: r.price, retcode: r.retcode });
      // Phase 4A A: SEND → RESPONSE → QUERY BROKER POSITION → RECONCILE → JOURNAL
      await this.o.reconciler?.reconcile("POST_ORDER").catch(() => undefined);
      return { block: null, response: r };
    } catch (e) {
      lc.record(intent.signalId, intent.symbol, "DEMO", "REJECTED", `ERROR ${(e as Error).message}`);
      await this.o.reconciler?.reconcile("POST_ORDER").catch(() => undefined);
      return { block: null, response: { status: "ERROR", ticket: null, price: null, retcode: null, comment: (e as Error).message } };
    }
  }

  async execute(intent: DemoOrderIntent, risk: RiskValidation): Promise<ExecuteResult> {
    const r = await this.run(intent, risk);
    if (r.block) return { sent: false, blocked_by: r.block };
    return { sent: true, state: r.response!.status === "FILLED" ? "FILLED" : "REJECTED", ticket: r.response!.ticket };
  }

  /** Phase 3.5 wiring adapter: exposes the layer as a DemoExecGatewayPort so it sits between risk validation
   *  (DemoExecutionBridge sizing) and the shadow-gated broker gateway. sendOrder runs the full preflight plus
   *  lifecycle logging; a positive volume from the bridge is the copied risk-validation outcome. Reads pass through. */
  asGatewayPort(): DemoExecGatewayPort {
    const self = this;
    return {
      account: () => self.o.gateway.account(),
      symbol: (s) => self.o.gateway.symbol(s),
      positions: () => self.o.gateway.positions(),
      closeDeal: (t) => self.o.gateway.closeDeal(t),
      sendOrder: async (req: DemoOrderRequest): Promise<DemoOrderResponse> => {
        const intent: DemoOrderIntent = {
          signalId: req.signalId, planId: "", symbol: req.symbol, direction: req.direction,
          plannedEntry: 0, stopLoss: req.stopLoss, takeProfit: req.takeProfit, rr: null, closedBarAt: 0,
          context: { regime: null, h4Bias: null, h1State: null, setup: null, decision: null, confidence: null, reasons: [], signalSource: {}, engineSnapshot: null },
        };
        const r = await self.run(intent, { approved: req.volume > 0, volume: req.volume });
        if (r.block) return { status: "REJECTED", ticket: null, price: null, retcode: null, comment: r.block };
        return r.response!;
      },
    };
  }
}

export type ReconcileIssue =
  | { readonly kind: "MISSING_POSITION"; readonly signalId: string; readonly symbol: string }
  | { readonly kind: "DUPLICATE_POSITION"; readonly signalId: string; readonly tickets: readonly number[] }
  | { readonly kind: "MISMATCH"; readonly signalId: string; readonly internalSymbol: string; readonly brokerSymbol: string; readonly ticket: number }
  | { readonly kind: "UNTRACKED_POSITION"; readonly ticket: number; readonly symbol: string };

/** Pure comparison: internal FILLED signals vs broker demo positions (matched by signal id in order comment). */
export function reconcilePositions(internal: readonly { signalId: string; symbol: string }[], broker: readonly DemoPosition[]): { readonly ok: boolean; readonly issues: readonly ReconcileIssue[] } {
  const issues: ReconcileIssue[] = [];
  const matched = new Set<number>();
  for (const i of internal) {
    const hits = broker.filter((p) => p.comment.includes(i.signalId));
    hits.forEach((h) => matched.add(h.ticket));
    if (hits.length === 0) issues.push({ kind: "MISSING_POSITION", signalId: i.signalId, symbol: i.symbol });
    else if (hits.length > 1) issues.push({ kind: "DUPLICATE_POSITION", signalId: i.signalId, tickets: hits.map((h) => h.ticket) });
    for (const h of hits) if (h.symbol.toUpperCase() !== i.symbol.toUpperCase()) issues.push({ kind: "MISMATCH", signalId: i.signalId, internalSymbol: i.symbol, brokerSymbol: h.symbol, ticket: h.ticket });
  }
  for (const p of broker) if (!matched.has(p.ticket)) issues.push({ kind: "UNTRACKED_POSITION", ticket: p.ticket, symbol: p.symbol });
  return { ok: issues.length === 0, issues };
}

// ---- Phase 4A — Broker reconciliation (post-order + periodic). Executor-side state check only. ----
export const RECONCILE_INTERVAL_MS = 60_000;

export interface ReconcileRecord {
  readonly schema: "reconcile-v1"; readonly trigger: "POST_ORDER" | "PERIODIC" | "STARTUP";
  readonly at: number; readonly timestamp: string; readonly ok: boolean;
  readonly issues: readonly ReconcileIssue[]; readonly broker_positions: number; readonly internal_open: number;
  readonly closed: readonly string[]; readonly error: string | null;
}

/** Compares lifecycle FILLED signals vs actual broker positions. Broker-side SL/TP closes are recorded as CLOSED
 *  (confirmed via closeDeal), never flagged. Any mismatch ⇒ blocked() true until a later clean reconcile.
 *  On restart the last persisted record seeds the block flag (fail closed). Every run is journaled append-only. */
export class PositionReconciler {
  private isBlocked = false;
  private last: ReconcileRecord | null = null;
  constructor(private readonly o: {
    gateway: DemoExecGatewayPort; lifecycle: OrderLifecycleLog; store: LifecycleStore; now: () => number;
    alert?: (r: ReconcileRecord) => void;
  }) {
    const lines = o.store.readLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const r = JSON.parse(lines[i]!) as ReconcileRecord; if (r && r.schema === "reconcile-v1") { this.last = r; this.isBlocked = !r.ok; break; } } catch { /* torn */ }
    }
  }
  blocked(): boolean { return this.isBlocked; }
  lastRecord(): ReconcileRecord | null { return this.last; }

  async reconcile(trigger: ReconcileRecord["trigger"]): Promise<ReconcileRecord> {
    let positions: readonly DemoPosition[] | null = null; let error: string | null = null;
    try { positions = await this.o.gateway.positions(); } catch (e) { error = (e as Error).message; }
    const closed: string[] = [];
    let issues: readonly ReconcileIssue[] = [];
    if (positions) {
      let r = reconcilePositions(this.o.lifecycle.openSignals(), positions);
      for (const i of r.issues) {
        if (i.kind !== "MISSING_POSITION") continue;
        const ticket = Number(this.o.lifecycle.all().find((x) => x.signal_id === i.signalId && x.state === "FILLED")?.data?.["ticket"]);
        const deal = Number.isFinite(ticket) ? await this.o.gateway.closeDeal(ticket).catch(() => null) : null;
        if (deal) { this.o.lifecycle.record(i.signalId, i.symbol, "DEMO", "CLOSED", deal.reason, { ...deal }); closed.push(i.signalId); }
      }
      if (closed.length) r = reconcilePositions(this.o.lifecycle.openSignals(), positions);
      issues = r.issues;
    }
    const at = this.o.now();
    const ok = positions !== null && issues.length === 0;
    const rec: ReconcileRecord = Object.freeze({
      schema: "reconcile-v1", trigger, at, timestamp: new Date(at).toISOString(), ok, issues,
      broker_positions: positions?.length ?? 0, internal_open: this.o.lifecycle.openSignals().length, closed, error,
    });
    this.o.store.append(JSON.stringify(rec)); // journal first
    this.last = rec; this.isBlocked = !ok;
    if (!ok) { try { this.o.alert?.(rec); } catch { /* alert never affects state */ } }
    return rec;
  }
}
