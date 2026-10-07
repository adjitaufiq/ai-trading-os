// Engine Host entry (runs on the Windows VPS with Bun: `bun engine-host/main.ts`).
// Thin glue only: Node fs/http + global WebSocket around src/core/enginehost. MONITOR_ONLY, read-only HTTP, no order path.
// Env:
//   ENGINE_GATEWAY_URL  local MT5 gateway (default http://127.0.0.1:8000, loopback)
//   ENGINE_HOST_PORT    read API port (default 8090), bound to 127.0.0.1; expose via your tunnel
//   ENGINE_SYMBOLS      comma list (default XAUUSD,BTCUSD)
//   ENGINE_DATA_DIR     persistence dir (default engine-host/data)
// Stage 10 DEMO lab (optional; default REAL_DISABLED = no order path wired):
//   EXECUTION_MODE        REAL_DISABLED | PAPER_ONLY | DEMO_STRESS_TEST
//   DEMO_EXEC_URL         loopback demo execution gateway (default http://127.0.0.1:8100)
//   DEMO_EXEC_TOKEN       shared token with vps/mt5_exec (required for DEMO_STRESS_TEST)
//   DEMO_ACCOUNT_WHITELIST / DEMO_SERVER_WHITELIST  comma lists (identity binding)
//   DEMO_CONTROL_URL      optional cloud kill-switch URL (fail-closed when unreachable)
//   Local kill switch: create file <ENGINE_DATA_DIR>/DEMO_KILL_SWITCH
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
import { DemoExecutionBridge } from "../src/core/execution/demo/DemoExecutionBridge";
import { createDemoGatewayClient } from "../src/core/execution/demo/gatewayClient";
import { parseWhitelist } from "../src/core/execution/demo/guards";
import { buildDemoIntent } from "../src/core/execution/demo/intent";
import { parseExecutionMode } from "../src/core/execution/demo/types";
import type { ApprovedPaperOpen } from "../src/core/paper/LivePaperLoop";
import type { MarketRuntimeReader } from "../src/core/runtime/MarketRuntime";
import { ENGINE_CORS_HEADERS, buildEngineEvents, routeEngineRequest, sseFrame } from "../src/core/enginehost/api";

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

// ---- Stage 10 DEMO lab wiring (no-op unless EXECUTION_MODE=DEMO_STRESS_TEST) ----
const executionMode = parseExecutionMode(env.EXECUTION_MODE);
let demo: DemoExecutionBridge | null = null;
let cloudKill = false;
if (executionMode === "DEMO_STRESS_TEST") {
  if (!env.DEMO_EXEC_TOKEN) throw new Error("DEMO_STRESS_TEST requires DEMO_EXEC_TOKEN");
  const whitelist = parseWhitelist(env.DEMO_ACCOUNT_WHITELIST, env.DEMO_SERVER_WHITELIST);
  if (!whitelist.logins.length || !whitelist.servers.length) throw new Error("DEMO_STRESS_TEST requires DEMO_ACCOUNT_WHITELIST and DEMO_SERVER_WHITELIST");
  const killFile = join(dataDir, "DEMO_KILL_SWITCH");
  const eventsFile = join(dataDir, "demo-events.jsonl");
  demo = new DemoExecutionBridge({
    mode: executionMode, whitelist, now: () => Date.now(), log,
    gateway: createDemoGatewayClient({ baseUrl: env.DEMO_EXEC_URL ?? "http://127.0.0.1:8100", token: env.DEMO_EXEC_TOKEN }),
    store: { readLines: () => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean) : [], append: (l) => appendFileSync(eventsFile, `${l}\n`) },
    killSwitch: () => cloudKill || existsSync(killFile),
  });
  const controlUrl = env.DEMO_CONTROL_URL;
  if (controlUrl) {
    cloudKill = true; // fail-closed until the first successful read
    const poll = async () => {
      try { const r = await fetch(controlUrl); const j = await r.json() as { stopped?: unknown }; cloudKill = !r.ok || j.stopped !== false; }
      catch { cloudKill = true; }
    };
    void poll(); setInterval(poll, 15_000);
  }
  setInterval(() => { void demo?.sync().catch((e) => log(`[demo-lab] sync failed ${(e as Error).message}`)); }, 15_000);
  log(`[demo-lab] DEMO_STRESS_TEST armed · logins ${whitelist.logins.join(",")} · servers ${whitelist.servers.join(",")}`);
}

const host = new EngineHost({
  symbols, persistence: new PaperPersistence(store), now: () => Date.now(), log, executionMode,
  ...(demo ? {
    onApprovedOpen: (e: ApprovedPaperOpen, reader: MarketRuntimeReader | null) => { void demo!.handle(buildDemoIntent(e, reader?.radarSnapshot() ?? null)).catch((x) => log(`[demo-lab] handle failed ${(x as Error).message}`)); },
    demoStatus: () => demo!.status(),
  } : {}),
  mount: ({ symbol, onChange, onRuntime }) => mountCanonicalRuntime({ client, config, wsFactory: browserWebSocketFactory, symbol, onChange, onRuntime }),
});
host.start();

const sse = new Set<import("node:http").ServerResponse>();
const seen = new Map<string, number>();
const seenBundle = new Map<string, string>();
setInterval(() => {
  const frames = buildEngineEvents(host, Date.now(), seen, seenBundle).map(sseFrame).join("");
  for (const r of sse) r.write(frames);
}, 2_000);

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && (path === "/v1/engine/events" || path === "/v1/engine/stream")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...ENGINE_CORS_HEADERS });
    // New subscriber gets every symbol's current bundle immediately (refresh recovery), then deltas.
    const now = Date.now();
    for (const symbol of host.symbols) { const b = host.bundle(symbol, now); if (b) res.write(sseFrame({ type: "SNAPSHOT_UPDATE", symbol, timestamp: new Date(now).toISOString(), data: b })); }
    sse.add(res); req.on("close", () => sse.delete(res));
    return;
  }
  const out = routeEngineRequest(host, req.method ?? "GET", req.url ?? "/", Date.now());
  res.writeHead(out.status, out.headers); res.end(out.body);
}).listen(port, "127.0.0.1", () => log(`[engine-host] read-only API on http://127.0.0.1:${port} · gateway ${gatewayUrl} · symbols ${symbols.join(",")} · data ${dataDir}`));

const shutdown = () => { log("[engine-host] shutting down, persisting state"); host.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
