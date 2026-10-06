// M1B.11 — Market Event Radar orchestrator. Observer only (authority NONE).
import { EVENT_POLICY } from "./eventPolicy";
import { detectEvents } from "./eventDetector";
import { createEvent, endEvent, recordOccurrence } from "./eventLifecycle";
import { InMemoryEventStore } from "./eventStore";
import type { EventObservation, MarketEvent, MarketEventType } from "./types";

interface Tracker { eventId: string; createdIdx: number; lastIdx: number; }
interface SymbolState {
  idx: number;
  lastBarTime: number;
  regime: string | null; horizon: string | null; volatility: string | null;
  trackers: Map<string, Tracker>;
}

const RESOLVABLE: readonly MarketEventType[] = ["LIQUIDITY_SWEEP", "SNR_INTERACTION"];

export class MarketEventEngine {
  private readonly states = new Map<string, SymbolState>();
  constructor(readonly store: InMemoryEventStore = new InMemoryEventStore()) {}

  /** Processes one CLOSED-bar observation; returns new/updated revisions in deterministic order. */
  step(o: EventObservation): readonly MarketEvent[] {
    let st = this.states.get(o.symbol);
    if (!st) { st = { idx: -1, lastBarTime: -Infinity, regime: null, horizon: null, volatility: null, trackers: new Map() }; this.states.set(o.symbol, st); }
    if (o.barTime <= st.lastBarTime) return []; // out-of-order / duplicate bar ignored
    st.idx++; st.lastBarTime = o.barTime;
    const at = o.barTime, idx = st.idx, out: MarketEvent[] = [];
    const save = (e: MarketEvent) => { this.store.saveEvent(e, at); out.push(e); return e; };
    const context: MarketEvent["context"] = {
      regime: o.regime.regime, horizon: o.horizon.recommendedHorizon, approach: o.horizon.marketApproach,
      footprintTags: o.horizon.horizonEvidence.tags.filter((t) => t.startsWith("FOOTPRINT_")),
    };
    const active = (t: Tracker) => this.store.getEvent(t.eventId)?.state === "ACTIVE";

    // 1. expiry
    for (const [key, t] of [...st.trackers].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const e = this.store.getEvent(t.eventId)!;
      const max = EVENT_POLICY[e.type].maxActiveBars;
      if (e.state === "ACTIVE" && max !== null && idx - t.createdIdx >= max) {
        save(endEvent(e, at, "EXPIRED"));
        if (EVENT_POLICY[e.type].watchOnExpiry) {
          save(createEvent({ symbol: o.symbol, type: "WATCH_INVALIDATED", timeframe: e.timeframe, at, context,
            evidence: [`EXPIRED_${e.type}_NO_CONFIRMATION`], subject: e.eventId, resolvesEventId: e.eventId }));
        }
      }
      if (e.state !== "ACTIVE" && idx - t.lastIdx > EVENT_POLICY[e.type].cooldownBars) st.trackers.delete(key); // bounded memory
    }

    // 2. reaction resolution (latest ACTIVE resolvable watch)
    if (o.reactionConfirmed) {
      const target = [...st.trackers.values()].map((t) => this.store.getEvent(t.eventId)!)
        .filter((e) => e.state === "ACTIVE" && RESOLVABLE.includes(e.type))
        .sort((a, b) => b.lastOccurredAt - a.lastOccurredAt || (a.eventId < b.eventId ? -1 : 1))[0];
      if (target) {
        save(endEvent(target, at, "RESOLVED"));
        save(createEvent({ symbol: o.symbol, type: "REACTION_CONFIRMED", timeframe: o.timeframe, at, context,
          evidence: ["M1B7_REACTION_CONFIRMED"], subject: target.eventId, resolvesEventId: target.eventId }));
      }
    }

    // 3. volatility exit resolves active expansion
    if (o.regime.asOf <= at && o.regime.volatility !== "EXPANSION") {
      const t = st.trackers.get("VOLATILITY_EXPANSION|M15|atr");
      if (t && active(t)) save(endEvent(this.store.getEvent(t.eventId)!, at, "RESOLVED"));
    }

    // 4. detections with dedup / supersede
    for (const d of detectEvents(o, st)) {
      const key = `${d.type}|${d.timeframe ?? "NA"}|${d.subject}`;
      const t = st.trackers.get(key);
      const cd = EVENT_POLICY[d.type].cooldownBars;
      if (t && idx - t.lastIdx <= cd) {
        if (active(t)) { save(recordOccurrence(this.store.getEvent(t.eventId)!, at)); t.lastIdx = idx; }
        continue; // ended within cooldown ⇒ suppressed
      }
      let resolves: string | null = null;
      if ((d.type === "REGIME_CHANGE" || d.type === "HORIZON_CHANGE") && t && active(t)) {
        save(endEvent(this.store.getEvent(t.eventId)!, at, "RESOLVED")); resolves = t.eventId;
      }
      const e = save(createEvent({ symbol: o.symbol, type: d.type, timeframe: d.timeframe, at, context, evidence: d.evidence, subject: d.subject, resolvesEventId: resolves }));
      st.trackers.set(key, { eventId: e.eventId, createdIdx: idx, lastIdx: idx });
    }

    if (o.regime.asOf <= at && o.regime.symbol === o.symbol) { st.regime = o.regime.regime; st.volatility = o.regime.volatility; }
    if (o.horizon.asOf <= at && o.horizon.symbol === o.symbol) st.horizon = o.horizon.recommendedHorizon;
    return Object.freeze(out);
  }

  trackerCount(symbol: string): number { return this.states.get(symbol)?.trackers.size ?? 0; }
}
