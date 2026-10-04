import type { SequenceDisposition, SequenceObservation } from "./types";

interface Mark {
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly sequence: number;
}

/**
 * Tracks the latest accepted (instance, epoch, sequence) per channel. Every irregularity is an
 * explicit observation; nothing is reordered, repaired or fabricated. Duplicates, regressions and
 * epoch regressions are QUARANTINE (state is not advanced). Gaps, epoch advances and instance
 * changes are ACCEPT_WITH_FLAG — observable, not terminal.
 */
export class SequenceTracker {
  private readonly last = new Map<"HTTP" | "STREAM", Mark>();
  private readonly log: SequenceObservation[] = [];

  track(channel: "HTTP" | "STREAM", m: Mark): { disposition: SequenceDisposition; observations: readonly SequenceObservation[] } {
    const prev = this.last.get(channel) ?? null;
    const obs: SequenceObservation[] = [];
    const add = (kind: SequenceObservation["kind"], missing?: number) =>
      obs.push(Object.freeze({ kind, channel, ...m, previous: prev, ...(missing !== undefined ? { missing } : {}) }));
    let disposition: SequenceDisposition = "ACCEPT";

    if (prev === null) {
      this.last.set(channel, m);
    } else if (m.bridge_instance_id !== prev.bridge_instance_id) {
      add("BRIDGE_INSTANCE_CHANGE");
      disposition = "ACCEPT_WITH_FLAG";
      this.last.set(channel, m);
    } else if (m.connection_epoch < prev.connection_epoch) {
      add("EPOCH_REGRESSION");
      disposition = "QUARANTINE";
    } else if (m.sequence === prev.sequence) {
      add("SEQUENCE_DUPLICATE");
      disposition = "QUARANTINE";
    } else if (m.sequence < prev.sequence) {
      add("SEQUENCE_REGRESSION");
      disposition = "QUARANTINE";
    } else {
      if (m.connection_epoch > prev.connection_epoch) add("EPOCH_ADVANCE");
      if (m.sequence > prev.sequence + 1) add("SEQUENCE_GAP", m.sequence - prev.sequence - 1);
      if (obs.length) disposition = "ACCEPT_WITH_FLAG";
      this.last.set(channel, m);
    }
    this.log.push(...obs);
    return { disposition, observations: Object.freeze(obs) };
  }

  latest(channel: "HTTP" | "STREAM"): Mark | null {
    return this.last.get(channel) ?? null;
  }
  get observations(): readonly SequenceObservation[] {
    return this.log;
  }
}
