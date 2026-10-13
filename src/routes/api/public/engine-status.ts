import { createFileRoute } from "@tanstack/react-router";
import { readRelayStatus } from "@/lib/engineStatus/relay.server";

// Public, read-only, sanitized engine status (relay snapshot only; no account/position/price fields exist in it).
export const Route = createFileRoute("/api/public/engine-status")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const st = await readRelayStatus(Date.now());
          return new Response(JSON.stringify(st), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        } catch {
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
      },
    },
  },
});
