import { it } from "vitest";
import { runStressTest } from "./simulationRunner";
import { generateStressReport } from "./stressReport";
import { PHASES } from "./types";
it("phases", () => { for (const p of PHASES) { const t=Date.now(); const r = runStressTest({ sampleSize: p.sampleSize, maxTrades: p.sampleSize, seed: 1 }); console.log(`=== PHASE ${p.phase} (${p.purpose}) ${Date.now()-t}ms\n`+generateStressReport(r)); } }, 590000);
