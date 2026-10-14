import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SseHub } from "@/core/enginehost/sseHub";
import { sseFrame } from "@/core/enginehost/api";

class FakeSocket extends EventEmitter { writable = true }
class FakeRes extends EventEmitter {
  writableEnded = false; destroyed = false; writableLength = 0; written: string[] = []; ok = true;
  socket = new FakeSocket();
  write(c: string) { if (this.writableEnded || this.destroyed) throw new Error("write after end"); this.written.push(c); if (!this.ok) this.writableLength += c.length; return this.ok; }
  end() { this.writableEnded = true; }
}
class FakeReq extends EventEmitter {}
const mk = () => ({ req: new FakeReq(), res: new FakeRes() });
const listeners = (e: EventEmitter) => e.eventNames().reduce((n, k) => n + e.listenerCount(k), 0);

describe("SseHub", () => {
  it("removes clients on res, req or socket close", () => {
    const hub = new SseHub({ now: () => 0 });
    const a = mk(), b = mk(), c = mk();
    hub.add(a.req, a.res); hub.add(b.req, b.res); hub.add(c.req, c.res);
    expect(hub.size).toBe(3);
    a.res.emit("close"); b.req.emit("close"); c.res.socket.emit("close");
    expect(hub.size).toBe(0);
  });

  it("cleanup is idempotent and detaches all listeners", () => {
    const hub = new SseHub({ now: () => 0 });
    const a = mk();
    hub.add(a.req, a.res);
    expect(() => { a.res.emit("close"); a.res.emit("error"); a.req.emit("close"); a.res.socket.emit("close"); }).not.toThrow();
    expect(hub.size).toBe(0);
    // only the permanent error guards remain (one per emitter); close/drain listeners are gone
    expect(listeners(a.res) + listeners(a.req) + listeners(a.res.socket)).toBe(3);
    expect(() => a.res.emit("error", new Error("late"))).not.toThrow();
  });

  it("never writes after the response or socket is closed", () => {
    const hub = new SseHub({ now: () => 0 });
    const a = mk(), b = mk();
    hub.add(a.req, a.res); hub.add(b.req, b.res);
    a.res.writableEnded = true; b.res.socket.writable = false;
    expect(() => hub.broadcast("x")).not.toThrow();
    expect(a.res.written).toEqual([]); expect(b.res.written).toEqual([]);
    expect(hub.size).toBe(0);
    const d = mk(); d.res.destroyed = true;
    expect(hub.add(d.req, d.res)).toBe(false);
  });

  it("slow client: skips frames while congested, resumes on drain, drops when stuck", () => {
    let t = 0;
    const hub = new SseHub({ now: () => t, maxCongestedMs: 10_000 });
    const a = mk(); a.res.ok = false;
    hub.add(a.req, a.res);
    for (let i = 0; i < 100; i++) { t += 100; hub.broadcast("frame"); }
    expect(a.res.written.length).toBe(1); // only the first write; nothing queued afterwards
    a.res.ok = true; a.res.emit("drain");
    hub.broadcast("frame"); expect(a.res.written.length).toBe(2);
    a.res.ok = false; hub.broadcast("frame");
    t += 20_000; hub.broadcast("frame");
    expect(hub.size).toBe(0); expect(a.res.writableEnded).toBe(true);
  });

  it("drops a client whose buffered bytes exceed the cap", () => {
    const hub = new SseHub({ now: () => 0, maxBufferedBytes: 10 });
    const a = mk(); a.res.ok = false;
    hub.add(a.req, a.res);
    hub.broadcast("x".repeat(50));
    expect(hub.size).toBe(0);
  });

  it("reconnects do not duplicate listeners or broadcasts", () => {
    const hub = new SseHub({ now: () => 0 });
    for (let i = 0; i < 500; i++) { const c = mk(); hub.add(c.req, c.res); hub.add(c.req, c.res); c.res.emit("close"); }
    expect(hub.size).toBe(0);
    const live = mk(); hub.add(live.req, live.res); hub.add(live.req, live.res);
    hub.broadcast("f");
    expect(live.res.written).toEqual(["f"]);
    expect(live.res.listenerCount("close")).toBe(1);
  });

  it("keeps frame format and order (initial snapshot then deltas)", () => {
    const hub = new SseHub({ now: () => 0 });
    const a = mk();
    const f1 = sseFrame({ type: "SNAPSHOT_UPDATE", symbol: "XAUUSD", timestamp: "t", data: 1 });
    const f2 = sseFrame({ type: "HEALTH_UPDATE", symbol: null, timestamp: "t", data: 2 });
    hub.add(a.req, a.res, f1); hub.broadcast(f2);
    expect(a.res.written).toEqual([f1, f2]);
    expect(f1).toBe(`event: SNAPSHOT_UPDATE\ndata: ${JSON.stringify({ type: "SNAPSHOT_UPDATE", symbol: "XAUUSD", timestamp: "t", data: 1 })}\n\n`);
  });

  it("real http: health responds and the set drains during SSE churn", async () => {
    const hub = new SseHub({ now: () => Date.now() });
    const server: Server = createServer((req, res) => {
      if (req.url === "/events") { res.writeHead(200, { "content-type": "text/event-stream" }); hub.add(req, res, "event: X\ndata: {}\n\n"); return; }
      res.writeHead(200); res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const open = () => new Promise<() => void>((resolve) => {
      const r = request({ host: "127.0.0.1", port, path: "/events" }, (res) => res.once("data", () => resolve(() => r.destroy())));
      r.end();
    });
    const closers = await Promise.all(Array.from({ length: 30 }, open));
    expect(hub.size).toBe(30);
    const health = await new Promise<string>((resolve) => request({ host: "127.0.0.1", port, path: "/health" }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).end());
    expect(health).toBe("ok");
    closers.forEach((c) => c());
    for (let i = 0; i < 50 && hub.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hub.size).toBe(0);
    hub.broadcast("late");
    await new Promise<void>((r) => server.close(() => r()));
  });
});
