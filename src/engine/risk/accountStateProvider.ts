// Phase 4A.1 — Account State Provider: the single source of balance/equity for the Risk Engine (M4).
// All account modes produce the same AccountState shape. Pure (no broker import): the broker provider is
// built from an injected identity reader so M4 never touches a gateway.
export type AccountMode = "PAPER" | "DEMO" | "REAL";
export type AccountSource = "PAPER_SIMULATED" | "EXNESS_DEMO" | "REAL_DISABLED";

export interface AccountState {
  readonly balance: number; readonly equity: number; readonly free_margin: number | null;
  readonly currency: string; readonly account_type: AccountMode; readonly source: AccountSource; readonly timestamp: string;
}

export interface AccountStateProvider {
  readonly mode: AccountMode;
  /** null = unavailable (caller fails closed, never falls back to another balance). */
  current(): Promise<AccountState | null>;
}

/** PAPER default; DEMO only when ACCOUNT_MODE=DEMO; REAL is recognised but never enabled. */
export function resolveAccountMode(env: { ACCOUNT_MODE?: string | undefined }): AccountMode {
  const v = env.ACCOUNT_MODE?.trim().toUpperCase();
  return v === "DEMO" ? "DEMO" : v === "REAL" ? "REAL" : "PAPER";
}

/** Paper simulation account. Starting balance is an explicit constructor input (not hidden in the risk path). */
export class SimulatedAccountProvider implements AccountStateProvider {
  readonly mode = "PAPER" as const;
  private balance: number; private equity: number;
  constructor(private readonly o: { initialBalance: number; currency?: string; now: () => number }) {
    if (!(o.initialBalance > 0)) throw new Error("SimulatedAccountProvider requires initialBalance > 0");
    this.balance = o.initialBalance; this.equity = o.initialBalance;
  }
  update(balance: number, equity: number): void { this.balance = balance; this.equity = equity; }
  snapshot(): AccountState {
    return Object.freeze({ balance: this.balance, equity: this.equity, free_margin: null, currency: this.o.currency ?? "USD",
      account_type: "PAPER", source: "PAPER_SIMULATED", timestamp: new Date(this.o.now()).toISOString() });
  }
  async current(): Promise<AccountState> { return this.snapshot(); }
}

/** Broker demo account: copies the broker identity fields as-is. Non-DEMO trade mode ⇒ null (fail closed). */
export class BrokerAccountProvider implements AccountStateProvider {
  readonly mode = "DEMO" as const;
  constructor(private readonly o: {
    read: () => Promise<{ balance: number; equity: number; currency: string; tradeMode: string; freeMargin?: number | null } | null>;
    now: () => number;
  }) {}
  async current(): Promise<AccountState | null> {
    let id; try { id = await this.o.read(); } catch { return null; }
    if (!id || id.tradeMode !== "DEMO" || !(id.balance > 0) || !(id.equity > 0)) return null;
    return Object.freeze({ balance: id.balance, equity: id.equity, free_margin: id.freeMargin ?? null, currency: id.currency,
      account_type: "DEMO", source: "EXNESS_DEMO", timestamp: new Date(this.o.now()).toISOString() });
  }
}

/** REAL interface placeholder: never returns an account, so no real-account sizing/execution is possible. */
export class RealAccountProviderDisabled implements AccountStateProvider {
  readonly mode = "REAL" as const;
  async current(): Promise<null> { return null; }
}
