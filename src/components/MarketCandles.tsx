import { memo, useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BridgeBar } from "@/core/broker/gateway/types";
import type { SnrZone } from "@/lib/snrOverlay";
import { SnrZonesPrimitive } from "@/components/SnrZonesPrimitive";

export interface MarketCandlesProps {
  bars: readonly BridgeBar[];
  digits: number;
  onInspect: (bar: BridgeBar | null) => void;
  onActivate: () => void;
  focus: boolean;
  snrZones?: readonly SnrZone[];
}

function MarketCandlesView({ bars, digits, onInspect, onActivate, focus, snrZones }: MarketCandlesProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlay = useRef<SnrZonesPrimitive | null>(null);
  const barsRef = useRef(bars);
  const inspectRef = useRef(onInspect);
  const activateRef = useRef(onActivate);
  const focusRef = useRef(focus);
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
    const snr = new SnrZonesPrimitive({ support: color("--canvas-up"), resistance: color("--canvas-down"), supportFill: color("--canvas-snr-support-fill"), resistanceFill: color("--canvas-snr-resistance-fill") });
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
    s.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    s.setData(bars.map((b) => ({ time: b.raw_time_s as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    chart.current?.timeScale().fitContent();
  }, [bars, digits]);

  useEffect(() => { overlay.current?.setZones(snrZones ?? []); }, [snrZones]);

  useEffect(() => {
    if (focus) requestAnimationFrame(() => chart.current?.timeScale().fitContent());
  }, [focus]);

  return <div ref={container} className="h-full w-full" data-testid="market-chart" data-candles={bars.length} data-snr-zones={snrZones?.length ?? 0} aria-label="Broker candlestick chart" />;
}

export const MarketCandles = memo(MarketCandlesView);