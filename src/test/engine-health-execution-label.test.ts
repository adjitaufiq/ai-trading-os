import { describe, expect, it } from "vitest";
import { EngineHost } from "@/core/enginehost/EngineHost";

const mk = (executionState?: () => { armed: boolean; enabled: boolean }) => new EngineHost({
  symbols: [], mount: () => () => undefined, now: () => 1,
  persistence: { load: () => ({ state: null, error: null }), persist: () => undefined } as never,
  ...(executionState ? { executionState } : {}),
});

describe("engine health execution label", () => {
  it("defaults to MONITOR_ONLY / disabled", () => {
    const h = mk().health();
    expect(h.operating_mode).toBe("MONITOR_ONLY"); expect(h.execution_enabled).toBe(false);
  });
  it("armed but shadow/kill active ⇒ DEMO, disabled", () => {
    const h = mk(() => ({ armed: true, enabled: false })).health();
    expect(h.operating_mode).toBe("DEMO"); expect(h.execution_enabled).toBe(false);
  });
  it("armed and clear ⇒ DEMO, enabled", () => {
    expect(mk(() => ({ armed: true, enabled: true })).health().execution_enabled).toBe(true);
  });
  it("not armed never reports enabled; throwing reports disabled", () => {
    expect(mk(() => ({ armed: false, enabled: true })).health().execution_enabled).toBe(false);
    expect(mk(() => { throw new Error("x"); }).health().operating_mode).toBe("MONITOR_ONLY");
  });
});
