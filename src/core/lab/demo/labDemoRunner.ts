/**
 * Lab DEMO runner v2 (VPS, headless). Seven Lab modes evaluate CLOSED M5 bars as candidate generators; ONE
 * deterministic dispatcher decides broker orders. Broker access only through LabBrokerPort (fake in tests,
 * loopback mt5_exec/mt5_gateway on the VPS) with Lab magic 610007. Paper Lab ledger is never read or written.
 *
 * Single config source: LabRiskPolicy (engine-host/lab-risk-policy.json). ARENA risk-policy.json is not read and no
 * ARENA STRICT veto (H4 bias, M1B, Decision Gate) is applied. Fixed Lab lots + COPET v2 nominal exits; Mode 12 keeps
 * technical Fibo SL/TP. Daily guard is signed P/L vs broker-day baseline (labPortfolioGuard.ts).
 * Fail-closed: unknown account / position / order / close / spec / baseline state blocks NEW entries.
 * Clock: broker server time only (port.serverTimeMs); no Date.now().
 */
import { evaluateLab, type LabSignal } from "@/core/lab/strategies";
import { applySafetyRiders } from "@/core/lab/safetyRiders";
import { applySpv, SPV_PRIORITY } from "@/core/lab/spvTraffic";
import type { LabState } from "@/core/lab/labLedger";
import type { TechBar } from "@/core/technical/indicators";
import type { BrokerSymbolInfo } from "@/engine/risk/types";
import { LAB_MAGIC, type LabRiskPolicy } from "./labRiskPolicy";
import { budgetAllows, computeDayPnl, nextPhase, usdAtPrice, type GuardSpec, type LabPhase } from "./labPortfolioGuard";

export const LAB_DEMO_RUNNER_VERSION = "lab-demo-runner-v2";
/** The seven operator-selected modes and their short code used in signal_id. */
export const LAB_DEMO_MODES: Readonly<Record<string, string>> = Object.freeze({
  SMC_FIBO_OTE: "12", DUAL_WALL_FAST: "11", GOLD_SNIPER: "13", FAST_BREAKOUT: "5", RANGE_REVERSAL: "9", BREAKOUT_RETEST: "8", EMA_CROSS: "2",
});
export const LAB_DEMO_SYMBOLS = ["XAUUSD", "BTCUSD"] as const;
type Sym = (typeof LAB_DEMO_SYMBOLS)[number];
/** GOLD_SNIPER is XAU-only (Lab quota BTC = 0). */
const SYMBOL_MODE_BLOCK: Readonly<Record<string, readonly string[]>> = { BTCUSD: ["GOLD_SNIPER"] };
export const UNKNOWN_ORDER_ABSENT_CYCLES = 3;
export const UNKNOWN_ORDER_MIN_AGE_MS = 120_000;

// ---------- ports ----------
export interface BrokerAccount { readonly login: number; readonly server: string; readonly tradeMode: string; readonly balance: number; readonly equity: number }
export interface BrokerPos {
  readonly ticket: number; readonly symbol: string; readonly comment: string; readonly magic: number; readonly side: "BUY" | "SELL";
  readonly volume: number; readonly priceOpen: number | null; readonly profit: number | null; readonly swap: number | null; readonly sl: number | null; readonly tp: number | null;
}
export interface OrderResult { readonly status: "FILLED" | "REJECTED" | "ERROR"; readonly ticket: number | null; readonly price: number | null; readonly volume: number | null; readonly comment: string | null }
export interface CloseResult { readonly status: "CLOSED" | "REJECTED" | "UNVERIFIED" | "NOT_FOUND" | "ERROR"; readonly comment: string | null }
export interface CloseDeal { readonly ticket: number; readonly time: number; readonly profit: number; readonly reason: string; readonly volume: number | null; readonly commission: number | null; readonly swap: number | null }
export interface LabBrokerPort {
  serverTimeMs(): Promise<number | null>;
  account(): Promise<BrokerAccount | null>;
  /** Lab-magic positions only (server-side filter). null = unavailable. */
  positions(): Promise<readonly BrokerPos[] | null>;
  closedBars(symbol: string, tf: "M5" | "M15" | "H1"): Promise<readonly TechBar[] | null>;
  quote(symbol: string): Promise<{ bid: number; ask: number } | null>;
  spec(symbol: string): Promise<BrokerSymbolInfo | null>;
  /** Exit deal(s) of a Lab position (profit incl. swap+commission). null = none (yet). */
  closeDeal(positionTicket: number): Promise<CloseDeal | null>;
  sendOrder(req: { signal_id: string; symbol: string; direction: "BUY" | "SELL"; volume: number; sl: number; tp: number; magic: number }): Promise<OrderResult>;
  closePosition(req: { ticket: number; signal_id: string; magic: number }): Promise<CloseResult>;
}
export interface LabRunnerStore { load(): unknown; save(state: LabRunnerState): void; journal(event: Record<string, unknown>): void }

// ---------- state ----------
export type TradeStatus = "PENDING" | "OPEN" | "CLOSING" | "CLOSED" | "REJECTED" | "UNKNOWN" | "NOT_FILLED";
export interface RunnerTrade {
  readonly signalId: string; readonly strategy: string; readonly symbol: string; readonly side: "BUY" | "SELL"; readonly barTime: number;
  status: TradeStatus; ticket: number | null; volume: number; requestedVolume: number; requestedPrice: number; entry: number | null; sl: number; tp: number;
  plannedRiskUsd: number; profile: "COPET" | "FIBO"; peakUsd: number; trailArmed: boolean; openedAt: number;
  /** Broker profit mark at the start of the current broker day (0 if opened that day). */
  dayBaseUsd: number; closedAt: number | null; closedDay: string | null; exitReason: string | null; closeReason: string | null; closeAttempts: number;
  pnlUsd: number | null; commissionUsd: number | null; swapUsd: number | null; slippagePoints: number | null; absentCycles: number; partial: boolean;
}
export interface LabRunnerState {
  readonly version: string;
  lastBar: Record<string, number>;
  seenSignals: string[];
  trades: RunnerTrade[];
  phase: LabPhase; phaseDay: string | null; day: string | null;
  reconciliationClean: boolean;
  blockReason: string | null;
  degradedTickets: number[];
}
export const emptyRunnerState = (): LabRunnerState => ({ version: LAB_DEMO_RUNNER_VERSION, lastBar: {}, seenSignals: [], trades: [], phase: "TRADING", phaseDay: null, day: null, reconciliationClean: false, blockReason: "NOT_STARTED", degradedTickets: [] });

/** Unreadable / foreign state ⇒ empty state: every live Lab position then reconciles as UNTRACKED (trailing degraded, entries blocked). */
export function restoreRunnerState(raw: unknown): LabRunnerState {
  const r = raw as Partial<LabRunnerState> | null;
  if (!r || r.version !== LAB_DEMO_RUNNER_VERSION || !Array.isArray(r.trades) || !Array.isArray(r.seenSignals)) return emptyRunnerState();
  return { ...emptyRunnerState(), ...r, reconciliationClean: false, blockReason: "RESTART_RECONCILE_PENDING" } as LabRunnerState;
}

export interface RunnerConfig {
  readonly policy: LabRiskPolicy;
  readonly whitelistLogins: ReadonlySet<number>;
  readonly whitelistServers: ReadonlySet<string>;
  /** false = SHADOW: everything runs, but sendOrder/closePosition are never called. */
  readonly armed: boolean;
  readonly killSwitch: () => boolean;
  /** Test seam only; production uses the Lab evaluateLab unchanged. */
  readonly evaluate?: typeof evaluateLab;
}

/** signal_id ≤ 31 chars (MT5 comment limit): L<mode><sym><bar base36><side>. */
export function labSignalId(strategy: string, symbol: string, barTime: number, side: "BUY" | "SELL"): string {
  return `L${LAB_DEMO_MODES[strategy] ?? "x"}${symbol.slice(0, 3)}${Math.floor(barTime / 1000).toString(36)}${side[0]}`;
}
export const commentMatches = (comment: string, sid: string) => comment === sid || (comment.length >= 8 && sid.startsWith(comment));

const ACTIVE: readonly TradeStatus[] = ["PENDING", "OPEN", "CLOSING", "UNKNOWN"];
const isActive = (t: RunnerTrade) => ACTIVE.includes(t.status);
export const brokerDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const rank = (s: string) => { const i = SPV_PRIORITY.indexOf(s); return i < 0 ? 99 : i; };
const toGuardSpec = (s: BrokerSymbolInfo | null): GuardSpec | null => (s && s.tickSize > 0 && s.tickValue > 0 ? { tickSize: s.tickSize, tickValue: s.tickValue } : null);

/** Broker volume preflight: lot is never changed; invalid ⇒ reject. */
export function volumeValid(lot: number, s: BrokerSymbolInfo): boolean {
  if (!(lot >= s.volumeMin && lot <= s.volumeMax) || !(s.volumeStep > 0)) return false;
  const k = lot / s.volumeStep;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

export class LabDemoRunner {
  private s: LabRunnerState;
  private specs: Record<string, BrokerSymbolInfo | null> = {};
  /** Tickets already sent a close this tick: a retry needs the NEXT tick's fresh positions read. */
  private closedThisTick = new Set<number>();
  constructor(private readonly port: LabBrokerPort, private readonly store: LabRunnerStore, private readonly cfg: RunnerConfig) {
    if (cfg.policy.magic !== LAB_MAGIC) throw new Error("LAB_MAGIC_REQUIRED");
    this.s = restoreRunnerState(store.load());
  }
  get state(): Readonly<LabRunnerState> { return this.s; }

  private log(type: string, data: Record<string, unknown>) { this.store.journal({ type, version: LAB_DEMO_RUNNER_VERSION, ...data }); }
  private save() { this.store.save(this.s); }
  private block(reason: string) { this.s.blockReason = reason; }

  /** Operator clears a sticky STATE_DESYNC_HALT after manual review (file trigger on VPS). */
  clearDesync(): void { if (this.s.phase === "STATE_DESYNC_HALT") { this.s.phase = "TRADING"; this.log("DESYNC_CLEARED", {}); this.save(); } }

  /** One cycle: reconcile → day baseline → portfolio guard → close retries/trailing → (new closed bar) dispatch. Never throws. */
  async tick(): Promise<void> {
    try { await this.cycle(); } catch (e) { this.block(`CYCLE_ERROR ${(e as Error).message}`); this.log("CYCLE_ERROR", { error: String(e) }); }
    this.save();
  }

  private async cycle(): Promise<void> {
    this.closedThisTick.clear();
    const now = await this.port.serverTimeMs();
    if (now == null) return this.block("BROKER_TIME_UNAVAILABLE");
    const acct = await this.port.account();
    const demoOk = !!acct && acct.tradeMode === "DEMO" && this.cfg.whitelistLogins.has(acct.login) && this.cfg.whitelistServers.has(acct.server);
    if (!demoOk) { this.block(acct?.tradeMode === "REAL" ? "ACCOUNT_REAL_REFUSED" : "ACCOUNT_NOT_VERIFIED_DEMO"); return; }
    for (const sym of LAB_DEMO_SYMBOLS) this.specs[sym] = await this.port.spec(sym);

    const raw = await this.port.positions();
    if (!raw) return this.block("POSITIONS_UNAVAILABLE");
    const positions = raw.filter((p) => p.magic === LAB_MAGIC); // defence in depth: never manage foreign/manual positions
    await this.reconcile(positions, now);

    // ---- broker-day baseline: positions crossing midnight start the new day at their current mark ----
    const day = brokerDay(now);
    if (this.s.day !== day) {
      for (const t of this.s.trades.filter((x) => x.status === "OPEN" || x.status === "CLOSING")) {
        const p = positions.find((x) => x.ticket === t.ticket);
        const mark = p?.profit == null ? null : p.profit + (p.swap ?? 0);
        t.dayBaseUsd = mark ?? 0; // unknown mark ⇒ 0 = charge the full SL scenario again (conservative)
        this.log("DAY_ROLLOVER_BASELINE", { day, ticket: t.ticket, dayBaseUsd: t.dayBaseUsd, markKnown: mark != null });
      }
      if (this.s.day) this.log("DAY_ROLLOVER", { from: this.s.day, to: day });
      this.s.day = day;
    }

    const P = this.cfg.policy;
    const gt = this.s.trades.filter((t) => t.ticket != null && (isActive(t) || t.status === "CLOSED"))
      .map((t) => ({ ticket: t.ticket!, symbol: t.symbol, side: t.side, volume: t.volume, dayBaseUsd: t.dayBaseUsd, closedDay: t.closedDay, pnlUsd: t.pnlUsd, open: isActive(t) }));
    const specs = Object.fromEntries(LAB_DEMO_SYMBOLS.map((s) => [s, toGuardSpec(this.specs[s] ?? null)]));
    const pnl = computeDayPnl(gt, positions, specs, day, P.friction_buffer_usd_per_position);
    const phase = nextPhase({ phase: this.s.phase, day: this.s.phaseDay }, day, pnl.dayPnlUsd, P.daily_target_usd, P.daily_stop_usd);
    if (phase !== this.s.phase || this.s.phaseDay !== day) {
      if (phase !== this.s.phase) this.log("PORTFOLIO_PHASE", { from: this.s.phase, to: phase, day, ...pnl, note: "realized result may differ from trigger (spread/slippage/gap/costs)" });
      this.s.phase = phase; this.s.phaseDay = day;
    }
    if (phase === "PORTFOLIO_STOP_HIT") for (const t of this.s.trades.filter((x) => x.status === "OPEN")) await this.close(t, "DAILY_STOP");
    if (phase === "PORTFOLIO_STOP_HIT" && pnl.openCount === 0 && pnl.realizedUsd < -P.daily_stop_usd)
      this.log("SLIPPAGE_OVERSHOOT", { day, realizedUsd: pnl.realizedUsd, stopUsd: P.daily_stop_usd });

    // ---- close retries: only after this tick's fresh positions read (idempotent) ----
    for (const t of this.s.trades.filter((x) => x.status === "CLOSING")) {
      if (this.closedThisTick.has(t.ticket!) || !positions.some((p) => p.ticket === t.ticket)) continue; // reconcile will confirm via deal
      if (t.closeAttempts >= P.max_close_attempts) {
        if (this.s.phase !== "STATE_DESYNC_HALT") { this.s.phase = "STATE_DESYNC_HALT"; this.log("STATE_DESYNC_HALT", { ticket: t.ticket, signalId: t.signalId, attempts: t.closeAttempts }); }
        continue;
      }
      await this.sendClose(t);
    }

    // ---- COPET / FIBO trailing on verified Lab positions (runner-side; broker still holds only the hard SL) ----
    for (const t of this.s.trades.filter((x) => x.status === "OPEN")) {
      const p = positions.find((x) => x.ticket === t.ticket);
      if (!p || p.profit == null) continue;
      const { arm, gap } = this.trail(t);
      t.peakUsd = Math.max(t.peakUsd, p.profit);
      if (!t.trailArmed && t.peakUsd >= arm) { t.trailArmed = true; this.log("TRAIL_ARMED", { ticket: t.ticket, peakUsd: t.peakUsd, floorUsd: t.peakUsd - gap }); }
      if (t.trailArmed && p.profit <= t.peakUsd - gap) await this.close(t, "TRAIL");
    }

    if (this.s.phase === "STATE_DESYNC_HALT") return this.block("STATE_DESYNC_HALT");
    if (phase !== "TRADING") return this.block(phase);
    if (this.cfg.killSwitch()) return this.block("KILL_SWITCH");
    if (!this.s.reconciliationClean) return this.block(this.s.degradedTickets.length ? "UNTRACKED_TRAILING_DEGRADED" : "RECONCILIATION_NOT_CLEAN");
    if (this.s.trades.some((t) => t.status === "CLOSING")) return this.block("CLOSE_NOT_VERIFIED");
    if (this.s.trades.some((t) => t.status === "UNKNOWN" || t.status === "PENDING")) return this.block("ORDER_STATE_UNKNOWN");
    if (pnl.worstCaseUsd == null) return this.block(`RISK_UNMEASURABLE ${pnl.unmeasurable.join(",")}`);
    this.s.blockReason = null;
    await this.dispatch(acct!, now, day, pnl.worstCaseUsd, positions);
  }

  private trail(t: RunnerTrade): { arm: number; gap: number } {
    const P = this.cfg.policy;
    if (t.profile === "FIBO") return { arm: P.fibo.arm_r * t.plannedRiskUsd, gap: Math.max(P.fibo.min_gap_usd, P.fibo.gap_r * t.plannedRiskUsd) };
    const c = P.copet[t.symbol as Sym];
    return { arm: c.trail_arm_usd, gap: c.trail_gap_usd };
  }

  /** Broker ↔ state. Manual closes confirmed only via deal history; vanished-without-deal keeps the slot occupied. */
  private async reconcile(positions: readonly BrokerPos[], now: number): Promise<void> {
    let clean = true;
    const degraded: number[] = [];
    for (const p of positions) {
      let t = this.s.trades.find((x) => x.ticket === p.ticket);
      if (!t) {
        t = this.s.trades.find((x) => (x.status === "UNKNOWN" || x.status === "PENDING") && x.symbol === p.symbol && commentMatches(p.comment, x.signalId));
        if (t) { Object.assign(t, { status: "OPEN", ticket: p.ticket, volume: p.volume, entry: p.priceOpen }); this.log("RECONCILE_ADOPT", { signalId: t.signalId, ticket: p.ticket }); }
        else { clean = false; degraded.push(p.ticket); this.log("RECONCILE_MISMATCH", { kind: "UNTRACKED_TRAILING_DEGRADED", ticket: p.ticket, symbol: p.symbol, comment: p.comment, note: "broker hard SL/TP only; runner does not touch it" }); continue; }
      }
      if (p.sl == null || !(p.sl > 0)) { clean = false; this.log("RECONCILE_MISMATCH", { kind: "SL_MISSING", ticket: p.ticket }); }
      if (p.volume < t.volume - 1e-9) { this.log("PARTIAL_CLOSE_DETECTED", { ticket: p.ticket, from: t.volume, to: p.volume }); t.volume = p.volume; t.partial = true; }
      t.absentCycles = 0;
    }
    for (const t of this.s.trades.filter((x) => x.status === "OPEN" || x.status === "CLOSING")) {
      if (positions.some((p) => p.ticket === t.ticket)) continue;
      const d = await this.port.closeDeal(t.ticket!);
      if (d) {
        const manual = t.status === "OPEN" && d.reason === "MANUAL";
        const exit = manual ? "EXIT_MANUAL_OPERATOR" : t.status === "CLOSING" ? t.closeReason : d.reason;
        Object.assign(t, { status: "CLOSED", closedAt: d.time * 1000, closedDay: brokerDay(d.time * 1000), pnlUsd: d.profit, commissionUsd: d.commission, swapUsd: d.swap, exitReason: exit });
        this.log("TRADE_CLOSED", { signalId: t.signalId, strategy: t.strategy, symbol: t.symbol, ticket: t.ticket, pnlUsd: d.profit, commissionUsd: d.commission, swapUsd: d.swap, brokerReason: d.reason, exitReason: exit, costsKnown: d.commission != null && d.swap != null });
      } else { clean = false; t.absentCycles++; this.log("RECONCILE_MISMATCH", { kind: "POSITION_GONE_NO_DEAL", ticket: t.ticket, cycles: t.absentCycles, note: "slot stays occupied until deal history confirms" }); }
    }
    for (const t of this.s.trades.filter((x) => x.status === "UNKNOWN")) {
      if (++t.absentCycles >= UNKNOWN_ORDER_ABSENT_CYCLES && now - t.openedAt >= UNKNOWN_ORDER_MIN_AGE_MS) { t.status = "NOT_FILLED"; this.log("ORDER_NOT_FILLED", { signalId: t.signalId }); }
    }
    this.s.reconciliationClean = clean;
    this.s.degradedTickets = degraded;
  }

  /** Marks CLOSING (write-ahead) then sends one close. Later attempts only via the retry loop after a fresh read. */
  private async close(t: RunnerTrade, reason: string): Promise<void> {
    if (t.status !== "OPEN") return;
    t.status = "CLOSING"; t.closeReason = reason;
    this.log("CLOSE_REQUEST", { ticket: t.ticket, signalId: t.signalId, reason, armed: this.cfg.armed });
    this.save();
    if (!this.cfg.armed) { t.status = "OPEN"; return; } // SHADOW: decision journaled only
    await this.sendClose(t);
  }

  private async sendClose(t: RunnerTrade): Promise<void> {
    if (!this.cfg.armed) return;
    this.closedThisTick.add(t.ticket!);
    t.closeAttempts++;
    let r: CloseResult;
    try { r = await this.port.closePosition({ ticket: t.ticket!, signal_id: t.signalId, magic: LAB_MAGIC }); } catch (e) { r = { status: "ERROR", comment: `TIMEOUT_OR_TRANSPORT ${String(e)}` }; }
    this.log("CLOSE_RESULT", { ticket: t.ticket, signalId: t.signalId, attempt: t.closeAttempts, status: r.status, comment: r.comment, note: r.status === "CLOSED" ? "awaiting deal history" : "will re-read positions before any retry" });
  }

  private async dispatch(acct: BrokerAccount, now: number, day: string, worstCase0: number, positions: readonly BrokerPos[]): Promise<void> {
    const P = this.cfg.policy;
    const cands: { symbol: Sym; sig: LabSignal; sid: string }[] = [];
    for (const symbol of LAB_DEMO_SYMBOLS) {
      const m5 = await this.port.closedBars(symbol, "M5"), m15 = await this.port.closedBars(symbol, "M15"), h1 = await this.port.closedBars(symbol, "H1");
      if (!m5 || !m15 || !h1 || !m5.length) { this.log("DATA_UNAVAILABLE", { symbol }); continue; }
      const last = m5[m5.length - 1]!;
      if (last.close_time > now) continue;
      if ((this.s.lastBar[symbol] ?? 0) >= last.open_time) continue; // one evaluation per closed bar, no stale queue
      this.s.lastBar[symbol] = last.open_time;
      const sigs = (this.cfg.evaluate ?? evaluateLab)(m5, m15, h1).filter((x) => x.strategy in LAB_DEMO_MODES);
      for (const x of sigs) if ((SYMBOL_MODE_BLOCK[symbol] ?? []).includes(x.strategy)) this.suppress(symbol, x, "INELIGIBLE_SYMBOL");
      const eligible = sigs.filter((x) => !(SYMBOL_MODE_BLOCK[symbol] ?? []).includes(x.strategy));
      const shim = { trades: this.s.trades.filter((t) => t.symbol === symbol && (t.status === "CLOSED" || isActive(t))).map((t) => ({ symbol, strategy: t.strategy, side: t.side, closed_at: t.status === "CLOSED" ? t.closedAt : null, exit_reason: t.status !== "CLOSED" ? null : t.exitReason === "SL" || t.exitReason === "TP" || t.exitReason === "TRAIL" ? t.exitReason : "MANUAL", signal_bar_time: t.barTime })) } as unknown as LabState;
      const rid = applySafetyRiders(eligible, shim, symbol, m5, now);
      for (const x of eligible.filter((e) => !rid.pass.includes(e))) this.suppress(symbol, x, `SUPPRESSED_SAFETY ${rid.blocked ?? ""}`.trim());
      const spv = applySpv(rid.pass, shim, symbol, now);
      for (const x of rid.pass.filter((e) => !spv.pass.includes(e))) this.suppress(symbol, x, spv.blocked === "BLOCK_SPV_STALE_SIGNAL" ? "SUPPRESSED_STALE" : "SUPPRESSED_DIRECTION_LOCK");
      for (const x of spv.pass) {
        const sid = labSignalId(x.strategy, symbol, x.bar_time, x.side);
        if (!this.s.seenSignals.includes(sid)) cands.push({ symbol, sig: x, sid });
      }
    }
    // Single dispatcher: SPV rank, then XAU before BTC. Rank is a selection rule, not a performance claim.
    cands.sort((a, b) => rank(a.sig.strategy) - rank(b.sig.strategy) || LAB_DEMO_SYMBOLS.indexOf(a.symbol) - LAB_DEMO_SYMBOLS.indexOf(b.symbol));
    let worst = worstCase0;
    for (const c of cands) {
      const active = this.s.trades.filter(isActive);
      const today = this.s.trades.filter((t) => brokerDay(t.openedAt) === day && t.status !== "REJECTED" && t.status !== "NOT_FILLED").length;
      const sup = (r: string, extra: Record<string, unknown> = {}) => { this.s.seenSignals.push(c.sid); this.suppress(c.symbol, c.sig, r, extra); };
      if (active.filter((t) => t.strategy === c.sig.strategy).length >= P.max_active_positions_per_mode) { sup("SUPPRESSED_MODE_SLOT_FULL"); continue; }
      if (active.length >= P.max_active_positions_total) { sup("SUPPRESSED_SLOT_FULL"); continue; }
      if (active.filter((t) => t.symbol === c.symbol).length >= P.max_active_positions_per_symbol) { sup("SUPPRESSED_SYMBOL_CAP"); continue; }
      if (active.some((t) => t.symbol === c.symbol && t.side !== c.sig.side)) { sup("SUPPRESSED_DIRECTION_LOCK", { against: "ACTIVE_POSITION" }); continue; }
      if (P.max_trades_per_day != null && today >= P.max_trades_per_day) { sup("SUPPRESSED_DAILY_TRADE_CAP"); continue; }
      const loss = await this.open(acct, c.symbol, c.sig, c.sid, now, worst, positions);
      if (loss != null) worst -= loss + P.friction_buffer_usd_per_position;
    }
  }

  private suppress(symbol: string, sig: LabSignal, reason: string, extra: Record<string, unknown> = {}) {
    this.log("CANDIDATE_SUPPRESSED", { symbol, strategy: sig.strategy, side: sig.side, barTime: sig.bar_time, reason, ...extra });
  }

  /** Returns the planned SL loss (USD, ≥0) when an order intent was created, else null. */
  private async open(acct: BrokerAccount, symbol: Sym, sig: LabSignal, sid: string, now: number, worstCase: number, positions: readonly BrokerPos[]): Promise<number | null> {
    const P = this.cfg.policy;
    const fibo = sig.strategy === "SMC_FIBO_OTE";
    const reject = (reason: string, extra: Record<string, unknown> = {}) => { this.log("ENTRY_REJECTED", { signalId: sid, strategy: sig.strategy, symbol, reason, ...extra }); this.s.seenSignals.push(sid); return null; };
    const q = await this.port.quote(symbol), spec = this.specs[symbol] ?? null;
    if (!q || !spec || !toGuardSpec(spec)) return reject("QUOTE_OR_SPEC_UNAVAILABLE");
    const entry = sig.side === "BUY" ? q.ask : q.bid;
    const dir = sig.side === "BUY" ? 1 : -1;
    let lot: number, sl: number, tp: number;
    if (fibo) {
      lot = P.fibo.lot[symbol];
      sl = sig.sl_price ?? entry - dir * sig.sl_distance;
      tp = sig.tp_price ?? (sig.tp_distance ? entry + dir * sig.tp_distance : NaN);
    } else {
      const c = P.copet[symbol];
      lot = c.lot;
      sl = entry - dir * (c.sl_usd / (c.lot * c.contract_size_assumed));
      tp = entry + dir * (c.tp_usd / (c.lot * c.contract_size_assumed));
    }
    const sideOk = sig.side === "BUY" ? sl < entry && tp > entry : sl > entry && tp < entry;
    if (!Number.isFinite(sl) || !Number.isFinite(tp) || !sideOk) return reject("INVALID_SL_TP"); // anti-chase: price beyond technical level
    if (!volumeValid(lot, spec)) return reject("REJECTED_BROKER_VOLUME", { lot, volumeMin: spec.volumeMin, volumeStep: spec.volumeStep, volumeMax: spec.volumeMax });
    const slLoss = -usdAtPrice(sig.side, entry, sl, lot, { tickSize: spec.tickSize, tickValue: spec.tickValue });
    if (!fibo) {
      const exp = P.copet[symbol].sl_usd;
      if (Math.abs(slLoss - exp) / exp > P.broker_spec_tolerance) return reject("REJECTED_BROKER_SPEC_MISMATCH", { brokerSlUsd: slLoss, profileSlUsd: exp, tickSize: spec.tickSize, tickValue: spec.tickValue });
    }
    const b = budgetAllows(worstCase, slLoss, P.friction_buffer_usd_per_position, P.daily_stop_usd);
    if (!b.ok) return reject("REJECTED_BUDGET_EXCEEDED", { worstCaseUsd: worstCase, candidateSlLossUsd: slLoss, projectedUsd: b.projectedUsd, stopUsd: P.daily_stop_usd });

    const t: RunnerTrade = { signalId: sid, strategy: sig.strategy, symbol, side: sig.side, barTime: sig.bar_time, status: "PENDING", ticket: null, volume: 0, requestedVolume: lot, requestedPrice: entry,
      entry: null, sl, tp, plannedRiskUsd: slLoss, profile: fibo ? "FIBO" : "COPET", peakUsd: 0, trailArmed: false, openedAt: now, dayBaseUsd: 0, closedAt: null, closedDay: null,
      exitReason: null, closeReason: null, closeAttempts: 0, pnlUsd: null, commissionUsd: null, swapUsd: null, slippagePoints: null, absentCycles: 0, partial: false };
    this.s.seenSignals.push(sid); this.s.trades.push(t); this.save();
    const exposure = Object.fromEntries(LAB_DEMO_SYMBOLS.map((s) => { const xs = this.s.trades.filter((x) => isActive(x) && x.symbol === s); return [s, { positions: xs.length, lots: xs.reduce((a, x) => a + (x.volume || x.requestedVolume), 0), plannedSlRiskUsd: xs.reduce((a, x) => a + x.plannedRiskUsd, 0), correlated: xs.length > 1 }]; }));
    this.log("ORDER_INTENT", { signalId: sid, strategy: sig.strategy, symbol, side: sig.side, lot, sl, tp, requestedPrice: entry, plannedSlRiskUsd: slLoss, worstCaseAfterUsd: b.projectedUsd, symbolExposure: exposure, why: sig.why, armed: this.cfg.armed, brokerPositionsSeen: positions.length });
    if (!this.cfg.armed) { t.status = "NOT_FILLED"; t.exitReason = "SHADOW"; return null; }
    let r: OrderResult;
    try { r = await this.port.sendOrder({ signal_id: sid, symbol, direction: sig.side, volume: lot, sl, tp, magic: LAB_MAGIC }); }
    catch (e) { t.status = "UNKNOWN"; this.log("ORDER_UNKNOWN", { signalId: sid, error: String(e) }); this.block("ORDER_STATE_UNKNOWN"); return slLoss; }
    this.log("ORDER_RESULT", { signalId: sid, ...r });
    if (r.status === "FILLED" && r.ticket) {
      const vol = r.volume ?? lot;
      const slip = r.price != null ? ((r.price - entry) * dir) / spec.tickSize : null;
      Object.assign(t, { status: "OPEN", ticket: r.ticket, entry: r.price, volume: vol, partial: vol < lot - 1e-9, slippagePoints: slip });
      if (t.partial) t.plannedRiskUsd = slLoss * (vol / lot);
      if (slip != null || t.partial) this.log("FILL_VS_PLAN", { signalId: sid, requestedPrice: entry, fillPrice: r.price, slippagePoints: slip, requestedLot: lot, filledLot: vol, note: "recorded only; Lab rules unchanged" });
      return slLoss;
    }
    if (r.status === "ERROR") { t.status = "UNKNOWN"; this.block("ORDER_STATE_UNKNOWN"); return slLoss; }
    t.status = "REJECTED"; t.exitReason = r.comment; return null;
  }
}
