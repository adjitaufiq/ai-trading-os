import { createFileRoute } from "@tanstack/react-router";
import { captureEngineMemory } from "@/lib/memory/capture.server";

// Scheduled every 5 min. Idempotent insert-only copy of public engine facts; the bearer check only filters stray traffic.
export const Route = createFileRoute("/api/public/hooks/engine-memory")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (!token || token !== process.env["SUPABASE_PUBLISHABLE_KEY"]) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        const res = await captureEngineMemory();
        return new Response(JSON.stringify(res), { status: res.ok ? 200 : 502, headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
