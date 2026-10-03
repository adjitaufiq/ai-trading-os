"""Stage 3.0B-2A wire shapes mirroring the FROZEN Stage 3.0B-1 TypeScript contract
(src/core/broker/bridge/types.ts). Frozen dataclasses: normalized output is immutable.
No decision semantics. No execution surface."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Generic, Literal, Optional, Tuple, TypeVar, Union

BRIDGE_SCHEMA_VERSION = "3.0B-1"
ADAPTER_VERSION = "3.0B-2A-native-1"

CoverageStatus = Literal["COMPLETE", "PARTIAL", "EMPTY", "UNKNOWN"]
BridgeErrorKind = Literal["MT5_ERROR", "CAPABILITY_DENIED", "INVALID_REQUEST", "NOT_FOUND"]


class _Wire:
    def to_wire(self) -> dict[str, Any]:
        return asdict(self)  # type: ignore[call-overload]


@dataclass(frozen=True)
class Mt5Error(_Wire):
    """Public wire shape of last_error(). Raw tuple stays in internal provenance."""
    code: int
    description: str


@dataclass(frozen=True)
class BridgeError(_Wire):
    kind: BridgeErrorKind
    message: str
    mt5_error: Optional[Mt5Error]


@dataclass(frozen=True)
class TerminalVersion(_Wire):
    terminal_version: int
    build: int
    release_date: str


@dataclass(frozen=True)
class TerminalInfoObservation(_Wire):
    connected: bool
    terminal_ping_us: int          # raw ping_last, MICROSECONDS
    terminal_ping_ms: float        # derived: us / 1000
    retransmission: float
    trade_allowed_observed: bool
    tradeapi_disabled_observed: bool
    authority: Literal["OBSERVATION_ONLY"] = "OBSERVATION_ONLY"


@dataclass(frozen=True)
class BridgeSymbolInfo(_Wire):
    broker_symbol: str
    description: str
    path: str
    currency_base: str
    currency_profit: str
    digits: int
    point: float
    trade_contract_size: float


@dataclass(frozen=True)
class BridgeTick(_Wire):
    broker_symbol: str
    raw_time_s: int                # raw native `time`
    raw_time_msc: int              # raw native `time_msc` (never synthesized)
    bid: float
    ask: float
    last: float
    volume: float
    flags: int
    time_precision: Literal["ms"] = "ms"


@dataclass(frozen=True)
class BridgeBar(_Wire):
    broker_symbol: str
    timeframe: str
    raw_time_s: int                # raw native `time` = bar OPEN, seconds; no ms invented
    open: float
    high: float
    low: float
    close: float
    tick_volume: int
    spread: int
    real_volume: int
    time_precision: Literal["s"] = "s"


@dataclass(frozen=True)
class HistoryCoverage(_Wire):
    requested_from: Optional[int]
    requested_to: Optional[int]
    returned_count: int
    oldest_returned_at: Optional[int]
    newest_returned_at: Optional[int]
    coverage_status: CoverageStatus
    reason: Optional[str] = None


T = TypeVar("T")


@dataclass(frozen=True)
class HistoryResult(Generic[T]):
    items: Tuple[T, ...]
    coverage: HistoryCoverage

    def to_wire(self) -> dict[str, Any]:
        return {"items": [i.to_wire() for i in self.items], "coverage": self.coverage.to_wire()}  # type: ignore[attr-defined]


@dataclass(frozen=True)
class Ok(Generic[T]):
    data: T
    ok: Literal[True] = True


@dataclass(frozen=True)
class Err:
    error: BridgeError
    ok: Literal[False] = False


AdapterResult = Union[Ok[T], Err]
