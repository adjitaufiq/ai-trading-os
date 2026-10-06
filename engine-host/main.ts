// Engine Host entry (runs on the Windows VPS with Bun: `bun engine-host/main.ts`).
// Thin glue only: Node fs/http + global WebSocket around src/core/enginehost. MONITOR_ONLY, read-only HTTP, no order path.
// Env:
//   ENGINE_GATEWAY_URL  local MT5 gateway (default http://127.0.0.1:8000, loopback)
//   ENGINE_HOST_PORT    read API port (default 8090), bound to 127.0.0.1; expose via your tunnel
//   ENGINE_SYMBOLS      comma list (default XAUUSD,BTCUSD)
//   ENGINE_DATA_DIR     persistence dir (default engine-host/data)
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrokerGatewayClient } from "../src/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "../src/core/broker/gateway/config";
import { LiveClock } from "../src/core/temporal/CanonicalClock";
import { mountCanonicalRuntime } from "../src/lib/canonicalRuntimes";
import { browserWebSocketFactory } from "../src/lib/browserWebSocket";
import { EngineHost } from "../src/core/enginehost/EngineHost";
import { PaperPersistence, type EngineStorePort } from "../src/core/enginehost/persistence";
import { ENGINE_CORS_HEADERS, envelope, routeEngineRequest } from "../src/core/enginehost/api";

const env = process.env;
const gatewayUrl = env.ENGINE_GATEWAY_URL ?? "http://127.0.0.1:8000";
const port = Number(env.ENGINE_HOST_PORT ?? 8090);
const symbols = (env.ENGINE_SYMBOLS ?? "XAUUSD,BTCUSD").split(",").map((s) => s.trim()).filter(Boolean);
const dataDir = resolve(env.ENGINE_DATA_DIR ?? join(import.meta.dirname ?? ".", "data"));
mkdirSync(dataDir, { recursive: true });

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const store: EngineStorePort = {
  readSnapshot: (s) => { const p = join(dataDir, `${safe(s)}.state.json`); return existsSync(p) ? readFileSync(p, "utf8") : null; },
  writeSnapshot: (s, json) => { const p = join(dataDir, `${safe(s)}.state.json`); writeFileSync(`${p}.tmp`, json); renameSync(`${p}.tmp`, p); },
  readJournalLines: (s) => { const p = join(dataDir, `${safe(s)}.journal.jsonl`); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []; },
  appendJournalLine: (s, line) => appendFileSync(join(dataDir, `${safe(s)}.journal.jsonl`), `${line}\n`),
};

const config = makeGatewayConfig({ httpBaseUrl: gatewayUrl, timeoutMs: 10_000 });
const client = new BrokerGatewayClient({ config, wallClock: new LiveClock(), monoClock: { now: () => performance.now() }, wsFactory: browserWebSocketFactory });
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const host = new EngineHost({
  symbols, persistence: new PaperPersistence(store), now: () => Date.now(), log,
  mount: ({ symbol, onChange, onRuntime }) => mountCanonicalRuntime({ client, config, wsFactory: browserWebSocketFactory, symbol, onChange, onRuntime }),
});
host.start();

const sse = new Set<import("node:http").ServerResponse>();
setInterval(() => {
  const msg = `data: ${JSON.stringify(envelope(host.health(), Date.now()))}\n\n`;
  for (const r of sse) r.write(msg);
}, 5_000);

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/v1/engine/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...ENGINE_CORS_HEADERS });
    sse.add(res); req.on("close", () => sse.delete(res));
    return;
  }
  const out = routeEngineRequest(host, req.method ?? "GET", req.url ?? "/", Date.now());
  res.writeHead(out.status, out.headers); res.end(out.body);
}).listen(port, "127.0.0.1", () => log(`[engine-host] read-only API on http://127.0.0.1:${port} · gateway ${gatewayUrl} · symbols ${symbols.join(",")} · data ${dataDir}`));

const shutdown = () => { log("[engine-host] shutting down, persisting state"); host.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
