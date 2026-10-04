"""Transport-owned envelope builder. Emits the FROZEN 3.0B-1 BridgeEnvelope field names.
Sequence and bridge_sent_at are assigned together under one lock, so sequence order equals
emission order and is strictly increasing per bridge instance, across connection epochs."""
from __future__ import annotations

import threading
import uuid
from typing import Any, Literal, Optional

from mt5_bridge.contracts import BRIDGE_SCHEMA_VERSION

from .clock import TransportClock

SourceMode = Literal["SIMULATION", "REAL"]
Delivery = Literal["LIVE", "BACKFILL"]

CAPABILITIES = frozenset({
    "SYSTEM.HEALTH", "SYSTEM.TERMINAL_INFO",
    "DISCOVERY.SYMBOLS", "DISCOVERY.SYMBOL_SPEC",
    "MARKET_DATA.TICKS", "MARKET_DATA.BARS",
})


def new_request_id() -> str:
    """Server-generated canonical request id. Client input is never used for it."""
    return uuid.uuid4().hex


class EnvelopeFactory:
    def __init__(self, clock: TransportClock, source_mode: SourceMode, instance_id: Optional[str] = None,
                 start_sequence: int = 1) -> None:
        if source_mode not in ("SIMULATION", "REAL"):
            raise ValueError("invalid source_mode")
        self._clock = clock
        self._mode: SourceMode = source_mode
        self.instance_id = instance_id or f"gw-{uuid.uuid4().hex[:12]}"
        self._next_seq = start_sequence
        self._epoch = 0
        self._lock = threading.Lock()

    @property
    def source_mode(self) -> SourceMode:
        return self._mode

    @property
    def epoch(self) -> int:
        return self._epoch

    def bump_epoch(self) -> int:
        """Reconnect: epoch increments, sequence is NOT reset."""
        with self._lock:
            self._epoch += 1
            return self._epoch

    def received(self) -> int:
        return self._clock.now_ms()

    def build(self, *, request_id: str, capability: str, delivery: Delivery, received_at: int,
              data: Any = None, error: Optional[dict[str, Any]] = None,
              source_event_at: Optional[int] = None) -> dict[str, Any]:
        if capability not in CAPABILITIES:
            raise ValueError(f"capability outside frozen whitelist: {capability}")
        if delivery not in ("LIVE", "BACKFILL"):
            raise ValueError("invalid delivery")
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            epoch = self._epoch
            sent_at = self._clock.now_ms()
        timing = {
            "source_event_at": source_event_at,
            "bridge_received_at": received_at,
            "bridge_sent_at": sent_at,
            # Client-clock fields are unobservable at the bridge: null, never fabricated.
            "client_sent_at": None,
            "client_received_at": None,
        }
        latency = {
            # Contaminated by broker/VPS clock offset; NOT network latency.
            "source_arrival_delay_observed_ms": None if source_event_at is None else received_at - source_event_at,
            "bridge_processing_ms": sent_at - received_at,
            "bridge_to_client_apparent_delay_ms": None,
            "transport_rtt_ms": None,
        }
        base = {
            "schema_version": BRIDGE_SCHEMA_VERSION,
            "bridge_instance_id": self.instance_id,
            "connection_epoch": epoch,
            "request_id": request_id,
            "sequence": seq,
            "delivery": delivery,
            "source": "EXNESS_MT5",
            "source_mode": self._mode,
            "capability": capability,
            "timing": timing,
            "latency": latency,
        }
        if error is None:
            base.update(ok=True, data=data, error=None)
        else:
            base.update(ok=False, data=None, error=error)
        return base
