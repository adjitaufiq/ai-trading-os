import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time, UTCTimestamp } from "lightweight-charts";
import { snrZoneLabel, type SnrZone, type SnrSwing } from "@/lib/snrOverlay";

type Palette = { support: string; resistance: string; supportFill: string; resistanceFill: string; background?: string };

/** Price/time-to-pixel projection only. Bands below candles; labels and confirmed swings above. */
export class SnrZonesPrimitive implements ISeriesPrimitive<Time> {
  private attachment: SeriesAttachedParameter<Time> | null = null;
  private zones: readonly SnrZone[] = [];
  private swings: readonly SnrSwing[] = [];
  private digits: number | null = null;
  constructor(private readonly palette: Palette) {}
  attached(attachment: SeriesAttachedParameter<Time>) { this.attachment = attachment; }
  detached() { this.attachment = null; }
  setZones(zones: readonly SnrZone[], digits: number | null = null) { this.zones = zones; this.digits = digits; this.attachment?.requestUpdate(); }
  setSwings(swings: readonly SnrSwing[]) { this.swings = swings; this.attachment?.requestUpdate(); }
  paneViews(): readonly IPrimitivePaneView[] {
    return [
      { zOrder: () => "bottom", renderer: () => ({ draw: (target) => this.draw(target, false) }) },
      { zOrder: () => "top", renderer: () => ({ draw: (target) => this.draw(target, true) }) },
    ];
  }
  private draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0], labels: boolean) {
    const attachment = this.attachment;
    if (!attachment) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      context.font = "10px monospace";
      const occupied: { x: number; y: number; width: number; height: number }[] = [];
      const label = (text: string, x: number, y: number, color: string) => {
        const width = context.measureText(text).width + 10;
        if (width > mediaSize.width - 8 || y < 0 || y + 18 > mediaSize.height) return;
        const left = Math.max(4, Math.min(x, mediaSize.width - width - 4));
        if (occupied.some((r) => left < r.x + r.width && left + width > r.x && y < r.y + r.height && y + 18 > r.y)) return;
        occupied.push({ x: left, y, width, height: 18 });
        if (this.palette.background) { context.fillStyle = this.palette.background; context.fillRect(left, y, width, 18); }
        context.fillStyle = color;
        context.textBaseline = "middle";
        context.fillText(text, left + 5, y + 9);
      };
      // Higher timeframes get first claim on label space; exact host ranges never shift.
      for (const zone of this.zones) {
        const high = attachment.series.priceToCoordinate(zone.high);
        const low = attachment.series.priceToCoordinate(zone.low);
        if (high == null || low == null) continue;
        const top = Math.min(high, low), bottom = Math.max(high, low);
        if (bottom < 0 || top > mediaSize.height) continue;
        const support = zone.type === "SUPPORT";
        const color = support ? this.palette.support : this.palette.resistance;
        const left = zone.timeframe === "M15" ? mediaSize.width * 0.55 : 0;
        if (labels) {
          label(snrZoneLabel(zone, this.digits), mediaSize.width - context.measureText(snrZoneLabel(zone, this.digits)).width - 18, Math.max(2, top - 20), color);
          continue;
        }
        if (zone.timeframe !== "H1") {
          context.fillStyle = support ? this.palette.supportFill : this.palette.resistanceFill;
          context.fillRect(left, top, mediaSize.width - left, Math.max(1, bottom - top));
        }
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.setLineDash(zone.timeframe === "H4" ? [] : zone.timeframe === "H1" ? [6, 4] : [2, 4]);
        context.beginPath();
        context.moveTo(left, top); context.lineTo(mediaSize.width, top);
        context.moveTo(left, bottom); context.lineTo(mediaSize.width, bottom);
        context.stroke();
      }
      if (labels) for (const swing of this.swings) {
        const x = attachment.chart.timeScale().timeToCoordinate((swing.pivot_time / 1000) as UTCTimestamp);
        const y = attachment.series.priceToCoordinate(swing.price);
        if (x == null || y == null || x < 0 || x > mediaSize.width || y < 0 || y > mediaSize.height) continue;
        const high = swing.kind === "HIGH";
        context.fillStyle = high ? this.palette.resistance : this.palette.support;
        context.beginPath();
        context.moveTo(x, y); context.lineTo(x - 4, y + (high ? -6 : 6)); context.lineTo(x + 4, y + (high ? -6 : 6)); context.closePath(); context.fill();
        label(`${high ? "Swing High" : "Swing Low"} ${swing.timeframe}`, x - 45, y + (high ? -26 : 8), context.fillStyle as string);
      }
      context.restore();
    });
  }
}
