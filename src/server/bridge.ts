import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { BrowserSession, type BrowserSessionOptions } from "./cdp-session.js";
import { discoverChrome } from "./discover.js";

export interface BridgeOptions extends BrowserSessionOptions {
  // HTTP/WebSocket bind address.
  listenHost?: string;
  listenPort?: number;
  // Override path to client static assets (defaults to bundled dist/client).
  staticDir?: string;
  // If true (default), and neither `target` nor `port` is set, discover the
  // user's already-running Chrome via DevToolsActivePort and prompt them via
  // chrome://inspect when remote-debugging isn't enabled yet.
  autoDiscover?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function defaultStaticDir(): string {
  // dist/server/bridge.js → ../client
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "client");
}

export interface BridgeHandle {
  close: () => Promise<void>;
  port: number;
}

export async function startBridge(opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const sessionOpts: BrowserSessionOptions = { ...opts };
  let cdpEndpoint = "";
  if (!sessionOpts.target && !sessionOpts.port && (opts.autoDiscover ?? true)) {
    const ep = await discoverChrome({ log: (m) => console.log(m) });
    sessionOpts.target = ep.browserWsUrl;
    cdpEndpoint = `${ep.host}:${ep.port}`;
    console.log(
      `[browser-interface] discovered Chrome at ${ep.host}:${ep.port} (profile: ${ep.profileDir})`,
    );
  } else if (sessionOpts.host && sessionOpts.port) {
    cdpEndpoint = `${sessionOpts.host}:${sessionOpts.port}`;
  } else if (sessionOpts.target) {
    const m = sessionOpts.target.match(/^wss?:\/\/([^/]+)/);
    if (m && m[1]) cdpEndpoint = m[1];
  }
  const session = new BrowserSession(sessionOpts);
  await session.connect();

  const staticDir = opts.staticDir ?? defaultStaticDir();
  const clients = new Set<WebSocket>();

  const httpServer = createServer((req, res) => {
    handleStatic(req, res, staticDir).catch((err) => {
      console.error("[browser-interface] static error:", err);
      res.statusCode = 500;
      res.end("internal error");
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);

    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Snap to whichever tab the user is actually looking at right now. Done
    // per-connection (not at server startup) because the user's foreground
    // tab in Chrome can change between when the bridge launches and when they
    // open the UI. If the active tab is already attached, this is a no-op.
    void (async () => {
      try {
        await session.syncToActiveTab();
      } catch (err) {
        console.error("[browser-interface] syncToActiveTab failed:", err);
      }
      const viewport = session.getViewport();
      const page = session.getPage();
      send({
        type: "ready",
        viewport,
        url: page.url,
        title: page.title,
        cdpEndpoint: cdpEndpoint || undefined,
      });
      const tabs = session.getTabs();
      if (tabs.length > 0) send({ type: "tabs", tabs });
      send({ type: "visibility", visible: session.getVisibility() });
      // Seed the UI with a current frame so it doesn't sit on the "Waiting for
      // first frame…" placeholder until the page happens to paint something.
      const frame = await session.captureCurrentFrame();
      if (frame) send(frame);
    })();

    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "invalid json" });
        return;
      }
      if (msg.type === "hello") {
        return; // we just accept it; no per-client state today
      }
      if (msg.type === "action") {
        try {
          await session.dispatch(msg.action);
          send({ type: "ack", id: msg.id });
        } catch (err) {
          send({
            type: "error",
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  const broadcast = (msg: ServerMessage) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  session.on("screenshot", broadcast);
  session.on("page", broadcast);
  session.on("tabs", broadcast);
  session.on("visibility", broadcast);
  session.on("inactive", broadcast);
  session.on("hover", broadcast);
  session.on("selection", broadcast);
  session.on("closed", () => {
    broadcast({ type: "error", message: "browser session closed" });
    for (const ws of clients) ws.close();
  });

  const port = opts.listenPort ?? 8787;
  const host = opts.listenHost ?? "127.0.0.1";
  await new Promise<void>((res) => httpServer.listen(port, host, res));
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[browser-interface] listening on http://${host}:${boundPort}`);

  return {
    port: boundPort,
    close: async () => {
      for (const ws of clients) ws.close();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => httpServer.close(() => res()));
      await session.close();
    },
  };
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, root: string) {
  const url = req.url || "/";
  if (url.startsWith("/ws")) return; // handled by WebSocket upgrade
  // Strip query/hash, default to index.html.
  const pathname = url.split("?")[0]?.split("#")[0] ?? "/";
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(requested).replace(/^([./\\]+)/, "/");
  const filePath = join(root, safe);
  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("content-type", mime);
    res.setHeader("cache-control", "no-store");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}
