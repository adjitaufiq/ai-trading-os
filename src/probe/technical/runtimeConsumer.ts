// v1b application-wiring consumer: reads ONLY the canonical runtime's read model. DIAGNOSTIC_PROBE, authority NONE.
import type { Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import { fromInternalBars } from "./inputs";
import { runSeriesProbe } from "./probe";

export function probeRuntime(reader: MarketRuntimeReader, tf: Timeframe) {
  const forming = reader.formingBar(tf);
  const bars = fromInternalBars(forming ? [...reader.closedBars(tf), forming] : reader.closedBars(tf));
  return runSeriesProbe({ symbol: reader.symbol, timeframe: tf, source_mode: "APPLICATION_RUNTIME", temporal_policy: "CANONICAL_CLOCK", bars, detected_at: reader.now() });
}
