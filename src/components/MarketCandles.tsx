import { memo, useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BridgeBar } from "@/core/broker/gateway/types";

export interface MarketCandlesProps {
  bars: readonly BridgeBar[];
  digits: number;
  onInspect: (bar: BridgeBar | null) => void;
  onActivate: () => void;
  focus: boolean;
}

function MarketCandlesView({ bars, digits, onInspect, onActivate, focus }: MarketCandlesProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
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
    const css = getComputedStyle(el);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: color("--background") }, textColor: color("--muted-foreground"), attributionLogo: true },
      grid: { vertLines: { color: color("--chart-grid") }, horzLines: { color: color("--chart-grid") } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: color("--border"), minimumWidth: 72 },
      timeScale: { borderColor: color("--border"), timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 9, minBarSpacing: 3 },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: color("--bull"), downColor: color("--bear"),
      borderUpColor: color("--bull"), borderDownColor: color("--bear"),
      wickUpColor: color("--bull"), wickDownColor: color("--bear"),
    });
    chart.current = c;
    series.current = s;
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
    return () => { observer.disconnect(); c.unsubscribeCrosshairMove(inspect); c.unsubscribeClick(click); c.remove(); chart.current = null; series.current = null; };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    s.setData(bars.map((b) => ({ time: b.raw_time_s as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    chart.current?.timeScale().fitContent();
  }, [bars, digits]);

  useEffect(() => {
    if (focus) requestAnimationFrame(() => chart.current?.timeScale().fitContent());
  }, [focus]);

  return <div ref={container} className="h-full w-full" data-testid="market-chart" data-candles={bars.length} aria-label="Broker candlestick chart" />;
}

export const MarketCandles = memo(MarketCandlesView);