// In-app SIGNAL READY radar (UI notification history). Frontend-only: works only while the page runtime is alive.
// Observes ENGINE signals only; never sees paper/manual clicks; has no broker/gateway/order import.
import type { TradingSnapshot } from "@/core/technical/tradingState";
import { engineSignalOf, type EngineSignal } from "@/lib/tradeSummary";
import type { KV } from "@/lib/paperJournal";

export const ALERTS_KEY = "signal-alerts-v1";
export const ALERTS_MAX = 100;
export type AlertAlignment = "WITH MACRO" | "COUNTER MACRO" | "NEUTRAL MACRO" | null;

export interface SignalAlert {
  readonly id: string;
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly from: EngineSignal;
  readonly alignment: AlertAlignment;
  readonly created_at: number;
  readonly entry: number | null;
  readonly sl: number | null;
  readonly tp1: number | null;
  readonly tp2: number | null;
  readonly reason: string;
  readonly read: boolean;
}

const ALIGN: Record<string, AlertAlignment> = { WITH_MACRO: "WITH MACRO", COUNTER_MACRO: "COUNTER MACRO", NEUTRAL_MACRO: "NEUTRAL MACRO" };

export function buildAlert(s: TradingSnapshot, symbol: string, side: "BUY" | "SELL", from: EngineSignal, now: number, id: string): SignalAlert {
  const plan = s.reference_plan.status === "AVAILABLE" && s.reference_plan.side === side ? s.reference_plan : null;
  const entry = plan?.entry ?? (side === "BUY" ? s.quote?.ask : s.quote?.bid) ?? null;
  const trig = s.operator?.trigger_bar ? `${s.operator.trigger_bar.timeframe} ${s.operator.trigger_bar.patterns.join("+")}` : s.signal.reason;
  return { id, symbol, side, from, alignment: ALIGN[s.operator?.alignment ?? ""] ?? null, created_at: now, entry,
    sl: plan?.sl ?? null, tp1: plan?.tp1 ?? null, tp2: plan?.tp2 ?? null, reason: String(trig).slice(0, 160), read: false };
}

const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));
export const alertTitle = (a: SignalAlert) => `SIGNAL READY · ${a.symbol}`;
export const alertHeadline = (a: SignalAlert) => `${a.side} SCALP${a.alignment ? ` · ${a.alignment}` : ""}`;
export const alertLevels = (a: SignalAlert) => `Entry ${fmt(a.entry)} · SL ${fmt(a.sl)} · TP1 ${fmt(a.tp1)} · TP2 ${fmt(a.tp2)}`;
export const notificationBody = (a: SignalAlert) => `${alertHeadline(a)} · Entry ${fmt(a.entry)} · SL ${fmt(a.sl)} · TP2 ${fmt(a.tp2)}`;

export class SignalAlertStore {
  private alerts: SignalAlert[] = [];
  /** Per-runtime-session baseline (NOT persisted): a reload never rings for an already-existing signal. */
  private last = new Map<string, EngineSignal>();
  private listeners = new Set<() => void>();
  private seq = 0;
  constructor(private readonly kv: KV | null) {
    try { const raw = kv?.getItem(ALERTS_KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) this.alerts = p.slice(0, ALERTS_MAX); } } catch { /* corrupt ⇒ empty */ }
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getAlerts = () => this.alerts;
  unreadCount() { return this.alerts.filter((a) => !a.read).length; }
  private commit(next: SignalAlert[]) {
    this.alerts = next.slice(0, ALERTS_MAX);
    try { this.kv?.setItem(ALERTS_KEY, JSON.stringify(this.alerts)); } catch { /* quota: memory only */ }
    for (const l of this.listeners) l();
  }

  /** Feed one ENGINE snapshot. Returns a new alert only on a fresh transition INTO BUY/SELL after the baseline. */
  observe(s: TradingSnapshot | null, symbol: string, now: number): SignalAlert | null {
    if (!s || s.availability === "UNAVAILABLE") return null;
    const to = engineSignalOf(s), from = this.last.get(symbol);
    this.last.set(symbol, to);
    if (from === undefined || from === to || to === "HOLD") return null;
    const alert = buildAlert(s, symbol, to, from, now, `alert-${now}-${++this.seq}`);
    this.commit([alert, ...this.alerts]);
    return alert;
  }
  markRead(id: string) { this.commit(this.alerts.map((a) => (a.id === id ? { ...a, read: true } : a))); }
  markAllRead() { this.commit(this.alerts.map((a) => (a.read ? a : { ...a, read: true }))); }
  clearRead() { this.commit(this.alerts.filter((a) => !a.read)); }
}

let shared: SignalAlertStore | null = null;
export function sharedSignalAlerts(): SignalAlertStore {
  if (!shared) shared = new SignalAlertStore(typeof window !== "undefined" ? window.localStorage : null);
  return shared;
}

// ---------------- audio alarm (Web Audio, generated beeps, needs explicit user unlock) ----------------
export const ALARM_PREF_KEY = "signal-alarm-pref-v1";
export type AlarmStatus = "OFF" | "ACTIVE" | "MUTED" | "NEEDS_REUNLOCK" | "UNAVAILABLE";
type Ctx = { state: string; currentTime: number; destination: unknown; resume(): Promise<void>; createOscillator(): any; createGain(): any };

export class AlarmController {
  private ctx: Ctx | null = null;
  private muted: boolean;
  private enabledPref: boolean;
  private needsReunlock = false;
  private listeners = new Set<() => void>();
  constructor(private readonly makeCtx: (() => Ctx) | null, private readonly kv: KV | null) {
    let p = { enabled: false, muted: false };
    try { const raw = kv?.getItem(ALARM_PREF_KEY); if (raw) p = { ...p, ...JSON.parse(raw) }; } catch { /* ignore */ }
    this.enabledPref = p.enabled; this.muted = p.muted;
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  private emit() { try { this.kv?.setItem(ALARM_PREF_KEY, JSON.stringify({ enabled: this.enabledPref, muted: this.muted })); } catch { /* ignore */ } for (const l of this.listeners) l(); }
  status = (): AlarmStatus => {
    if (!this.makeCtx) return "UNAVAILABLE";
    if (!this.enabledPref) return "OFF";
    if (this.muted) return "MUTED";
    if (!this.ctx || this.needsReunlock) return "NEEDS_REUNLOCK";
    return "ACTIVE";
  };
  /** MUST be called from a user gesture. */
  async enable(): Promise<AlarmStatus> {
    if (!this.makeCtx) return "UNAVAILABLE";
    try {
      this.ctx ??= this.makeCtx();
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.enabledPref = true; this.needsReunlock = this.ctx.state !== "running";
    } catch { this.enabledPref = true; this.needsReunlock = true; }
    this.emit();
    return this.status();
  }
  setMuted(m: boolean) { this.muted = m; this.emit(); }
  /** Short distinctive pattern; never loops. Returns true when sound was scheduled. */
  play(side: "BUY" | "SELL"): boolean {
    if (this.status() !== "ACTIVE" || !this.ctx) return false;
    if (this.ctx.state !== "running") { this.needsReunlock = true; this.emit(); return false; }
    try {
      const freqs = side === "BUY" ? [880, 1175, 1568] : [1568, 1175, 880];
      const t0 = this.ctx.currentTime;
      freqs.forEach((f, i) => {
        const o = this.ctx!.createOscillator(), g = this.ctx!.createGain();
        o.type = "square"; o.frequency.value = f;
        const t = t0 + i * 0.14;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        o.connect(g); g.connect(this.ctx!.destination); o.start(t); o.stop(t + 0.12);
      });
      return true;
    } catch { this.needsReunlock = true; this.emit(); return false; }
  }
}

export function browserAlarm(): AlarmController {
  const W = typeof window !== "undefined" ? (window as any) : null;
  const AC = W?.AudioContext ?? W?.webkitAudioContext;
  return new AlarmController(AC ? () => new AC() : null, W?.localStorage ?? null);
}

// ---------------- optional native notification (page must be alive) ----------------
export type NotifyPermission = "GRANTED" | "DENIED" | "NOT_SET" | "UNAVAILABLE";
export interface NotificationApi { permission: string; requestPermission(): Promise<string>; new (title: string, opts?: { body?: string; tag?: string }): { onclick: (() => void) | null } }

export function notifyPermission(api: NotificationApi | null): NotifyPermission {
  try { if (!api) return "UNAVAILABLE"; return api.permission === "granted" ? "GRANTED" : api.permission === "denied" ? "DENIED" : "NOT_SET"; } catch { return "UNAVAILABLE"; }
}
export async function requestNotify(api: NotificationApi | null): Promise<NotifyPermission> {
  if (!api) return "UNAVAILABLE";
  try { await api.requestPermission(); } catch { /* denied/unsupported */ }
  return notifyPermission(api);
}
/** Never throws. Returns true when a notification was shown. */
export function showNativeNotification(api: NotificationApi | null, a: SignalAlert, onClick?: () => void): boolean {
  if (notifyPermission(api) !== "GRANTED") return false;
  try {
    const n = new api!(alertTitle(a), { body: notificationBody(a), tag: a.id });
    n.onclick = () => { try { (globalThis as any).focus?.(); } catch { /* ignore */ } onClick?.(); };
    return true;
  } catch { return false; }
}
export function browserNotificationApi(): NotificationApi | null {
  return typeof window !== "undefined" && "Notification" in window ? ((window as any).Notification as NotificationApi) : null;
}
