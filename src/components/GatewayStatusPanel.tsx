import { useCallback, useEffect, useState } from "react";
import { OPERATING_MODE, type OperatingMode } from "@/core/contracts";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig, type GatewayEnvironment } from "@/core/broker/gateway/config";
import type { FreshnessStatus, GatewayHealthState, HealthStatus } from "@/core/broker/gateway/types";

const ENV_LABEL: Record<GatewayEnvironment, string> = { EXNESS_MT5_GATEWAY: "Configured target: Exness MT5 gateway (unverified)", FAKE_MT5_LOCAL: "Fake MT5 / Local Gateway" };

const tone = (s: HealthStatus | FreshnessStatus) =>
  s === "HEALTHY" || s === "FRESH" ? "text-bull" : s === "DOWN" || s === "STALE" ? "text-bear" : s === "DEGRADED" ? "text-warn" : "text-muted-foreground";

/** Initial state before any probe: nothing is assumed healthy. */
export const UNPROBED_STATE: GatewayHealthState = Object.freeze({
  transport_health: "UNKNOWN", gateway_health: "UNKNOWN", terminal_health: "UNKNOWN",
  market_data_freshness: "UNKNOWN", last_tick_age_ms: null, system_status: "UNKNOWN",
  execution_capability: "ABSENT", execution_authorization: "DISABLED", source_mode: null,
});

export function GatewayStatusView({ state, environment, mode = OPERATING_MODE }: {
  state: GatewayHealthState; environment: GatewayEnvironment; mode?: OperatingMode;
}) {
  const rows: [string, string, string][] = [
    ["Transport", state.transport_health, tone(state.transport_health)],
    ["Gateway", state.gateway_health, tone(state.gateway_health)],
    ["MT5 Terminal", state.terminal_health, tone(state.terminal_health)],
    ["Market Data", `${state.market_data_freshness}${state.last_tick_age_ms == null ? "" : ` · last tick ${state.last_tick_age_ms} ms ago`}`, tone(state.market_data_freshness)],
    ["System", state.system_status, tone(state.system_status)],
    ["Operating Mode", mode, "text-warn"],
    ["Execution Capability", state.execution_capability, "text-muted-foreground"],
    ["Execution Authorization", state.execution_authorization, "text-muted-foreground"],
  ];
  return (
    <div className="border border-border bg-card" data-testid="gateway-status">
      <h2 className="flex justify-between border-b border-border px-4 py-2 font-mono text-xs tracking-widest text-muted-foreground">
        <span>BROKER GATEWAY · STAGE 3.0B-2C</span>
        <span data-testid="gateway-env">
          {state.source_mode === "REAL"
            ? "Exness MT5 / REAL (READ-ONLY SMOKE)"
            : `${ENV_LABEL[environment]}${state.source_mode ? ` · ${state.source_mode}` : ""}`}
        </span>
      </h2>
      <ul className="divide-y divide-border font-mono text-xs">
        {rows.map(([k, v, c]) => (
          <li key={k} className="flex justify-between px-4 py-1.5">
            <span>{k}</span>
            <span className={c} data-testid={`gw-${k.toLowerCase().replace(/\s+/g, "-")}`}>{v}</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-2 font-mono text-xs text-muted-foreground">
        Read-only observation. Market Data freshness stays UNKNOWN until a configured policy exists (TRS-03).
      </p>
    </div>
  );
}

export function GatewayStatusPanel() {
  const [state, setState] = useState<GatewayHealthState>(UNPROBED_STATE);
  const [client] = useState(() => {
    const config = makeGatewayConfig({ timeoutMs: 3000 });
    return { config, c: new BrokerGatewayClient({ config, wallClock: new LiveClock(), monoClock: { now: () => performance.now() } }) };
  });
  const probe = useCallback(() => {
    client.c.probeHealth().then(setState).catch(() => undefined);
  }, [client]);
  useEffect(() => {
    probe();
    const id = setInterval(probe, 10_000);
    return () => clearInterval(id);
  }, [probe]);
  return <GatewayStatusView state={state} environment={client.config.environment} />;
}
