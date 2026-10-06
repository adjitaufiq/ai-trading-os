import { it, expect } from "vitest";
import { ZZZ } from "./zzz";
import { W } from "./ww";
import { ZZZ as Z2 } from "../zzz";
it("probe4", () => { expect(ZZZ).toBe(1); expect(W).toBe(1); expect(Z2).toBe(1); });
