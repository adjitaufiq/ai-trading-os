// Demo Stress Test executor (Stage 10 DEMO). Executor only: it receives an already-approved engine plan
// (READY + plan PLANNED + M4 APPROVED) and forwards it to the loopback demo gateway after identity + safety checks.
// No discretionary logic, no AI, no signal/risk/radar mutation. Every step is written to an append-only event log
// BEFORE the next side effect (SEND_ATTEMPT is written before the order is sent) so a restart can never double-send.
import { calculatePositionSize } from "../../../engine/risk/positionSizer";
import { checkDemoSafety, dailyLossPercent, validateDemoAccount } from "./guards";
import {
  DEMO_EXECUTION_POLICY_VERSION, DEMO_RISK_PROFILE, type AccountBlockReason, type BlockReason, type DemoAccountIdentity,
  type DemoEvent, type DemoExecGatewayPort, type DemoLabStatus, type DemoOrderIntent, type DemoRiskProfile,
  type DemoTradeRecord, type DemoWhitelist, type ExecutionMode,
} from "./types";

export interface DemoEventStore { readLines(): readonly string[]; append(line: string): void }

const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

export class DemoExecutionBridge {
  private readonly events: DemoEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private lastAccount: { id: DemoAccountIdentity | null; ok: boolean; reason: AccountBlockReason | null } = { id: null, ok: false, reason: "IDENTITY_UNAVAILABLE" };
  private openCount = 0;
  private readonly profile: DemoRiskProfile;

  constructor(private readonly o: {
    mode: ExecutionMode; gateway: DemoExecGatewayPort; whitelist: DemoWhitelist; store: DemoEventStore;
    killSwitch: () => boolean; now: () => number; profile?: DemoRiskProfile; log?: (m: string) => void;
  }) {
    this.profile = o.profile ?? DEMO_RISK_PROFILE;
    for (const line of o.store.readLines()) { try { this.events.push(Object.freeze(JSON.parse(line) as DemoEvent)); } catch { /* skip torn tail line */ } }
  }

  private push(e: Omit<DemoEvent, "at">): DemoEvent {
    const ev = Object.freeze({ ...e, at: this.o.now() }) as DemoEvent;
    this.o.store.append(JSON.stringify(ev)); // persist first
    this.events.push(ev);
    this.o.log?.(`[demo-lab] ${ev.type} ${ev.signalId ?? ""} ${ev.detail ?? ""}`);
    return ev;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private consumed(): Set<string> { return new Set(this.events.filter((e) => e.signalId).map((e) => e.signalId!)); }
  private today(): number { return dayOf(this.o.now()); }
  private dayStart(): number | null {
    const d = this.today();
    const e = [...this.events].reverse().find((x) => x.type === "DAY_START" && dayOf(x.at) === d);
    return e ? Number(e.data?.["balance"]) : null;
  }
  private tradesToday(): number { const d = this.today(); return this.events.filter((e) => e.type === "SEND_ATTEMPT" && dayOf(e.at) === d).length; }

  private async refreshAccount(): Promise<DemoAccountIdentity | null> {
    let id: DemoAccountIdentity | null = null;
    try { id = await this.o.gateway.account(); } catch { id = null; }
    const v = validateDemoAccount(id, this.o.whitelist);
    this.lastAccount = { id, ok: v.ok, reason: v.ok ? null : v.reason };
    if (v.ok && id && this.dayStart() === null) this.push({ type: "DAY_START", signalId: null, symbol: null, data: { balance: id.balance } });
    return v.ok ? id : null;
  }

  /** Handle one approved engine plan. Resolves with the terminal event for this signal. */
  handle(intent: DemoOrderIntent): Promise<DemoEvent> {
    return this.serial(async () => {
      const block = (reason: BlockReason, detail?: string) =>
        this.push({ type: "BLOCKED", signalId: intent.signalId, symbol: intent.symbol, detail: detail ? `${reason} ${detail}` : reason, data: { reason, intent } });
      if (this.o.mode !== "DEMO_STRESS_TEST") return block("MODE_NOT_DEMO");
      if (this.consumed().has(intent.signalId)) return block("DUPLICATE_SIGNAL");
      if (!(intent.stopLoss > 0 && intent.takeProfit > 0 && intent.plannedEntry > 0 && intent.stopLoss !== intent.plannedEntry)) return block("INVALID_PLAN");
      const id = await this.refreshAccount();
      if (!id) return block(this.lastAccount.reason ?? "IDENTITY_UNAVAILABLE");
      let positions;
      try { positions = await this.o.gateway.positions(); } catch (e) { return block("IDENTITY_UNAVAILABLE", `positions: ${(e as Error).message}`); }
      this.openCount = positions.length;
      const safety = checkDemoSafety(intent.signalId, {
        mode: this.o.mode, killSwitch: this.o.killSwitch(), consumedSignalIds: this.consumed(), openPositions: positions.length,
        tradesToday: this.tradesToday(), dayStartBalance: this.dayStart() ?? id.balance, equity: id.equity,
      }, this.profile);
      if (!safety.ok) return block(safety.reason);
      const info = await this.o.gateway.symbol(intent.symbol).catch(() => null);
      if (!info) return block("SYMBOL_INFO_UNAVAILABLE");
      const budget = (id.balance * this.profile.riskPercent) / 100;
      const size = calculatePositionSize(budget, Math.abs(intent.plannedEntry - intent.stopLoss), info, true);
      if (!size || size.finalLot < info.volumeMin) return block("LOT_BELOW_MINIMUM", `raw ${size?.rawLot ?? "?"}`);

      this.push({ type: "SEND_ATTEMPT", signalId: intent.signalId, symbol: intent.symbol, data: { intent, volume: size.finalLot, riskUSD: size.actualRiskUSD, budgetUSD: budget } });
      const t0 = this.o.now();
      let resp;
      try { resp = await this.o.gateway.sendOrder({ signalId: intent.signalId, symbol: intent.symbol, direction: intent.direction, volume: size.finalLot, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit }); }
      catch (e) { return this.push({ type: "ERROR", signalId: intent.signalId, symbol: intent.symbol, detail: (e as Error).message, data: { latencyMs: this.o.now() - t0 } }); }
      const latencyMs = this.o.now() - t0;
      const slippage = resp.price !== null ? r8(intent.direction === "BUY" ? resp.price - intent.plannedEntry : intent.plannedEntry - resp.price) : null;
      const type = resp.status === "FILLED" ? "FILLED" : resp.status === "REJECTED" ? "REJECTED" : "ERROR";
      if (type === "FILLED") this.openCount++;
      return this.push({ type, signalId: intent.signalId, symbol: intent.symbol, detail: `${resp.retcode ?? ""} ${resp.comment}`.trim(), data: { ticket: resp.ticket, price: resp.price, retcode: resp.retcode, latencyMs, slippage } });
    });
  }

  /** Detect broker-side closes (SL/TP at broker) and record the final outcome. */
  sync(): Promise<void> {
    return this.serial(async () => {
      await this.refreshAccount();
      let positions;
      try { positions = await this.o.gateway.positions(); } catch { return; }
      this.openCount = positions.length;
      const live = new Set(positions.map((p) => p.ticket));
      const closed = new Set(this.events.filter((e) => e.type === "CLOSED").map((e) => e.signalId));
      for (const f of this.events.filter((e) => e.type === "FILLED" && !closed.has(e.signalId))) {
        const ticket = Number(f.data?.["ticket"]);
        if (!Number.isFinite(ticket) || live.has(ticket)) continue;
        const deal = await this.o.gateway.closeDeal(ticket).catch(() => null);
        if (!deal) continue;
        this.push({ type: "CLOSED", signalId: f.signalId, symbol: f.symbol, detail: deal.reason, data: { ...deal } });
      }
    });
  }

  records(): DemoTradeRecord[] {
    const out: DemoTradeRecord[] = [];
    for (const s of this.events.filter((e) => e.type === "SEND_ATTEMPT")) {
      const intent = s.data!["intent"] as DemoOrderIntent;
      const res = this.events.find((e) => e.signalId === s.signalId && (e.type === "FILLED" || e.type === "REJECTED" || e.type === "ERROR"));
      const cl = this.events.find((e) => e.signalId === s.signalId && e.type === "CLOSED");
      const pnl = cl ? Number(cl.data?.["profit"]) : null;
      out.push(Object.freeze({
        tradeId: `demo_${intent.signalId}`, signalId: intent.signalId, symbol: intent.symbol, direction: intent.direction,
        sentAt: s.at, volume: Number(s.data!["volume"]), riskUSD: Number(s.data!["riskUSD"]),
        plannedEntry: intent.plannedEntry, actualEntry: (res?.data?.["price"] as number | null) ?? null,
        slippage: (res?.data?.["slippage"] as number | null) ?? null, latencyMs: (res?.data?.["latencyMs"] as number | null) ?? null,
        stopLoss: intent.stopLoss, takeProfit: intent.takeProfit, ticket: (res?.data?.["ticket"] as number | null) ?? null,
        executionResult: (res?.type as DemoTradeRecord["executionResult"]) ?? "PENDING", executionDetail: res?.detail ?? "",
        exitPrice: cl ? Number(cl.data?.["price"]) : null, exitReason: (cl?.data?.["reason"] as DemoTradeRecord["exitReason"]) ?? null,
        closedAt: cl ? Number(cl.data?.["time"]) * 1000 : null, profitLossUSD: pnl,
        outcome: pnl === null ? null : pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAKEVEN",
        context: intent.context,
      }));
    }
    return out;
  }

  status(): DemoLabStatus {
    const id = this.lastAccount.id;
    return Object.freeze({
      mode: this.o.mode, policyVersion: DEMO_EXECUTION_POLICY_VERSION, profile: this.profile, killSwitch: this.o.killSwitch(),
      account: { ok: this.lastAccount.ok, reason: this.lastAccount.reason, login: id?.login ?? null, server: id?.server ?? null, tradeMode: id?.tradeMode ?? null },
      openPositions: this.openCount, tradesToday: this.tradesToday(),
      dailyLossPercent: id ? Math.round(dailyLossPercent(this.dayStart() ?? id.balance, id.equity) * 100) / 100 : 0,
      lastEvent: this.events.at(-1) ?? null, records: this.records(), recentEvents: this.events.slice(-30),
    });
  }
}
