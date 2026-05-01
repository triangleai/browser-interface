# browserface

A lightweight human interface for live browser sessions over Chrome DevTools Protocol (CDP).

<video src="https://github.com/browserface/browserface/raw/main/docs/demo.mp4" controls width="100%"></video>

browserface gives humans the same primitives an agent uses — click, type,
scroll, navigate — over a Chromium session that may be running anywhere
(local, VPS, ECS/Fargate).

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

## Run

Run browserface from a clone of this repo:

```sh
git clone https://github.com/browserface/browserface
cd browserface
browser/face
```

By default browserface starts and attaches to its **own dedicated Chrome
profile** at `~/.browserface/chrome`, separate from your own Chrome. The
`browser/face` wrapper auto-runs `browser/start` to bring it up — no
setup, no popups, no overlap with your everyday browsing. The profile
persists, so once you sign into Gmail / Slack / etc. in it, those
sessions stick around for the next run.

Then open <http://127.0.0.1:8768>.

Why a dedicated profile by default: Chrome only suppresses the per-connect
"Allow remote debugging" popup when the debug port was opened at launch
via `--remote-debugging-port`. Attaching to your own Chrome via the
`chrome://inspect`-toggle path triggers that popup on every connect —
fine for the human ad-hoc use case, painful for autonomous agents. The
agent-profile default sidesteps it entirely. As a bonus, the agent's
blast radius is scoped to one profile, so bank tabs / work email / etc.
in your own Chrome are simply not reachable.

### Attach to your own Chrome instead

Pass `--discover` to use the original `chrome://inspect`-toggle flow
against your existing Chrome:

```sh
browser/face --discover
```

The first run opens `chrome://inspect/#remote-debugging` for you (via
AppleScript on macOS). Tick the checkbox, click `Allow`, and the bridge
attaches within a few seconds. Future runs skip the prompt — the toggle
is sticky.

### Other connection modes

```sh
# Specific CDP port (e.g. headless container):
browser/face --host 127.0.0.1 --port 9222

# Specific WS URL (page-level or browser-level):
browser/face --target ws://127.0.0.1:9222/devtools/browser/<id>

# Print connection commands for a Chrome on this or another machine:
browser/find

# Headless Chrome for testing:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --headless=new --no-first-run \
  --user-data-dir=/tmp/cdp-profile about:blank &
browser/face --port 9222
```

### The agent profile in detail

`browser/start` is the launcher behind the default mode. Idempotent — run
it directly to bring up the agent Chrome without starting the bridge:

```sh
browser/start    # launches Chrome with --user-data-dir=~/.browserface/chrome --remote-debugging-port=...
                 # prints the CDP WebSocket URL on stdout
```

Binary lookup, in order: `--chromium-binary <path>` → system Chrome
(`/Applications/Google Chrome.app` on macOS, `google-chrome`/`chromium`
on Linux) → `$PLAYWRIGHT_BROWSERS_PATH` if set → default Playwright cache
(`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on
Linux). Run `npx playwright install chromium` if neither system Chrome
nor a Playwright cache is present.

### CLI flags

| Flag | Description |
| --- | --- |
| _(none)_ | Attach to the agent profile (default; `browser/face` wrapper auto-runs `browser/start`) |
| `--discover` | Attach to your own Chrome via the `chrome://inspect`-toggle flow instead |
| `--target <url>` | Full CDP WebSocket URL (browser- or page-level) |
| `--host <host>` | CDP host (default `127.0.0.1`) |
| `--port <port>` | CDP port |
| `--listen-host <host>` | UI bind host (default `127.0.0.1`) |
| `--listen-port <port>` | UI bind port (default `8768`) |
| `--width <px>` `--height <px>` | Override viewport via `Emulation.setDeviceMetricsOverride` |
| `--max-fps <n>` | Cap emitted frames per second (default `30`; `0` disables) |
| `--format <png\|jpeg>` | Screenshot format (default `jpeg`) |
| `--quality <0-100>` | JPEG quality (default `60`) |

### Finding Chrome targets

`browser/find` reads Chrome's `DevToolsActivePort` file and prints
ready-to-run commands for connecting browserface to that Chrome. Run it
on the machine where Chrome is running.

For a local Chrome:

```sh
browser/find
```

For a Chrome running on another machine, run the same command on that machine.
The output includes a direct `browser/face --target ...` command and an SSH
tunnel workflow using `ssh -N -L`.

### Sharing

```sh
browser/share --oauth google --oauth-allow-email you@example.com
```

`browser/share` exposes the bridge over a public URL. See the script's
header for available auth flags and the security caveat.

To skip repeating auth flags on every invocation, save them once with
`browser/config`:

```sh
browser/config set auth --oauth google --oauth-allow-email you@example.com
browser/share you.ngrok.app
```

`browser/config` writes the flags to `~/.browserface/auth`; `browser/share`
reads that file whenever no auth flag is on the CLI. Any auth flag (or
`--auth-disabled`) on the CLI suppresses the file fallback for that
invocation, so per-task overrides still work.

Other commands:

```sh
browser/config show           # print all settings
browser/config show auth      # print one
browser/config clear auth     # remove ~/.browserface/auth
```

## Develop

```sh
browser/face dev --host 127.0.0.1 --port 9222
```

Watches the server and client; restarts the bridge on changes.

## Programmatic use

```ts
import { startBridge } from "browserface";

const handle = await startBridge({
  host: "127.0.0.1",
  port: 9222,
  listenPort: 8768,
});
// later:
await handle.close();
```

`startBridge({})` (no options) attaches to the agent profile at
`~/.browserface/chrome` and throws if it isn't running — bring it up with
the `browser/start` script first, or pass `discoverUserChrome: true` to
fall back to the chrome://inspect-toggle flow against your own Chrome.

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

