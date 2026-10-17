// Desktop cockpit projection (PC/laptop only). Pure field copy of the same snapshot the mobile view reads
// (MobileTerminalContext report) — never computes indicators, direction, plans or execution state.
import { useEffect, useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { useMobileTerminal } from "./MobileTerminalContext";
import { Direction, Lamp, mobileLamps } from "./MobileTradingView";
import { setupStatus } from "@/lib/setupStatus";
import { resolveMarketSession } from "@/core/temporal/MarketSessionResolver";
import type { ExeLamp } from "@/lib/exeLamp";

const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2));
const text = (v: string | null | undefined) => v?.replaceAll("_", " ") ?? "—";
const tone = { healthy: "text-bull", waiting: "text-warn", attention: "text-bear", unknown: "text-muted-foreground" } as const;
const FRAMES = ["H4", "H1", "M15", "M5"] as const;

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-md border border-border bg-card/40 p-3 ${className}`}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-primary">{title}</h2>
      {children}
    </section>
  );
}

export function DesktopHeaderStrip({ symbol, engineStatus, exe }: { symbol: string; engineStatus: string; exe: ExeLamp | null }) {
  const m = useMobileTerminal();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = m?.report?.snapshot ?? null;
  const lamps = mobileLamps(s, m?.report?.facts ?? null, engineStatus, !!m?.observation?.connected, exe);
  const session = resolveMarketSession(now, symbol === "BTCUSD" ? "CRYPTO" : "COMMODITY");
  const bias = s?.primary_bias;
  const wib = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "medium" }).format(now);
  return (
    <div className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))_auto] items-stretch gap-2 py-2" data-testid="desktop-header-strip">
      <div className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-3">
        <span className="font-mono text-2xl font-bold">{symbol}</span>
        <span className="text-xs text-muted-foreground">{symbol === "XAUUSD" ? "GOLD / USD" : "BITCOIN / USD"}</span>
      </div>
      <div className="rounded-md border border-border bg-card/40 px-3 py-2">
        <div className="text-[10px] text-muted-foreground">BIAS · H4 (PRIMARY)</div>
        <div className={`font-mono text-lg font-semibold ${bias === "BUY" ? "text-bull" : bias === "SELL" ? "text-bear" : "text-muted-foreground"}`}>
          {bias === "BUY" ? "↗ BULLISH" : bias === "SELL" ? "↘ BEARISH" : "— NONE"}
        </div>
        {s && s.counter_trend_condition !== "NONE" ? <div className="text-[10px] text-warn">{text(s.counter_trend_condition)}</div> : null}
      </div>
      <div className="rounded-md border border-border bg-card/40 px-3 py-2">
        <div className="text-[10px] text-muted-foreground">SESSION (UTC kalender)</div>
        <div className="font-mono text-lg font-semibold">{text(session)}</div>
        <div className="text-[10px] text-muted-foreground">Regime {text(s?.operator?.regime)}</div>
      </div>
      <div className="flex min-w-0 items-center rounded-md border border-border bg-card/40" title={lamps.map((l) => `${l.label}: ${l.detail}`).join("\n")}>
        {lamps.map((l) => <Lamp key={l.label} label={l.label} tone={l.tone} />)}
      </div>
      <div className="flex flex-col justify-center rounded-md border border-border bg-card/40 px-3 text-right">
        <div className="font-mono text-sm">{wib}</div>
        <div className="text-[10px] text-muted-foreground">WIB</div>
      </div>
    </div>
  );
}

export function DesktopSidePanel({ exe }: { exe?: ExeLamp | null }) {
  const m = useMobileTerminal();
  const s = m?.report?.snapshot ?? null;
  const op = s?.availability === "AVAILABLE" ? s.operator : null;
  const ev = s?.availability === "AVAILABLE" ? s.evidence : null;
  const st = setupStatus(s, exe ?? null);
  return (
    <div className="space-y-3" data-testid="desktop-side-panel">
      <Card title="Market map (HTF view)">
        <div className="grid grid-cols-4 gap-2">
          {FRAMES.map((tf) => (
            <div key={tf} className="min-w-0 rounded border border-border px-1.5 py-2 text-center">
              <div className="text-[10px] text-muted-foreground">{tf}</div>
              <div className="mt-1 text-xs font-semibold"><Direction value={op?.per_tf[tf].trend} /></div>
              <div className="mt-1 break-words text-[10px] leading-tight text-muted-foreground [overflow-wrap:anywhere]">{text(ev?.[tf].structure.summary)}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1.5 text-xs">
          <div className="flex justify-between gap-2"><span className="text-bear">RESISTANCE</span><span className="font-mono">{fmt(op?.nearest_resistance?.high)} – {fmt(op?.nearest_resistance?.low)} <small className="text-muted-foreground">{op?.nearest_resistance?.source_tf}</small></span></div>
          <div className="flex justify-between gap-2"><span className="text-bull">SUPPORT</span><span className="font-mono">{fmt(op?.nearest_support?.low)} – {fmt(op?.nearest_support?.high)} <small className="text-muted-foreground">{op?.nearest_support?.source_tf}</small></span></div>
          <div className="flex justify-between gap-2 text-muted-foreground"><span>ALIGNMENT</span><span className="text-right">{text(op?.alignment)}</span></div>
          <div className="flex justify-between gap-2 text-muted-foreground"><span>ATR14 M15 · RSI14 H1</span><span className="font-mono">{ev?.M15.atr14.status === "OK" ? fmt(ev.M15.atr14.value) : "—"} · {ev?.H1.rsi14.status === "OK" ? fmt(ev.H1.rsi14.value) : "—"}</span></div>
        </div>
      </Card>
      <Card title="Trade plan">
        <div className={`text-xs font-semibold ${tone[st.tone]}`} data-testid="desktop-setup-status">{st.label}</div>
        <p className="mt-1 break-words text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
          {st.reason}{st.plan ? ` · sumber ${st.plan.source === "REFERENCE_PLAN" ? "plan eksekusi" : "proyeksi radar"}` : ""}
        </p>
        <table className="mt-2 w-full text-xs">
          <tbody className="divide-y divide-border">
            {([
              ["DIRECTION", st.plan?.source === "REFERENCE_PLAN" && s?.reference_plan.status === "AVAILABLE" ? <Direction value={s.reference_plan.side} /> : "—", ""],
              ["ENTRY", fmt(st.plan?.entry), ""],
              ["STOP LOSS", fmt(st.plan?.sl), "text-bear"],
              ["TP1", fmt(st.plan?.tp1), "text-bull"],
              ["TP2", fmt(st.plan?.tp2), "text-bull"],
              ["R:R", st.plan?.final_rr != null ? `1:${fmt(st.plan.final_rr)}` : "—", ""],
            ] as const).map(([k, v, c]) => (
              <tr key={k}><td className="py-1.5 text-muted-foreground">{k}</td><td className={`py-1.5 text-right font-mono ${c}`}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function DesktopChecklist() {
  const m = useMobileTerminal();
  const s = m?.report?.snapshot ?? null;
  const why = s?.why ?? [];
  return (
    <Card title={`Execution checklist · ${s?.signal.state === "READY" ? "READY" : "WAIT"}`}>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 xl:grid-cols-2">
        {why.length ? why.map((f, i) => (
          <li key={i} className="flex min-w-0 items-start gap-2 text-xs">
            <span className={`mt-0.5 shrink-0 ${f.ok === true ? "text-bull" : f.ok === false ? "text-bear" : "text-muted-foreground"}`}>
              {f.ok === true ? <Check className="size-4" /> : f.ok === false ? <X className="size-4" /> : <Minus className="size-4" />}
            </span>
            <span className="min-w-0 flex-1 break-words leading-relaxed [overflow-wrap:anywhere]">{text(f.text)}</span>
          </li>
        )) : <li className="text-xs text-muted-foreground">— Belum dievaluasi</li>}
      </ul>
    </Card>
  );
}
