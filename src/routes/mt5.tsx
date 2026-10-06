import { createFileRoute, Link, ClientOnly } from "@tanstack/react-router";
import { useMt5Gateway } from "@/hooks/use-mt5-gateway";
import { Mt5ConnectionCard, SymbolListTable } from "@/components/Mt5Connection";

export const Route = createFileRoute("/mt5")({
  head: () => ({
    meta: [
      { title: "Trading OS — MT5 Gateway Connection" },
      { name: "description", content: "Live read-only status and symbol list from the Exness MT5 gateway." },
      { property: "og:title", content: "Trading OS — MT5 Gateway Connection" },
      { property: "og:description", content: "Connection status, terminal state and available symbols from MT5." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Mt5Page,
});

function Live() {
  const s = useMt5Gateway();
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Mt5ConnectionCard s={s} onRefresh={() => void s.refresh()} />
      <SymbolListTable symbols={s.symbols} />
    </div>
  );
}

function Mt5Page() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-border px-6 py-3 font-mono text-sm">
        <span className="font-semibold tracking-widest">TRADING OS · MT5 GATEWAY</span>
        <Link to="/" className="text-xs text-muted-foreground underline">monitor</Link>
      </header>
      <main className="p-4">
        <ClientOnly fallback={<div className="font-mono text-xs text-muted-foreground">loading…</div>}><Live /></ClientOnly>
      </main>
    </div>
  );
}
