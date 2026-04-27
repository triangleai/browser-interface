import type {
  ClientAction,
  ClientActionMessage,
  ServerMessage,
} from "../shared/protocol.js";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

// WebSocket transport between the client UI and the bridge server. Owns the
// connection lifecycle (auto-reconnect with exponential backoff up to 5s),
// the action-id sequencer, and dispatch of incoming server messages back to
// the caller. Status transitions go to setStatus so the caller can update
// whatever indicator it wants — the transport itself doesn't know about UI.
export interface BridgeOptions {
  setStatus: (state: ConnectionState) => void;
  onMessage: (msg: ServerMessage) => void;
}

export interface BridgeClient {
  connect: () => void;
  // Returns the action id (so the caller can correlate ack/error responses)
  // or null if the socket isn't open. Actions queued before the socket opens
  // are dropped — the caller is expected to be reactive to setStatus.
  send: (action: ClientAction) => string | null;
}

export function createBridge(opts: BridgeOptions): BridgeClient {
  let ws: WebSocket | null = null;
  let retryDelay = 500;
  let nextActionId = 1;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    ws = sock;
    opts.setStatus("connecting");

    sock.addEventListener("open", () => {
      retryDelay = 500;
      opts.setStatus("connected");
      sock.send(
        JSON.stringify({
          type: "hello",
          client: `human-${Math.random().toString(36).slice(2, 8)}`,
          role: "human",
        }),
      );
    });

    sock.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      opts.onMessage(msg);
    });

    sock.addEventListener("close", () => {
      ws = null;
      opts.setStatus("disconnected");
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(5000, retryDelay * 2);
    });

    sock.addEventListener("error", () => {
      opts.setStatus("error");
    });
  }

  function send(action: ClientAction): string | null {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const id = String(nextActionId++);
    const msg: ClientActionMessage = { type: "action", id, action };
    ws.send(JSON.stringify(msg));
    return id;
  }

  return { connect, send };
}
