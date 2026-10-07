import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";
import { captureEngineMemory } from "@/lib/memory/capture.server";

const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();

// Scheduled every 5 min. Caller must present the server-only ENGINE_MEMORY_HOOK_SECRET; nothing runs before that check.
export const Route = createFileRoute("/api/public/hooks/engine-memory")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["ENGINE_MEMORY_HOOK_SECRET"];
        if (!secret) return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500 });
        const token = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!token || !timingSafeEqual(digest(token), digest(secret))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
        }
        const res = await captureEngineMemory();
        return new Response(JSON.stringify(res), { status: res.ok ? 200 : 502, headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
