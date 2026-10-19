// Lab DEMO runner entry (Windows VPS, Bun): `bun engine-host/lab-runner.ts`. Thin glue around src/core/lab/demo/labDemoRunner.
// Default SHADOW: evaluates + journals, never calls the broker write routes. Sends DEMO orders only when
// LAB_RUNNER_ARMED=YES; mt5_exec (loopback 8100) still re-validates DEMO + whitelist on every call.
// Env:
//   ENGINE_GATEWAY_URL   read-only MT5 gateway (default http://127.0.0.1:8765)
//   DEMO_EXEC_URL        demo executor (default http://127.0.0.1:8100)
//   DEMO_EXEC_TOKEN      bearer token shared with vps/mt5_exec (required)
//   DEMO_ACCOUNT_WHITELIST / DEMO_SERVER_WHITELIST  comma lists (required)
//   RISK_POLICY_FILE     default engine-host/risk-policy.json (read-only; invalid ⇒ refuse to start)
//   LAB_RUNNER_DATA_DIR  default engine-host/data/lab-runner (state.json + journal.jsonl + lock)
//   LAB_RUNNER_ARMED     YES to allow orders/closes (anything else = SHADOW)
//   LAB_RUNNER_INTERVAL_MS default 5000
//   Kill switch: create <data dir>/DEMO_KILL_SWITCH (or EMERGENCY_STOP) — blocks new entries immediately.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LabDemoRunner, type BrokerPos, type LabBrokerPort } from "../src/core/lab/demo/labDemoRunner";
import { parseRiskPolicy } from "../src/engine/risk/riskPolicy";
import type { TechBar } from "../src/core/technical/indicators";

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const GW = env("ENGINE_GATEWAY_URL", "http://127.0.0.1:8765"), EX = env("DEMO_EXEC_URL", "http://127.0.0.1:8100");
const TOKEN = env("DEMO_EXEC_TOKEN");
const logins = new Set(env("DEMO_ACCOUNT_WHITELIST").split(",").map((x) => Number(x.trim())).filter((x) => x > 0));
const servers = new Set(env("DEMO_SERVER_WHITELIST").split(",").map((x) => x.trim()).filter(Boolean));
const loopback = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u);
if (!loopback(GW) || !loopback(EX)) throw new Error("gateway/executor must be loopback");
if (TOKEN.length < 24 || !logins.size || !servers.size) throw new Error("DEMO_EXEC_TOKEN and DEMO whitelists required");
const pol = parseRiskPolicy(readFileSync(env("RISK_POLICY_FILE", "engine-host/risk-policy.json"), "utf8"));
if (!pol.ok) throw new Error(`risk policy invalid: ${pol.error}`);

const dir = env("LAB_RUNNER_DATA_DIR", "engine-host/data/lab-runner");
mkdirSync(dir, { recursive: true });
const lock = join(dir, "lab-runner.lock");
if (existsSync(lock)) {
  const pid = Number(JSON.parse(readFileSync(lock, "utf8")).pid);
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
  if (alive) { console.error(`[lab-runner] another runner (pid ${pid}) holds the lock`); process.exit(3); }
}
writeFileSync(lock, JSON.stringify({ pid: process.pid }));
process.on("exit", () => { try { unlinkSync(lock); } catch { /* ignore */ } });

const TIMEOUT_MS = 8000;
async function get(base: string, path: string, auth = false): Promise<any> {
  const r = await fetch(base + path, { headers: auth ? { authorization: `Bearer ${TOKEN}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}
async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(EX + path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); // caller treats as UNKNOWN / close failure
  return r.json();
}
const safe = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
const TF_MS = { M5: 300_000, M15: 900_000, H1: 3_600_000 } as const;

const port: LabBrokerPort = {
  serverTimeMs: () => safe(async () => { const e = await get(GW, "/v1/ticks/latest/XAUUSD"); const t = Number(e?.data?.raw_time_msc); return t > 0 ? t : null; }),
  account: () => safe(async () => { const a = await get(EX, "/v1/demo/account", true); return { login: a.login, server: a.server, tradeMode: a.trade_mode, balance: a.balance, equity: a.equity }; }),
  positions: () => safe(async () => (await get(EX, "/v1/demo/positions", true) as any[]).map((p): BrokerPos => ({ ticket: p.ticket, symbol: p.symbol, comment: p.comment, magicOk: true, volume: p.volume, profit: p.profit, sl: p.sl, tp: p.tp }))),
  closedBars: (symbol, tf) => safe(async () => {
    const e = await get(GW, `/v1/bars/${symbol}/${tf}?mode=pos&start=1&count=200`); // start=1 skips the forming bar
    const rows: any[] = Array.isArray(e?.data) ? e.data : e?.data?.bars ?? [];
    const ms = TF_MS[tf];
    return rows.map((b): TechBar => ({ open_time: b.raw_time_s * 1000, close_time: b.raw_time_s * 1000 + ms, available_at: b.raw_time_s * 1000 + ms, open: b.open, high: b.high, low: b.low, close: b.close }))
      .sort((a, b) => a.open_time - b.open_time);
  }),
  quote: (symbol) => safe(async () => { const d = (await get(GW, `/v1/ticks/latest/${symbol}`)).data; return d?.bid > 0 && d?.ask > 0 ? { bid: d.bid, ask: d.ask } : null; }),
  spec: (symbol) => safe(async () => { const s = await get(EX, `/v1/demo/symbol?name=${encodeURIComponent(symbol)}`, true); return s ? { symbol, volumeMin: s.volume_min, volumeMax: s.volume_max, volumeStep: s.volume_step, tickSize: s.tick_size, tickValue: s.tick_value, marginPerLot: 0 } : null; }),
  closeDeal: (t) => safe(async () => { const d = await get(EX, `/v1/demo/close-deal?position=${t}`, true); return d && !d.error ? { ticket: t, time: d.time, profit: d.profit, reason: d.reason } : null; }),
  sendOrder: async (req) => { const r = await post("/v1/demo/orders", req); return { status: r.status, ticket: r.ticket, price: r.price, volume: r.volume, comment: r.comment ?? r.error ?? null }; },
  closePosition: async (req) => { const r = await post("/v1/demo/close", req); return { status: r.status, comment: r.comment ?? null }; },
};

const stateFile = join(dir, "state.json"), journalFile = join(dir, "journal.jsonl");
const runner = new LabDemoRunner(port, {
  load: () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null),
  save: (s) => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(s)); renameSync(`${stateFile}.tmp`, stateFile); },
  journal: (e) => appendFileSync(journalFile, JSON.stringify({ at_local: new Date().toISOString(), ...e }) + "\n"),
}, {
  policy: pol.policy, whitelistLogins: logins, whitelistServers: servers,
  armed: env("LAB_RUNNER_ARMED") === "YES",
  killSwitch: () => existsSync(join(dir, "DEMO_KILL_SWITCH")) || existsSync(join(dir, "EMERGENCY_STOP")),
});
console.log(`[lab-runner] started ${runner.state.version} armed=${env("LAB_RUNNER_ARMED") === "YES"} policy=${JSON.stringify(pol.policy)}`);
let busy = false;
setInterval(async () => { if (busy) return; busy = true; try { await runner.tick(); } finally { busy = false; } }, Number(env("LAB_RUNNER_INTERVAL_MS", "5000")) || 5000);
