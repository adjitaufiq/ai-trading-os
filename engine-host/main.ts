// Engine Host entry (runs on the Windows VPS with Bun: `bun engine-host/main.ts`).
// Thin glue only: Node fs/http + global WebSocket around src/core/enginehost. MONITOR_ONLY, read-only HTTP, no order path.
// Env:
//   ENGINE_GATEWAY_URL  local MT5 gateway (default http://127.0.0.1:8765, loopback)
//   ENGINE_HOST_PORT    read API port (default 8090), bound to 127.0.0.1; expose via your tunnel
//   ENGINE_SYMBOLS      comma list (default XAUUSD,BTCUSD)
//   ENGINE_DATA_DIR     persistence dir (default engine-host/data)
// Phase 3.5 canonical execution config (single source of truth, fail-closed):
//   EXECUTION_MODE        SHADOW | DEMO   (default SHADOW = analyze + journal only, no broker order)
//                         legacy values accepted: DEMO_STRESS_TEST → DEMO, REAL_DISABLED/PAPER_ONLY → SHADOW
//   SHADOW_MODE           legacy override; only ON is honored (forces shadow even in DEMO). OFF is ignored.
//   RISK_POLICY_FILE  location of risk-policy.json (default engine-host/risk-policy.json). Phase 4A: the ONLY source of
//                     risk_per_trade / max_position / max_symbol / max_daily_trade / emergency_stop. Env never overrides them
//                     (MAX_DAILY_TRADE is ignored). Invalid file ⇒ host refuses to start; missing ⇒ SHADOW only.
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
// The env EXECUTION_MODE still has to be DEMO to wire any order path; the cloud can only
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
import { DemoExecutionLayer, OrderLifecycleLog, PositionReconciler, RECONCILE_INTERVAL_MS, resolveExecutionPathMode } from "../src/core/execution/demo/DemoExecutionLayer";
import { ShadowGuard, resolveShadowActive, shadowGatedGateway, shadowSafetyFromPolicy } from "../src/core/execution/shadow/ShadowGuard";
import { DEFAULT_RISK_POLICY, parseRiskPolicy, riskPercentOf, type RiskPolicy } from "../src/core/execution/riskPolicy";
import { BrokerAccountProvider, resolveAccountMode, type AccountState } from "../src/core/execution/riskPolicy";
import { demoHistoryRows, paperHistoryRows } from "../src/core/execution/demo/tradeLifecycle";
import { validateDemoAccount } from "../src/core/execution/demo/guards";
import type { MarketRuntime } from "../src/core/runtime/MarketRuntime";
import { ControlPlaneAgent } from "../src/core/execution/control/agentSync";
import { signRequest } from "../src/core/execution/control/contract";
import type { EnginePipelineEvent } from "../src/core/enginehost/EngineHost";
import type { ApprovedPaperOpen } from "../src/core/paper/LivePaperLoop";
import type { MarketRuntimeReader } from "../src/core/runtime/MarketRuntime";
import { resolveBuildInfo } from "../src/core/enginehost/buildInfo";
import { ENGINE_CORS_HEADERS, buildEngineEvents, routeEngineRequest, sseFrame } from "../src/core/enginehost/api";

const env = process.env;
const gatewayUrl = env.ENGINE_GATEWAY_URL ?? "http://127.0.0.1:8765";
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

// ---- Phase 4A risk policy: single auditable file; env only gives its location. ----
const policyFile = resolve(env.RISK_POLICY_FILE ?? join(import.meta.dirname ?? ".", "risk-policy.json"));
let riskPolicy: RiskPolicy = DEFAULT_RISK_POLICY;
let policyLoaded = false;
if (existsSync(policyFile)) {
  const pr = parseRiskPolicy(readFileSync(policyFile, "utf8"));
  if (!pr.ok) throw new Error(`risk-policy.json invalid (${pr.error}) at ${policyFile}`);
  riskPolicy = pr.policy; policyLoaded = true;
}
log(`[risk-policy] ${policyLoaded ? policyFile : "NOT FOUND (defaults, DEMO refused)"} ${JSON.stringify(riskPolicy)}`);
// Cached actual broker positions (refreshed by reconciliation) feed the shadow MAX_POSITION/MAX_SYMBOL checks.
let brokerPositions: readonly { symbol: string }[] = [];

// ---- Phase 2A Shadow Guard: every approved order intent passes here; while active, no broker send is reachable. ----
const shadowFile = join(dataDir, "shadow-events.jsonl");
const shadowActive = resolveShadowActive(env);
let demoRef: { status(): { openPositions: number } } | null = null;
const shadow = new ShadowGuard({
  active: () => shadowActive, now: () => Date.now(), log: (m) => console.log(`${new Date().toISOString()} ${m}`), safety: shadowSafetyFromPolicy(riskPolicy),
  store: { readLines: () => existsSync(shadowFile) ? readFileSync(shadowFile, "utf8").split("\n").filter(Boolean) : [], append: (l) => appendFileSync(shadowFile, `${l}\n`) },
  emergencyStop: () => riskPolicy.emergency_stop || existsSync(join(dataDir, "EMERGENCY_STOP")) || existsSync(join(dataDir, "DEMO_KILL_SWITCH")),
  openState: () => ({ openPositions: Math.max(brokerPositions.length, demoRef?.status().openPositions ?? 0), openSymbols: brokerPositions.map((p) => p.symbol) }),
});
console.log(`${new Date().toISOString()} [shadow] ${shadow.status().label} · max_daily_trade ${shadow.safety.maxDailyTrades}`);

// ---- DEMO path wiring (no-op unless EXECUTION_MODE=DEMO; legacy DEMO_STRESS_TEST accepted) ----
const pathMode = resolveExecutionPathMode(env);
const executionMode = pathMode === "DEMO" ? "DEMO_STRESS_TEST" as const : parseExecutionMode(env.EXECUTION_MODE);
// ---- Phase 4A.2 Account State Provider: ACCOUNT_MODE=PAPER (simulated) | DEMO (Exness demo); REAL refused. ----
// EXECUTION_MODE=DEMO forces ACCOUNT_MODE=DEMO so approval, lot, exposure and daily loss all use the broker account.
const accountMode = pathMode === "DEMO" ? "DEMO" as const : resolveAccountMode(env);
if (accountMode === "REAL") throw new Error("ACCOUNT_MODE=REAL is not supported (real account capability is absent)");
let accountCache: { state: AccountState; at: number } | null = null;
const ACCOUNT_STATE_MAX_AGE_MS = 60_000;
const accountStateSource = accountMode === "DEMO"
  ? () => (accountCache && Date.now() - accountCache.at <= ACCOUNT_STATE_MAX_AGE_MS ? accountCache.state : null)
  : null;
if (accountMode === "DEMO") {
  if (!env.DEMO_EXEC_TOKEN) throw new Error("ACCOUNT_MODE=DEMO requires DEMO_EXEC_TOKEN (read-only account read)");
  const wl = parseWhitelist(env.DEMO_ACCOUNT_WHITELIST, env.DEMO_SERVER_WHITELIST);
  if (!wl.logins.length || !wl.servers.length) throw new Error("ACCOUNT_MODE=DEMO requires DEMO_ACCOUNT_WHITELIST and DEMO_SERVER_WHITELIST");
  const reader = shadowGatedGateway(createDemoGatewayClient({ baseUrl: env.DEMO_EXEC_URL ?? "http://127.0.0.1:8100", token: env.DEMO_EXEC_TOKEN }), shadow);
  const provider = new BrokerAccountProvider({
    now: () => Date.now(),
    read: async () => { const id = await reader.account(); return id && validateDemoAccount(id, wl).ok ? id : null; },
  });
  const pull = async () => { const st = await provider.current(); if (st) accountCache = { state: st, at: Date.now() }; else log("[account] DEMO account state unavailable — paper M4 approvals blocked"); };
  void pull(); setInterval(() => { void pull(); }, 15_000);
}
log(`[account] ACCOUNT_MODE=${accountMode}`);
const runtimes = new Map<string, MarketRuntime>();

let demo: DemoExecutionBridge | null = null;
let cloudKill = false;
let agent: ControlPlaneAgent | null = null;
const AGENT_VERSION = "engine-host/control-plane-v1";
if (pathMode === "DEMO") {
  if (!policyLoaded) throw new Error(`EXECUTION_MODE=DEMO requires risk-policy.json at ${policyFile}`);
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
  // Phase 3.5 chain: Decision Gate → Shadow Guard (intent gate) → DemoExecutionBridge (risk validation/sizing)
  //   → DemoExecutionLayer (mode check, duplicate/SL/TP/risk/symbol/account/position preflight + append-only
  //   order lifecycle log) → shadowGatedGateway (port-level shadow) → broker demo gateway.
  const lifecycleFile = join(dataDir, "order-lifecycle.jsonl");
  const lifecycle = new OrderLifecycleLog(
    { readLines: () => existsSync(lifecycleFile) ? readFileSync(lifecycleFile, "utf8").split("\n").filter(Boolean) : [], append: (l) => appendFileSync(lifecycleFile, `${l}\n`) },
    () => Date.now(),
  );
  const brokerGw = shadowGatedGateway(createDemoGatewayClient({ baseUrl: env.DEMO_EXEC_URL ?? "http://127.0.0.1:8100", token: env.DEMO_EXEC_TOKEN }), shadow);
  const reconcileFile = join(dataDir, "reconcile-events.jsonl");
  const reconciler = new PositionReconciler({
    lifecycle, now: () => Date.now(),
    gateway: { ...brokerGw, positions: async () => { const p = await brokerGw.positions(); brokerPositions = p; return p; } },
    store: { readLines: () => existsSync(reconcileFile) ? readFileSync(reconcileFile, "utf8").split("\n").filter(Boolean) : [], append: (l) => appendFileSync(reconcileFile, `${l}\n`) },
    alert: (r) => log(`[reconcile] ALERT ${r.trigger} mismatch — new orders BLOCKED ${JSON.stringify(r.issues)}${r.error ? ` error=${r.error}` : ""}`),
  });
  const layer = new DemoExecutionLayer({
    mode: pathMode, whitelist, lifecycle, maxPositions: riskPolicy.max_position, maxSymbols: riskPolicy.max_symbol, reconciler,
    gateway: brokerGw,
  });
  void reconciler.reconcile("STARTUP");
  setInterval(() => { void reconciler.reconcile("PERIODIC").catch((e) => log(`[reconcile] failed ${(e as Error).message}`)); }, RECONCILE_INTERVAL_MS);
  demo = new DemoExecutionBridge({
    mode: executionMode, whitelist, now: () => Date.now(), log, policy: riskPolicy,
    gateway: layer.asGatewayPort(),
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
  log(`[demo-lab] EXECUTION_MODE=DEMO armed · logins ${whitelist.logins.join(",")} · servers ${whitelist.servers.join(",")}`);
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
  mount: ({ symbol, onChange, onRuntime }) => mountCanonicalRuntime({ client, config, wsFactory: browserWebSocketFactory, symbol, onChange,
    onRuntime: (rt) => { rt.setPaperAccountStateSource(accountStateSource); runtimes.set(symbol, rt); onRuntime(rt); } }),
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
  if (req.method === "GET" && path === "/v1/journal/trades") {
    // Phase 4A.2 read-only trade history: demo (broker) + paper rows, each labelled with its account source.
    const eventsFile = join(dataDir, "demo-events.jsonl");
    const demoEvents = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
    const paper = [...runtimes.values()].flatMap((rt) => paperHistoryRows((rt.reader.paperTrades?.() ?? []) as never, (id) => rt.reader.paperTradeAccountSource?.(id) ?? null, riskPercentOf(riskPolicy)));
    const body = JSON.stringify({ account_mode: accountMode, risk_policy: riskPolicy, demo: demoHistoryRows(demoEvents), paper });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...ENGINE_CORS_HEADERS }); res.end(body);
    return;
  }
  const out = routeEngineRequest(host, req.method ?? "GET", req.url ?? "/", Date.now());
  res.writeHead(out.status, out.headers); res.end(out.body);
}).listen(port, "127.0.0.1", () => log(`[engine-host] read-only API on http://127.0.0.1:${port} · gateway ${gatewayUrl} · symbols ${symbols.join(",")} · data ${dataDir}`));

const shutdown = () => { log("[engine-host] shutting down, persisting state"); host.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
