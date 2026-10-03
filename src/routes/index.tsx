import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  EXECUTION_ENABLED,
  OPERATING_MODE,
  type HealthState,
  type MarketEvent,
  type ModuleHealth,
} from "@/core/contracts";
import { mockMarketAdapter } from "@/core/mockMarketAdapter";

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

const STAGES = [
  ["0", "Foundation", "LOCKED"], ["1", "Research Spec", "PARALLEL"], ["2", "Application Skeleton", "ACTIVE"],
  ["3", "Market Data Core", ""], ["4", "Technical Intelligence", ""], ["5", "Chart + Manual Structure", ""],
  ["6", "Strategy / Guard Engine", ""], ["7", "External Intelligence", ""], ["8", "AI Analyst", ""],
  ["9", "Replay / Research Lab", ""], ["10", "Demo Execution", ""], ["11", "Live Execution", ""],
  ["12", "Review / Learning Loop", ""],
];

const stateColor: Record<HealthState, string> = {
  HEALTHY: "text-bull", DEGRADED: "text-warn", DOWN: "text-bear", NOT_BUILT: "text-muted-foreground",
};

function useTicks(symbol: string) {
  const [e, setE] = useState<MarketEvent | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  useEffect(() => mockMarketAdapter.subscribe(symbol, (n) => {
    setE((old) => { setPrev(old?.bid ?? null); return n; });
  }), [symbol]);
  return { e, dir: e && prev != null ? Math.sign(e.bid - prev) : 0 };
}

function Ticker({ symbol }: { symbol: string }) {
  const { e, dir } = useTicks(symbol);
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex justify-between text-xs text-muted-foreground font-mono">
        <span>{symbol}</span><span>{e?.source ?? "—"}</span>
      </div>
      <div className={`mt-2 font-mono text-3xl ${dir > 0 ? "text-bull" : dir < 0 ? "text-bear" : ""}`}>
        {e ? e.bid.toFixed(2) : "—"}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-xs text-muted-foreground">
        <span>ASK {e?.ask.toFixed(2) ?? "—"}</span>
        <span>SPR {e?.spread.toFixed(2) ?? "—"}</span>
        <span>LAT {e ? e.receivedAt - e.brokerTime : "—"}ms</span>
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
                <span><span className="font-mono text-muted-foreground mr-2">{n.padStart(2, "0")}</span>{name}</span>
                <span className="font-mono text-xs">{tag}</span>
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </div>
  );
}
