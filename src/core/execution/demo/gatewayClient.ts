// Typed client for the loopback demo execution gateway (vps/mt5_exec). One method per route, strict parsing.
// Used only by the engine host process on the VPS; never imported by the dashboard.
import type { BrokerSymbolInfo } from "../../../engine/risk/types";
import type { AccountTradeMode, DemoAccountIdentity, DemoCloseDeal, DemoExecGatewayPort, DemoOrderRequest, DemoOrderResponse, DemoPosition } from "./types";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MODES: readonly AccountTradeMode[] = ["DEMO", "CONTEST", "REAL", "UNKNOWN"];

export function createDemoGatewayClient(o: { baseUrl: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }): DemoExecGatewayPort {
  const f = o.fetchImpl ?? fetch;
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 10_000);
    try {
      const r = await f(`${o.baseUrl.replace(/\/+$/, "")}${path}`, {
        method, signal: ctl.signal,
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (!r.ok && method === "GET") return null;
      return j;
    } finally { clearTimeout(t); }
  };
  return {
    async account(): Promise<DemoAccountIdentity | null> {
      const j = await call("GET", "/v1/demo/account");
      if (!j || num(j["login"]) === null || typeof j["server"] !== "string") return null;
      const mode = MODES.includes(j["trade_mode"] as AccountTradeMode) ? (j["trade_mode"] as AccountTradeMode) : "UNKNOWN";
      return { login: j["login"] as number, server: j["server"], tradeMode: mode, balance: num(j["balance"]) ?? 0, equity: num(j["equity"]) ?? 0, currency: String(j["currency"] ?? "") };
    },
    async symbol(symbol: string): Promise<BrokerSymbolInfo | null> {
      const j = await call("GET", `/v1/demo/symbol?name=${encodeURIComponent(symbol)}`);
      if (!j) return null;
      const keys = ["volume_min", "volume_max", "volume_step", "tick_size", "tick_value"] as const;
      if (keys.some((k) => !(num(j[k])! > 0))) return null;
      return { symbol, volumeMin: j["volume_min"] as number, volumeMax: j["volume_max"] as number, volumeStep: j["volume_step"] as number, tickSize: j["tick_size"] as number, tickValue: j["tick_value"] as number, marginPerLot: num(j["margin_per_lot"]) ?? 0 };
    },
    async positions(): Promise<readonly DemoPosition[]> {
      const j = await call("GET", "/v1/demo/positions");
      if (!j || !Array.isArray(j["positions"])) throw new Error("POSITIONS_UNAVAILABLE");
      return (j["positions"] as Record<string, unknown>[]).map((p) => ({ ticket: Number(p["ticket"]), symbol: String(p["symbol"]), comment: String(p["comment"] ?? "") }));
    },
    async closeDeal(ticket: number): Promise<DemoCloseDeal | null> {
      const j = await call("GET", `/v1/demo/close-deal?position=${ticket}`);
      if (!j || num(j["price"]) === null) return null;
      const reason = j["reason"] === "SL" || j["reason"] === "TP" ? j["reason"] : "OTHER";
      return { positionTicket: ticket, price: j["price"] as number, profit: num(j["profit"]) ?? 0, time: num(j["time"]) ?? 0, reason };
    },
    async sendOrder(req: DemoOrderRequest): Promise<DemoOrderResponse> {
      const j = await call("POST", "/v1/demo/orders", { signal_id: req.signalId, symbol: req.symbol, direction: req.direction, volume: req.volume, sl: req.stopLoss, tp: req.takeProfit });
      if (!j) return { status: "ERROR", ticket: null, price: null, retcode: null, comment: "NO_RESPONSE" };
      const status = j["status"] === "FILLED" || j["status"] === "REJECTED" ? j["status"] : "ERROR";
      return { status, ticket: num(j["ticket"]), price: num(j["price"]), retcode: num(j["retcode"]), comment: String(j["comment"] ?? "") };
    },
  };
}
