#!/usr/bin/env node
import { startBridge, type BridgeOptions } from "./bridge.js";

interface CliArgs {
  target?: string;
  host?: string;
  port?: number;
  listenHost?: string;
  listenPort?: number;
  width?: number;
  height?: number;
  maxFps?: number;
  format?: "png" | "jpeg";
  quality?: number;
  noAutoDiscover?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    const next = () => argv[++i];
    switch (arg) {
      case "--target":
      case "-t":
        out.target = next();
        break;
      case "--host":
        out.host = next();
        break;
      case "--port":
        out.port = Number(next());
        break;
      case "--listen-host":
        out.listenHost = next();
        break;
      case "--listen-port":
      case "-l":
        out.listenPort = Number(next());
        break;
      case "--width":
        out.width = Number(next());
        break;
      case "--height":
        out.height = Number(next());
        break;
      case "--max-fps":
        out.maxFps = Number(next());
        break;
      case "--format": {
        const v = next();
        if (v === "png" || v === "jpeg") out.format = v;
        break;
      }
      case "--quality":
        out.quality = Number(next());
        break;
      case "--no-auto-discover":
        out.noAutoDiscover = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`unknown arg: ${arg}`);
        printHelp();
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`browserface — human UI for a CDP browser session

Usage:
  browserface [options]

By default, browserface discovers your already-running Chrome by reading
DevToolsActivePort from each known profile directory. If none is enabled yet,
it opens chrome://inspect/#remote-debugging so you can tick the sticky toggle.

CDP target (skips auto-discovery):
  --target, -t <url>       Full CDP WebSocket URL (browser- or page-level)
  --host <host>            CDP host (default 127.0.0.1)
  --port <port>            CDP port (no default — set this to skip discovery)
  --no-auto-discover       Fail instead of running auto-discovery

Server:
  --listen-host <host>     HTTP/WS bind host (default 127.0.0.1)
  --listen-port, -l <port> HTTP/WS bind port (default 5252)

Viewport / capture:
  --width <px>             Override viewport width (Emulation.setDeviceMetricsOverride)
  --height <px>            Override viewport height
  --max-fps <n>            Cap emitted frames/sec (default 30; 0 disables)
  --format <png|jpeg>      Screenshot format (default jpeg)
  --quality <0-100>        JPEG quality (default 60)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts: BridgeOptions = {};
  if (args.target) opts.target = args.target;
  if (args.host) opts.host = args.host;
  if (args.port) opts.port = args.port;
  if (args.listenHost) opts.listenHost = args.listenHost;
  if (args.listenPort) opts.listenPort = args.listenPort;
  // Cap emitted frame rate by default. A 60 Hz updating page (canvas, video,
  // many SPAs) would otherwise spam every connected client with frames the
  // user can't perceive — 30 fps is plenty smooth. Pass --max-fps 0 to
  // disable. Pass --max-fps <n> to override.
  opts.maxFps = args.maxFps !== undefined ? args.maxFps : 30;
  if (args.format) opts.screenshotFormat = args.format;
  if (args.quality !== undefined) opts.screenshotQuality = args.quality;
  if (args.width && args.height) {
    opts.viewport = { width: args.width, height: args.height };
  }
  if (args.noAutoDiscover) opts.autoDiscover = false;

  const handle = await startBridge(opts);

  const shutdown = async (signal: string) => {
    console.log(`\n[browserface] received ${signal}, shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[browserface] failed to start:", err);
  process.exit(1);
});
