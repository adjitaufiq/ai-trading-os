import { describe, expect, it } from "vitest";
import { setupStatus, pickPlan } from "@/lib/setupStatus";
import type { ExeLamp } from "@/lib/exeLamp";

const ref = (o: Record<string, unknown> = {}) => ({ status: "AVAILABLE", entry: 100, sl: 99, tp1: 101, tp2: 102, final_rr: 2, economics_status: "OK", economics_reason: "RAW", ...o });
const radar = (o: Record<string, unknown> = {}) => ({ status: "AVAILABLE", reference_entry: 200, sl: 201, tp1: 199, tp2: 198, final_rr: 2, economics_status: "OK", economics_reason: "RAW", ...o });
const snap = (o: Record<string, unknown> = {}) => ({
  availability: "AVAILABLE", primary_bias: "SELL", signal: { state: "WAIT", reason: "WAITING_TRIGGER" },
  reference_plan: { status: "NOT_AVAILABLE", reason: "NO_SIGNAL" }, radar_plan: null, ...o,
}) as never;
const exe = (o: Partial<ExeLamp> = {}): ExeLamp => ({ tone: "healthy", label: "EXE READY", engine: "ONLINE", mode: "DEMO", execution: "READY", ageSec: 2, detail: "ok", ...o });
const readySnap = (p = ref()) => snap({ signal: { state: "READY", reason: "READY" }, reference_plan: p, radar_plan: radar() });

describe("setupStatus precedence", () => {
  it("unavailable snapshot", () => expect(setupStatus(null, exe()).kind).toBe("UNAVAILABLE"));
  it("full READY + valid plan + fresh runtime READY ⇒ SIAP_EXEC", () => {
    const s = setupStatus(readySnap(), exe());
    expect(s.kind).toBe("SIAP_EXEC"); expect(s.tone).toBe("healthy");
  });
  it("READY uses reference_plan only, never radar values", () => {
    const s = setupStatus(readySnap(), exe());
    expect(s.plan?.source).toBe("REFERENCE_PLAN"); expect(s.plan?.entry).toBe(100); expect(s.plan?.sl).toBe(99);
  });
  it("BAD_RR from same plan beats runtime status", () => {
    const s = setupStatus(readySnap(ref({ tp1: null, final_rr: 0, economics_status: "BAD_RR", economics_reason: "BAD_RR_AFTER_STRUCTURAL_CLAMP" })), exe());
    expect(s.kind).toBe("BAD_RR"); expect(s.reason).toMatch(/Order ditolak/);
  });
  it("runtime missing / stale / degraded / unknown ⇒ EXEC_UNKNOWN, never SIAP", () => {
    for (const e of [null, exe({ tone: "unknown", execution: "UNKNOWN", label: "EXE NOT CONNECTED" }), exe({ tone: "attention", label: "EXE STALE", execution: "UNKNOWN" }), exe({ tone: "attention", label: "EXE DEGRADED", execution: "UNKNOWN" }), exe({ tone: "waiting", label: "EXE VERIFYING", execution: "WAITING_SIGNAL" })])
      expect(setupStatus(readySnap(), e).kind).toBe("EXEC_UNKNOWN");
  });
  it("runtime blocked ⇒ EXEC_BLOCKED", () => {
    expect(setupStatus(readySnap(), exe({ tone: "attention", label: "EXE BLOCKED", execution: "BLOCKED" })).kind).toBe("EXEC_BLOCKED");
  });
  it("READY without execution plan ⇒ WAIT, not SIAP", () => {
    expect(setupStatus(snap({ signal: { state: "READY", reason: "R" }, radar_plan: radar() }), exe()).kind).toBe("WAIT");
  });
  it("not READY with only radar ⇒ PROJECTION using radar values", () => {
    const s = setupStatus(snap({ radar_plan: radar() }), exe());
    expect(s.kind).toBe("PROJECTION"); expect(s.label).toBe("PROYEKSI — BUKAN RENCANA ORDER"); expect(s.plan?.entry).toBe(200);
  });
  it("not READY with reference plan ⇒ WAIT", () => {
    expect(setupStatus(snap({ reference_plan: ref(), radar_plan: radar() }), exe()).kind).toBe("WAIT");
  });
  it("radar BAD_RR stays projection, not order rejection", () => {
    expect(setupStatus(snap({ radar_plan: radar({ economics_status: "BAD_RR", tp1: null }) }), exe()).kind).toBe("PROJECTION");
  });
  it("pickPlan never mixes sources", () => {
    expect(pickPlan(snap({ reference_plan: ref(), radar_plan: radar() }))?.source).toBe("REFERENCE_PLAN");
  });
});
