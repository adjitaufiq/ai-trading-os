// Lab DEMO journal transmitter — SEPARATE process from the runner. Read-only over the runner's local
// state.json + journal.jsonl; pushes HMAC-signed copies to the cloud journal. Never imports the broker
// port, never calls /v1/demo/*, never writes runner state. Disabled unless LAB_JOURNAL_SYNC=YES.
//   LAB_JOURNAL_SYNC=YES            required, else exits 0 (default OFF)
//   LAB_JOURNAL_SYNC_URL            e.g. https://<app>/api/public/agent/lab-demo-journal
//   EXECUTION_AGENT_SECRET          HMAC secret (never logged)
//   LAB_JOURNAL_AGENT_ID            default lab-runner-vps
//   LAB_RUNNER_DATA_DIR             default engine-host/data/lab-runner
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { signRequest } from "../src/core/execution/control/contract";

const env = (k: string) => process.env[k] ?? "";
if (env("LAB_JOURNAL_SYNC") !== "YES") { console.log("[lab-journal-sync] disabled (LAB_JOURNAL_SYNC != YES)"); process.exit(0); }
const url = env("LAB_JOURNAL_SYNC_URL"), secret = env("EXECUTION_AGENT_SECRET");
if (!url.startsWith("https://") || !secret) { console.error("[lab-journal-sync] missing LAB_JOURNAL_SYNC_URL (https) or EXECUTION_AGENT_SECRET"); process.exit(1); }
const agentId = env("LAB_JOURNAL_AGENT_ID") || "lab-runner-vps";
const dir = env("LAB_RUNNER_DATA_DIR") || "engine-host/data/lab-runner";
const stateFile = join(dir, "state.json"), journalFile = join(dir, "journal.jsonl"), cursorFile = join(dir, "journal-sync.cursor");
const MAX_LINES = 500, MAX_BYTES = 1_000_000, BASE_MS = 30_000, MAX_BACKOFF_MS = 300_000;

const readCursor = () => { try { return Math.max(0, Number(readFileSync(cursorFile, "utf8")) || 0); } catch { return 0; } };
const writeCursor = (n: number) => { writeFileSync(`${cursorFile}.tmp`, String(n)); renameSync(`${cursorFile}.tmp`, cursorFile); };

/** Reads complete lines from offset; returns lines and the byte offset after the last complete line. */
function readLines(offset: number): { lines: string[]; next: number } {
  if (!existsSync(journalFile)) return { lines: [], next: offset };
  const fd = openSync(journalFile, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset > size) offset = 0; // file rotated/truncated: restart; server dedups by event key
    const buf = Buffer.alloc(Math.min(MAX_BYTES, size - offset));
    readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf8"), lines: string[] = [];
    let pos = 0;
    while (lines.length < MAX_LINES) { const nl = text.indexOf("\n", pos); if (nl < 0) break; const l = text.slice(pos, nl); if (l.trim()) lines.push(l); pos = nl + 1; }
    return { lines, next: offset + Buffer.byteLength(text.slice(0, pos), "utf8") };
  } finally { closeSync(fd); }
}

async function push(): Promise<boolean> {
  if (!existsSync(stateFile)) { console.log("[lab-journal-sync] no state.json yet"); return true; }
  const s = JSON.parse(readFileSync(stateFile, "utf8"));
  const cursor = readCursor(), { lines, next } = readLines(cursor);
  const body = JSON.stringify({
    agent_id: agentId, snapshot_at: Date.now(),
    runner: { version: String(s.version ?? "unknown"), armed: env("LAB_RUNNER_ARMED") === "YES", phase: String(s.phase ?? "UNKNOWN"), reconciliationClean: !!s.reconciliationClean, blockReason: s.blockReason ?? null },
    trades: Array.isArray(s.trades) ? s.trades.slice(-500) : [],
    events: lines.map((line) => ({ line })),
  });
  const path = new URL(url).pathname, ts = String(Date.now());
  const sig = await signRequest(secret, ts, "POST", path, body);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-agent-timestamp": ts, "x-agent-signature": sig }, body, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) { console.error(`[lab-journal-sync] HTTP ${r.status}`); return false; }
  if (next !== cursor) writeCursor(next); // advance only after the server stored the batch
  console.log(`[lab-journal-sync] ok ${await r.text()}`);
  return true;
}

let backoff = BASE_MS;
async function loop() {
  let ok = false;
  try { ok = await push(); } catch (e) { console.error(`[lab-journal-sync] ${(e as Error).message}`); }
  backoff = ok ? BASE_MS : Math.min(MAX_BACKOFF_MS, backoff * 2);
  setTimeout(loop, backoff);
}
console.log(`[lab-journal-sync] started agent=${agentId} dir=${dir}`);
void loop();
