import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { TerminalMarket } from "@/components/RealMarketTerminal";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { useServerFn } from "@tanstack/react-start";
import { TechnicalSlicePanel } from "@/components/TechnicalSlicePanel";
import { explainTradingState } from "@/lib/ai-why.functions";
import { browserWebSocketFactory } from "@/lib/browserWebSocket";
import { mountCanonicalRuntime, type MountedRuntime } from "@/lib/canonicalRuntimes";

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

const SYMBOLS = ["XAUUSD", "BTCUSD"] as const;

function Terminal() {
  const [selectedSymbol, setSelectedSymbol] = useState<TerminalMarket>("XAUUSD");
  const config = useMemo(() => makeGatewayConfig({ timeoutMs: 15_000 }), []);
  const client = useMemo(() => new BrokerGatewayClient({
    config, wallClock: new LiveClock(), monoClock: { now: () => performance.now() }, wsFactory: browserWebSocketFactory,
  }), [config]);
  const [mounted, setMounted] = useState<Record<string, MountedRuntime>>({});
  useEffect(() => {
    // Canonical runtime per symbol: spec + measured offset from the gateway, live WebSocket, finite BACKFILL bootstrap.
    const stops = SYMBOLS.map((symbol) => mountCanonicalRuntime({
      client, config, wsFactory: browserWebSocketFactory, symbol,
      onChange: (m) => setMounted((old) => ({ ...old, [m.symbol]: m })),
    }));
    return () => { for (const s of stops) s(); };
  }, [client, config]);
  const xau = mounted["XAUUSD"]?.reader ?? null, btc = mounted["BTCUSD"]?.reader ?? null;
  // Recreated only when a reader identity changes (so transition trails survive status updates).
  const runtimes = useMemo(() => [{ symbol: "XAUUSD", reader: xau }, { symbol: "BTCUSD", reader: btc }], [xau, btc]);
  const liveReaders = useMemo(() => ({ XAUUSD: xau, BTCUSD: btc }), [xau, btc]);
  const unmountedReason = SYMBOLS.filter((s) => !mounted[s]?.reader).map((s) => `${s}: ${mounted[s]?.status ?? "PENDING"}`).join(" · ");
  const explain = useServerFn(explainTradingState);
  return <>
    <RealMarketTerminal client={client} liveReaders={liveReaders} selectedSymbol={selectedSymbol} onSelectedSymbolChange={setSelectedSymbol} />
    <TechnicalSlicePanel runtimes={runtimes} selectedSymbol={selectedSymbol} unmountedReason={`CANONICAL_RUNTIME_NOT_MOUNTED ${unmountedReason}`} explain={(snapshot) => explain({ data: { snapshot } })} />
  </>;
}

function Index() {
  return <ClientOnly fallback={<div className="min-h-screen bg-background p-5 text-muted-foreground">Memuat terminal pasar…</div>}>
    <Suspense fallback={<div className="min-h-screen bg-background p-5 text-muted-foreground">Memuat terminal pasar…</div>}><Terminal /></Suspense>
  </ClientOnly>;
}
