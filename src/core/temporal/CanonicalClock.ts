import type { ClockMode } from "../contracts";

/** The only source of "now" for the core engine. */
export interface CanonicalClock {
  readonly mode: ClockMode;
  now(): number;
}

/** LIVE clock. This is the single controlled Date.now() call in core. Monotonic. */
export class LiveClock implements CanonicalClock {
  readonly mode = "LIVE" as const;
  private last = 0;
  constructor(private readonly source: () => number = () => Date.now()) {}
  now(): number {
    const t = this.source();
    this.last = Math.max(this.last, t);
    return this.last;
  }
}

/** REPLAY clock. Time moves only when explicitly advanced; never backwards. */
export class ReplayClock implements CanonicalClock {
  readonly mode = "REPLAY" as const;
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advanceTo(t: number): void {
    if (t < this.t) throw new Error(`ReplayClock cannot move backwards: ${t} < ${this.t}`);
    this.t = t;
  }
}
