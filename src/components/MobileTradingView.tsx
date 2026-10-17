import { useState } from "react";
import { Check, X, Minus, Radar, Activity, ShieldCheck } from "lucide-react";
import { setupStatus } from "@/lib/setupStatus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useMobileTerminal } from "./MobileTerminalContext";
import type { TradingSnapshot } from "@/core/technical/tradingState";
import type { RuntimeFacts } from "@/lib/cockpitSource";
import type { ExeLamp } from "@/lib/exeLamp";
export type LampTone = "healthy" | "waiting" | "attention" | "unknown";
const toneClass = {
  healthy: "text-bull",
  waiting: "text-warn",
  attention: "text-bear",
  unknown: "text-muted-foreground",
};
const fmt = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(2);
const text = (v: string | null | undefined) => v?.replaceAll("_", " ") ?? "—";
export function mobileLamps(
  snapshot: TradingSnapshot | null,
  facts: RuntimeFacts | null,
  engineStatus: string,
  connected: boolean,
  exe?: ExeLamp | null,
) {
  const ev = snapshot?.availability === "AVAILABLE" ? snapshot.evidence : null;
  const indicatorTone = (status: string | undefined): LampTone =>
    status === "OK" ? "healthy" : "unknown";
  const checks = snapshot?.operator?.checks;
  return [
    {
      label: "FEED",
      tone: connected ? "healthy" : "attention",
      detail: connected ? "Feed broker tervalidasi" : "Feed belum terhubung / tidak terkini",
    },
    {
      label: "ENG",
      tone:
        engineStatus === "LIVE" && facts?.engineHealth?.state === "ONLINE"
          ? "healthy"
          : engineStatus === "OFFLINE"
            ? "attention"
            : "waiting",
      detail: `Engine Host ${engineStatus} · ${facts?.source ?? "belum tersedia"}`,
    },
    {
      label: "EMA",
      tone: indicatorTone(ev?.H1.ema21.status),
      detail: `EMA21 H1 ${ev?.H1.ema21.status ?? "belum dievaluasi"}`,
    },
    {
      label: "STR",
      tone: ev && ev.H1.structure.summary !== "INSUFFICIENT_HISTORY" ? "healthy" : "unknown",
      detail: text(ev?.H1.structure.summary),
    },
    {
      label: "SNR",
      tone: ev?.H1.snr ? "healthy" : "unknown",
      detail: `Lokasi ${text(snapshot?.operator?.location)}`,
    },
    {
      label: "RSI",
      tone: indicatorTone(ev?.H1.rsi14.status),
      detail: `RSI14 H1 ${ev?.H1.rsi14.status === "OK" ? fmt(ev.H1.rsi14.value) : "belum dievaluasi"} · gate ${checks?.rsi == null ? "—" : checks.rsi ? "✓" : "✗"}`,
    },
    {
      label: "ATR",
      tone: indicatorTone(ev?.M15.atr14.status),
      detail: `ATR14 M15 ${ev?.M15.atr14.status === "OK" ? fmt(ev.M15.atr14.value) : "belum dievaluasi"}`,
    },
    {
      label: "CND",
      tone: snapshot?.signal.state === "READY" ? "healthy" : ev ? "waiting" : "unknown",
      detail: text(snapshot?.signal.reason),
    },
    {
      label: "EXE",
      tone: exe?.tone ?? "unknown",
      detail: exe ? `${exe.label} · ${exe.detail}` : "EXE NOT CONNECTED · status eksekusi Engine Host belum tersedia",
    },
  ] as { label: string; tone: LampTone; detail: string }[];
}
export function Lamp({
  label,
  tone,
  onClick,
}: {
  label: string;
  tone: LampTone;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      title={`${label}: ${tone}`}
      aria-label={`${label}: ${tone}`}
      className={`h-12 min-w-0 flex-1 flex-col gap-1 rounded-none px-0 text-[9px] ${toneClass[tone]}`}
    >
      <span className={`mobile-lamp mobile-lamp-${tone}`} />
      <span>{label}</span>
    </Button>
  );
}
export function MobileTradingView({ onWhy, exe }: { onWhy: () => void; exe?: ExeLamp | null }) {
  const mobile = useMobileTerminal();
  if (!mobile) return null;
  const s = mobile.report?.snapshot ?? null;
  const op = s?.availability === "AVAILABLE" ? s.operator : null;
  const ev = s?.availability === "AVAILABLE" ? s.evidence : null;
  const st = setupStatus(s, exe);
  const frames = ["H4", "H1", "M15", "M5"] as const;
  const ready = s?.signal.state === "READY";
  const why = s?.why ?? [];
  if (mobile.tab === "RADAR")
    return (
      <div className="space-y-5 py-4">
        <h2 className="mobile-label">Matriks multi-timeframe</h2>
        <div className="grid grid-cols-4 divide-x divide-border border-y border-border py-4">
          {frames.map((tf) => (
            <div key={tf} className="min-w-0 text-center">
              <div className="mobile-label">{tf}</div>
              <Direction value={op?.per_tf[tf].trend} />
              <div className="mt-2 text-[10px] text-muted-foreground">
                {text(ev?.[tf].structure.summary)}
              </div>
            </div>
          ))}
        </div>
        <h3 className="mobile-label">Area terdekat</h3>
        {(
          [
            ["SUPPORT", op?.nearest_support],
            ["RESISTANCE", op?.nearest_resistance],
          ] as const
        ).map(([label, z]) => (
          <div key={label} className="flex justify-between border-b border-border pb-3">
            <span className={label === "SUPPORT" ? "text-bull" : "text-bear"}>{label}</span>
            <span className="font-mono text-sm">
              {fmt(z?.low)} – {fmt(z?.high)}{" "}
              <small className="text-muted-foreground">{z?.source_tf}</small>
            </span>
          </div>
        ))}
        <div className="text-xs text-muted-foreground">
          {text(op?.alignment)} · {text(mobile.report?.facts.radar?.horizon.marketApproach)}
        </div>
      </div>
    );
  if (mobile.tab === "ANALYSIS")
    return (
      <div className="space-y-5 py-4">
        <h2 className="mobile-label">Analisis teknikal · closed candles</h2>
        {frames.map((tf) => (
          <section key={tf} className="border-b border-border pb-4">
            <h3 className="mb-3 font-mono text-sm">{tf}</h3>
            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  ["EMA21", ev?.[tf].ema21],
                  ["EMA50", ev?.[tf].ema50],
                  ["RSI14", ev?.[tf].rsi14],
                  ["ATR14", ev?.[tf].atr14],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="mobile-label">
                    {k}{" "}
                    <span className={v?.status === "OK" ? "text-bull" : "text-muted-foreground"}>
                      ●
                    </span>
                  </div>
                  <div className="mt-2 font-mono text-sm">
                    {v?.status === "OK" ? fmt(v.value) : "—"}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              STR {text(ev?.[tf].structure.summary)}
            </div>
          </section>
        ))}
      </div>
    );
  return (
    <div className="space-y-3 pb-5">
      <section className="rounded-md border border-border bg-card/40 p-3" data-testid="mobile-market-map">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="mobile-label">Market map · struktur</h2>
          <span className="break-words text-[10px] text-muted-foreground [overflow-wrap:anywhere]">
            REGIME {text(op?.regime)}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {frames.map((tf) => (
            <div key={tf} className="min-w-0 rounded border border-border px-1.5 py-2 text-center">
              <div className="mobile-label">{tf}</div>
              <div className="mt-1 text-xs font-semibold">
                <Direction value={op?.per_tf[tf].trend} />
              </div>
              <div className="mt-1 break-words text-[10px] leading-tight text-muted-foreground [overflow-wrap:anywhere]">
                {text(ev?.[tf].structure.summary)}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-md border border-border bg-card/40 p-3">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="mobile-label">Primary bias · H4</h2>
          <span
            className={`font-mono text-base font-semibold ${s?.primary_bias === "BUY" ? "text-bull" : s?.primary_bias === "SELL" ? "text-bear" : "text-muted-foreground"}`}
            data-testid="mobile-primary-bias"
          >
            {s?.primary_bias === "BUY" ? "↗ BUY" : s?.primary_bias === "SELL" ? "↘ SELL" : "— NONE"}
          </span>
        </div>
        {s && s.counter_trend_condition !== "NONE" ? (
          <p className="mb-3 break-words text-[11px] font-semibold leading-snug text-warn [overflow-wrap:anywhere]" data-testid="mobile-counter-trend-warning">
            COUNTER TREND WARNING: {s.counter_trend_condition} — pullback melawan arah utama, bukan sinyal
          </p>
        ) : null}
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="mobile-label">Trade plan</h2>
          <span className={`break-words text-right text-[10px] font-semibold [overflow-wrap:anywhere] ${toneClass[st.tone]}`} data-testid="mobile-setup-status">
            {st.label}
          </span>
        </div>
        <p className="mb-3 break-words text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]" data-testid="mobile-setup-reason">
          {st.reason}
          {st.plan ? ` · sumber ${st.plan.source === "REFERENCE_PLAN" ? "plan eksekusi" : "proyeksi radar"}` : ""}
        </p>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["ENTRY", st.plan?.entry, ""],
              ["SL", st.plan?.sl, "text-bear"],
              ["TP1", st.plan?.tp1, "text-bull"],
              ["TP2", st.plan?.tp2, "text-bull"],
              ["R:R", st.plan?.final_rr, ""],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label} className="min-w-0 rounded border border-border px-2 py-2">
              <div className="mobile-label">{label}</div>
              <div className={`mt-1 break-all font-mono text-sm ${tone}`}>
                {label === "R:R" && value != null ? `1:${fmt(value)}` : fmt(value)}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-md border border-border bg-card/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="mobile-label">Checklist WHY · {ready ? "READY" : "WAIT"}</h2>
          <Button size="sm" variant="outline" onClick={onWhy}>
            Why?
          </Button>
        </div>
        <ul className="mt-3 space-y-2">
          {why.length ? (
            why.slice(0, 6).map((f, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2 text-xs">
                <span
                  className={`mt-0.5 shrink-0 ${
                    f.ok === true
                      ? "text-bull"
                      : f.ok === false
                        ? "text-bear"
                        : "text-muted-foreground"
                  }`}
                >
                  {f.ok === true ? (
                    <Check className="size-4" />
                  ) : f.ok === false ? (
                    <X className="size-4" />
                  ) : (
                    <Minus className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1 break-words leading-relaxed [overflow-wrap:anywhere]">
                  {text(f.text)}
                </span>
              </li>
            ))
          ) : (
            <li className="text-xs text-muted-foreground">— Belum dievaluasi</li>
          )}
        </ul>
      </section>
    </div>
  );
}
export function Direction({ value }: { value: string | undefined }) {
  return (
    <span
      className={
        value === "UP" || value === "BUY"
          ? "text-bull"
          : value === "DOWN" || value === "SELL"
            ? "text-bear"
            : "text-muted-foreground"
      }
    >
      {value === "UP" || value === "BUY"
        ? "↗ BUY"
        : value === "DOWN" || value === "SELL"
          ? "↘ SELL"
          : "—"}
    </span>
  );
}
export function MobileBottomNav({ engineStatus, exe, relay }: { engineStatus: string; exe?: ExeLamp | null; relay?: { text: string; online: boolean } | null }) {
  const m = useMobileTerminal();
  const [detail, setDetail] = useState(false);
  if (!m) return null;
  const s = m.report?.snapshot;
  const badge = setupStatus(s ?? null, exe);
  const icons = { TRADE: ShieldCheck, RADAR: Radar, ANALYSIS: Activity };
  const result =
    exe?.execution === "BLOCKED" ? "BLOCKED" : s?.signal.state === "READY" ? "READY" : "WAIT";
  const exeClass = exe?.tone === "healthy" ? "text-bull" : exe?.tone === "waiting" ? "text-warn" : exe?.tone === "attention" ? "text-bear" : relay ? (relay.online ? "text-warn" : "text-bear") : "text-muted-foreground";
  return (
    <>
      <div className="mobile-execution-bar">
        <span className={`shrink-0 ${exeClass}`}>● EXE</span>
        <span className="min-w-0 flex-1 break-words text-[10px] leading-snug text-muted-foreground [overflow-wrap:anywhere]" data-testid="mobile-engine-status">
          {(() => {
            const full = relay ? relay.text : exe ? `ENGINE ${exe.engine} · MODE ${exe.mode} · ${exe.execution}${exe.ageSec !== null ? ` · ${exe.ageSec}s` : ""}` : "NOT CONNECTED";
            const parts = full.split(" · ");
            const head = parts.slice(0, 2).join(" · ");
            const rest = parts.slice(2).join(" · ");
            return (
              <>
                <span className="block font-semibold text-foreground">{head}</span>
                {rest ? <span className="block">{rest}</span> : null}
              </>
            );
          })()}
        </span>
        <span
          role="status"
          data-testid="mobile-auto-exec-badge"
          className={`max-w-[42%] shrink-0 rounded-md border border-border px-2 py-1 text-right text-[10px] font-semibold leading-snug ${toneClass[badge.tone]}`}
        >
          {badge.badge}
        </span>
      </div>
      <nav aria-label="Navigasi mobile" className="mobile-bottom-nav">
        {(["TRADE", "RADAR", "ANALYSIS"] as const).map((t) => {
          const Icon = icons[t];
          return (
            <Button
              key={t}
              role="tab"
              aria-selected={m.tab === t && !m.accessory}
              variant="ghost"
              onClick={() => {
                m.setTab(t);
                m.setAccessory(null);
              }}
              className={`mobile-nav-button ${m.tab === t && !m.accessory ? "mobile-nav-active" : ""}`}
            >
              <Icon
                className={
                  t === "RADAR" &&
                  engineStatus === "LIVE" &&
                  m.report?.facts.radarHealth?.status === "ACTIVE"
                    ? "mobile-radar-sweep size-4"
                    : "size-4"
                }
              />
              <span>{t === "ANALYSIS" ? "ANALISIS" : t}</span>
              <small>
                {t === "TRADE"
                  ? result
                  : t === "RADAR"
                    ? text(s?.operator?.alignment)
                    : s?.operator?.macro.mtf.confidence != null
                      ? `${s.operator.macro.mtf.confidence}% MTF`
                      : "—"}
              </small>
            </Button>
          );
        })}
      </nav>
      <Dialog open={detail} onOpenChange={setDetail}>
        <DialogContent>
          <DialogTitle>Eksekusi</DialogTitle>
          <DialogDescription>MONITOR_ONLY</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}
