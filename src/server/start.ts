// browser/start — launch a dedicated agent Chrome, or attach to one that
// is already running.
//
//   1. Try to attach: read DevToolsActivePort and probe the port.
//   2. If alive but no tabs (macOS keeps Chrome.app running with no
//      windows), open a chrome://newtab/ tab so a window comes back.
//   3. Otherwise launch Chrome with --user-data-dir and -remote-debugging-port,
//      wait for it to publish DevToolsActivePort, bail early if it dies.
//
// Output: CDP WebSocket URL on stdout (one line). Status messages and
// errors go to stderr.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agentProfileDir, probePort, readDevToolsActivePort } from "./discover.js";

interface StartArgs {
  profileDir: string;
  binaryOverride?: string;
  requestedPort?: number;
  noLaunch: boolean;
}

function printHelp(): void {
  console.log(`browser/start — launch a dedicated Chrome with remote debugging
enabled, using its own profile so the user's own Chrome is untouched.
Idempotent: if the profile is already running, just prints its CDP
WebSocket URL.

Usage:
  browser/start                            launch (or attach to) the agent profile
  browser/start --user-data-dir <dir>      override profile location (default ~/.browserface/chrome)
  browser/start --chromium-binary <path>   override binary lookup
  browser/start --port <n>                 request a specific debug port (default lets Chrome pick)
  browser/start --no-launch                only attach if already running; error otherwise
  browser/start --help, -h                 print this help

Binary lookup, in order:
  1. --chromium-binary <path>   explicit override
  2. system Chrome              /Applications/Google Chrome.app on macOS;
                                google-chrome / chromium on Linux
  3. PLAYWRIGHT_BROWSERS_PATH   workspace-vendored Playwright Chromium
  4. default Playwright cache   ~/Library/Caches/ms-playwright (macOS)
                                ~/.cache/ms-playwright (Linux)

Output: prints the CDP WebSocket URL on stdout (one line). Status messages
go to stderr. Exit 0 on success.

Why a dedicated profile: Chrome only suppresses the per-connect "Allow
remote debugging" popup when the debug port was opened at launch via
--remote-debugging-port. The chrome://inspect-toggle path keeps prompting,
which doesn't work for autonomous agents. Launching our own Chrome side-
steps that and also keeps the agent's blast radius scoped to one profile
instead of the owner's full browsing.`);
}

function parseStartArgs(argv: string[]): StartArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "user-data-dir": { type: "string" },
        "chromium-binary": { type: "string" },
        "port": { type: "string" },
        "no-launch": { type: "boolean" },
        "help": { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`browser/start: ${msg}`);
    process.exit(1);
  }
  const { values } = parsed;
  if (values["help"]) {
    printHelp();
    process.exit(0);
  }
  let requestedPort: number | undefined;
  if (values["port"] !== undefined) {
    const n = Number(values["port"]);
    if (!Number.isInteger(n) || n < 0) {
      console.error(
        `browser/start: --port must be a non-negative integer (got '${values["port"]}')`,
      );
      process.exit(1);
    }
    requestedPort = n;
  }
  return {
    profileDir: values["user-data-dir"] ?? agentProfileDir(),
    binaryOverride: values["chromium-binary"],
    requestedPort,
    noLaunch: values["no-launch"] ?? false,
  };
}

// ── binary lookup ─────────────────────────────────────────────────────────

// Walk PATH for the first executable named `cmd`. Avoids spawning `which`.
function whichSync(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

// Best Playwright chromium revision under <root>/chromium-* (newest mtime),
// returning the executable inside it. Null if `root` is missing or no
// revision has the platform binary.
function playwrightBinaryIn(root: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  let bestDir: string | null = null;
  let bestMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.startsWith("chromium-")) continue;
    const dir = join(root, entry);
    try {
      const m = statSync(dir).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        bestDir = dir;
      }
    } catch {
      continue;
    }
  }
  if (!bestDir) return null;
  const candidate =
    platform() === "darwin"
      ? join(bestDir, "chrome-mac/Chromium.app/Contents/MacOS/Chromium")
      : platform() === "linux"
        ? join(bestDir, "chrome-linux/chrome")
        : null;
  return candidate && existsSync(candidate) ? candidate : null;
}

function findChromeBinary(override: string | undefined): string {
  if (override) {
    try {
      accessSync(override, constants.X_OK);
    } catch {
      console.error(`browser/start: --chromium-binary '${override}' not found or not executable`);
      process.exit(1);
    }
    return override;
  }
  if (platform() === "darwin") {
    const sys = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(sys)) return sys;
  } else if (platform() === "linux") {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      const p = whichSync(name);
      if (p) return p;
    }
  }
  // Workspace Playwright cache, then default.
  const roots: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform() === "darwin") roots.push(join(homedir(), "Library/Caches/ms-playwright"));
  else if (platform() === "linux") roots.push(join(homedir(), ".cache/ms-playwright"));
  for (const root of roots) {
    const found = playwrightBinaryIn(root);
    if (found) return found;
  }
  console.error("browser/start: no Chrome or Chromium binary found.");
  console.error("  Tried: system Chrome, $PLAYWRIGHT_BROWSERS_PATH, default Playwright cache.");
  console.error(
    "  Install Chrome, or run 'npx playwright install chromium', or pass --chromium-binary <path>.",
  );
  process.exit(1);
}

// ── /json probe + new tab ─────────────────────────────────────────────────

interface JsonTarget {
  type: string;
}

// True if Chrome at $port has at least one page-type target. macOS keeps
// Chrome.app alive after the last window is closed, so the CDP port stays
// bound but /json reports zero page targets — visually nothing's there.
async function hasPageTarget(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const targets = (await res.json()) as JsonTarget[];
    return targets.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

// Open a fresh new-tab page so a window comes up.
async function openNewTab(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/new?chrome://newtab/`, {
    method: "PUT",
    signal: AbortSignal.timeout(2000),
  });
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseStartArgs(process.argv.slice(2));

  // Already running?
  const live = await readDevToolsActivePort(args.profileDir);
  if (live && (await probePort(live.host, live.port))) {
    if (!(await hasPageTarget(live.port))) {
      console.error("browser/start: agent Chrome is alive but has no open windows; opening one.");
      await openNewTab(live.port).catch(() => {
        console.error("browser/start: warning: PUT /json/new failed");
      });
    }
    console.log(live.browserWsUrl);
    return;
  }

  if (args.noLaunch) {
    console.error(
      `browser/start: --no-launch and no agent Chrome is running at ${args.profileDir}`,
    );
    process.exit(1);
  }

  const binary = findChromeBinary(args.binaryOverride);
  mkdirSync(args.profileDir, { recursive: true });

  // --remote-debugging-port=0 lets Chrome pick a free port; the actual port
  // lands in DevToolsActivePort.
  const launchArgs = [
    `--user-data-dir=${args.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${args.requestedPort ?? 0}`,
  ];
  console.error(`browser/start: launching ${binary}`);
  const child = spawn(binary, launchArgs, { detached: true, stdio: "ignore" });
  child.unref();

  // Wait up to 30s for Chrome to write DevToolsActivePort and start
  // listening. Bail early if Chrome itself exits — typical cause: another
  // Chrome process already holds the profile lock.
  const deadlineMs = Date.now() + 30_000;
  while (Date.now() < deadlineMs) {
    const ep = await readDevToolsActivePort(args.profileDir);
    if (ep && (await probePort(ep.host, ep.port))) {
      console.log(ep.browserWsUrl);
      return;
    }
    if (child.exitCode !== null) {
      console.error("browser/start: Chrome exited before publishing DevToolsActivePort.");
      console.error(`  Likely: another Chrome process already holds ${args.profileDir}.`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(
    `browser/start: Chrome launched but DevToolsActivePort never came up at ${args.profileDir}/DevToolsActivePort`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("browser/start:", err?.message ?? err);
  process.exit(1);
});
