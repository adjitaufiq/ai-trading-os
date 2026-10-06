import { describe, expect, it } from "vitest";
import { detectCandlePattern, patternDirection } from "../candlePatternDetector";
import { c } from "./helpers";

const prevNeutral = c(0, 2000, 2020, 1980, 2001);

describe("M1B.7 candle pattern detector", () => {
  it("bullish engulfing", () => {
    expect(detectCandlePattern(c(0, 2005, 2006, 1999, 2000), c(1, 2000, 2008, 1998, 2007))).toBe("BULLISH_ENGULFING");
  });
  it("bearish engulfing", () => {
    expect(detectCandlePattern(c(0, 2000, 2006, 1999, 2005), c(1, 2005, 2007, 1997, 1998))).toBe("BEARISH_ENGULFING");
  });
  it("bullish rejection wick (lower wick 0.5, green, body > pinbar max)", () => {
    const cur = c(1, 2005, 2010, 2000, 2009); // range10 lower5 body4 upper1
    expect(detectCandlePattern(c(0, 2030, 2040, 2025, 2035), cur)).toBe("BULLISH_REJECTION_WICK");
    expect(patternDirection("BULLISH_REJECTION_WICK", cur)).toBe("BULLISH");
  });
  it("bearish rejection wick", () => {
    expect(detectCandlePattern(c(0, 1970, 1975, 1960, 1965), c(1, 2005, 2010, 2000, 2001))).toBe("BEARISH_REJECTION_WICK");
  });
  it("bullish pinbar", () => {
    const cur = c(1, 2008, 2010, 2000, 2009); // body1 lower8
    expect(detectCandlePattern(c(0, 2030, 2040, 2025, 2035), cur)).toBe("PINBAR");
    expect(patternDirection("PINBAR", cur)).toBe("BULLISH");
  });
  it("bearish pinbar", () => {
    const cur = c(1, 2002, 2010, 2000, 2001);
    expect(detectCandlePattern(c(0, 2030, 2040, 2025, 2035), cur)).toBe("PINBAR");
    expect(patternDirection("PINBAR", cur)).toBe("BEARISH");
  });
  it("inside bar is neutral", () => {
    const cur = c(1, 2005, 2010, 1995, 2003); // body 2/15, wicks 5/15, 8/15 < 0.55
    expect(detectCandlePattern(prevNeutral, cur)).toBe("INSIDE_BAR");
    expect(patternDirection("INSIDE_BAR", cur)).toBe("NEUTRAL");
  });
  it("bullish marubozu", () => {
    const cur = c(1, 2000, 2010.5, 1999.5, 2010);
    expect(detectCandlePattern(c(0, 2030, 2040, 2025, 2035), cur)).toBe("MARUBOZU");
    expect(patternDirection("MARUBOZU", cur)).toBe("BULLISH");
  });
  it("bearish marubozu", () => {
    const cur = c(1, 2010, 2010.5, 1999.5, 2000);
    expect(detectCandlePattern(c(0, 2030, 2040, 2025, 2035), cur)).toBe("MARUBOZU");
    expect(patternDirection("MARUBOZU", cur)).toBe("BEARISH");
  });
  it("running candle rejected (NONE)", () => {
    expect(detectCandlePattern(c(0, 2005, 2006, 1999, 2000), c(1, 2000, 2008, 1998, 2007, false))).toBe("NONE");
  });
  it("closed candle accepted", () => {
    expect(detectCandlePattern(c(0, 2005, 2006, 1999, 2000), c(1, 2000, 2008, 1998, 2007, true))).not.toBe("NONE");
  });
  it("zero-range candle ⇒ NONE", () => {
    expect(detectCandlePattern(prevNeutral, c(1, 2000, 2000, 2000, 2000))).toBe("NONE");
  });
});
