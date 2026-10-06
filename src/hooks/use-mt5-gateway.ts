// Read-only MT5 connection hook. Goes through the typed BrokerGatewayClient only (no direct fetch, no mocks).
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import type { BridgeHealth, BridgeSymbolInfo } from "@/core/broker/bridge/types";
import type { ClientError } from "@/core/broker/gateway/types";

export type Mt5ConnectionStatus = "CHECKING" | "ONLINE" | "TERMINAL_DISCONNECTED" | "OFFLINE" | "TIMEOUT" | "INVALID_RESPONSE" | "ERROR";

export interface Mt5GatewayState {
  status: Mt5ConnectionStatus;
  baseUrl: string;
  source: string | null;
  health: BridgeHealth | null;
  healthError: ClientError | null;
  symbols: readonly BridgeSymbolInfo[] | null;
  symbolsError: ClientError | null;
  checkedAt: number | null;
  latencyMs: number | null;
}

function statusFromError(e: ClientError): Mt5ConnectionStatus {
  if (e.kind === "TRANSPORT_ERROR") return "OFFLINE";
  if (e.kind === "TIMEOUT") return "TIMEOUT";
  if (e.kind === "CLIENT_PROTOCOL_ERROR" || e.kind === "HTTP_PROTOCOL_ERROR") return "INVALID_RESPONSE";
  return "ERROR";
}

export function useMt5Gateway(pollMs = 15_000) {
  const client = useMemo(() => {
    const config = makeGatewayConfig({ timeoutMs: 8000 });
    return { config, c: new BrokerGatewayClient({ config, wallClock: new LiveClock(), monoClock: { now: () => performance.now() } }) };
  }, []);
  const [state, setState] = useState<Mt5GatewayState>({
    status: "CHECKING", baseUrl: client.config.httpBaseUrl, source: null, health: null, healthError: null,
    symbols: null, symbolsError: null, checkedAt: null, latencyMs: null,
  });

  const refresh = useCallback(async () => {
    const h = await client.c.getHealth();
    if (!h.ok) {
      setState((s) => ({ ...s, status: statusFromError(h.error), healthError: h.error, checkedAt: Date.now(), latencyMs: h.error.timing?.transport_rtt_ms ?? null }));
      return;
    }
    const sym = await client.c.getSymbols();
    setState({
      status: h.data.terminal_connected ? "ONLINE" : "TERMINAL_DISCONNECTED",
      baseUrl: client.config.httpBaseUrl,
      source: h.envelope.source,
      health: h.data,
      healthError: null,
      symbols: sym.ok ? sym.data : null,
      symbolsError: sym.ok ? null : sym.error,
      checkedAt: Date.now(),
      latencyMs: h.timing.transport_rtt_ms,
    });
  }, [client]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { ...state, refresh };
}
