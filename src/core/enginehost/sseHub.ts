// SSE subscriber hub for the engine host (transport hygiene only; no trading logic).
// - Idempotent cleanup on res/req/socket close or error.
// - Never writes to an ended/destroyed/non-writable response.
// - Backpressure: when write() returns false the client is marked congested and receives no further
//   frames until 'drain'; a client congested longer than maxCongestedMs (or above maxBufferedBytes) is
//   dropped instead of letting its buffer grow without bound. SSE carries latest state, so skipped
//   frames are acceptable (each new SNAPSHOT_UPDATE supersedes older ones).

export interface SseSocketLike {
  readonly writable?: boolean;
  on(ev: "close" | "error", fn: () => void): unknown;
  off?(ev: "close" | "error", fn: () => void): unknown;
}
export interface SseResponseLike {
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
  readonly writableLength?: number;
  readonly socket?: SseSocketLike | null;
  write(chunk: string): boolean;
  end?(): unknown;
  on(ev: "close" | "error" | "drain", fn: () => void): unknown;
  off?(ev: "close" | "error" | "drain", fn: () => void): unknown;
}
export interface SseRequestLike { on(ev: "close" | "error", fn: () => void): unknown; off?(ev: "close" | "error", fn: () => void): unknown }

export interface SseHubOptions { readonly now: () => number; readonly maxCongestedMs?: number; readonly maxBufferedBytes?: number }

interface Client { res: SseResponseLike; congestedSince: number | null; cleanup: () => void }

export class SseHub {
  private readonly clients = new Map<SseResponseLike, Client>();
  private readonly maxCongestedMs: number;
  private readonly maxBufferedBytes: number;
  constructor(private readonly o: SseHubOptions) {
    this.maxCongestedMs = o.maxCongestedMs ?? 30_000;
    this.maxBufferedBytes = o.maxBufferedBytes ?? 4 * 1024 * 1024;
  }

  get size(): number { return this.clients.size; }

  private static writable(res: SseResponseLike): boolean {
    if (res.writableEnded || res.destroyed) return false;
    if (res.socket && res.socket.writable === false) return false;
    return true;
  }

  /** Register a subscriber. `initial` frames are written first (same guards). Returns false if not added. */
  add(req: SseRequestLike, res: SseResponseLike, initial = ""): boolean {
    if (this.clients.has(res)) return true;
    if (!SseHub.writable(res)) return false;
    const socket = res.socket ?? null;
    let done = false;
    const onDrain = () => { const c = this.clients.get(res); if (c) c.congestedSince = null; };
    const cleanup = () => {
      if (done) return;
      done = true;
      this.clients.delete(res);
      res.off?.("close", cleanup); res.off?.("error", cleanup); res.off?.("drain", onDrain);
      req.off?.("close", cleanup); req.off?.("error", cleanup);
      socket?.off?.("close", cleanup); socket?.off?.("error", cleanup);
    };
    const client: Client = { res, congestedSince: null, cleanup };
    this.clients.set(res, client);
    res.on("close", cleanup); res.on("error", cleanup); res.on("drain", onDrain);
    req.on("close", cleanup); req.on("error", cleanup);
    socket?.on("close", cleanup); socket?.on("error", cleanup);
    if (initial) this.send(client, initial);
    return this.clients.has(res);
  }

  private drop(c: Client): void {
    c.cleanup();
    try { c.res.end?.(); } catch { /* already gone */ }
  }

  private send(c: Client, frames: string): void {
    if (!SseHub.writable(c.res)) { c.cleanup(); return; }
    const now = this.o.now();
    if (c.congestedSince !== null) {
      if (now - c.congestedSince > this.maxCongestedMs || (c.res.writableLength ?? 0) > this.maxBufferedBytes) this.drop(c);
      return; // skip frame while congested; latest state arrives after drain
    }
    let ok: boolean;
    try { ok = c.res.write(frames); } catch { c.cleanup(); return; }
    if (!ok) c.congestedSince = now;
    if ((c.res.writableLength ?? 0) > this.maxBufferedBytes) this.drop(c);
  }

  broadcast(frames: string): void {
    if (!frames) return;
    for (const c of [...this.clients.values()]) this.send(c, frames);
  }
}
