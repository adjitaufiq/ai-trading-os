import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { SnrZone } from "@/lib/snrOverlay";

type Palette = { support: string; resistance: string; supportFill: string; resistanceFill: string };

/** Price-to-pixel projection only; bands stay underneath candles and track zoom/pan automatically. */
export class SnrZonesPrimitive implements ISeriesPrimitive<Time> {
  private attachment: SeriesAttachedParameter<Time> | null = null;
  private zones: readonly SnrZone[] = [];
  constructor(private readonly palette: Palette) {}
  attached(attachment: SeriesAttachedParameter<Time>) { this.attachment = attachment; }
  detached() { this.attachment = null; }
  setZones(zones: readonly SnrZone[]) { this.zones = zones; this.attachment?.requestUpdate(); }
  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => "bottom", renderer: () => ({ draw: (target) => this.draw(target) }) }];
  }
  private draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    const series = this.attachment?.series;
    if (!series) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      for (const zone of this.zones) {
        const high = series.priceToCoordinate(zone.high);
        const low = series.priceToCoordinate(zone.low);
        if (high == null || low == null) continue;
        const top = Math.min(high, low), bottom = Math.max(high, low);
        if (bottom < 0 || top > mediaSize.height) continue;
        const support = zone.type === "SUPPORT";
        context.fillStyle = support ? this.palette.supportFill : this.palette.resistanceFill;
        context.fillRect(0, top, mediaSize.width, Math.max(1, bottom - top));
        context.strokeStyle = support ? this.palette.support : this.palette.resistance;
        context.lineWidth = 1;
        context.setLineDash(zone.timeframe === "H4" ? [] : zone.timeframe === "H1" ? [6, 4] : [2, 4]);
        context.beginPath();
        context.moveTo(0, top); context.lineTo(mediaSize.width, top);
        context.moveTo(0, bottom); context.lineTo(mediaSize.width, bottom);
        context.stroke();
      }
      context.restore();
    });
  }
}