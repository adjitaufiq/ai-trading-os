import { useState } from "react";
import { Check, X, Minus, LockKeyhole, Radar, Activity, ShieldCheck } from "lucide-react";
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
export function MobileTradingView({ onWhy }: { onWhy: () => void }) {
  const mobile = useMobileTerminal();
  if (!mobile) return null;
  const s = mobile.report?.snapshot ?? null;
  const op = s?.availability === "AVAILABLE" ? s.operator : null;
  const ev = s?.availability === "AVAILABLE" ? s.evidence : null;
  const plan = s?.reference_plan.status === "AVAILABLE" ? s.reference_plan : null;
  const rp = s?.radar_plan?.status === "AVAILABLE" ? s.radar_plan : null;
  const values = plan ?? rp;
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
    <div className="space-y-4 pb-5">
      <div className="flex gap-5 overflow-x-auto border-y border-border py-3">
        {["MARKET", ...frames].map((tf) => (
          <div key={tf} className="shrink-0">
            <div className="mobile-label">{tf}</div>
            <div className="mt-1 text-xs">
              {tf === "MARKET" ? (
                text(op?.regime)
              ) : (
                <Direction value={op?.per_tf[tf as (typeof frames)[number]].trend} />
              )}
            </div>
          </div>
        ))}
      </div>
      <section className="rounded-md border border-border p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="mobile-label">Primary bias</h2>
          <span
            className={`font-mono text-sm font-semibold ${s?.primary_bias === "BUY" ? "text-bull" : s?.primary_bias === "SELL" ? "text-bear" : "text-muted-foreground"}`}
            data-testid="mobile-primary-bias"
          >
            {s?.primary_bias === "BUY" ? "↗ BUY" : s?.primary_bias === "SELL" ? "↘ SELL" : "— NONE"}
          </span>
        </div>
        {s && s.counter_trend_condition !== "NONE" ? (
          <p className="mb-3 text-[11px] font-semibold text-warn" data-testid="mobile-counter-trend-warning">
            COUNTER TREND WARNING: {s.counter_trend_condition} — pullback melawan arah utama, bukan sinyal
          </p>
        ) : null}
        <div className="mb-3 flex justify-between">
          <h2 className="mobile-label">Setup</h2>
          <span className={ready ? "text-bull text-[10px]" : "text-warn text-[10px]"}>
            {ready ? "READY" : "PROYEKSI"}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-x-4 gap-y-4">
          {(
            [
              ["ENTRY", plan?.entry ?? rp?.reference_entry],
              ["SL", values?.sl],
              ["TP1", values?.tp1],
              ["TP2", values?.tp2],
              ["R:R", values?.final_rr],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <div className="mobile-label">{label}</div>
              <div className="mt-1 font-mono text-base">
                {label === "R:R" && value != null ? `1:${fmt(value)}` : fmt(value)}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="flex items-center justify-between">
          <h2 className="mobile-label">WHY · {ready ? "READY" : "WAIT"}</h2>
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
        <Button disabled size="sm" variant="outline" className="h-8 shrink-0 text-xs">
          <LockKeyhole className="size-3" />
          Konfirmasi
        </Button>
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
