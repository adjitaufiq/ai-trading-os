// Deterministic Stage 3.0B-1 bridge simulation. SIMULATION only; no real terminal.
import { BASE_BRIDGE_SCRIPT, BRIDGE_T0, BRIDGE_T0_S, type SyntheticBridgeScript } from "../../fixtures/syntheticBridgeFixture";
import { ReplayClock } from "../../temporal/CanonicalClock";
import { MockMT5BridgeClient } from "./MockMT5BridgeClient";
import type { BridgeEnvelope } from "./types";

export interface BridgeSimResult {
  readonly transcript: readonly BridgeEnvelope<unknown>[];
}

export function runBridgeSimulation(script: SyntheticBridgeScript = BASE_BRIDGE_SCRIPT): BridgeSimResult {
  const c = new MockMT5BridgeClient(script, new ReplayClock(BRIDGE_T0));
  const t: BridgeEnvelope<unknown>[] = [];
  t.push(c.health());
  t.push(c.terminalInfo());
  t.push(c.clockProbe());
  t.push(c.symbols("*XAU*"));
  t.push(c.resolveSymbol("XAUUSD", "*XAU*"));
  t.push(c.resolveSymbol("BTCUSD", "*BTC*"));
  t.push(c.ticks("XAUUSDm", BRIDGE_T0_S, BRIDGE_T0_S + 60, "LIVE"));
  t.push(c.bars("XAUUSDm", "M5", BRIDGE_T0_S, BRIDGE_T0_S + 1500));
  c.reconnect();
  t.push(c.health());
  t.push(c.bars("XAUUSDm", "M5", BRIDGE_T0_S, BRIDGE_T0_S + 900, "BACKFILL"));
  return { transcript: t };
}
