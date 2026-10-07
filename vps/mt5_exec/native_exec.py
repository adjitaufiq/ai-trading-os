"""Native boundary for DEMO execution. The only place outside mt5_bridge/native.py that imports
the MetaTrader5 package, behind its own whitelist proxy. The read-only bridge whitelist is NOT widened."""
from __future__ import annotations

from typing import Any, FrozenSet

EXEC_WHITELIST: FrozenSet[str] = frozenset({
    "initialize", "last_error", "account_info",
    "symbol_info", "symbol_info_tick", "symbol_select",
    "order_check", "order_send", "positions_get", "history_deals_get",
})
CONSTANT_PREFIXES = ("ACCOUNT_TRADE_MODE_", "ORDER_TYPE_", "ORDER_TIME_", "ORDER_FILLING_", "TRADE_ACTION_", "TRADE_RETCODE_", "DEAL_ENTRY_", "DEAL_REASON_", "SYMBOL_FILLING_")


class ExecCapabilityDenied(AttributeError):
    pass


class WhitelistedExecNative:
    __slots__ = ("_m",)

    def __init__(self, module: Any) -> None:
        object.__setattr__(self, "_m", module)

    def __getattr__(self, name: str) -> Any:
        if name in EXEC_WHITELIST or name.startswith(CONSTANT_PREFIXES):
            return getattr(object.__getattribute__(self, "_m"), name)
        raise ExecCapabilityDenied(f"native member '{name}' is outside the demo execution whitelist")

    def __setattr__(self, name: str, value: Any) -> None:
        raise ExecCapabilityDenied("native proxy is immutable")


def load_exec_native() -> WhitelistedExecNative:  # pragma: no cover - Windows VPS only
    import MetaTrader5  # noqa: PLC0415
    return WhitelistedExecNative(MetaTrader5)
