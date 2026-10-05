// Application composition of the canonical market runtime. This is the SAME MarketRuntime used by tests;
// only the gateway port differs (real BrokerGatewayClient here, BrokerGatewayClient over a hermetic transport in tests).
// G2 OPEN: there is no verified broker-time offset, so the caller must pass a SymbolSpecification explicitly.
// No offset default exists here on purpose.
import { BrokerGatewayClient, type WebSocketFactory } from "../broker/gateway/BrokerGatewayClient";
import type { GatewayConfig } from "../broker/gateway/config";
import type { ClassifierConfig } from "../broker/AnomalyClassifier";
import type { SymbolSpecification } from "../broker/types";
import { LiveClock } from "../temporal/CanonicalClock";
import { MarketRuntime } from "./MarketRuntime";

export interface ApplicationRuntimeInput {
  readonly config: GatewayConfig;
  readonly wsFactory: WebSocketFactory;
  readonly binding: { readonly broker_symbol: string; readonly canonical_symbol: string };
  readonly spec: SymbolSpecification;
  readonly classifier: ClassifierConfig;
  readonly maxClosedBarsPerTimeframe: number;
}

export function createApplicationMarketRuntime(i: ApplicationRuntimeInput): MarketRuntime {
  const clock = new LiveClock();
  let mono = 0;
  const gateway = new BrokerGatewayClient({
    config: i.config, wallClock: clock, monoClock: { now: () => (mono = Math.max(mono, clock.now())) }, wsFactory: i.wsFactory,
  });
  return new MarketRuntime({ gateway, clock, binding: i.binding, spec: i.spec, classifier: i.classifier, maxClosedBarsPerTimeframe: i.maxClosedBarsPerTimeframe });
}
