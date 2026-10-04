"""Minimal asyncio HTTP/1.1 + RFC 6455 WebSocket transport (stdlib only).
Binds loopback only in 2B. Every connection is closed after one HTTP response."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import struct
from typing import Any, Optional, Tuple

from .service import GatewayService

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_HEADER_BYTES = 16_384
MAX_WS_MESSAGE = 4_096
REASONS = {101: "Switching Protocols", 200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
           405: "Method Not Allowed", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable"}


class GatewayServer:
    def __init__(self, service: GatewayService, host: str = "127.0.0.1", port: int = 0) -> None:
        if host not in LOOPBACK_HOSTS:
            raise ValueError("2B gateway binds loopback only")
        self.service, self.host, self._port = service, host, port
        self._server: Optional[asyncio.base_events.Server] = None

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.sockets[0].getsockname()[1])

    @property
    def bound_host(self) -> str:
        assert self._server is not None
        return str(self._server.sockets[0].getsockname()[0])

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._conn, self.host, self._port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    # ---------- HTTP ----------
    async def _conn(self, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        try:
            try:
                head = await r.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                return
            if len(head) > MAX_HEADER_BYTES:
                return await self._send(w, 400, {"detail": "header too large"})
            lines = head.decode("latin-1").split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
                return await self._send(w, 400, {"detail": "bad request line"})
            method, target = parts[0], parts[1]
            headers = {}
            for ln in lines[1:]:
                if ln:
                    k, _, v = ln.partition(":")
                    headers[k.strip().lower()] = v.strip()
            if target.split("?")[0] == "/v1/stream":
                if method == "GET" and headers.get("upgrade", "").lower() == "websocket":
                    return await self._ws(r, w, headers)
                return await self._send(w, 400 if method == "GET" else 405, {"detail": "websocket upgrade required"})
            res = await self.service.handle_http(method, target)
            await self._send(w, res.status, res.body, res.headers)
        except Exception as ex:  # never leak internals
            self.service.internal_errors.append(f"transport {type(ex).__name__}")
            try:
                await self._send(w, 500, {"detail": "internal gateway error"})
            except Exception:
                pass
        finally:
            w.close()

    async def _send(self, w: asyncio.StreamWriter, status: int, body: Any,
                    headers: Tuple[Tuple[str, str], ...] = ()) -> None:
        payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        hdr = [f"HTTP/1.1 {status} {REASONS.get(status, 'Error')}", "Content-Type: application/json",
               f"Content-Length: {len(payload)}", "Connection: close", *[f"{k}: {v}" for k, v in headers]]
        w.write(("\r\n".join(hdr) + "\r\n\r\n").encode() + payload)
        await w.drain()

    # ---------- WebSocket ----------
    async def _ws(self, r: asyncio.StreamReader, w: asyncio.StreamWriter, headers: dict[str, str]) -> None:
        key = headers.get("sec-websocket-key", "")
        if headers.get("sec-websocket-version") != "13" or len(key) < 16:
            return await self._send(w, 400, {"detail": "bad websocket handshake"})
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        w.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                 f"Sec-WebSocket-Accept: {accept}\r\nX-Bridge-Authority: READ_ONLY_OBSERVATION\r\n\r\n").encode())
        await w.drain()
        while True:
            frame = await _read_frame(r)
            if frame is None:
                return
            op, data = frame
            if op == 0x8:
                await _write_frame(w, 0x8, data[:2] or struct.pack("!H", 1000))
                return
            if op == 0x9:
                await _write_frame(w, 0xA, data)
                continue
            if op == 0xA:
                continue
            if op != 0x1:
                await _write_frame(w, 0x8, struct.pack("!H", 1003))
                return
            try:
                msg = json.loads(data.decode("utf8"))
            except (ValueError, UnicodeDecodeError):
                await self._ws_send(w, self.service.stream_invalid("message is not JSON"))
                continue
            for env in await self.service.stream_events(msg):
                await self._ws_send(w, env)

    async def _ws_send(self, w: asyncio.StreamWriter, env: dict[str, Any]) -> None:
        await _write_frame(w, 0x1, json.dumps(env, separators=(",", ":"), allow_nan=False).encode())


async def _read_frame(r: asyncio.StreamReader) -> Optional[Tuple[int, bytes]]:
    try:
        b1, b2 = await r.readexactly(2)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", await r.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", await r.readexactly(8))[0]
        if not b2 & 0x80 or not b1 & 0x80 or n > MAX_WS_MESSAGE:
            return None  # unmasked client frame, fragmentation or oversize: drop connection
        mask = await r.readexactly(4)
        raw = await r.readexactly(n)
    except (asyncio.IncompleteReadError, ConnectionError):
        return None
    return b1 & 0x0F, bytes(c ^ mask[i % 4] for i, c in enumerate(raw))


async def _write_frame(w: asyncio.StreamWriter, op: int, data: bytes) -> None:
    n = len(data)
    if n < 126:
        hdr = struct.pack("!BB", 0x80 | op, n)
    elif n < 65536:
        hdr = struct.pack("!BBH", 0x80 | op, 126, n)
    else:
        hdr = struct.pack("!BBQ", 0x80 | op, 127, n)
    w.write(hdr + data)
    await w.drain()
