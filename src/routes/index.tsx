import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { useServerFn } from "@tanstack/react-start";
import { TechnicalSlicePanel } from "@/components/TechnicalSlicePanel";
import { explainTradingState } from "@/lib/ai-why.functions";

const RealMarketTerminal = lazy(() => import("@/components/RealMarketTerminal").then((m) => ({ default: m.RealMarketTerminal })));

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "Personal AI Trading OS — Exness Demo Market Terminal" },
    { name: "description", content: "Read-only real Exness Demo market terminal for XAUUSD and BTCUSD." },
    { property: "og:title", content: "Personal AI Trading OS — Market Terminal" },
    { property: "og:description", content: "Monitor real Exness Demo gold and Bitcoin quotes and broker candlesticks. No execution." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: Index,
});

const RUNTIMES = Object.freeze([{ symbol: "XAUUSD", reader: null }, { symbol: "BTCUSD", reader: null }]);
const CANONICAL_RUNTIME_BLOCKERS = "CANONICAL_RUNTIME_NOT_MOUNTED: G2 broker_utc_offset_ms unverified (no default allowed); real gateway LIVE stream /v1/stream unavailable (HTTP 404); WebSocket injection deferred";

function Terminal() {
  const client = useMemo(() => new BrokerGatewayClient({
    config: makeGatewayConfig({ timeoutMs: 15_000 }), wallClock: new LiveClock(), monoClock: { now: () => performance.now() },
  }), []);
  const explain = useServerFn(explainTradingState);
  // Technical state consumes ONLY the canonical MarketRuntime. It is not mounted yet: missing canonical capabilities are
  // reported instead of falling back to direct REST bars (see CANONICAL_RUNTIME_BLOCKERS).
  return <>
    <RealMarketTerminal client={client} />
    <TechnicalSlicePanel runtimes={RUNTIMES} unmountedReason={CANONICAL_RUNTIME_BLOCKERS} explain={(snapshot) => explain({ data: { snapshot } })} />
  </>;
}

function Index() {
  return <ClientOnly fallback={<div className="min-h-screen bg-background p-5 text-muted-foreground">Loading market terminal…</div>}>
    <Suspense fallback={<div className="min-h-screen bg-background p-5 text-muted-foreground">Loading market terminal…</div>}><Terminal /></Suspense>
  </ClientOnly>;
}
