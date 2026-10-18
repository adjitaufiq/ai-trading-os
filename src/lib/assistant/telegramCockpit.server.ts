// Telegram one-click cockpit (6-button reply keyboard). Every card is a template filled ONLY with stored facts:
// engine_memory (Engine Host snapshot per closed M5), engine_status_relay (sanitized VPS heartbeat) and
// lab_journal_trades (browser PAPER journal). No AI text, no calculation of signals, no order/config path.
import { escapeTelegramHtml as esc } from "@/lib/assistant/telegramFormat";
import { LAB_LABELS, type LabStrategy } from "@/core/lab/strategies";
import { maxDrawdown, winLossStats } from "@/core/lab/labReport";

export const BTN = {
  XAU: "🥇 Gold (XAUUSD) Radar",
  BTC: "₿ Bitcoin (BTCUSD) Radar",
  SETUP: "🎯 Ready Setups & Plan",
  LAB: "📊 Strategy Lab Cockpit",
  AUDIT: "📋 Full Audit Report",
  HEALTH: "🚦 System Health & VPS",
} as const;

export const COCKPIT_KEYBOARD = {
  keyboard: [[{ text: BTN.XAU }, { text: BTN.BTC }], [{ text: BTN.SETUP }, { text: BTN.LAB }], [{ text: BTN.AUDIT }, { text: BTN.HEALTH }]],
  resize_keyboard: true,
  is_persistent: true,
};

export type CockpitAction = keyof typeof BTN;
export function matchButton(text: string): CockpitAction | null {
  const t = text.trim().toLowerCase();
  for (const [k, v] of Object.entries(BTN)) if (t === v.toLowerCase()) return k as CockpitAction;
  const cmd: Record<string, CockpitAction> = { "/xau": "XAU", "/gold": "XAU", "/btc": "BTC", "/setup": "SETUP", "/lab": "LAB", "/update": "LAB", "/audit": "AUDIT", "/report": "AUDIT", "/health": "HEALTH" };
  return cmd[t.split(/[\s@]/)[0] ?? ""] ?? null;
}

const WIB = (ms: number) => new Date(ms).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " WIB";
const age = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} jam ${m % 60} mnt`; };
const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const v = (x: unknown) => (x === null || x === undefined || x === "" ? "UNKNOWN" : esc(String(x)));
const FRESH_MS = 15 * 60_000;

type Admin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
async function admin(): Promise<Admin> { return (await import("@/integrations/supabase/client.server")).supabaseAdmin; }

function freshness(atIso: string | null, now: number): string {
  if (!atIso) return "⚪ Data: UNKNOWN (belum ada snapshot)";
  const a = now - Date.parse(atIso);
  return a <= FRESH_MS ? `🟢 Data FRESH · ${WIB(Date.parse(atIso))} (${age(a)} lalu)` : `🔴 Data STALE · ${WIB(Date.parse(atIso))} (${age(a)} lalu)`;
}

/** Direction word copied from engine state labels; null when the label carries no direction. */
export function dirOf(s: string | null | undefined): "BULL" | "BEAR" | null {
  if (!s) return null; const u = s.toUpperCase();
  if (/BULL|BUY|UP|HH_HL/.test(u)) return "BULL";
  if (/BEAR|SELL|DOWN|LH_LL/.test(u)) return "BEAR";
  return null;
}

async function latestMemory(symbol: string) {
  const sb = await admin();
  const { data } = await sb.from("engine_memory").select("*").eq("symbol", symbol).order("m5_close_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

export async function radarCard(symbol: "XAUUSD" | "BTCUSD", now: number): Promise<string> {
  const m = await latestMemory(symbol);
  const icon = symbol === "XAUUSD" ? "🥇" : "₿";
  if (!m) return `${icon} <b>${symbol} RADAR</b>\n\n⚪ Belum ada snapshot engine tersimpan.`;
  const h4 = dirOf(m.h4_state), h1 = dirOf(m.h1_state);
  const div = h4 && h1 && h4 !== h1 ? `⚠️ <b>Macro Divergence:</b> H4 ${h4} vs H1 ${h1}` : h4 && h1 ? "✅ H4 & H1 searah" : "⚪ Divergence: UNKNOWN";
  const L = [
    `${icon} <b>${symbol} RADAR</b>`,
    freshness(m.m5_close_at, now),
    "",
    `💰 Harga: <b>${v(m.price)}</b>`,
    `🧭 Bias: <b>${v(m.bias)}</b> · Confidence ${v(m.confidence)}`,
    `📐 H4: ${v(m.h4_state)}`,
    `📐 H1: ${v(m.h1_state)}`,
    div,
    `🌊 Regime: ${v(m.regime)} · Fase: ${v(m.market_phase)}`,
    "",
    `🔺 Resisten: ${v(m.resistance)}`,
    `🔻 Support: ${v(m.support)}`,
    "",
    `🚦 Radar: ${v(m.radar_status)} · Engine: ${v(m.engine_state)}`,
  ];
  if (m.active_events?.length) L.push(`📡 Event: ${esc(m.active_events.slice(0, 4).join(", "))}`);
  L.push("", "<i>Sumber: Engine Host snapshot (closed M5). Bukan sinyal order.</i>");
  return L.join("\n");
}

export async function setupsCard(now: number): Promise<string> {
  const L = ["🎯 <b>READY SETUPS & PLAN</b>"];
  for (const sym of ["XAUUSD", "BTCUSD"] as const) {
    const m = await latestMemory(sym);
    L.push("", `<b>${sym}</b>`);
    if (!m) { L.push("⚪ Belum ada snapshot."); continue; }
    L.push(freshness(m.m5_close_at, now));
    L.push(`Keputusan: <b>${v(m.decision)}</b> · Setup: ${v(m.setup)}`);
    L.push(`Approach: ${v(m.approach)} · Risk: ${v(m.risk)}`);
    if (m.confirmation_needed?.length) L.push(`⏳ Tunggu: ${esc(m.confirmation_needed.slice(0, 3).join("; "))}`);
    if (m.invalidation?.length) L.push(`❌ Invalidasi: ${esc(m.invalidation.slice(0, 2).join("; "))}`);
    if (m.reasons?.length) L.push(`💬 ${esc(m.reasons.slice(0, 2).join("; "))}`);
  }
  const sb = await admin();
  const { data: ev } = await sb.from("engine_events").select("event_type, symbol, reason, occurred_at").in("event_type", ["READY", "EXECUTION", "BLOCKED"]).order("occurred_at", { ascending: false }).limit(3);
  if (ev?.length) {
    L.push("", "<b>Event terakhir</b>");
    for (const e of ev) L.push(`• ${esc(e.event_type)} ${v(e.symbol)} — ${esc(String(e.reason).slice(0, 80))} (${WIB(Date.parse(e.occurred_at))})`);
  }
  L.push("", "<i>Copy dari engine; tidak ada eksekusi dari Telegram.</i>");
  return L.join("\n");
}

interface LabRowT { strategy: string; symbol: string; pnl_usd: number; closed_at_ms: number | null; opened_at_ms: number; status: string }
async function latestLab() {
  const sb = await admin();
  const { data: s } = await sb.from("lab_journal_sessions").select("id, client_as_of_ms, initial_balance").order("client_as_of_ms", { ascending: false }).limit(1);
  const sess = s?.[0];
  if (!sess) return null;
  const rows: LabRowT[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await sb.from("lab_journal_trades").select("strategy, symbol, pnl_usd, closed_at_ms, opened_at_ms, status").eq("session_id", sess.id).range(from, from + 999);
    if (!data?.length) break; rows.push(...(data as LabRowT[])); if (data.length < 1000) break;
  }
  return { sess, rows };
}
const label = (s: string) => LAB_LABELS[s as LabStrategy] ?? s;

interface Agg { key: string; n: number; w: number; pnl: number; open: number; pnls: number[]; recent: number }
function aggregate(rows: LabRowT[], by: (r: LabRowT) => string, now: number): Agg[] {
  const m = new Map<string, Agg>();
  const sorted = [...rows].sort((a, b) => (a.closed_at_ms ?? 0) - (b.closed_at_ms ?? 0));
  for (const r of sorted) {
    const k = by(r); const a = m.get(k) ?? { key: k, n: 0, w: 0, pnl: 0, open: 0, pnls: [], recent: 0 };
    if (r.closed_at_ms == null) a.open++;
    else { a.n++; if (r.pnl_usd > 0) a.w++; a.pnl += r.pnl_usd; a.pnls.push(r.pnl_usd); if (now - r.closed_at_ms <= 3 * 3600_000) a.recent += r.pnl_usd; }
    m.set(k, a);
  }
  return [...m.values()].sort((a, b) => b.pnl - a.pnl);
}
const wr = (a: Agg) => (a.n ? `${((a.w / a.n) * 100).toFixed(1)}%` : "-");

export async function labCard(now: number, full = false): Promise<string> {
  const lab = await latestLab();
  const head = full ? "📋 <b>FULL AUDIT REPORT — STRATEGY LAB</b>" : "📊 <b>STRATEGY LAB COCKPIT</b>";
  if (!lab) return `${head}\n\n⚪ Belum ada jurnal Lab di cloud.`;
  const { sess, rows } = lab;
  const closed = rows.filter((r) => r.closed_at_ms != null);
  const realized = closed.reduce((s, r) => s + r.pnl_usd, 0);
  const all = aggregate(rows, () => "ALL", now)[0];
  const wl = winLossStats(closed.map((r) => r.pnl_usd));
  const dd = maxDrawdown([...closed].sort((a, b) => (a.closed_at_ms ?? 0) - (b.closed_at_ms ?? 0)).map((r) => r.pnl_usd), sess.initial_balance);
  const syncAge = now - sess.client_as_of_ms;
  const L = [
    head,
    syncAge <= FRESH_MS ? `🟢 Sync FRESH · ${WIB(sess.client_as_of_ms)}` : `🔴 Sync STALE · ${WIB(sess.client_as_of_ms)} (${age(syncAge)} lalu — browser runner mungkin mati)`,
    "<i>SIMULASI PAPER — bukan profit broker MT5</i>",
    "",
    "<b>📈 Status Global</b>",
    `• Balance: <b>$${(sess.initial_balance + realized).toFixed(2)}</b> (modal $${sess.initial_balance})`,
    (() => { const st = Math.floor((now + 7 * 3600_000) / 86_400_000) * 86_400_000 - 7 * 3600_000; const c = closed.filter((r) => (r.closed_at_ms ?? 0) >= st); return `• P/L Hari Ini (WIB): <b>${usd(c.reduce((s, r) => s + r.pnl_usd, 0))}</b> · ${c.length} closed`; })(),
    `• Realized All-Time: ${usd(realized)} · Floating: tidak disinkron`,
    `• Closed: ${all?.n ?? 0} · W/L ${all?.w ?? 0}/${(all?.n ?? 0) - (all?.w ?? 0)} (${all ? wr(all) : "-"})`,
    `• Open: ${all?.open ?? 0} · 3 jam: ${usd(all?.recent ?? 0)}`,
    `• AvgW ${wl.avgWin == null ? "-" : "$" + wl.avgWin.toFixed(2)} · AvgL ${wl.avgLoss == null ? "-" : "$" + wl.avgLoss.toFixed(2)} · RR ${wl.rr == null ? "-" : wl.rr.toFixed(2)}`,
    `• Max DD: −$${dd.usd.toFixed(2)} (${(dd.pct * 100).toFixed(1)}% dari peak)`,
    "",
    "<b>🪙 Per Pair</b>",
  ];
  for (const a of aggregate(rows, (r) => r.symbol, now)) L.push(`• ${esc(a.key)}: ${usd(a.pnl)} · ${a.n} trade (${wr(a)}) · ${a.open} open`);
  const modes = aggregate(rows, (r) => r.strategy, now);
  const medal = ["🥇", "🥈", "🥉"];
  L.push("", full ? "<b>🏆 Leaderboard Semua Mode</b>" : "<b>🏆 Top 3 Mesin Cuan</b>");
  (full ? modes : modes.slice(0, 3)).forEach((a, i) => {
    L.push(`${medal[i] ?? `#${i + 1}`} <b>${esc(label(a.key))}</b>`, `   Net ${usd(a.pnl)} · ${a.w}W/${a.n - a.w}L (${wr(a)})`, `   Open ${a.open} · 3j ${usd(a.recent)}`);
    if (full) { const s = winLossStats(a.pnls); const d = maxDrawdown(a.pnls, 0); L.push(`   AvgW ${s.avgWin?.toFixed(2) ?? "-"} · AvgL ${s.avgLoss?.toFixed(2) ?? "-"} · RR ${s.rr?.toFixed(2) ?? "-"} · DD −$${d.usd.toFixed(2)}`); }
    if (full) L.push("");
  });
  const worst = modes[modes.length - 1];
  if (!full && worst && worst.pnl < 0) L.push("", `⚠️ Terlemah: ${esc(label(worst.key))} ${usd(worst.pnl)}`);
  const stack = modes.filter((a) => a.open > 2);
  L.push("", stack.length ? `🧱 Stacking: ${stack.map((a) => `${esc(label(a.key))} (${a.open})`).join(", ")}` : "🧱 Stacking: tidak ada");
  L.push("", "<i>Status ON/OFF mode disimpan di browser; lihat dashboard.</i>");
  return L.join("\n");
}

export async function healthCard(now: number): Promise<string> {
  const { pullStatusProxy, readRelayStatus } = await import("@/lib/engineStatus/relay.server");
  await pullStatusProxy().catch(() => false);
  const st = await readRelayStatus(Date.now());
  const s = st.snapshot;
  const dot = (ok: boolean | null) => (ok === null ? "⚪" : ok ? "🟢" : "🔴");
  const L = [
    "🚦 <b>SYSTEM HEALTH & VPS</b>",
    `${dot(st.status === "NO_DATA" ? null : st.status === "ONLINE")} Engine: <b>${st.status}</b>`,
    `💓 Heartbeat: ${st.heartbeat_at ? `${WIB(st.heartbeat_at)} (${age(st.heartbeat_age_ms ?? 0)} lalu) · ${st.data}` : "UNKNOWN"}`,
  ];
  if (s) {
    L.push(
      `${dot(s.mt5 === "UNKNOWN" ? null : s.mt5 === "CONNECTED")} MT5: ${s.mt5}`,
      `${dot(s.engine_reachable)} Engine Host terjangkau: ${s.engine_reachable ? "Ya" : "Tidak"}`,
      `🛡 Shadow Guard: ${s.shadow} · Kill switch: ${s.kill_switch ? "ON" : "OFF"}`,
      `⚙️ Mode: ${s.mode} · Eksekusi: ${s.execution} · Sinyal: ${s.signal}`,
      `🕒 Engine cek: ${s.engine_checked_at ? WIB(s.engine_checked_at) : "UNKNOWN"}${s.stale ? " · STALE" : ""}`,
    );
    if (s.blockers.length) L.push(`⛔ Blocker: ${esc(s.blockers.join(", "))}`);
  }
  for (const sym of ["XAUUSD", "BTCUSD"] as const) {
    const m = await latestMemory(sym);
    L.push(`📡 ${sym} data terakhir: ${m ? `${WIB(Date.parse(m.m5_close_at))} (${age(now - Date.parse(m.m5_close_at))} lalu)` : "UNKNOWN"}`);
  }
  L.push("", "<i>Read-only status relay. Tidak ada kontrol dari Telegram.</i>");
  return L.join("\n");
}

export async function renderCockpit(action: CockpitAction, now: number): Promise<string> {
  switch (action) {
    case "XAU": return radarCard("XAUUSD", now);
    case "BTC": return radarCard("BTCUSD", now);
    case "SETUP": return setupsCard(now);
    case "LAB": return labCard(now, false);
    case "AUDIT": return labCard(now, true);
    case "HEALTH": return healthCard(now);
  }
}
