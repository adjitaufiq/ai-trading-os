import { verifyRequest } from "@/core/execution/control/contract";

/** Verifies the HMAC-signed VPS agent request. Returns the raw body when valid, null otherwise. */
export async function readSignedAgentRequest(request: Request): Promise<string | null> {
  const body = request.method === "GET" ? "" : await request.text();
  const ok = await verifyRequest(process.env["EXECUTION_AGENT_SECRET"], {
    ts: request.headers.get("x-agent-timestamp"), sig: request.headers.get("x-agent-signature"),
    method: request.method, path: new URL(request.url).pathname, body, now: Date.now(),
  });
  return ok ? body : null;
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
