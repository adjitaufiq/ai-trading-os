import { createFileRoute, Link } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { useMemo } from "react";
import { BrokerAuditTerminal } from "@/components/BrokerAuditTerminal";
import { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { LiveClock } from "@/core/temporal/CanonicalClock";

export const Route = createFileRoute("/audit")({
  head: () => ({
    meta: [
      { title: "Trading OS — Broker Audit Terminal" },
      { name: "description", content: "Read-only Exness MT5 broker observability and audit terminal (monitor only)." },
      { property: "og:title", content: "Trading OS — Broker Audit Terminal" },
      { property: "og:description", content: "Raw broker ticks, bars, coverage and gap diagnostics for MT5 comparison." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuditPage,
});

function Live() {
  const client = useMemo(() => new BrokerGatewayClient({
    config: makeGatewayConfig(), wallClock: new LiveClock(), monoClock: { now: () => performance.now() },
  }), []);
  return <BrokerAuditTerminal client={client} />;
}

function AuditPage() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-border px-6 py-3 font-mono text-sm">
        <span className="font-semibold tracking-widest">TRADING OS · REAL BROKER AUDIT</span>
        <Link to="/" className="text-xs text-muted-foreground underline">monitor</Link>
      </header>
      <main className="p-4">
        <ClientOnly fallback={<div className="font-mono text-xs text-muted-foreground">loading…</div>}><Live /></ClientOnly>
      </main>
    </div>
  );
}
