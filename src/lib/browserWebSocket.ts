// Browser WebSocket factory, injected into BrokerGatewayClient (src/core never constructs a socket itself).
// The socket is read-only market data transport; the client only sends its typed subscribe frame.
import type { WebSocketFactory, WebSocketLike } from "@/core/broker/gateway/BrokerGatewayClient";

export const browserWebSocketFactory: WebSocketFactory = (url: string): WebSocketLike => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => unknown }).WebSocket;
  if (!Ctor) throw new Error("WebSocket is not available in this environment");
  return new Ctor(url) as WebSocketLike;
};
