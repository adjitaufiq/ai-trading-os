import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TerminalMarket } from "@/components/RealMarketTerminal";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { useServerFn } from "@tanstack/react-start";
import { TechnicalSlicePanel } from "@/components/TechnicalSlicePanel";
import { JournalPanel } from "@/components/JournalPanel";
import { AlertCenter } from "@/components/AlertCenter";
import {
  browserAlarm,
  browserNotificationApi,
  sharedSignalAlerts,
  showNativeNotification,
  type SignalAlert,
} from "@/lib/signalAlerts";
import { Button } from "@/components/ui/button";
import { explainTradingState } from "@/lib/ai-why.functions";
import { browserWebSocketFactory } from "@/lib/browserWebSocket";
import { mountCanonicalRuntime, type MountedRuntime } from "@/lib/canonicalRuntimes";
import { useEngineHostStore } from "@/hooks/use-engine-host";
import { useRelayStatus, relayLine } from "@/hooks/use-relay-status";
import { exeLamp } from "@/lib/exeLamp";
import { MobileTerminalProvider, useMobileTerminal } from "@/components/MobileTerminalContext";
import { MobileTerminalChrome } from "@/components/MobileTerminalChrome";
import { MobileTradingView, MobileBottomNav } from "@/components/MobileTradingView";
import { BacktestPanel } from "@/components/JournalPanel";
import { Link } from "@tanstack/react-router";

const RealMarketTerminal = lazy(() =>
  import("@/components/RealMarketTerminal").then((m) => ({ default: m.RealMarketTerminal })),
);

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Personal AI Trading OS — Exness Demo Market Terminal" },
      {
        name: "description",
        content: "Read-only real Exness Demo market terminal for XAUUSD and BTCUSD.",
      },
      { property: "og:title", content: "Personal AI Trading OS — Market Terminal" },
      {
        property: "og:description",
        content:
          "Monitor real Exness Demo gold and Bitcoin quotes and broker candlesticks. No execution.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const SYMBOLS = ["XAUUSD", "BTCUSD"] as const;

function Terminal() {
  const mobile = useMobileTerminal();
  const [selectedSymbol, setSelectedSymbol] = useState<TerminalMarket>("XAUUSD");
  const config = useMemo(() => makeGatewayConfig({ timeoutMs: 30_000 }), []);
  const client = useMemo(
    () =>
      new BrokerGatewayClient({
        config,
        wallClock: new LiveClock(),
        monoClock: { now: () => performance.now() },
        wsFactory: browserWebSocketFactory,
      }),
    [config],
  );
  const [mounted, setMounted] = useState<Record<string, MountedRuntime>>({});
  // Strict source ownership: the engine host (VPS) owns every view when LIVE; a local runtime is mounted ONLY in
  // BROWSER SESSION (no engine host configured, or engine host OFFLINE). Never both at once.
  const { store: engine, state: engineState } = useEngineHostStore(SYMBOLS);
  const relay = useRelayStatus();
  const exe = exeLamp(engineState.execution, engineState.executionAt, engineState.status, Date.now());
  const browserSession = engineState.status === "DISABLED" || engineState.status === "OFFLINE";
  useEffect(() => {
    if (!browserSession) {
      setMounted({});
      return;
    }
    // Canonical runtime per symbol: spec + measured offset from the gateway, live WebSocket, finite BACKFILL bootstrap.
    const stops = SYMBOLS.map((symbol) =>
      mountCanonicalRuntime({
        client,
        config,
        wsFactory: browserWebSocketFactory,
        symbol,
        onChange: (m) => setMounted((old) => ({ ...old, [m.symbol]: m })),
      }),
    );
    return () => {
      for (const s of stops) s();
      setMounted({});
    };
  }, [client, config, browserSession]);
  const xau = browserSession ? (mounted["XAUUSD"]?.reader ?? null) : null,
    btc = browserSession ? (mounted["BTCUSD"]?.reader ?? null) : null;
  // Recreated only when a reader identity changes (so transition trails survive status updates).
  const runtimes = useMemo(
    () => [
      { symbol: "XAUUSD", reader: xau },
      { symbol: "BTCUSD", reader: btc },
    ],
    [xau, btc],
  );
  const liveReaders = useMemo(() => ({ XAUUSD: xau, BTCUSD: btc }), [xau, btc]);
  const unmountedReason = SYMBOLS.filter((s) => !mounted[s]?.reader)
    .map((s) => `${s}: ${mounted[s]?.status ?? "PENDING"}`)
    .join(" · ");
  const explain = useServerFn(explainTradingState);
  const [tab, setTab] = useState<"COCKPIT" | "JOURNAL">("COCKPIT");
  const alerts = useMemo(() => sharedSignalAlerts(), []);
  const alertItems = useSyncExternalStore(alerts.subscribe, alerts.getAlerts, alerts.getAlerts);
  const alarm = useMemo(() => browserAlarm(), []);
  const notificationApi = useMemo(() => browserNotificationApi(), []);
  const focusAlert = (symbol: string) => {
    if (symbol === "XAUUSD" || symbol === "BTCUSD") setSelectedSymbol(symbol);
    setTab("COCKPIT");
  };
  const onAlert = (a: SignalAlert) => {
    alarm.play(a.side);
    showNativeNotification(notificationApi, a, () => focusAlert(a.symbol));
  };
  const fallbackReason =
    engineState.status === "OFFLINE" ? (engineState.error ?? "UNREACHABLE") : null;
  const engineTrades =
    engineState.status === "LIVE"
      ? Object.values(engineState.bundles).flatMap((b) => b.trades)
      : null;
  return (
    <>
      <div className="mobile-terminal-only">
        <MobileTerminalChrome
          selectedSymbol={selectedSymbol}
          onSymbol={setSelectedSymbol}
          engineStatus={engineState.status}
          engineDetail={`ENGINE HOST ${engineState.status}\n${fallbackReason ?? ""}\nSOURCE ${engineState.status === "LIVE" ? "ENGINE_HOST" : "BROWSER_SESSION (EPHEMERAL)"}`}
          hasAlerts={alertItems.some((alert) => !alert.read)}
          exe={exe}
        />
      </div>
      <div
        className="desktop-terminal-only mx-auto max-w-screen-2xl px-4 pt-2 sm:px-8"
        data-testid="state-source-banner"
      >
        {engineState.status === "LIVE" ? (
          <p className="text-xs font-semibold text-bull">SOURCE: ENGINE HOST VPS (LIVE)</p>
        ) : engineState.status === "CHECKING" ? (
          <p className="text-xs text-muted-foreground">Menghubungkan engine host VPS…</p>
        ) : engineState.status === "OFFLINE" ? (
          <p className="text-xs font-semibold text-warn" role="alert">
            ENGINE HOST OFFLINE ({fallbackReason}) · fallback BROWSER SESSION (EPHEMERAL) — refresh
            akan me-reset state.
          </p>
        ) : (
          <p className="text-xs text-warn">
            SOURCE: BROWSER SESSION (EPHEMERAL) — detail engine host tidak dibuka ke publik; status engine
            dibaca dari status-only di bawah. Refresh akan me-reset state.
          </p>
        )}
        {engineState.status !== "LIVE" && (
          <p
            className={`text-xs font-semibold ${relay.status?.status === "ONLINE" ? "text-bull" : "text-warn"}`}
            data-testid="relay-status"
          >
            {relayLine(relay.status, relay.error)}
          </p>
        )}
      </div>
      <RealMarketTerminal
        client={client}
        liveReaders={liveReaders}
        selectedSymbol={selectedSymbol}
        onSelectedSymbolChange={setSelectedSymbol}
      />
      <div
        className="desktop-terminal-only mx-auto flex max-w-screen-2xl gap-1 px-4 pb-3 sm:px-8"
        role="tablist"
      >
        <Button
          size="sm"
          role="tab"
          aria-selected={tab === "COCKPIT"}
          variant={tab === "COCKPIT" ? "secondary" : "ghost"}
          onClick={() => setTab("COCKPIT")}
        >
          Kokpit
        </Button>
        <Button
          size="sm"
          role="tab"
          aria-selected={tab === "JOURNAL"}
          variant={tab === "JOURNAL" ? "secondary" : "ghost"}
          onClick={() => setTab("JOURNAL")}
        >
          Jurnal &amp; Backtest
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/assistant">AI Assistant</Link>
        </Button>
        <AlertCenter
          store={alerts}
          alarm={alarm}
          notificationApi={notificationApi}
          onSelect={focusAlert}
        />
      </div>
      {/* Cockpit stays mounted (hidden) so paper marks and signal journaling keep running. */}
      <div
        className={`terminal-original-cockpit ${mobile?.accessory === "Detail Radar & Teknikal" || mobile?.accessory === "Mode & Simulasi" ? "mobile-accessory-visible" : ""}`}
        hidden={tab !== "COCKPIT"}
      >
        {engineState.status === "CHECKING" ? (
          <div className="mx-auto max-w-screen-2xl px-4 text-sm text-muted-foreground sm:px-8">
            Memuat state terakhir dari engine host…
          </div>
        ) : (
          <TechnicalSlicePanel
            runtimes={runtimes}
            engine={engineState.status === "LIVE" ? engine : undefined}
            fallbackReason={fallbackReason}
            selectedSymbol={selectedSymbol}
            unmountedReason={`CANONICAL_RUNTIME_NOT_MOUNTED ${unmountedReason}`}
            explain={(snapshot) => explain({ data: { snapshot } })}
            alerts={alerts}
            onAlert={onAlert}
          />
        )}
      </div>
      <div className="mobile-terminal-only mobile-content">
        {!mobile?.accessory ? (
          <MobileTradingView
            onWhy={() => {
              mobile?.setAccessory("Detail Radar & Teknikal");
            }}
          />
        ) : mobile.accessory === "Jurnal" ? (
          <JournalPanel
            runtimes={runtimes}
            selectedSymbol={selectedSymbol}
            engineTrades={engineTrades}
          />
        ) : mobile.accessory === "Backtest" ? (
          <BacktestPanel runtimes={runtimes} symbol={selectedSymbol} />
        ) : mobile.accessory === "Alert" ? (
          <AlertCenter
            store={alerts}
            alarm={alarm}
            notificationApi={notificationApi}
            onSelect={focusAlert}
          />
        ) : null}
        <MobileBottomNav
          engineStatus={engineState.status}
          exe={exe}
          relay={engineState.status !== "LIVE" ? { text: relayLine(relay.status, relay.error), online: relay.status?.status === "ONLINE" } : null}
        />
      </div>
      {tab === "JOURNAL" ? (
        <JournalPanel
          runtimes={runtimes}
          selectedSymbol={selectedSymbol}
          engineTrades={engineTrades}
        />
      ) : null}
    </>
  );
}

function Index() {
  return (
    <ClientOnly
      fallback={
        <div className="min-h-screen bg-background p-5 text-muted-foreground">
          Memuat terminal pasar…
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="min-h-screen bg-background p-5 text-muted-foreground">
            Memuat terminal pasar…
          </div>
        }
      >
        <MobileTerminalProvider>
          <Terminal />
        </MobileTerminalProvider>
      </Suspense>
    </ClientOnly>
  );
}
