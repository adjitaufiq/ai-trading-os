import type { MarketEvent } from "../contracts";

/** 2026-01-05 08:00:00 UTC — aligned to an M5 boundary. */
export const FIXTURE_START = Date.UTC(2026, 0, 5, 8, 0, 0);

const S = 1000;
// [offset of event_at from start (s), bid, spread, observe delay (ms), ingest delay (ms)]
const RAW: [number, number, number, number, number][] = [
  [0, 2345.1, 0.18, 12, 3],
  [45, 2345.6, 0.2, 10, 4],
  [120, 2344.9, 0.19, 15, 2],
  [210, 2346.2, 0.22, 9, 5],
  [299, 2346.0, 0.21, 11, 3], // last tick of bar 08:00
  [301, 2346.4, 0.2, 14, 2], // crosses boundary → bar 08:00 CLOSED
  [380, 2347.1, 0.23, 8, 4],
  [470, 2346.5, 0.2, 12, 3],
  [560, 2347.8, 0.24, 10, 6],
  [610, 2348.0, 0.25, 13, 2], // crosses boundary → bar 08:05 CLOSED
  [700, 2347.4, 0.21, 9, 3],
];

export const xauusdTemporalFixture: readonly MarketEvent[] = Object.freeze(
  RAW.map(([off, bid, spread, obs, ing], seq) => {
    const event_at = FIXTURE_START + off * S;
    const observed_at = event_at + obs;
    return Object.freeze<MarketEvent>({
      seq,
      symbol: "XAUUSD",
      source: "REPLAY_FIXTURE",
      bid,
      ask: +(bid + spread).toFixed(2),
      spread,
      event_at,
      observed_at,
      ingested_at: observed_at + ing,
    });
  }),
);
