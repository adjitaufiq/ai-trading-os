"""Hermetic test server for the TypeScript 2C E2E: FakeMT5 -> ReadOnlyMT5Adapter -> GatewayService
-> real loopback GatewayServer. Prints one JSON line with the port, serves until stdin closes.
Process-local controls (NOT network-reachable) are read from stdin: 'reconnect'."""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mt5_bridge.adapter import ReadOnlyMT5Adapter  # noqa: E402
from mt5_gateway.clock import FakeTransportClock  # noqa: E402
from mt5_gateway.server import GatewayServer  # noqa: E402
from mt5_gateway.service import GatewayService  # noqa: E402

from fake_mt5 import T0, FakeMT5  # noqa: E402


async def main() -> None:
    fake = FakeMT5()
    svc = GatewayService(ReadOnlyMT5Adapter(fake), FakeTransportClock(T0 * 1000 + 10_000), "SIMULATION", "gw-e2e")
    svc.start()
    server = GatewayServer(svc, "127.0.0.1", 0)
    await server.start()
    print(json.dumps({"port": server.port, "host": server.bound_host}), flush=True)
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        if line.strip() == "reconnect":
            svc.reconnect()
            print(json.dumps({"epoch": svc.envelopes.epoch}), flush=True)
    await server.stop()
    svc.stop()
    if fake.forbidden_hits:
        sys.exit(3)


if __name__ == "__main__":
    asyncio.run(main())
