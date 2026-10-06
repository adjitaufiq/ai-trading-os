import { it } from "vitest";
import { runStressTest } from "@/engine/stress-test/simulationRunner";
import { generateStressReport } from "@/engine/stress-test/stressReport";
it("smoke", () => { const t=Date.now(); const r = runStressTest({ sampleSize: 20, maxTrades: 20, seed: 1 }); console.log(generateStressReport(r), Date.now()-t, "ms"); }, 120000);
