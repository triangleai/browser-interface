# browserface

A lightweight human interface for live browser sessions over Chrome DevTools Protocol (CDP).

browserface gives humans the same primitives an agent uses — click, type,
scroll, navigate — over a Chromium session that may be running anywhere
(local, VPS, ECS/Fargate). Instead of streaming a remote desktop or shipping a
full browser UI, it provides a minimal, structured surface: periodic
screenshots, page state, and a JSON action protocol over WebSocket.

It is the human counterpart to agent control layers like Playwright or Browser
Harness. Agents and humans share the same control surface, which means
intervention — handling a login, clearing a 2FA prompt, correcting an action —
is a smooth handoff rather than a context switch.

## How it works

```
Chromium (anywhere, headless OK)
  ↓ CDP WebSocket
Browser Session (chrome-remote-interface)
  ↓ extracts state (Page.captureScreenshot, Runtime, DOM, page events)
  ↓ dispatches actions (Input.dispatchMouseEvent / dispatchKeyEvent / insertText)
Bridge (HTTP + WebSocket)
  ↓ JSON protocol
Client UI (any browser) — and/or agents
```

## Install

```sh
npm install
npm run build
```

## Run

By default browserface attaches to your **already-running daily-driver
Chrome**. Same trick browser-harness uses: Chrome has a per-profile sticky
toggle at `chrome://inspect/#remote-debugging` that, once ticked, makes Chrome
auto-enable CDP on every launch and write the dynamic port to
`<profile>/DevToolsActivePort`. browserface reads that file, probes the
port, and connects via the browser-level WebSocket — no `--remote-debugging-port`
launch flag, no separate Chrome instance.

```sh
npm start
```

The first run opens `chrome://inspect/#remote-debugging` for you (via
AppleScript on macOS). Tick the checkbox, click `Allow`, and the bridge attaches
within a few seconds. Future runs skip the prompt — the toggle is sticky.

Then open <http://127.0.0.1:8787>.

### Other connection modes

```sh
# Skip discovery and connect to a specific CDP port (e.g. headless container):
npm start -- --host 127.0.0.1 --port 9222

# Or a specific WS URL (page-level or browser-level):
npm start -- --target ws://127.0.0.1:9222/devtools/browser/<id>

# Print connection commands for an already-running Chrome:
npm run find-chrome

# Headless Chrome for testing:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --headless=new --no-first-run \
  --user-data-dir=/tmp/cdp-profile about:blank &
npm start -- --port 9222
```

### CLI flags

| Flag | Description |
| --- | --- |
| _(none)_ | Auto-discover via `DevToolsActivePort` (default) |
| `--target, -t <url>` | Full CDP WebSocket URL (browser- or page-level) |
| `--host <host>` | CDP host (default `127.0.0.1`) |
| `--port <port>` | CDP port — set this to skip auto-discovery |
| `--no-auto-discover` | Disable discovery; require `--target` or `--port` |
| `--listen-host <host>` | UI bind host (default `127.0.0.1`) |
| `--listen-port, -l <port>` | UI bind port (default `8787`) |
| `--width <px>` `--height <px>` | Override viewport via `Emulation.setDeviceMetricsOverride` |
| `--max-fps <n>` | Cap emitted frames per second (default `30`; `0` disables) |
| `--format <png\|jpeg>` | Screenshot format (default `jpeg`) |
| `--quality <0-100>` | JPEG quality (default `60`) |

### Finding Chrome targets

`npm run find-chrome` reads Chrome's `DevToolsActivePort` file and prints
ready-to-run commands for connecting browserface to that Chrome. Run it
on the machine where Chrome is running.

For a local Chrome:

```sh
npm run find-chrome
```

For a Chrome running on another machine, run the same command on that machine.
The output includes a direct `npm start -- --target ...` command and an SSH
tunnel workflow using `ssh -N -L`.

### Behind ngrok

```sh
npm start                                                # binds 127.0.0.1:8787
ngrok http 8787 --oauth google --oauth-allow-email you@example.com
```

HTTP tunnel only — `/ws` needs the upgrade. CDP stays bound to localhost;
only the bridge port is exposed. The bridge has no auth of its own, so
always front it with `--oauth`, `--basic-auth`, or `--cidr-allow` —
whoever loads the URL drives your browser.

## Develop

```sh
npm run dev -- --host 127.0.0.1 --port 9222
```

Watches the server and client; restarts the bridge on changes.

## Programmatic use

```ts
import { startBridge } from "browserface";

const handle = await startBridge({
  host: "127.0.0.1",
  port: 9222,
  listenPort: 8787,
});
// later:
await handle.close();
```

The same `BrowserSession` class is exported for headless / agent use without
the HTTP UI:

```ts
import { BrowserSession } from "browserface";

const session = new BrowserSession({ host: "127.0.0.1", port: 9222 });
await session.connect();
await session.dispatch({ type: "navigate", url: "https://example.com" });
session.on("screenshot", (frame) => {
  // frame.data is base64-encoded png/jpeg
});
session.startScreenshotLoop();
```

## Protocol

`src/shared/protocol.ts` is the single source of truth for the wire format —
every message between server and client (and any agent) uses these types. The
server pushes `screenshot`, `page`, `ready`, `ack`, `error`. Clients send
`hello` and `action` with one of: `click`, `mousemove`, `type`, `key`,
`scroll`, `navigate`, `reload`, `back`, `forward`.

## Status

This is the initial scaffold: screenshots + input dispatch + minimal UI.
Planned next: DOM-extracted element overlays, action replay/logging, and an
agent-side helper that speaks the same protocol.
