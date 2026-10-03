import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  EXECUTION_ENABLED,
  OPERATING_MODE,
  type Bar,
  type HealthState,
  type MarketEvent,
  type ModuleHealth,
} from "@/core/contracts";
import { MockMarketAdapter } from "@/core/market/MockMarketAdapter";
import { LiveClock } from "@/core/temporal/CanonicalClock";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { xauusdTemporalFixture } from "@/core/fixtures/xauusdTemporalFixture";
import { runReplay } from "@/core/replay";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Trading OS — Monitor" },
      { name: "description", content: "Personal AI Trading OS: monitor-only application skeleton." },
      { property: "og:title", content: "Trading OS — Monitor" },
      { property: "og:description", content: "Monitor-only skeleton with enforced architecture boundaries." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const MODULES: ModuleHealth[] = [
  { name: "Market", state: "DEGRADED", note: "Mock adapter — MT5 read-only pending (Stage 3)" },
  { name: "Evidence", state: "NOT_BUILT", note: "Canonical EvidenceState contract defined" },
  { name: "Strategy", state: "NOT_BUILT", note: "EMA_MTF_V1 — Stage 6" },
  { name: "Guards", state: "NOT_BUILT", note: "Preflight / invariants — Stage 6" },
  { name: "Drawings", state: "NOT_BUILT", note: "USER evidence — Stage 5" },
  { name: "External Context", state: "NOT_BUILT", note: "Providers — Stage 7" },
  { name: "AI Analyst", state: "NOT_BUILT", note: "EXPLANATION_ONLY — Stage 8" },
  { name: "Journal", state: "NOT_BUILT", note: "Decision snapshots — Stage 12" },
  { name: "System Health", state: "HEALTHY", note: "Frontend shell online" },
];

const STAGES: [string, string, string][] = [
  ["0", "Foundation", "LOCKED"], ["1", "Research Spec", "PARALLEL"], ["2", "Application Skeleton", "ACTIVE"],
  ["3", "Market Data Core", ""], ["4", "Technical Intelligence", ""], ["5", "Chart + Manual Structure", ""],
  ["6", "Strategy / Guard Engine", ""], ["7", "External Intelligence", ""], ["8", "AI Analyst", ""],
  ["9", "Replay / Research Lab", ""], ["10", "Demo Execution", ""], ["11", "Live Execution", ""],
  ["12", "Review / Learning Loop", ""],
];

const stateColor: Record<HealthState, string> = {
  HEALTHY: "text-bull", DEGRADED: "text-warn", DOWN: "text-bear", NOT_BUILT: "text-muted-foreground",
};

const liveClock = new LiveClock();
const liveAdapter = new MockMarketAdapter(liveClock);
const replayResult = runReplay(xauusdTemporalFixture, "XAUUSD", "M5");

const fmt = (t: number | null) => (t == null ? "—" : new Date(t).toISOString().slice(11, 23));

function useLive(symbol: string) {
  const [e, setE] = useState<MarketEvent | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  const [bar, setBar] = useState<Bar | null>(null);
  const [lastClosed, setLastClosed] = useState<Bar | null>(null);
  useEffect(() => {
    const agg = new CandleAggregator(symbol, "M5", liveClock);
    const off = agg.onBar((b) => (b.status === "CLOSED" ? setLastClosed(b) : setBar(b)));
    const unsub = liveAdapter.subscribe(symbol, (n) => {
      agg.ingest(n);
      setE((old) => { setPrev(old?.bid ?? null); return n; });
    });
    const tick = setInterval(() => { agg.checkBoundary(); if (!agg.current) setBar(null); }, 1000);
    return () => { off(); unsub(); clearInterval(tick); };
  }, [symbol]);
  return { e, bar, lastClosed, dir: e && prev != null ? Math.sign(e.bid - prev) : 0 };
}

function Ticker({ symbol }: { symbol: string }) {
  const { e, dir, bar, lastClosed } = useLive(symbol);
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex justify-between text-xs text-muted-foreground font-mono">
        <span>{symbol}</span><span>{e?.source ?? "—"} · CLOCK {liveClock.mode}</span>
      </div>
      <div className={`mt-2 font-mono text-3xl ${dir > 0 ? "text-bull" : dir < 0 ? "text-bear" : ""}`}>
        {e ? e.bid.toFixed(2) : "—"}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-xs text-muted-foreground">
        <span>ASK {e?.ask.toFixed(2) ?? "—"}</span>
        <span>SPR {e?.spread.toFixed(2) ?? "—"}</span>
        <span>LAT {e ? e.ingested_at - e.event_at : "—"}ms</span>
      </div>
      <div className="mt-3 space-y-1 border-t border-border pt-2 font-mono text-xs">
        <div className="flex justify-between">
          <span>M5 {bar ? <span className="text-warn">FORMING</span> : "—"}</span>
          <span className="text-muted-foreground">{bar ? `${bar.tick_count} ticks · close ${fmt(bar.close_time)}` : ""}</span>
        </div>
        <div className="flex justify-between">
          <span>M5 last <span className="text-bull">{lastClosed ? "CLOSED" : "—"}</span></span>
          <span className="text-muted-foreground">{lastClosed ? `closed_at ${fmt(lastClosed.closed_at)}` : "waiting for boundary"}</span>
        </div>
      </div>
    </div>
  );
}

function ReplayPanel() {
  const rows = [...replayResult.closed, ...(replayResult.forming ? [replayResult.forming] : [])];
  return (
    <div className="border border-border bg-card">
      <h2 className="flex justify-between border-b border-border px-4 py-2 font-mono text-xs tracking-widest text-muted-foreground">
        <span>REPLAY FIXTURE · XAUUSD M5</span><span>CLOCK REPLAY</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              {["open_time", "close_time", "status", "closed_at", "effective_at", "available_at", "O", "H", "L", "C", "n"].map((h) => (
                <th key={h} className="px-3 py-1 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.open_time} className="border-t border-border">
                <td className="px-3 py-1">{fmt(b.open_time)}</td>
                <td className="px-3 py-1">{fmt(b.close_time)}</td>
                <td className={`px-3 py-1 ${b.status === "CLOSED" ? "text-bull" : "text-warn"}`}>{b.status}</td>
                <td className="px-3 py-1">{fmt(b.closed_at)}</td>
                <td className="px-3 py-1">{fmt(b.effective_at)}</td>
                <td className="px-3 py-1">{fmt(b.available_at)}</td>
                <td className="px-3 py-1">{b.open}</td><td className="px-3 py-1">{b.high}</td>
                <td className="px-3 py-1">{b.low}</td><td className="px-3 py-1">{b.close}</td>
                <td className="px-3 py-1">{b.tick_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Index() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-border px-6 py-3 font-mono text-sm">
        <span className="font-semibold tracking-widest">TRADING OS</span>
        <div className="flex gap-4">
          <span className="border border-warn px-2 text-warn">{OPERATING_MODE.replace("_", " ")}</span>
          <span className="text-muted-foreground">execution.enabled = {String(EXECUTION_ENABLED)}</span>
          <span className="text-warn">MT5 ○ mock</span>
        </div>
      </header>

      <main className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Ticker symbol="XAUUSD" />
            <Ticker symbol="BTCUSD" />
          </div>

          <ReplayPanel />

          <div className="border border-border bg-card">
            <h2 className="border-b border-border px-4 py-2 font-mono text-xs tracking-widest text-muted-foreground">
              APPLICATION MODULES
            </h2>
            <ul className="divide-y divide-border">
              {MODULES.map((m) => (
                <li key={m.name} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>{m.name}</span>
                  <span className="hidden text-xs text-muted-foreground sm:block">{m.note}</span>
                  <span className={`font-mono text-xs ${stateColor[m.state]}`}>{m.state}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="font-mono text-xs text-muted-foreground">
            Evidence ≠ Decision · Setup ≠ Signal · Signal ≠ Execution · AI ≠ Authority. No order capability exists in this build.
          </p>
        </section>

        <aside className="border border-border bg-card">
          <h2 className="border-b border-border px-4 py-2 font-mono text-xs tracking-widest text-muted-foreground">ROADMAP</h2>
          <ol className="p-2 text-sm">
            {STAGES.map(([n, name, tag]) => (
              <li key={n} className={`flex justify-between px-2 py-1 ${tag === "ACTIVE" ? "bg-muted text-primary" : ""}`}>
                <span><span className="font-mono text-muted-foreground mr-2">{String(n).padStart(2, "0")}</span>{name}</span>
                <span className="font-mono text-xs">{tag}</span>
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </div>
  );
}
