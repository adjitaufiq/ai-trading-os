"""Native boundary. The real package is imported ONLY here, lazily, on the Windows VPS.
The adapter sees the native module solely through WhitelistedNative, which refuses
every member outside the read-only whitelist."""
from __future__ import annotations

from typing import Any, FrozenSet

NATIVE_WHITELIST: FrozenSet[str] = frozenset({
    # SYSTEM
    "initialize", "shutdown", "version", "terminal_info", "last_error",
    # DISCOVERY
    "symbols_get", "symbol_info", "symbol_select",
    # MARKET_DATA
    "symbol_info_tick", "copy_ticks_from", "copy_ticks_range",
    "copy_rates_from", "copy_rates_from_pos", "copy_rates_range",
})
# Read-only constants needed to build market-data requests.
CONSTANT_PREFIXES = ("TIMEFRAME_", "COPY_TICKS_")


class NativeCapabilityDenied(AttributeError):
    pass


class WhitelistedNative:
    """Proxy: only whitelisted functions and read-only constants are reachable."""
    __slots__ = ("_m",)

    def __init__(self, module: Any) -> None:
        object.__setattr__(self, "_m", module)

    def __getattr__(self, name: str) -> Any:
        if name in NATIVE_WHITELIST or name.startswith(CONSTANT_PREFIXES):
            return getattr(object.__getattribute__(self, "_m"), name)
        raise NativeCapabilityDenied(f"native member '{name}' is outside the read-only whitelist")

    def __setattr__(self, name: str, value: Any) -> None:
        raise NativeCapabilityDenied("native proxy is immutable")


def load_native_module() -> WhitelistedNative:  # pragma: no cover - Windows VPS only
    import MetaTrader5  # noqa: PLC0415  (isolated native import)
    return WhitelistedNative(MetaTrader5)
