// Discover an already-running Chromium-based browser via the DevToolsActivePort
// file each profile writes when remote-debugging is enabled. Mirrors the strategy
// used by browser-harness: don't relaunch Chrome, just read the port the user's
// Chrome already published, and prompt them to enable the per-profile sticky
// `chrome://inspect/#remote-debugging` toggle on first run.

import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Profile directories Chrome / Edge / Brave / Chromium write into. First-match wins.
function profileDirs(): string[] {
  const home = homedir();
  return [
    // macOS
    join(home, "Library/Application Support/Google/Chrome"),
    join(home, "Library/Application Support/Microsoft Edge"),
    join(home, "Library/Application Support/Microsoft Edge Beta"),
    join(home, "Library/Application Support/Microsoft Edge Dev"),
    join(home, "Library/Application Support/Microsoft Edge Canary"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
    join(home, "Library/Application Support/Chromium"),
    // Linux
    join(home, ".config/google-chrome"),
    join(home, ".config/chromium"),
    join(home, ".config/chromium-browser"),
    join(home, ".config/microsoft-edge"),
    join(home, ".config/microsoft-edge-beta"),
    join(home, ".config/microsoft-edge-dev"),
    join(home, ".config/BraveSoftware/Brave-Browser"),
    // Linux (Flatpak)
    join(home, ".var/app/com.google.Chrome/config/google-chrome"),
    join(home, ".var/app/org.chromium.Chromium/config/chromium"),
    join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
    join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    // Windows
    join(home, "AppData/Local/Google/Chrome/User Data"),
    join(home, "AppData/Local/Chromium/User Data"),
    join(home, "AppData/Local/Microsoft/Edge/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Dev/User Data"),
    join(home, "AppData/Local/Microsoft/Edge SxS/User Data"),
    join(home, "AppData/Local/BraveSoftware/Brave-Browser/User Data"),
  ];
}

export interface DevToolsEndpoint {
  host: string; // always 127.0.0.1 — Chrome only listens on loopback for this
  port: number;
  // Browser-level WebSocket URL; useful as a fallback when /json/* is disabled.
  browserWsUrl: string;
  // The profile directory this came from, for diagnostics.
  profileDir: string;
}

export async function readDevToolsActivePort(profile: string): Promise<DevToolsEndpoint | null> {
  const file = join(profile, "DevToolsActivePort");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const portStr = lines[0];
  const path = lines[1] ?? "";
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    host: "127.0.0.1",
    port,
    browserWsUrl: `ws://127.0.0.1:${port}${path}`,
    profileDir: profile,
  };
}

export async function findFirstActivePort(): Promise<DevToolsEndpoint | null> {
  for (const dir of profileDirs()) {
    const ep = await readDevToolsActivePort(dir);
    if (ep) return ep;
  }
  return null;
}

export async function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
  });
}

export async function waitForPort(
  host: string,
  port: number,
  deadlineMs: number,
): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (await probePort(host, port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Open chrome://inspect/#remote-debugging in the user's already-running Chrome
// so they can tick the sticky "Allow" checkbox. Best-effort: silent if it fails.
export async function openChromeInspect(): Promise<void> {
  const url = "chrome://inspect/#remote-debugging";
  if (platform() === "darwin") {
    await new Promise<void>((resolve) => {
      const proc = spawn(
        "osascript",
        [
          "-e",
          'tell application "Google Chrome" to activate',
          "-e",
          `tell application "Google Chrome" to open location "${url}"`,
        ],
        { stdio: "ignore" },
      );
      proc.on("exit", () => resolve());
      proc.on("error", () => resolve());
    });
    return;
  }
  // On Linux/Windows we can't reliably open a chrome:// URL from outside Chrome —
  // the user has to paste it. Fall through silently.
}

export interface DiscoverOptions {
  // Total time to spend trying, including waiting for the user to tick Allow.
  timeoutMs?: number;
  // Whether to escalate by opening chrome://inspect when no live port is found.
  autoOpenInspect?: boolean;
  // Override the profile directory list (used for tests).
  profileDirs?: string[];
  // Optional logger for human-facing progress.
  log?: (msg: string) => void;
}

export class DiscoveryError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export async function discoverChrome(opts: DiscoverOptions = {}): Promise<DevToolsEndpoint> {
  const log = opts.log ?? (() => {});
  const autoOpen = opts.autoOpenInspect ?? true;
  const deadlineMs = Date.now() + (opts.timeoutMs ?? 90_000);
  const dirs = opts.profileDirs ?? profileDirs();

  const readAny = async (): Promise<DevToolsEndpoint | null> => {
    for (const d of dirs) {
      const ep = await readDevToolsActivePort(d);
      if (ep) return ep;
    }
    return null;
  };

  // 1. Initial read.
  let endpoint = await readAny();

  // 2. If we have an endpoint and the port is live, we're done.
  if (endpoint && (await probePort(endpoint.host, endpoint.port))) {
    return endpoint;
  }

  // 3. Either no DevToolsActivePort, or a stale one (port not listening).
  //    Both cases mean the per-profile sticky toggle isn't currently in effect.
  if (autoOpen) {
    log(
      "[browserface] enabling Chrome remote-debugging — opening chrome://inspect/#remote-debugging.\n" +
        "  In the tab that opens: tick 'Discover network targets' and click 'Allow' if prompted.\n" +
        "  (This setting sticks per-profile, so subsequent runs won't need it.)",
    );
    await openChromeInspect();
  } else if (!endpoint) {
    throw new DiscoveryError(
      "No Chrome with remote-debugging enabled found.",
      "Open chrome://inspect/#remote-debugging in your Chrome and tick the checkbox, or pass --target / --port explicitly.",
    );
  }

  // 4. Poll: re-read DevToolsActivePort (Chrome rewrites it on enable) and probe
  //    the port until something comes up or we hit the deadline.
  let lastLogged = 0;
  while (Date.now() < deadlineMs) {
    endpoint = await readAny();
    if (endpoint && (await probePort(endpoint.host, endpoint.port))) {
      return endpoint;
    }
    const now = Date.now();
    if (now - lastLogged > 5_000) {
      log("[browserface] waiting for remote-debugging port to come up…");
      lastLogged = now;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  throw new DiscoveryError(
    "Timed out waiting for Chrome remote-debugging.",
    "If chrome://inspect didn't open automatically, open it manually, tick 'Discover network targets', and click 'Allow'.",
  );
}
