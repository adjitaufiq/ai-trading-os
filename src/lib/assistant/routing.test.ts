import { describe, expect, it } from "vitest";
import { classifyIntent, tierForIntent } from "./routing";

describe("classifyIntent", () => {
  it("routes briefing requests to DEEP_ANALYSIS regardless of wording", () => {
    expect(classifyIntent("Buat briefing XAUUSD sesi ini")).toBe("DEEP_ANALYSIS");
    expect(classifyIntent("halo", { briefing: true })).toBe("DEEP_ANALYSIS");
  });

  it("routes journal/performance/history questions to DEEP_ANALYSIS", () => {
    expect(classifyIntent("Review performa journal paper trading bulan ini")).toBe("DEEP_ANALYSIS");
    expect(classifyIntent("Bandingkan kondisi sekarang dengan histori yang mirip")).toBe("DEEP_ANALYSIS");
    expect(classifyIntent("Apa failure pattern paling umum di journal?")).toBe("DEEP_ANALYSIS");
    expect(classifyIntent("Kenapa engine memilih decision STAND_ASIDE?")).toBe("DEEP_ANALYSIS");
  });

  it("routes short definitional questions to QUICK_EXPLAIN", () => {
    expect(classifyIntent("Apa itu RANGE_COMPRESSION?")).toBe("QUICK_EXPLAIN");
    expect(classifyIntent("What does NO_FIT mean?")).toBe("QUICK_EXPLAIN");
    expect(classifyIntent("Arti FVG_ACTIVE")).toBe("QUICK_EXPLAIN");
  });

  it("keeps live-condition and longer questions at STANDARD", () => {
    expect(classifyIntent("Apa yang terjadi sekarang di XAUUSD? Ceritakan kondisi market, level penting, dan apa yang ditunggu radar saat ini.")).toBe("STANDARD");
    expect(classifyIntent("Radar sekarang nunggu apa?")).toBe("STANDARD");
    expect(classifyIntent("")).toBe("STANDARD");
  });
});

describe("tierForIntent", () => {
  it("maps intents to tiers", () => {
    expect(tierForIntent("QUICK_EXPLAIN")).toBe("fast");
    expect(tierForIntent("STANDARD")).toBe("medium");
    expect(tierForIntent("DEEP_ANALYSIS")).toBe("reasoning");
  });
});
