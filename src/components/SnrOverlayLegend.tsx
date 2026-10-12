import { snrZoneLabel, type SnrSnapshot, type SnrZone } from "@/lib/snrOverlay";

export function SnrOverlayLegend({ snapshot, zones, digits, visible = true }: { snapshot: SnrSnapshot | null; zones?: readonly SnrZone[]; digits: number | null; visible?: boolean }) {
  if (!visible) return null;
  if (!snapshot?.zones.length) return <div role="status" data-testid="snr-unavailable" className="py-2 text-xs text-muted-foreground">SNR unavailable</div>;
  const shown = zones ?? snapshot.zones;
  return <details className="border-b border-border py-2 text-xs" aria-label="Market structure zones" data-testid="snr-legend">
    <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">ENGINE HOST · SNR · {shown.length} ZONA</summary>
    <div className="mt-2 grid gap-x-5 gap-y-1 font-mono tabular-nums sm:grid-cols-2">
      {shown.map((zone, index) => <span key={`${zone.type}-${zone.timeframe}-${zone.low}-${zone.high}-${index}`} className={zone.type === "SUPPORT" ? "text-bull" : "text-bear"}>{snrZoneLabel(zone, digits)}</span>)}
    </div>
  </details>;
}
