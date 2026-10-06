import { useMemo, useState } from "react";
import type { Mt5ConnectionStatus, Mt5GatewayState } from "@/hooks/use-mt5-gateway";
import type { BridgeSymbolInfo } from "@/core/broker/bridge/types";

const LABEL: Record<Mt5ConnectionStatus, string> = {
  CHECKING: "Checking…", ONLINE: "Connected", TERMINAL_DISCONNECTED: "Terminal disconnected",
  OFFLINE: "Gateway offline", TIMEOUT: "Request timed out", INVALID_RESPONSE: "Invalid response", ERROR: "Gateway error",
};
const tone = (s: Mt5ConnectionStatus) =>
  s === "ONLINE" ? "bg-bull text-bull" : s === "CHECKING" ? "bg-muted-foreground text-muted-foreground" : s === "TERMINAL_DISCONNECTED" ? "bg-warn text-warn" : "bg-bear text-bear";

export function LiveStatusIndicator({ status }: { status: Mt5ConnectionStatus }) {
  const [dot, text] = tone(status).split(" ");
  return (
    <span className={`inline-flex items-center gap-2 font-mono text-xs ${text}`} data-testid="mt5-status">
      <span className={`h-2.5 w-2.5 rounded-full ${dot} ${status === "ONLINE" ? "animate-pulse" : ""}`} />
      {LABEL[status]}
    </span>
  );
}

export function Mt5ConnectionCard({ s, onRefresh }: { s: Mt5GatewayState; onRefresh: () => void }) {
  const err = s.healthError ?? s.symbolsError;
  const rows: [string, string][] = [
    ["Gateway", s.baseUrl],
    ["Source", s.source ?? "—"],
    ["Source mode", s.health?.source_mode ?? "—"],
    ["Terminal connected", s.health ? String(s.health.terminal_connected) : "—"],
    ["Bridge instance", s.health?.bridge_instance_id ?? "—"],
    ["Latency", s.latencyMs == null ? "—" : `${Math.round(s.latencyMs)} ms`],
    ["Last check", s.checkedAt ? new Date(s.checkedAt).toISOString().slice(11, 19) + " UTC" : "—"],
  ];
  return (
    <section className="border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="font-mono text-xs tracking-widest text-muted-foreground">MT5 CONNECTION · READ-ONLY</h2>
        <LiveStatusIndicator status={s.status} />
      </header>
      <ul className="divide-y divide-border font-mono text-xs">
        {rows.map(([k, v]) => (
          <li key={k} className="flex justify-between gap-4 px-4 py-1.5"><span className="text-muted-foreground">{k}</span><span className="truncate">{v}</span></li>
        ))}
      </ul>
      {err && <p className="border-t border-border px-4 py-2 font-mono text-xs text-bear">{err.kind}: {err.message}</p>}
      <div className="border-t border-border px-4 py-2">
        <button onClick={onRefresh} className="rounded border border-border px-3 py-1 font-mono text-xs hover:bg-muted">Refresh</button>
      </div>
    </section>
  );
}

export function SymbolListTable({ symbols }: { symbols: readonly BridgeSymbolInfo[] | null }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => (symbols ?? []).filter((x) => `${x.broker_symbol} ${x.description} ${x.path}`.toLowerCase().includes(q.toLowerCase())), [symbols, q]);
  return (
    <section className="border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="font-mono text-xs tracking-widest text-muted-foreground">SYMBOLS {symbols ? `· ${symbols.length}` : ""}</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="w-40 rounded border border-border bg-background px-2 py-1 font-mono text-xs" />
      </header>
      {symbols == null ? (
        <p className="px-4 py-3 font-mono text-xs text-muted-foreground">No symbol data from gateway.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full font-mono text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>{["Symbol", "Description", "Path", "Base/Profit", "Digits", "Point", "Contract"].map((h) => <th key={h} className="px-3 py-1.5 text-left font-normal">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((x) => (
                <tr key={x.broker_symbol}>
                  <td className="px-3 py-1 font-semibold">{x.broker_symbol}</td>
                  <td className="px-3 py-1">{x.description}</td>
                  <td className="px-3 py-1 text-muted-foreground">{x.path}</td>
                  <td className="px-3 py-1">{x.currency_base}/{x.currency_profit}</td>
                  <td className="px-3 py-1">{x.digits}</td>
                  <td className="px-3 py-1">{x.point}</td>
                  <td className="px-3 py-1">{x.trade_contract_size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
