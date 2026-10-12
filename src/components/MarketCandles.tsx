import { memo, useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BridgeBar } from "@/core/broker/gateway/types";
import type { SnrZone, SnrSwing } from "@/lib/snrOverlay";
import { SnrZonesPrimitive } from "@/components/SnrZonesPrimitive";
import { Minus, Plus, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { preserveChartRange, zoomChartRange } from "@/lib/chartViewport";

export interface MarketCandlesProps {
  bars: readonly BridgeBar[];
  digits: number;
  onInspect: (bar: BridgeBar | null) => void;
  onActivate: () => void;
  focus: boolean;
  snrZones?: readonly SnrZone[] | undefined;
  snrSwings?: readonly SnrSwing[] | undefined;
  annotationsVisible?: boolean;
}

function MarketCandlesView({ bars, digits, onInspect, onActivate, focus, snrZones, snrSwings, annotationsVisible = false }: MarketCandlesProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlay = useRef<SnrZonesPrimitive | null>(null);
  const barsRef = useRef(bars);
  const inspectRef = useRef(onInspect);
  const activateRef = useRef(onActivate);
  const focusRef = useRef(focus);
  const previousBars = useRef<readonly BridgeBar[]>([]);
  const initialized = useRef(false);
  barsRef.current = bars;
  inspectRef.current = onInspect;
  activateRef.current = onActivate;
  focusRef.current = focus;

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    // Canvas chart parsers require sRGB colors, not unresolved oklch tokens.
    const color = (name: string) => getComputedStyle(el).getPropertyValue(name).trim();
    const c = createChart(el, {
      autoSize: true,
      localization: { locale: "en-US" },
      layout: { background: { type: ColorType.Solid, color: color("--canvas-background") }, textColor: color("--canvas-foreground"), attributionLogo: true },
      grid: { vertLines: { color: color("--canvas-grid") }, horzLines: { color: color("--canvas-grid") } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: color("--canvas-border"), minimumWidth: 72 },
      timeScale: { borderColor: color("--canvas-border"), timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 9, minBarSpacing: 3 },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: color("--canvas-up"), downColor: color("--canvas-down"),
      borderUpColor: color("--canvas-up"), borderDownColor: color("--canvas-down"),
      wickUpColor: color("--canvas-up"), wickDownColor: color("--canvas-down"),
    });
    chart.current = c;
    series.current = s;
    const snr = new SnrZonesPrimitive({ support: color("--canvas-up"), resistance: color("--canvas-down"), supportFill: color("--canvas-snr-support-fill"), resistanceFill: color("--canvas-snr-resistance-fill"), background: color("--canvas-background") });
    s.attachPrimitive(snr);
    overlay.current = snr;
    const inspect = (param: MouseEventParams<Time>) => {
      if (param.time == null) { inspectRef.current(null); return; }
      inspectRef.current(barsRef.current.find((bar) => bar.raw_time_s === param.time) ?? null);
    };
    const click = (param: MouseEventParams<Time>) => {
      inspect(param);
      if (!focusRef.current) activateRef.current();
    };
    c.subscribeCrosshairMove(inspect);
    c.subscribeClick(click);
    const observer = new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight) c.resize(el.clientWidth, el.clientHeight);
    });
    observer.observe(el);
    return () => { observer.disconnect(); c.unsubscribeCrosshairMove(inspect); c.unsubscribeClick(click); s.detachPrimitive(snr); overlay.current = null; c.remove(); chart.current = null; series.current = null; };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const scale = chart.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    s.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    s.setData(bars.map((b) => ({ time: b.raw_time_s as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    if (!initialized.current && bars.length) {
      scale?.fitContent(); initialized.current = true;
    } else if (range) {
      scale?.setVisibleLogicalRange(preserveChartRange(range, previousBars.current, bars));
    }
    previousBars.current = bars;
  }, [bars, digits]);

  useEffect(() => { overlay.current?.setZones(snrZones ?? [], digits); overlay.current?.setSwings(snrSwings ?? []); overlay.current?.setAnnotationsVisible(annotationsVisible); }, [snrZones, snrSwings, digits, annotationsVisible]);

  const zoom = (direction: "in" | "out") => {
    const c = chart.current;
    const range = c?.timeScale().getVisibleLogicalRange();
    if (!c || !range || !bars.length) return;
    c.priceScale("right").applyOptions({ autoScale: true });
    c.timeScale().setVisibleLogicalRange(zoomChartRange(range, bars.length, direction));
  };
  const reset = () => {
    chart.current?.priceScale("right").applyOptions({ autoScale: true });
    chart.current?.timeScale().fitContent();
  };
  return <div className="relative h-full w-full">
    <div ref={container} className="h-full w-full" data-testid="market-chart" data-candles={bars.length} data-snr-zones={snrZones?.length ?? 0} data-snr-swings={snrSwings?.length ?? 0} data-snr-annotations={annotationsVisible} aria-label="Broker candlestick chart" />
    <div role="group" aria-label="Zoom grafik" className="absolute bottom-9 left-2 z-10 flex gap-1 border border-border bg-background/95 p-1">
      <Button size="icon" variant="ghost" aria-label="Zoom in" title="Zoom in" onClick={() => zoom("in")}><Plus /></Button>
      <Button size="icon" variant="ghost" aria-label="Zoom out" title="Zoom out" onClick={() => zoom("out")}><Minus /></Button>
      <Button size="icon" variant="ghost" aria-label="Reset view" title="Reset view" onClick={reset}><Scan /></Button>
    </div>
  </div>;
}

export const MarketCandles = memo(MarketCandlesView);