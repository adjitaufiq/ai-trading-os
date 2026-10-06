// Deterministic synthetic M5 generator. Output is RAW payloads (source "MOCK")
// that still pass through M1B.1 validateAndNormalize — never injected as ArenaCandle.
import type { RawGatewayPayload } from "../core/normalizer/types";
import { ALL_SCENARIOS, STRESS_ENV as E, type MarketScenario } from "./types";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rnd: () => number) => {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface GeneratedBar { raw: RawGatewayPayload; scenario: MarketScenario }

export interface SegmentState { price: number; ts: number; i: number }

/** One scenario segment, continuing from `st` (mutated). */
export function generateSegment(symbol: string, scenario: MarketScenario, bars: number, rnd: () => number, st: SegmentState): GeneratedBar[] {
  const out: GeneratedBar[] = [];
  const dir = rnd() < 0.5 ? 1 : -1;
  const center = st.price;
  for (let k = 0; k < bars; k++, st.i++) {
    const o = st.price;
    let sigma = 0.8, mu = 0, spread = E.SPREAD_NORMAL + rnd() * 0.04, wickUp = 0, wickDn = 0;
    switch (scenario) {
      case "NORMAL_TREND": mu = dir * 0.12 + Math.sin(k / 30) * 0.3 * dir; break;
      case "RANGE_MARKET": mu = -0.03 * (o - center); break;
      case "HIGH_VOLATILITY":
        sigma = 2.4; spread = 0.25 + rnd() * 0.35;
        if (rnd() < 0.03) sigma *= 3;
        break;
      case "FALSE_BREAKOUT": {
        const ph = k % 80;
        mu = ph >= 60 && ph < 64 ? dir * 1.6 : ph >= 64 && ph < 70 ? -dir * 1.4 : -0.03 * (o - center);
        break;
      }
      case "LIQUIDITY_HUNT":
        mu = dir * 0.08;
        if (k % 45 === 44) { if (dir > 0) wickDn = 4 * sigma; else wickUp = 4 * sigma; }
        break;
      case "LOW_LIQUIDITY": sigma = 0.3; spread = 0.3 + rnd() * 0.1; break;
    }
    const c = Math.max(1, o + mu + sigma * gauss(rnd));
    const h = Math.max(o, c) + Math.abs(gauss(rnd)) * sigma * 0.5 + wickUp;
    const l = Math.max(0.5, Math.min(o, c) - Math.abs(gauss(rnd)) * sigma * 0.5 - wickDn);
    out.push({ scenario, raw: { symbol, timeframe: "M5", time: st.ts, open: r2(o), high: r2(Math.max(h, o, c)), low: r2(Math.min(l, o, c)), close: r2(c), volume: 100, spread: r2(spread), source: "MOCK" } });
    st.price = r2(c);
    st.ts += 300;
  }
  return out;
}

/** Path of consecutive segments; scenario order drawn from the PRNG. */
export function generatePath(symbol: string, seed: number, totalBars: number, scenarios: readonly MarketScenario[] = ALL_SCENARIOS): GeneratedBar[] {
  const rnd = mulberry32(seed);
  const st: SegmentState = { price: E.BASE_PRICE, ts: E.START_TS, i: 0 };
  const out: GeneratedBar[] = [];
  while (out.length < totalBars) {
    const sc = scenarios[Math.floor(rnd() * scenarios.length)]!;
    out.push(...generateSegment(symbol, sc, Math.min(E.SEGMENT_BARS, totalBars - out.length), rnd, st));
  }
  return out;
}
