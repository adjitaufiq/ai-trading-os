import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { TerminalMarket } from "@/components/RealMarketTerminal";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { useServerFn } from "@tanstack/react-start";
import { TechnicalSlicePanel } from "@/components/TechnicalSlicePanel";
import { JournalPanel } from "@/components/JournalPanel";
import { AlertCenter } from "@/components/AlertCenter";
import { browserAlarm, browserNotificationApi, sharedSignalAlerts, showNativeNotification, type SignalAlert } from "@/lib/signalAlerts";
import { Button } from "@/components/ui/button";
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
  const [tab, setTab] = useState<"COCKPIT" | "JOURNAL">("COCKPIT");
  const alerts = useMemo(() => sharedSignalAlerts(), []);
  const alarm = useMemo(() => browserAlarm(), []);
  const notificationApi = useMemo(() => browserNotificationApi(), []);
  const focusAlert = (symbol: string) => { if (symbol === "XAUUSD" || symbol === "BTCUSD") setSelectedSymbol(symbol); setTab("COCKPIT"); };
  const onAlert = (a: SignalAlert) => { alarm.play(a.side); showNativeNotification(notificationApi, a, () => focusAlert(a.symbol)); };
  return <>
    <RealMarketTerminal client={client} liveReaders={liveReaders} selectedSymbol={selectedSymbol} onSelectedSymbolChange={setSelectedSymbol} />
    <div className="mx-auto flex max-w-screen-2xl gap-1 px-4 pb-3 sm:px-8" role="tablist">
      <Button size="sm" role="tab" aria-selected={tab === "COCKPIT"} variant={tab === "COCKPIT" ? "secondary" : "ghost"} onClick={() => setTab("COCKPIT")}>Kokpit</Button>
      <Button size="sm" role="tab" aria-selected={tab === "JOURNAL"} variant={tab === "JOURNAL" ? "secondary" : "ghost"} onClick={() => setTab("JOURNAL")}>Jurnal &amp; Backtest</Button>
      <AlertCenter store={alerts} alarm={alarm} notificationApi={notificationApi} onSelect={focusAlert} />
    </div>
    {/* Cockpit stays mounted (hidden) so paper marks and signal journaling keep running. */}
    <div hidden={tab !== "COCKPIT"}><TechnicalSlicePanel runtimes={runtimes} selectedSymbol={selectedSymbol} unmountedReason={`CANONICAL_RUNTIME_NOT_MOUNTED ${unmountedReason}`} explain={(snapshot) => explain({ data: { snapshot } })} alerts={alerts} onAlert={onAlert} /></div>
    {tab === "JOURNAL" ? <JournalPanel runtimes={runtimes} selectedSymbol={selectedSymbol} /> : null}
  </>;
}

function Index() {
  return <ClientOnly fallback={<div className="min-h-screen bg-background p-5 text-muted-foreground">Memuat terminal pasar…</div>}>
    <Suspense fallback={<div className="min-h-screen bg-background p-5 text-muted-foreground">Memuat terminal pasar…</div>}><Terminal /></Suspense>
  </ClientOnly>;
}
