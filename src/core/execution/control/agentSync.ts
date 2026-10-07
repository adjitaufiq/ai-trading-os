// VPS agent side of the control plane: PULL execution_config, PUSH heartbeat + execution events.
// Fail-closed: until a signed config read succeeds (and whenever it goes stale) the agent is halted.
import { deriveControl, maskAccount, signRequest, type DerivedControl, type ExecutionConfigWire } from "./contract";
import type { DemoLabStatus, DemoEvent } from "../demo/types";

export const CONFIG_STALE_MS = 60_000;

export interface AgentSyncOptions {
  readonly baseUrl: string; readonly secret: string; readonly agentId: string; readonly version: string;
  readonly executionMode: string; readonly now: () => number;
  readonly status: () => DemoLabStatus | null;
  readonly fetchImpl?: typeof fetch; readonly log?: (m: string) => void;
}

export class ControlPlaneAgent {
  private control: DerivedControl = deriveControl(null);
  private lastOkAt = 0;
  private lastError: string | null = null;
  private lastEventAt: number;
  constructor(private readonly o: AgentSyncOptions) { this.lastEventAt = o.now(); }

  /** Current control; stale or missing config ⇒ halted. */
  current(): DerivedControl {
    if (this.o.now() - this.lastOkAt > CONFIG_STALE_MS) return { ...deriveControl(null), reason: "CONFIG_STALE" };
    return this.control;
  }

  private async call(method: "GET" | "POST", path: string, body = ""): Promise<Response> {
    const ts = String(this.o.now());
    const sig = await signRequest(this.o.secret, ts, method, path, body);
    return (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl.replace(/\/+$/, "")}${path}`, {
      method, body: method === "POST" ? body : null,
      headers: { "content-type": "application/json", "x-agent-timestamp": ts, "x-agent-signature": sig },
    });
  }

  async pullConfig(): Promise<void> {
    try {
      const r = await this.call("GET", "/api/public/agent/config");
      if (!r.ok) throw new Error(`config HTTP ${r.status}`);
      const j = await r.json() as { config: ExecutionConfigWire | null; control: { halted: boolean } };
      const derived = deriveControl(j.config);
      // Server also folds in the legacy demo-lab switch; honour whichever is stricter.
      this.control = j.control?.halted && !derived.halted ? { ...derived, halted: true, reason: "SERVER_HALTED" } : derived;
      this.lastOkAt = this.o.now(); this.lastError = null;
    } catch (e) { this.lastError = (e as Error).message; this.o.log?.(`[control] pull failed ${this.lastError}`); }
  }

  async pushHeartbeat(): Promise<void> {
    const s = this.o.status();
    const body = JSON.stringify({
      agent_id: this.o.agentId, mt5_connected: !!s?.account?.login, account_mode: s?.account?.tradeMode ?? null,
      account_number_masked: maskAccount(s?.account?.login ?? null), broker_server: s?.account?.server ?? null,
      execution_mode: this.o.executionMode, open_positions: s ? s.openPositions : null,
      current_version: this.o.version, last_error: this.lastError ?? (s?.account && !s.account.ok ? s.account.reason : null),
    });
    try { const r = await this.call("POST", "/api/public/agent/heartbeat", body); if (!r.ok) this.o.log?.(`[control] heartbeat HTTP ${r.status}`); }
    catch (e) { this.o.log?.(`[control] heartbeat failed ${(e as Error).message}`); }
  }

  /** Pushes execution events newer than the last pushed one (best effort; local JSONL stays the source of truth). */
  async pushEvents(recent: readonly DemoEvent[]): Promise<void> {
    const batch = recent.filter((e) => e.at > this.lastEventAt).slice(0, 100);
    if (!batch.length) return;
    const body = JSON.stringify({ agent_id: this.o.agentId, events: batch.map((e) => ({ type: e.type, at: e.at, signal_id: e.signalId, symbol: e.symbol, ...(e.detail ? { detail: e.detail.slice(0, 500) } : {}) })) });
    try { const r = await this.call("POST", "/api/public/agent/events", body); if (r.ok) this.lastEventAt = batch[batch.length - 1]!.at; }
    catch (e) { this.o.log?.(`[control] events failed ${(e as Error).message}`); }
  }
}
