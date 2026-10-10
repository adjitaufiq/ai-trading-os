import type { SnrSnapshot } from "@/lib/snrOverlay";

export function SnrOverlayLegend({ snapshot, digits, visible = true }: { snapshot: SnrSnapshot | null; digits: number | null; visible?: boolean }) {
  const format = (value: number) => digits == null ? String(value) : value.toFixed(digits);
  if (!visible) return null;
  if (!snapshot?.zones.length) return <div role="status" data-testid="snr-unavailable" className="py-2 text-xs text-muted-foreground">SNR unavailable</div>;
  return <div className="border-b border-border py-2 text-xs" aria-label="Auto-detected support/resistance overlay" data-testid="snr-legend">
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono tabular-nums">
      {snapshot.zones.map((zone, index) => <span key={`${zone.type}-${zone.timeframe}-${zone.low}-${zone.high}-${index}`} className={zone.type === "SUPPORT" ? "text-bull" : "text-bear"}>
        {zone.type === "SUPPORT" ? "Support" : "Resistance"} · {zone.timeframe} · {format(zone.low)}–{format(zone.high)}
      </span>)}
    </div>
    <div className="mt-1 text-[10px] text-muted-foreground">ENGINE HOST · Zone Strength: Under Calibration · RESEARCH_REQUIRED</div>
  </div>;
}