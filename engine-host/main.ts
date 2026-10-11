// Engine Host entry (runs on the Windows VPS with Bun: `bun engine-host/main.ts`).
// Thin glue only: Node fs/http + global WebSocket around src/core/enginehost. MONITOR_ONLY, read-only HTTP, no order path.
// Env:
//   ENGINE_GATEWAY_URL  local MT5 gateway (default http://127.0.0.1:8000, loopback)
//   ENGINE_HOST_PORT    read API port (default 8090), bound to 127.0.0.1; expose via your tunnel
//   ENGINE_SYMBOLS      comma list (default XAUUSD,BTCUSD)
//   ENGINE_DATA_DIR     persistence dir (default engine-host/data)
// Phase 3.5 canonical execution config (single source of truth, fail-closed):
//   EXECUTION_MODE        SHADOW | DEMO   (default SHADOW = analyze + journal only, no broker order)
//                         legacy values accepted: DEMO_STRESS_TEST → DEMO, REAL_DISABLED/PAPER_ONLY → SHADOW
//   SHADOW_MODE           legacy override; only ON is honored (forces shadow even in DEMO). OFF is ignored.
//   MAX_DAILY_TRADE  shadow/demo safety daily cap (default 5); MAX_POSITION=1, MAX_SYMBOL=1, duplicate/SL/TP/emergency stop fixed ON
//   Emergency stop: create file <ENGINE_DATA_DIR>/EMERGENCY_STOP (or DEMO_KILL_SWITCH)
// DEMO path (wired only when EXECUTION_MODE=DEMO):
//   DEMO_EXEC_URL         loopback demo execution gateway (default http://127.0.0.1:8100)
//   DEMO_EXEC_TOKEN       shared token with vps/mt5_exec (required for DEMO_STRESS_TEST)
//   DEMO_ACCOUNT_WHITELIST / DEMO_SERVER_WHITELIST  comma lists (identity binding)
//   DEMO_CONTROL_URL      optional cloud kill-switch URL (fail-closed when unreachable)
//   Local kill switch: create file <ENGINE_DATA_DIR>/DEMO_KILL_SWITCH
// Step 2 cloud control plane (optional, recommended): config pulled from the cloud, heartbeat/events pushed.
//   CONTROL_PLANE_URL        e.g. https://ai-trading-os.lovable.app
//   EXECUTION_AGENT_SECRET   HMAC secret shared with the cloud (same value as the cloud secret)
//   EXECUTION_AGENT_ID       agent name (default vps-1)
// The env EXECUTION_MODE still has to be DEMO_STRESS_TEST to wire any order path; the cloud can only
// halt or set limits within it, never arm a host started without it, and never target a real account.
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
import { DemoExecutionLayer, OrderLifecycleLog, resolveExecutionPathMode } from "../src/core/execution/demo/DemoExecutionLayer";
import { ShadowGuard, parseShadowSafety, resolveShadowActive, shadowGatedGateway } from "../src/core/execution/shadow/ShadowGuard";
import { ControlPlaneAgent } from "../src/core/execution/control/agentSync";
import { signRequest } from "../src/core/execution/control/contract";
import type { EnginePipelineEvent } from "../src/core/enginehost/EngineHost";
import type { ApprovedPaperOpen } from "../src/core/paper/LivePaperLoop";
import type { MarketRuntimeReader } from "../src/core/runtime/MarketRuntime";
import { resolveBuildInfo } from "../src/core/enginehost/buildInfo";
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

// ---- Phase 2A Shadow Guard: every approved order intent passes here; while active, no broker send is reachable. ----
const shadowFile = join(dataDir, "shadow-events.jsonl");
const shadowActive = resolveShadowActive(env);
let demoRef: { status(): { openPositions: number } } | null = null;
const shadow = new ShadowGuard({
  active: () => shadowActive, now: () => Date.now(), log: (m) => console.log(`${new Date().toISOString()} ${m}`), safety: parseShadowSafety(env),
  store: { readLines: () => existsSync(shadowFile) ? readFileSync(shadowFile, "utf8").split("\n").filter(Boolean) : [], append: (l) => appendFileSync(shadowFile, `${l}\n`) },
  emergencyStop: () => existsSync(join(dataDir, "EMERGENCY_STOP")) || existsSync(join(dataDir, "DEMO_KILL_SWITCH")),
  openState: () => ({ openPositions: demoRef?.status().openPositions ?? 0, openSymbols: [] }),
});
console.log(`${new Date().toISOString()} [shadow] ${shadow.status().label} · max_daily_trade ${shadow.safety.maxDailyTrades}`);

// ---- DEMO path wiring (no-op unless EXECUTION_MODE=DEMO; legacy DEMO_STRESS_TEST accepted) ----
const pathMode = resolveExecutionPathMode(env);
const executionMode = pathMode === "DEMO" ? "DEMO_STRESS_TEST" as const : parseExecutionMode(env.EXECUTION_MODE);
let demo: DemoExecutionBridge | null = null;
let cloudKill = false;
let agent: ControlPlaneAgent | null = null;
const AGENT_VERSION = "engine-host/control-plane-v1";
if (pathMode === "DEMO") {
  if (!env.DEMO_EXEC_TOKEN) throw new Error("EXECUTION_MODE=DEMO requires DEMO_EXEC_TOKEN");
  const whitelist = parseWhitelist(env.DEMO_ACCOUNT_WHITELIST, env.DEMO_SERVER_WHITELIST);
  if (!whitelist.logins.length || !whitelist.servers.length) throw new Error("EXECUTION_MODE=DEMO requires DEMO_ACCOUNT_WHITELIST and DEMO_SERVER_WHITELIST");
  if (env.CONTROL_PLANE_URL && env.EXECUTION_AGENT_SECRET) {
    agent = new ControlPlaneAgent({
      baseUrl: env.CONTROL_PLANE_URL, secret: env.EXECUTION_AGENT_SECRET, agentId: env.EXECUTION_AGENT_ID ?? "vps-1",
      version: AGENT_VERSION, executionMode, now: () => Date.now(), log, status: () => demo?.status() ?? null,
    });
  } else {
    log("[demo-lab] STANDALONE mode: CONTROL_PLANE_URL/EXECUTION_AGENT_SECRET not set, using local env limits + DEMO_KILL_SWITCH file only");
  }
  if (env.DEMO_CONTROL_URL) log("[demo-lab] DEMO_CONTROL_URL set: orders blocked until it returns stopped=false (unset it for pure standalone)");
  const killFile = join(dataDir, "DEMO_KILL_SWITCH");
  const eventsFile = join(dataDir, "demo-events.jsonl");
  demo = new DemoExecutionBridge({
    mode: executionMode, whitelist, now: () => Date.now(), log,
    gateway: shadowGatedGateway(createDemoGatewayClient({ baseUrl: env.DEMO_EXEC_URL ?? "http://127.0.0.1:8100", token: env.DEMO_EXEC_TOKEN }), shadow),
    store: { readLines: () => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean) : [], append: (l) => appendFileSync(eventsFile, `${l}\n`) },
    killSwitch: () => cloudKill || existsSync(killFile) || (agent ? agent.current().halted : false),
    ...(agent ? { profile: () => agent!.current().profile } : {}),
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
  if (agent) {
    const a = agent;
    const tick = async () => { await a.pullConfig(); await a.pushHeartbeat(); await a.pushEvents(demo?.status().recentEvents ?? []); };
    void tick(); setInterval(() => { void tick(); }, 15_000);
  }
  demoRef = demo;
  setInterval(() => { void demo?.sync().catch((e) => log(`[demo-lab] sync failed ${(e as Error).message}`)); }, 15_000);
  log(`[demo-lab] DEMO_STRESS_TEST armed · logins ${whitelist.logins.join(",")} · servers ${whitelist.servers.join(",")}`);
}

// ---- Durable engine-event outbox: every pipeline event hits disk first, then is pushed (signed) to the cloud. ----
// Survives VPS restart: the cursor file records the last pushed line; unpushed lines are retried every 10s.
const outboxFile = join(dataDir, "engine-events.outbox.jsonl");
const cursorFile = join(dataDir, "engine-events.cursor");
const pushOutbox = async () => {
  if (!env.CONTROL_PLANE_URL || !env.EXECUTION_AGENT_SECRET || !existsSync(outboxFile)) return;
  const lines = readFileSync(outboxFile, "utf8").split("\n").filter(Boolean);
  const done = existsSync(cursorFile) ? Number(readFileSync(cursorFile, "utf8")) || 0 : 0;
  const batch = lines.slice(done, done + 200);
  if (!batch.length) return;
  const path = "/api/public/agent/engine-events";
  const body = JSON.stringify({ agent_id: env.EXECUTION_AGENT_ID ?? "vps-1", events: batch.map((l) => JSON.parse(l)) });
  const ts = String(Date.now());
  try {
    const r = await fetch(`${env.CONTROL_PLANE_URL.replace(/\/+$/, "")}${path}`, { method: "POST", body, headers: { "content-type": "application/json", "x-agent-timestamp": ts, "x-agent-signature": await signRequest(env.EXECUTION_AGENT_SECRET, ts, "POST", path, body) } });
    if (r.ok) writeFileSync(cursorFile, String(done + batch.length)); else log(`[events] push HTTP ${r.status}`);
  } catch (e) { log(`[events] push failed ${(e as Error).message}`); }
};
setInterval(() => { void pushOutbox(); }, 10_000);
if (!env.CONTROL_PLANE_URL || !env.EXECUTION_AGENT_SECRET) log("[events] CONTROL_PLANE_URL/EXECUTION_AGENT_SECRET not set: events kept on disk only (5-min cloud capture still runs)");

// Build identity: env (ENGINE_COMMIT / ENGINE_BUILD_TIME) wins, else engine-host/BUILD_INFO.json from the deploy zip.
const buildFile = join(import.meta.dirname ?? ".", "BUILD_INFO.json");
let buildSrc: { commit?: unknown; build_time?: unknown } = {};
try { if (existsSync(buildFile)) buildSrc = JSON.parse(readFileSync(buildFile, "utf8")); } catch { log("[engine-host] BUILD_INFO.json unreadable, commit/build_time reported null"); }
const build = resolveBuildInfo({ commit: env.ENGINE_COMMIT ?? buildSrc.commit, build_time: env.ENGINE_BUILD_TIME ?? buildSrc.build_time });
log(`[engine-host] build ${build.engine_version} commit ${build.commit ?? "UNKNOWN"} built ${build.build_time ?? "UNKNOWN"}`);

const host = new EngineHost({
  build,
  onPipelineEvent: (e: EnginePipelineEvent) => { appendFileSync(outboxFile, `${JSON.stringify(e)}\n`); void pushOutbox(); },
  symbols, persistence: new PaperPersistence(store), now: () => Date.now(), log, executionMode,
  shadowStatus: () => shadow.status(),
  onApprovedOpen: (e: ApprovedPaperOpen, reader: MarketRuntimeReader | null) => {
    const intent = buildDemoIntent(e, reader?.radarSnapshot() ?? null, host.bundle(e.symbol, Date.now())?.slice?.current ?? null);
    const g = shadow.gate(intent);
    if (!g.allow || !demo) return;
    if (agent && !agent.current().allowedSymbols.includes(e.symbol.toUpperCase())) { log(`[demo-lab] ${e.symbol} not in cloud allowed_symbols, skipped`); return; }
    void demo.handle(intent).catch((x) => log(`[demo-lab] handle failed ${(x as Error).message}`));
  },
  ...(demo ? { demoStatus: () => demo!.status() } : {}),
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
