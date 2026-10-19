/**
 * Lab DEMO runner (VPS, headless). Seven Lab modes evaluate CLOSED M5 bars; ONE dispatcher picks at most one
 * broker order per tick. Broker access only through the injected LabBrokerPort (fake in tests, loopback
 * mt5_exec/mt5_gateway on the VPS). Paper Lab ledger is never read or written here.
 *
 * Fail-closed: any unknown account / position / order / close state blocks NEW entries.
 * Risk: risk-policy.json (risk_per_trade, max_position, max_daily_trade, max_daily_loss) is read-only input;
 * the daily stop is the STRICTER of policy max_daily_loss × day-start balance and the operator −$30.
 * Clock: broker server time only (port.serverTimeMs); no Date.now().
 */
import { evaluateLab, type LabSignal, type LabStrategy } from "@/core/lab/strategies";
import { applySafetyRiders } from "@/core/lab/safetyRiders";
import { applySpv } from "@/core/lab/spvTraffic";
import type { LabState } from "@/core/lab/labLedger";
import type { TechBar } from "@/core/technical/indicators";
import { calculatePositionSize } from "@/engine/risk/positionSizer";
import type { BrokerSymbolInfo } from "@/engine/risk/types";
import type { RiskPolicy } from "@/engine/risk/riskPolicy";
import { DEFAULT_DAILY_LIMITS, evaluateDailyGuard, INITIAL_GUARD_STATE, restoreGuardState, type DailyGuardState } from "./dailyGuard";

export const LAB_DEMO_RUNNER_VERSION = "lab-demo-runner-v1";
/** The seven operator-selected modes and their short code used in signal_id. */
export const LAB_DEMO_MODES: Readonly<Record<string, string>> = Object.freeze({
  SMC_FIBO_OTE: "12", DUAL_WALL_FAST: "11", GOLD_SNIPER: "13", FAST_BREAKOUT: "5", RANGE_REVERSAL: "9", BREAKOUT_RETEST: "8", EMA_CROSS: "2",
});
export const LAB_DEMO_SYMBOLS = ["XAUUSD", "BTCUSD"] as const;
/** GOLD_SNIPER is XAU-only (Lab quota BTC = 0). */
const SYMBOL_MODE_BLOCK: Readonly<Record<string, readonly string[]>> = { BTCUSD: ["GOLD_SNIPER"] };
/** Broker trailing: COPET v2 dollar levels mapped onto R (XAU $3/$2 over $10 SL ⇒ 0.3R/0.2R); Mode 12 keeps its own R trail. */
export const LAB_DEMO_TRAIL = Object.freeze({ COPET_ARM_R: 0.3, COPET_GAP_R: 0.2, COPET_TP_R: 1, FIBO_ARM_R: 1, FIBO_GAP_R: 0.5, FIBO_MIN_GAP_USD: 1 });
export const UNKNOWN_ORDER_ABSENT_CYCLES = 2;

// ---------- ports ----------
export interface BrokerAccount { readonly login: number; readonly server: string; readonly tradeMode: string; readonly balance: number; readonly equity: number }
export interface BrokerPos { readonly ticket: number; readonly symbol: string; readonly comment: string; readonly magicOk: boolean; readonly volume: number; readonly profit: number | null; readonly sl: number | null; readonly tp: number | null }
export interface OrderResult { readonly status: "FILLED" | "REJECTED" | "ERROR"; readonly ticket: number | null; readonly price: number | null; readonly volume: number | null; readonly comment: string | null }
export interface CloseResult { readonly status: "CLOSED" | "REJECTED" | "UNVERIFIED" | "NOT_FOUND" | "ERROR"; readonly comment: string | null }
export interface CloseDeal { readonly ticket: number; readonly time: number; readonly profit: number; readonly reason: string }
export interface LabBrokerPort {
  serverTimeMs(): Promise<number | null>;
  account(): Promise<BrokerAccount | null>;
  /** Bot-magic positions only. null = unavailable. */
  positions(): Promise<readonly BrokerPos[] | null>;
  closedBars(symbol: string, tf: "M5" | "M15" | "H1"): Promise<readonly TechBar[] | null>;
  quote(symbol: string): Promise<{ bid: number; ask: number } | null>;
  spec(symbol: string): Promise<BrokerSymbolInfo | null>;
  /** Close deal of a bot position (profit incl. swap+commission). null = none yet. */
  closeDeal(positionTicket: number): Promise<CloseDeal | null>;
  sendOrder(req: { signal_id: string; symbol: string; direction: "BUY" | "SELL"; volume: number; sl: number; tp: number }): Promise<OrderResult>;
  closePosition(req: { ticket: number; signal_id: string }): Promise<CloseResult>;
}
export interface LabRunnerStore { load(): unknown; save(state: LabRunnerState): void; journal(event: Record<string, unknown>): void }

// ---------- state ----------
export type TradeStatus = "PENDING" | "OPEN" | "CLOSING" | "CLOSED" | "REJECTED" | "UNKNOWN" | "NOT_FILLED";
export interface RunnerTrade {
  readonly signalId: string; readonly strategy: string; readonly symbol: string; readonly side: "BUY" | "SELL"; readonly barTime: number;
  status: TradeStatus; ticket: number | null; volume: number; requestedVolume: number; entry: number | null; sl: number; tp: number;
  riskUsd: number; profile: "COPET" | "FIBO"; peakUsd: number; openedAt: number; closedAt: number | null; exitReason: string | null; pnlUsd: number | null; absentCycles: number; partial: boolean;
}
export interface LabRunnerState {
  readonly version: string;
  lastBar: Record<string, number>;
  seenSignals: string[];
  trades: RunnerTrade[];
  guard: DailyGuardState;
  dayStartBalance: { day: string; balance: number } | null;
  closeFailures: number;
  reconciliationClean: boolean;
  blockReason: string | null;
}
export const emptyRunnerState = (): LabRunnerState => ({ version: LAB_DEMO_RUNNER_VERSION, lastBar: {}, seenSignals: [], trades: [], guard: INITIAL_GUARD_STATE, dayStartBalance: null, closeFailures: 0, reconciliationClean: false, blockReason: "NOT_STARTED" });

export function restoreRunnerState(raw: unknown): LabRunnerState {
  const r = raw as Partial<LabRunnerState> | null;
  if (!r || r.version !== LAB_DEMO_RUNNER_VERSION || !Array.isArray(r.trades) || !Array.isArray(r.seenSignals)) return emptyRunnerState();
  // After restart: reconciliation must run clean again before any entry.
  return { ...emptyRunnerState(), ...r, guard: restoreGuardState(r.guard), reconciliationClean: false, blockReason: "RESTART_RECONCILE_PENDING" } as LabRunnerState;
}

export interface RunnerConfig {
  readonly policy: RiskPolicy;
  readonly whitelistLogins: ReadonlySet<number>;
  readonly whitelistServers: ReadonlySet<string>;
  /** false = SHADOW: everything runs, but sendOrder/closePosition are never called. */
  readonly armed: boolean;
  readonly killSwitch: () => boolean;
  readonly targetUsd?: number;
  readonly operatorLossUsd?: number;
}

/** signal_id ≤ 31 chars (MT5 comment limit): L<mode><sym><bar base36><side>. */
export function labSignalId(strategy: string, symbol: string, barTime: number, side: "BUY" | "SELL"): string {
  return `L${LAB_DEMO_MODES[strategy] ?? "x"}${symbol.slice(0, 3)}${Math.floor(barTime / 1000).toString(36)}${side[0]}`;
}
/** Comment match tolerates broker truncation (prefix ≥ 8 chars); magic + ticket are always checked too. */
export const commentMatches = (comment: string, sid: string) => comment === sid || (comment.length >= 8 && sid.startsWith(comment));

export const effectiveDailyLossUsd = (policy: RiskPolicy, dayStartBalance: number, operatorLossUsd = DEFAULT_DAILY_LIMITS.lossUsd) =>
  Math.min(operatorLossUsd, policy.max_daily_loss * dayStartBalance);

const ACTIVE: readonly TradeStatus[] = ["PENDING", "OPEN", "CLOSING", "UNKNOWN"];
const isActive = (t: RunnerTrade) => ACTIVE.includes(t.status);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class LabDemoRunner {
  private s: LabRunnerState;
  constructor(private readonly port: LabBrokerPort, private readonly store: LabRunnerStore, private readonly cfg: RunnerConfig) {
    this.s = restoreRunnerState(store.load());
  }
  get state(): Readonly<LabRunnerState> { return this.s; }

  private log(type: string, data: Record<string, unknown>) { this.store.journal({ type, version: LAB_DEMO_RUNNER_VERSION, ...data }); }
  private save() { this.store.save(this.s); }
  private block(reason: string) { this.s.blockReason = reason; }

  /** One cycle: reconcile → daily guard → trailing → (new closed bar) entries. Never throws. */
  async tick(): Promise<void> {
    try { await this.cycle(); } catch (e) { this.block(`CYCLE_ERROR ${(e as Error).message}`); this.log("CYCLE_ERROR", { error: String(e) }); }
    this.save();
  }

  private async cycle(): Promise<void> {
    const now = await this.port.serverTimeMs();
    if (now == null) return this.block("BROKER_TIME_UNAVAILABLE");
    const acct = await this.port.account();
    const demoOk = !!acct && acct.tradeMode === "DEMO" && this.cfg.whitelistLogins.has(acct.login) && this.cfg.whitelistServers.has(acct.server);
    if (!demoOk) { this.block(acct?.tradeMode === "REAL" ? "ACCOUNT_REAL_REFUSED" : "ACCOUNT_NOT_VERIFIED_DEMO"); return; }
    const day = dayOf(now);
    if (this.s.dayStartBalance?.day !== day) this.s.dayStartBalance = { day, balance: acct!.balance };

    const positions = await this.port.positions();
    if (!positions) return this.block("POSITIONS_UNAVAILABLE");
    await this.reconcile(positions, now);

    // ---- daily portfolio guard (stricter of policy and operator limit) ----
    const lossUsd = effectiveDailyLossUsd(this.cfg.policy, this.s.dayStartBalance!.balance, this.cfg.operatorLossUsd);
    const deals = this.s.trades.filter((t) => t.status === "CLOSED" && t.pnlUsd != null && t.closedAt != null && t.ticket != null)
      .map((t) => ({ ticket: t.ticket!, time: Math.floor(t.closedAt! / 1000), profit: t.pnlUsd!, isBot: true }));
    const botPos = positions.filter((p) => this.s.trades.some((t) => t.ticket === p.ticket && isActive(t)))
      .map((p) => ({ ticket: p.ticket, signalId: this.s.trades.find((t) => t.ticket === p.ticket)!.signalId, symbol: p.symbol, profit: p.profit }));
    const g = evaluateDailyGuard(this.s.guard, {
      serverTimeSec: Math.floor(now / 1000), accountVerifiedDemo: true, reconciliationClean: this.s.reconciliationClean,
      deals, positions: botPos, closeFailures: this.s.closeFailures,
    }, { targetUsd: this.cfg.targetUsd ?? DEFAULT_DAILY_LIMITS.targetUsd, lossUsd });
    if (g.state.phase !== this.s.guard.phase) this.log("DAILY_GUARD", { phase: g.state.phase, reason: g.state.reason, totalUsd: g.totalUsd, lossLimitUsd: lossUsd, affected: g.closeTickets });
    this.s.guard = g.state;
    for (const c of g.closeTickets) await this.close(c.ticket, c.signalId, g.state.phase === "LOSS_HIT" || g.state.reason?.includes("<=") ? "DAILY_LOSS" : "DAILY_TARGET");

    // ---- trailing on verified bot positions ----
    for (const t of this.s.trades.filter((x) => x.status === "OPEN")) {
      const p = positions.find((x) => x.ticket === t.ticket);
      if (!p || p.profit == null || t.riskUsd <= 0) continue;
      t.peakUsd = Math.max(t.peakUsd, p.profit);
      const T = LAB_DEMO_TRAIL;
      const arm = t.profile === "FIBO" ? T.FIBO_ARM_R * t.riskUsd : T.COPET_ARM_R * t.riskUsd;
      const gap = t.profile === "FIBO" ? Math.max(T.FIBO_MIN_GAP_USD, T.FIBO_GAP_R * t.riskUsd) : T.COPET_GAP_R * t.riskUsd;
      if (t.peakUsd >= arm && p.profit <= t.peakUsd - gap) await this.close(t.ticket!, t.signalId, "TRAIL");
    }

    if (!g.allowEntries) return this.block(`DAILY_GUARD ${g.state.reason ?? g.state.phase}`);
    if (this.cfg.killSwitch() || this.cfg.policy.emergency_stop) return this.block("KILL_SWITCH");
    if (!this.s.reconciliationClean) return this.block("RECONCILIATION_NOT_CLEAN");
    if (this.s.closeFailures > 0) return this.block("CLOSE_UNVERIFIED");
    if (this.s.trades.some((t) => t.status === "UNKNOWN" || t.status === "PENDING")) return this.block("ORDER_STATE_UNKNOWN");
    this.block(null as unknown as string);
    this.s.blockReason = null;
    await this.entries(acct!, now);
  }

  /** Broker ↔ state. Unknown bot positions or unexplained disappearances ⇒ not clean. Manual trades never appear (magic filter). */
  private async reconcile(positions: readonly BrokerPos[], now: number): Promise<void> {
    let clean = true;
    for (const p of positions) {
      if (!p.magicOk) continue;
      let t = this.s.trades.find((x) => x.ticket === p.ticket);
      if (!t) {
        t = this.s.trades.find((x) => (x.status === "UNKNOWN" || x.status === "PENDING") && x.symbol === p.symbol && commentMatches(p.comment, x.signalId));
        if (t) { t.status = "OPEN"; t.ticket = p.ticket; t.volume = p.volume; this.log("RECONCILE_ADOPT", { signalId: t.signalId, ticket: p.ticket }); }
        else { clean = false; this.log("RECONCILE_MISMATCH", { kind: "UNKNOWN_BOT_POSITION", ticket: p.ticket, symbol: p.symbol, comment: p.comment }); continue; }
      }
      if (p.sl == null || !(p.sl > 0)) { clean = false; this.log("RECONCILE_MISMATCH", { kind: "SL_MISSING", ticket: p.ticket }); }
    }
    for (const t of this.s.trades.filter((x) => x.status === "OPEN" || x.status === "CLOSING")) {
      if (positions.some((p) => p.ticket === t.ticket)) continue;
      const d = await this.port.closeDeal(t.ticket!);
      if (d) {
        Object.assign(t, { status: "CLOSED", closedAt: d.time * 1000, pnlUsd: d.profit, exitReason: t.exitReason ?? d.reason });
        this.log("TRADE_CLOSED", { signalId: t.signalId, ticket: t.ticket, pnlUsd: d.profit, reason: t.exitReason, note: "realized may differ from trigger (spread/slippage/gap)" });
        if (t.status === "CLOSED" && this.s.closeFailures > 0 && t.exitReason?.startsWith("FAIL")) this.s.closeFailures--;
      } else { clean = false; this.log("RECONCILE_MISMATCH", { kind: "POSITION_GONE_NO_DEAL", ticket: t.ticket }); }
    }
    for (const t of this.s.trades.filter((x) => x.status === "UNKNOWN")) {
      if (++t.absentCycles >= UNKNOWN_ORDER_ABSENT_CYCLES) { t.status = "NOT_FILLED"; this.log("ORDER_NOT_FILLED", { signalId: t.signalId }); }
    }
    this.s.reconciliationClean = clean;
    void now;
  }

  private async close(ticket: number, signalId: string, reason: string): Promise<void> {
    const t = this.s.trades.find((x) => x.ticket === ticket && x.signalId === signalId);
    if (!t || t.status !== "OPEN") return; // only verified bot positions; CLOSING waits for reconcile
    this.log("CLOSE_REQUEST", { ticket, signalId, reason, armed: this.cfg.armed });
    if (!this.cfg.armed) return;
    let r: CloseResult;
    try { r = await this.port.closePosition({ ticket, signal_id: signalId }); } catch (e) { r = { status: "ERROR", comment: `TIMEOUT_OR_TRANSPORT ${String(e)}` }; }
    this.log("CLOSE_RESULT", { ticket, signalId, status: r.status, comment: r.comment });
    if (r.status === "CLOSED") { t.status = "CLOSING"; t.exitReason = reason; }
    else if (r.status === "NOT_FOUND") { t.status = "CLOSING"; t.exitReason = reason; } // reconcile confirms via close deal
    else { this.s.closeFailures++; this.block(`CLOSE_${r.status}`); }
  }

  private async entries(acct: BrokerAccount, now: number): Promise<void> {
    const P = this.cfg.policy;
    const today = dayOf(now);
    const openCount = this.s.trades.filter(isActive).length;
    const tradesToday = this.s.trades.filter((t) => dayOf(t.openedAt) === today && t.status !== "REJECTED" && t.status !== "NOT_FILLED").length;
    if (openCount >= P.max_position) return;
    if (tradesToday >= P.max_daily_trade) return this.block("MAX_DAILY_TRADE");
    const candidates: { symbol: string; sig: LabSignal; m5: readonly TechBar[] }[] = [];
    for (const symbol of LAB_DEMO_SYMBOLS) {
      const m5 = await this.port.closedBars(symbol, "M5"), m15 = await this.port.closedBars(symbol, "M15"), h1 = await this.port.closedBars(symbol, "H1");
      if (!m5 || !m15 || !h1 || !m5.length) { this.log("DATA_UNAVAILABLE", { symbol }); continue; }
      const last = m5[m5.length - 1]!;
      if (last.close_time > now) continue; // not closed by broker clock
      if ((this.s.lastBar[symbol] ?? 0) >= last.open_time) continue; // one evaluation per closed bar
      this.s.lastBar[symbol] = last.open_time;
      if (this.s.trades.some((t) => t.symbol === symbol && isActive(t))) continue; // 1 position per symbol
      const sigs = evaluateLab(m5, m15, h1).filter((x) => x.strategy in LAB_DEMO_MODES && !(SYMBOL_MODE_BLOCK[symbol] ?? []).includes(x.strategy));
      const shim = { trades: this.s.trades.filter((t) => t.symbol === symbol && t.status === "CLOSED").map((t) => ({ symbol, strategy: t.strategy, side: t.side, closed_at: t.closedAt, exit_reason: t.exitReason === "SL" || t.exitReason === "TP" || t.exitReason === "TRAIL" ? t.exitReason : "MANUAL", signal_bar_time: t.barTime })) } as unknown as LabState;
      const rid = applySafetyRiders(sigs, shim, symbol, m5, now);
      if (rid.blocked) this.log("SAFETY_BLOCK", { symbol, blocked: rid.blocked });
      const spv = applySpv(rid.pass, shim, symbol, now);
      if (spv.blocked) this.log("SPV_BLOCK", { symbol, blocked: spv.blocked });
      const pick = spv.pass.find((x) => !this.s.seenSignals.includes(labSignalId(x.strategy, symbol, x.bar_time, x.side)));
      if (pick) candidates.push({ symbol, sig: pick, m5 });
    }
    // Single dispatcher: deterministic order (SPV priority already applied per symbol; XAU before BTC), global cap.
    let slots = P.max_position - openCount;
    for (const c of candidates) {
      if (slots <= 0 || tradesToday + (P.max_position - openCount - slots) >= P.max_daily_trade) break;
      if (await this.open(acct, c.symbol, c.sig, now)) slots--;
    }
  }

  private async open(acct: BrokerAccount, symbol: string, sig: LabSignal, now: number): Promise<boolean> {
    const sid = labSignalId(sig.strategy, symbol, sig.bar_time, sig.side);
    const fibo = sig.strategy === ("SMC_FIBO_OTE" satisfies LabStrategy);
    const q = await this.port.quote(symbol), spec = await this.port.spec(symbol);
    const reject = (reason: string) => { this.log("ENTRY_REJECTED", { signalId: sid, strategy: sig.strategy, symbol, reason }); this.s.seenSignals.push(sid); return false; };
    if (!q || !spec) return reject("QUOTE_OR_SPEC_UNAVAILABLE");
    const entry = sig.side === "BUY" ? q.ask : q.bid;
    const sl = fibo && sig.sl_price ? sig.sl_price : sig.side === "BUY" ? entry - sig.sl_distance : entry + sig.sl_distance;
    const slDist = Math.abs(entry - sl);
    const tp = fibo && sig.tp_price ? sig.tp_price : sig.side === "BUY" ? entry + slDist * LAB_DEMO_TRAIL.COPET_TP_R : entry - slDist * LAB_DEMO_TRAIL.COPET_TP_R;
    const sideOk = sig.side === "BUY" ? sl < entry && tp > entry : sl > entry && tp < entry;
    if (!(slDist > 0) || !sideOk || !Number.isFinite(tp)) return reject("INVALID_SL_TP"); // anti-chase: price beyond technical level
    const size = calculatePositionSize(acct.equity * this.cfg.policy.risk_per_trade, slDist, spec, true);
    if (!size || size.finalLot < spec.volumeMin || size.finalLot <= 0) return reject("SIZE_BELOW_MIN_FOR_RISK");
    // write-ahead
    const t: RunnerTrade = { signalId: sid, strategy: sig.strategy, symbol, side: sig.side, barTime: sig.bar_time, status: "PENDING", ticket: null, volume: 0, requestedVolume: size.finalLot,
      entry: null, sl, tp, riskUsd: size.actualRiskUSD, profile: fibo ? "FIBO" : "COPET", peakUsd: 0, openedAt: now, closedAt: null, exitReason: null, pnlUsd: null, absentCycles: 0, partial: false };
    this.s.seenSignals.push(sid); this.s.trades.push(t); this.save();
    this.log("ORDER_INTENT", { signalId: sid, strategy: sig.strategy, symbol, side: sig.side, volume: size.finalLot, sl, tp, riskUsd: size.actualRiskUSD, why: sig.why, armed: this.cfg.armed });
    if (!this.cfg.armed) { t.status = "NOT_FILLED"; t.exitReason = "SHADOW"; return false; }
    let r: OrderResult;
    try { r = await this.port.sendOrder({ signal_id: sid, symbol, direction: sig.side, volume: size.finalLot, sl, tp }); }
    catch (e) { t.status = "UNKNOWN"; this.log("ORDER_UNKNOWN", { signalId: sid, error: String(e) }); this.block("ORDER_STATE_UNKNOWN"); return true; }
    this.log("ORDER_RESULT", { signalId: sid, ...r });
    if (r.status === "FILLED" && r.ticket) {
      Object.assign(t, { status: "OPEN", ticket: r.ticket, entry: r.price, volume: r.volume ?? size.finalLot, partial: (r.volume ?? size.finalLot) < size.finalLot });
      if (t.partial) t.riskUsd = size.actualRiskUSD * (t.volume / size.finalLot);
      return true;
    }
    if (r.status === "ERROR") { t.status = "UNKNOWN"; this.block("ORDER_STATE_UNKNOWN"); return true; }
    t.status = "REJECTED"; t.exitReason = r.comment; return false;
  }
}
