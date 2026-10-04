"""Real loopback test client (raw sockets via asyncio). Talks to the actual gateway server."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import struct
from typing import Any, Optional


async def http(port: int, path: str, method: str = "GET", headers: Optional[dict[str, str]] = None
               ) -> tuple[int, dict[str, str], Any]:
    r, w = await asyncio.open_connection("127.0.0.1", port)
    extra = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items())
    w.write(f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}\r\n".encode())
    await w.drain()
    raw = await r.read()
    w.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    status = int(lines[0].split(" ")[1])
    hdrs = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:])}
    return status, hdrs, json.loads(body) if body else None


class WsClient:
    def __init__(self, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        self.r, self.w = r, w

    @classmethod
    async def connect(cls, port: int, path: str = "/v1/stream") -> tuple["WsClient", int, dict[str, str]]:
        r, w = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode()
        w.write((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                 f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        await w.drain()
        head = (await r.readuntil(b"\r\n\r\n")).decode()
        lines = head.split("\r\n")
        hdrs = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:] if ln)}
        return cls(r, w), int(lines[0].split(" ")[1]), hdrs

    async def send_raw(self, op: int, data: bytes) -> None:
        mask = os.urandom(4)
        n = len(data)
        hdr = struct.pack("!BB", 0x80 | op, 0x80 | n) if n < 126 else struct.pack("!BBH", 0x80 | op, 0x80 | 126, n)
        self.w.write(hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))
        await self.w.drain()

    async def send_json(self, obj: Any) -> None:
        await self.send_raw(0x1, json.dumps(obj).encode())

    async def recv(self, timeout: float = 2.0) -> tuple[int, bytes]:
        async def read() -> tuple[int, bytes]:
            b1, b2 = await self.r.readexactly(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.r.readexactly(8))[0]
            return b1 & 0x0F, await self.r.readexactly(n)
        return await asyncio.wait_for(read(), timeout)

    async def recv_json(self) -> Any:
        op, data = await self.recv()
        assert op == 0x1, op
        return json.loads(data)

    async def close(self) -> tuple[int, bytes]:
        await self.send_raw(0x8, struct.pack("!H", 1000))
        res = await self.recv()
        self.w.close()
        return res
