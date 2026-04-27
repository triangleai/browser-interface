import CDP from "chrome-remote-interface";
import { EventEmitter } from "node:events";
import type {
  ClientAction,
  HoverMessage,
  InactiveTabMessage,
  ModifierKey,
  PageStateMessage,
  ScreenshotMessage,
  TabInfo,
  TabsMessage,
  VisibilityMessage,
} from "../shared/protocol.js";
import { keyDescriptorFor } from "./keymap.js";

export interface BrowserSessionOptions {
  // Either pass a full ws:// URL (browser- or page-level), or host/port. If
  // host/port is given, the session will fetch the browser ws URL via
  // /json/version, falling back to constructing it from a Target query.
  target?: string;
  host?: string;
  port?: number;
  // Optional explicit page-target id to attach to. If omitted we pick the first
  // real (non chrome://, non devtools://) page; if there are none we create one.
  targetId?: string;
  // When switching tabs, also bring the new tab to the foreground in the user's
  // actual Chrome window via Target.activateTarget. Default true — Chrome's
  // compositor only commits frames for the foreground-visible tab, so without
  // this the screencast goes silent on switch. Set false if you'd rather not
  // disturb the user's window and accept that backgrounded tabs won't render.
  activateOnSwitch?: boolean;
  // Screencast config. Frames are pushed by Chrome via Page.screencastFrame
  // events whenever the visible content changes.
  screenshotFormat?: "png" | "jpeg";
  screenshotQuality?: number; // jpeg only, 0-100
  // Drop frames between captures: 1 = every frame (default), 2 = every 2nd, etc.
  // Useful to throttle bandwidth on remote / slow links.
  everyNthFrame?: number;
  // Deprecated: pre-screencast polling interval. Honored as a hint to compute
  // everyNthFrame if `everyNthFrame` itself isn't set.
  screenshotIntervalMs?: number;
  // Optional viewport override applied via Emulation.setDeviceMetricsOverride.
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
}

const MODIFIER_BITS: Record<ModifierKey, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

function modifierMask(mods?: ModifierKey[]): number {
  if (!mods) return 0;
  return mods.reduce((acc, m) => acc | MODIFIER_BITS[m], 0);
}

// URL prefixes for targets that *aren't* user-visible browser tabs — they're
// internal Chrome surfaces that show up as `type: "page"` in CDP but the user
// would never expect to see them in a tab list (omnibox popup, extension
// background pages, devtools windows, etc.).
const HIDDEN_URL_PREFIXES = [
  "chrome-search://", // omnibox / NTP popup
  "chrome-untrusted://", // sandboxed internal UIs
  "chrome-extension://", // extension popups & background pages
  "devtools://", // DevTools instances
];

// chrome://<name>.top-chrome/ URLs are WebUI surfaces embedded in Chrome's
// browser frame (omnibox popup, tab search, side panels). They look like pages
// in CDP but they aren't tabs the user can navigate to.
const TOP_CHROME_RE = /^chrome:\/\/[^/]*\.top-chrome\//;

// User-visible tab: any page target that isn't a Chrome-internal surface.
// Includes about:blank, chrome://newtab/, http(s)://, file://, etc.
function isUserVisibleTab(t: { type?: string; url?: string }): boolean {
  if (t.type !== "page") return false;
  const url = t.url ?? "";
  if (HIDDEN_URL_PREFIXES.some((p) => url.startsWith(p))) return false;
  if (TOP_CHROME_RE.test(url)) return false;
  return true;
}

// Pages with real navigable content. Used when picking a default page target
// at connect time — we'd rather attach to https://github.com than chrome://newtab.
const INTERNAL_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "chrome-search://",
  "about:",
  "edge://",
];

function isRealPage(t: { type?: string; url?: string }): boolean {
  if (t.type !== "page") return false;
  const url = t.url ?? "";
  return !INTERNAL_URL_PREFIXES.some((p) => url.startsWith(p));
}

// chrome-remote-interface's typed `send` requires a literal keyof Commands; we
// route everything through this loose wrapper so we can pass dynamic method
// names (e.g. "Page.captureScreenshot") and sessionIds. We must call it as
// a method on `client` to preserve `this`.
function rawSend(
  client: CDP.Client,
  method: string,
  params: unknown = {},
  sessionId?: string,
): Promise<unknown> {
  const c = client as unknown as {
    send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  };
  return c.send(method, params, sessionId);
}

// Race a promise against a deadline. Returns null if the deadline is hit first.
// Useful for guarding any CDP call that might hang (e.g. on a discarded tab
// where the renderer can't respond).
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Probe each candidate target for document.visibilityState === "visible".
// Whichever returns visible is the foreground tab in its window. In typical
// single-window setups this picks out the one tab the user is actively viewing;
// with multiple windows we just take the first match. Probes run in parallel
// with timeouts so a single unresponsive tab (frozen, attach-blocked, etc.)
// can't hang connect — if no probe returns visible within the deadline, the
// caller falls back to the legacy first-real-page pick.
async function findActiveTargetId(
  client: CDP.Client,
  targetIds: string[],
): Promise<string | null> {
  if (targetIds.length === 0) return null;
  const PROBE_TIMEOUT_MS = 1500;
  const TOTAL_TIMEOUT_MS = 3000;

  const probe = async (targetId: string): Promise<string | null> => {
    let sessionId: string | null = null;
    try {
      const attached = (await withTimeout(
        rawSend(client, "Target.attachToTarget", { targetId, flatten: true }),
        PROBE_TIMEOUT_MS,
      )) as { sessionId: string } | null;
      if (!attached) return null;
      sessionId = attached.sessionId;
      const evalRes = (await withTimeout(
        rawSend(
          client,
          "Runtime.evaluate",
          { expression: "document.visibilityState", returnByValue: true },
          sessionId,
        ),
        PROBE_TIMEOUT_MS,
      )) as { result?: { value?: string } } | null;
      return evalRes?.result?.value === "visible" ? targetId : null;
    } catch {
      return null;
    } finally {
      // Fire-and-forget detach so a hung detach can't keep the probe alive.
      if (sessionId) {
        rawSend(client, "Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
  };

  const all = Promise.all(targetIds.map(probe)).then(
    (results) => results.find((r) => r !== null) ?? null,
  );
  return (await withTimeout(all, TOTAL_TIMEOUT_MS)) ?? null;
}

export interface BrowserSessionEvents {
  screenshot: (msg: ScreenshotMessage) => void;
  page: (msg: PageStateMessage) => void;
  tabs: (msg: TabsMessage) => void;
  visibility: (msg: VisibilityMessage) => void;
  inactive: (msg: InactiveTabMessage) => void;
  hover: (msg: HoverMessage) => void;
  closed: () => void;
}

export declare interface BrowserSession {
  on<K extends keyof BrowserSessionEvents>(event: K, listener: BrowserSessionEvents[K]): this;
  off<K extends keyof BrowserSessionEvents>(event: K, listener: BrowserSessionEvents[K]): this;
  emit<K extends keyof BrowserSessionEvents>(
    event: K,
    ...args: Parameters<BrowserSessionEvents[K]>
  ): boolean;
}

interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

export class BrowserSession extends EventEmitter {
  private client: CDP.Client | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private frameCount = 0;
  private screencasting = false;
  private viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
  private lastPage: PageStateMessage = { type: "page", url: "", title: "", loading: false };
  // Tracked page targets: targetId → {url, title}. Maintained via Target.* events.
  private tabs = new Map<string, { url: string; title: string }>();
  // Whether our attached tab is currently foreground-visible in real Chrome.
  // Updated from Page.screencastVisibilityChanged.
  private visible = true;
  // Hover detection: throttled lookup of <a href> at the user's mouse position.
  private lastMouseX = 0;
  private lastMouseY = 0;
  private hoverTimer: NodeJS.Timeout | null = null;
  private hoverPending = false;
  private lastHoveredHref: string | null = null;
  // Idle timer that auto-clears the hovered URL ~3s after the user last
  // hovered a link, so it lingers long enough to be selectable in the status
  // bar but doesn't sit there permanently when the user has moved on.
  private hoverIdleTimer: NodeJS.Timeout | null = null;

  constructor(private opts: BrowserSessionOptions = {}) {
    super();
  }

  async connect(): Promise<void> {
    // Prefer a direct browser ws URL over /json/* discovery, since newer Chrome
    // builds may 404 the HTTP CDP endpoints. If only host/port is given, we
    // resolve the browser ws via /json/version with a loose fallback.
    const target = this.opts.target ?? (await this.resolveBrowserWsUrl());
    const cdpOpts: CDP.Options = { target, local: true };
    const client = await CDP(cdpOpts);
    this.client = client;

    // Pick a page target and attach with flatten:true so we get a per-page sessionId.
    const targetInfo = await this.pickPageTarget(client);
    this.targetId = targetInfo.targetId;
    const attached = (await rawSend(client, "Target.attachToTarget", {
      targetId: targetInfo.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;

    this.lastPage = {
      type: "page",
      url: targetInfo.url ?? "",
      title: targetInfo.title ?? "",
      loading: false,
    };
    this.emit("page", this.lastPage);

    // Enable the domains we care about on the page session. Best-effort —
    // a couple of these can fail on edge-case targets and we keep going.
    for (const domain of ["Page", "DOM", "Runtime", "Network"]) {
      try {
        await this.send(`${domain}.enable`, {});
      } catch (err) {
        console.warn(`[browser-interface] enable ${domain} failed:`, err);
      }
    }

    if (this.opts.viewport) {
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: this.opts.viewport.width,
        height: this.opts.viewport.height,
        deviceScaleFactor: this.opts.viewport.deviceScaleFactor ?? 1,
        mobile: this.opts.viewport.mobile ?? false,
      });
      this.viewport = {
        width: this.opts.viewport.width,
        height: this.opts.viewport.height,
        deviceScaleFactor: this.opts.viewport.deviceScaleFactor ?? 1,
      };
    } else {
      try {
        const evalRes = (await this.send("Runtime.evaluate", {
          expression:
            "JSON.stringify({width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio})",
          returnByValue: true,
        })) as { result: { value?: unknown } };
        const v = JSON.parse(String(evalRes.result.value ?? "{}"));
        if (typeof v.width === "number" && typeof v.height === "number") {
          this.viewport = {
            width: v.width,
            height: v.height,
            deviceScaleFactor: v.dpr ?? 1,
          };
        }
      } catch {
        // keep defaults
      }
    }

    // Populate the initial tab list, then subscribe to live target events at the
    // browser level (no sessionId on these).
    const allTargets = (await rawSend(client, "Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    for (const t of allTargets.targetInfos.filter(isUserVisibleTab)) {
      this.tabs.set(t.targetId, { url: t.url, title: t.title });
    }
    try {
      await rawSend(client, "Target.setDiscoverTargets", { discover: true });
    } catch (err) {
      console.warn("[browser-interface] Target.setDiscoverTargets failed:", err);
    }
    this.emitTabs();

    // Filter incoming events to our session and dispatch the ones we care about.
    client.on("event", (ev: CdpEvent) => this.handleEvent(ev));
    client.on("disconnect", () => this.emit("closed"));

    void this.refreshTitle();
    await this.startScreencast();
  }

  private async resolveBrowserWsUrl(): Promise<string> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port;
    if (!port) {
      throw new Error(
        "BrowserSessionOptions: pass `target` (full ws URL) or `port` (with optional `host`)",
      );
    }
    // Try /json/version — works on most Chrome builds.
    try {
      const res = await fetch(`http://${host}:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch {
      // fall through
    }
    // Fallback: assume the standard browser-level path. Chrome accepts a connect
    // to /devtools/browser without an id when no specific browser target is
    // expected, but most builds require the id from DevToolsActivePort. If we
    // got here, the caller really should have passed `target` directly.
    throw new Error(
      `Could not resolve browser ws URL from http://${host}:${port}/json/version. ` +
        `Pass --target ws://${host}:${port}/devtools/browser/<id> explicitly.`,
    );
  }

  private async pickPageTarget(client: CDP.Client): Promise<{
    targetId: string;
    url?: string;
    title?: string;
  }> {
    const { targetInfos } = (await rawSend(client, "Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    if (this.opts.targetId) {
      const found = targetInfos.find((t) => t.targetId === this.opts.targetId);
      if (!found) throw new Error(`target id not found: ${this.opts.targetId}`);
      return { targetId: found.targetId, url: found.url, title: found.title };
    }
    // Cheap initial pick — we'll sync to the actually-active tab when a UI
    // client connects, since the user's foreground tab can change between
    // server start and someone opening the bridge.
    const real = targetInfos.find(isRealPage);
    if (real) return { targetId: real.targetId, url: real.url, title: real.title };
    const anyPage = targetInfos.find((t) => t.type === "page");
    if (anyPage) return { targetId: anyPage.targetId, url: anyPage.url, title: anyPage.title };
    const created = (await rawSend(client, "Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    return { targetId: created.targetId, url: "about:blank", title: "" };
  }

  private async send<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.client || !this.sessionId) throw new Error("session not connected");
    return (await rawSend(this.client, method, params, this.sessionId)) as T;
  }

  private handleEvent(ev: CdpEvent) {
    // Browser-level events (no sessionId) — Target lifecycle.
    if (!ev.sessionId) {
      switch (ev.method) {
        case "Target.targetCreated": {
          const p = ev.params as {
            targetInfo: { targetId: string; type: string; url: string; title: string };
          };
          if (isUserVisibleTab(p.targetInfo)) {
            this.tabs.set(p.targetInfo.targetId, {
              url: p.targetInfo.url,
              title: p.targetInfo.title,
            });
            this.emitTabs();
          }
          return;
        }
        case "Target.targetInfoChanged": {
          const p = ev.params as {
            targetInfo: { targetId: string; type: string; url: string; title: string };
          };
          // A target's URL can transition between visible and hidden during its
          // lifetime (e.g. an extension page navigates, an omnibox popup gets
          // re-used). Reflect both directions.
          const visible = isUserVisibleTab(p.targetInfo);
          const had = this.tabs.has(p.targetInfo.targetId);
          if (visible) {
            this.tabs.set(p.targetInfo.targetId, {
              url: p.targetInfo.url,
              title: p.targetInfo.title,
            });
            this.emitTabs();
            if (p.targetInfo.targetId === this.targetId) {
              this.lastPage = {
                ...this.lastPage,
                url: p.targetInfo.url,
                title: p.targetInfo.title,
              };
              this.emit("page", this.lastPage);
            }
          } else if (had) {
            this.tabs.delete(p.targetInfo.targetId);
            this.emitTabs();
          }
          return;
        }
        case "Target.targetDestroyed": {
          const p = ev.params as { targetId: string };
          if (this.tabs.delete(p.targetId)) this.emitTabs();
          if (p.targetId === this.targetId) {
            // Our active tab is gone — switch to any remaining page.
            const next = this.tabs.keys().next().value as string | undefined;
            if (next) {
              void this.switchToTarget(next).catch((err) =>
                console.error("[browser-interface] auto-switch failed:", err),
              );
            } else {
              this.sessionId = null;
              this.targetId = null;
            }
          }
          return;
        }
      }
      return;
    }

    // Page-level events — only act on ones for our active session.
    if (ev.sessionId !== this.sessionId) return;
    switch (ev.method) {
      case "Page.frameNavigated": {
        const params = ev.params as { frame?: { parentId?: string; url?: string } };
        if (params.frame?.parentId) return; // subframe
        this.lastPage = {
          type: "page",
          url: params.frame?.url ?? "",
          title: this.lastPage.title,
          loading: true,
        };
        this.emit("page", this.lastPage);
        return;
      }
      case "Page.loadEventFired":
      case "Page.frameStoppedLoading":
        this.lastPage = { ...this.lastPage, loading: false };
        this.emit("page", this.lastPage);
        void this.refreshTitle();
        return;
      case "Page.javascriptDialogOpening":
        // For now, surface dialogs by closing them with accept=false so the
        // session doesn't deadlock on alert(). A future iteration can let the
        // human decide.
        void this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
        return;
      case "Page.screencastVisibilityChanged": {
        const params = ev.params as { visible: boolean };
        if (params.visible !== this.visible) {
          this.visible = params.visible;
          this.emit("visibility", { type: "visibility", visible: params.visible });
        }
        return;
      }
      case "Page.screencastFrame": {
        const params = ev.params as {
          data: string;
          metadata: {
            deviceWidth?: number;
            deviceHeight?: number;
            timestamp?: number;
            pageScaleFactor?: number;
          };
          sessionId: number;
        };
        // We must ack every frame or Chrome stops sending them.
        void this.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(
          () => {},
        );
        const w = params.metadata.deviceWidth ?? this.viewport.width;
        const h = params.metadata.deviceHeight ?? this.viewport.height;
        if (w !== this.viewport.width || h !== this.viewport.height) {
          this.viewport = { ...this.viewport, width: w, height: h };
        }
        const format = this.opts.screenshotFormat ?? "jpeg";
        const msg: ScreenshotMessage = {
          type: "screenshot",
          data: params.data,
          format,
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: this.viewport.deviceScaleFactor,
          frame: ++this.frameCount,
          capturedAt: params.metadata.timestamp
            ? params.metadata.timestamp * 1000
            : Date.now(),
        };
        this.emit("screenshot", msg);
        return;
      }
    }
  }

  private emitTabs(): void {
    this.emit("tabs", { type: "tabs", tabs: this.getTabs() });
  }

  getTabs(): TabInfo[] {
    return [...this.tabs.entries()].map(([id, info]) => ({
      id,
      url: info.url,
      title: info.title,
      active: id === this.targetId,
    }));
  }

  getVisibility(): boolean {
    return this.visible;
  }

  // Leading-edge throttle: fire a hover lookup immediately when the user
  // starts moving the mouse, then enforce a cooldown so we don't flood the
  // CDP channel. Pending mousemoves during the cooldown coalesce into one
  // trailing lookup so the displayed URL keeps up as the mouse keeps moving.
  private scheduleHoverCheck() {
    if (this.hoverTimer) {
      this.hoverPending = true;
      return;
    }
    void this.checkHover();
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (this.hoverPending) {
        this.hoverPending = false;
        this.scheduleHoverCheck();
      }
    }, 120);
  }

  private async checkHover(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    const x = this.lastMouseX;
    const y = this.lastMouseY;
    try {
      const evalRes = (await withTimeout(
        this.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
          // elementFromPoint returns the topmost element at the coords; closest('a')
          // walks up to find the nearest anchor ancestor (so hovering an icon or
          // span inside a link still resolves to the link's href).
          expression: `(()=>{const el=document.elementFromPoint(${x},${y});return el?(el.closest('a')?.href||null):null})()`,
          returnByValue: true,
        }),
        500,
      )) as { result?: { value?: unknown } } | null;
      const href =
        typeof evalRes?.result?.value === "string" ? (evalRes.result.value as string) : null;
      if (href !== null) {
        // Cursor is on a link — show it (if new) and cancel any pending
        // auto-clear so the URL stays visible as long as the user keeps the
        // cursor on a link, even if they stop moving the mouse entirely.
        if (href !== this.lastHoveredHref) {
          this.lastHoveredHref = href;
          this.emit("hover", { type: "hover", href });
        }
        this.cancelHoverIdle();
      } else if (this.lastHoveredHref !== null) {
        // Cursor moved off a link onto whitespace within the frame; this is
        // when the auto-clear countdown should start.
        this.armHoverIdle();
      }
    } catch {
      // ignore — CDP can be momentarily busy mid-navigation
    }
  }

  private armHoverIdle(timeoutMs = 3000) {
    // Don't extend a running timer — if multiple "moved off" events arrive
    // in quick succession (e.g. cursor moves to whitespace then leaves the
    // frame), the deadline stays measured from the first transition.
    if (this.hoverIdleTimer) return;
    this.hoverIdleTimer = setTimeout(() => {
      this.hoverIdleTimer = null;
      this.clearHover();
    }, timeoutMs);
  }

  private cancelHoverIdle() {
    if (this.hoverIdleTimer) {
      clearTimeout(this.hoverIdleTimer);
      this.hoverIdleTimer = null;
    }
  }

  private clearHover() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.hoverIdleTimer) {
      clearTimeout(this.hoverIdleTimer);
      this.hoverIdleTimer = null;
    }
    this.hoverPending = false;
    if (this.lastHoveredHref !== null) {
      this.lastHoveredHref = null;
      this.emit("hover", { type: "hover", href: null });
    }
  }

  // One-shot screenshot used to seed a freshly-connected UI client with a
  // current frame. Page.startScreencast is event-driven and only emits when
  // the page paints, so a static page would otherwise leave the UI stuck on
  // its placeholder until the user does something. Bounded with a timeout
  // so it can't hang a slow renderer; returns null on any failure.
  async captureCurrentFrame(): Promise<ScreenshotMessage | null> {
    if (!this.client || !this.sessionId) return null;
    const format = this.opts.screenshotFormat ?? "jpeg";
    const params: { format: "png" | "jpeg"; quality?: number } = { format };
    if (format === "jpeg") params.quality = this.opts.screenshotQuality ?? 60;
    try {
      const result = (await withTimeout(
        this.send<{ data: string }>("Page.captureScreenshot", params),
        2000,
      )) as { data: string } | null;
      if (!result) return null;
      return {
        type: "screenshot",
        data: result.data,
        format,
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: this.viewport.deviceScaleFactor,
        frame: ++this.frameCount,
        capturedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  // Force-foreground the bridge's current target in real Chrome. Used when the
  // user has switched away in their browser and wants to bring the bridged
  // tab back without going through the tab list.
  async refocus(): Promise<void> {
    if (!this.client || !this.targetId) return;
    try {
      await rawSend(this.client, "Target.activateTarget", { targetId: this.targetId });
    } catch {
      // ignore
    }
  }

  async switchToTarget(targetId: string): Promise<void> {
    if (!this.client) throw new Error("session not connected");
    if (this.targetId === targetId) return;
    if (!this.tabs.has(targetId)) throw new Error(`unknown tab id: ${targetId}`);

    const ATTACH_TIMEOUT_MS = 3000;
    const DOMAIN_TIMEOUT_MS = 1500;

    // Activate the target *first*. Chrome's discarded-tab revival fires on
    // user-initiated activation; doing this before attach gives the renderer
    // time to spin up so the subsequent attach + domain enables don't hang.
    if (this.opts.activateOnSwitch !== false) {
      try {
        await withTimeout(
          rawSend(this.client, "Target.activateTarget", { targetId }),
          DOMAIN_TIMEOUT_MS,
        );
      } catch {
        // not all CDP endpoints expose this
      }
    }

    // Attach to the new target with a timeout. We do this *before* detaching
    // the old session so a hang here doesn't strand the bridge with no tab.
    const attached = (await withTimeout(
      rawSend(this.client, "Target.attachToTarget", { targetId, flatten: true }),
      ATTACH_TIMEOUT_MS,
    )) as { sessionId: string } | null;
    if (!attached) {
      throw new Error("tab is not responding (attach timed out — likely discarded by Chrome)");
    }

    // Now we own the new session. Tear down the old one.
    const oldSessionId = this.sessionId;
    await this.stopScreencast();
    this.clearHover();
    if (oldSessionId) {
      // Fire-and-forget — the new session is already established and a slow
      // detach on the old session shouldn't block the switch.
      rawSend(this.client, "Target.detachFromTarget", { sessionId: oldSessionId }).catch(
        () => {},
      );
    }

    this.sessionId = attached.sessionId;
    this.targetId = targetId;

    // Domain enables are best-effort and timeout-bounded — if a domain doesn't
    // come back within a short window the page is probably wedged, but we
    // still want to update the UI (so the user sees the tab switch happened)
    // and let the inactive-tab detection downstream handle the recovery flow.
    for (const domain of ["Page", "DOM", "Runtime", "Network"]) {
      try {
        await withTimeout(this.send(`${domain}.enable`), DOMAIN_TIMEOUT_MS);
      } catch (err) {
        console.warn(`[browser-interface] enable ${domain} failed:`, err);
      }
    }

    if (!this.visible) {
      this.visible = true;
      this.emit("visibility", { type: "visibility", visible: true });
    }
    const tab = this.tabs.get(targetId);
    this.lastPage = {
      type: "page",
      url: tab?.url ?? "",
      title: tab?.title ?? "",
      loading: false,
    };
    this.emit("page", this.lastPage);
    this.emitTabs();

    // startScreencast already swallows internal errors and bounds its own work.
    await this.startScreencast();

    // Detect Memory-Saver-discarded tabs by waiting for a first frame: live
    // pages always emit one immediately on screencast start. If we get nothing
    // within a couple of seconds, almost certainly the renderer is discarded
    // and the tab needs a force-reload to come back.
    const switchedToId = targetId;
    const framesAtSwitch = this.frameCount;
    setTimeout(() => {
      if (this.targetId === switchedToId && this.frameCount === framesAtSwitch) {
        this.emit("inactive", { type: "inactive", tabId: switchedToId });
      }
    }, 2500);
  }

  async newTab(url?: string): Promise<string> {
    if (!this.client) throw new Error("session not connected");
    const created = (await rawSend(this.client, "Target.createTarget", {
      url: url ?? "about:blank",
    })) as { targetId: string };
    // Target.targetCreated should arrive and seed `tabs`, but be defensive.
    if (!this.tabs.has(created.targetId)) {
      this.tabs.set(created.targetId, { url: url ?? "about:blank", title: "" });
    }
    await this.switchToTarget(created.targetId);
    return created.targetId;
  }

  async closeTab(targetId: string): Promise<void> {
    if (!this.client) throw new Error("session not connected");
    await rawSend(this.client, "Target.closeTarget", { targetId });
    // The Target.targetDestroyed event handler will update tabs and auto-switch.
  }

  // Probe each tracked tab and switch to whichever one is actually foreground
  // in the user's Chrome window right now. Called when a UI client connects so
  // the human sees the tab they're looking at, not whatever the bridge happened
  // to attach to at startup. No-op if the active tab is already attached or if
  // detection fails (e.g., Chrome window minimized).
  async syncToActiveTab(): Promise<void> {
    if (!this.client) return;
    const ids = [...this.tabs.keys()];
    const activeId = await findActiveTargetId(this.client, ids);
    if (activeId && activeId !== this.targetId) {
      await this.switchToTarget(activeId);
    }
  }

  getViewport() {
    return { ...this.viewport };
  }

  getPage(): PageStateMessage {
    return this.lastPage;
  }

  // Start streaming Page.screencastFrame events for the current page session.
  // Unlike Page.captureScreenshot, this works for tabs that aren't the
  // foreground window in real Chrome — Chrome runs the page's compositor
  // either way and pushes a frame whenever something visible changes.
  async startScreencast(): Promise<void> {
    if (!this.client || !this.sessionId) throw new Error("session not connected");
    if (this.screencasting) return;
    const format = this.opts.screenshotFormat ?? "jpeg";
    const params: {
      format: "png" | "jpeg";
      quality?: number;
      everyNthFrame?: number;
      maxWidth?: number;
      maxHeight?: number;
    } = { format };
    if (format === "jpeg") params.quality = this.opts.screenshotQuality ?? 60;
    params.everyNthFrame = this.computeEveryNthFrame();
    try {
      await this.send("Page.startScreencast", params);
      this.screencasting = true;
    } catch (err) {
      console.error("[browser-interface] startScreencast failed:", err);
    }
  }

  async stopScreencast(): Promise<void> {
    if (!this.client || !this.sessionId || !this.screencasting) {
      this.screencasting = false;
      return;
    }
    try {
      await this.send("Page.stopScreencast");
    } catch {
      // ignore — session may already be detached
    }
    this.screencasting = false;
  }

  private computeEveryNthFrame(): number {
    if (this.opts.everyNthFrame && this.opts.everyNthFrame > 0) {
      return Math.floor(this.opts.everyNthFrame);
    }
    if (this.opts.screenshotIntervalMs && this.opts.screenshotIntervalMs > 16) {
      // Screencast emits at the page's refresh rate (~60fps). Approximate the
      // legacy interval by skipping frames.
      return Math.max(1, Math.round(this.opts.screenshotIntervalMs / 16));
    }
    return 1;
  }

  private async refreshTitle(): Promise<void> {
    if (!this.client) return;
    try {
      const evalRes = await this.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const title = typeof evalRes.result.value === "string" ? evalRes.result.value : "";
      if (title !== this.lastPage.title) {
        this.lastPage = { ...this.lastPage, title };
        this.emit("page", this.lastPage);
      }
    } catch {
      // ignore
    }
  }

  async dispatch(action: ClientAction): Promise<void> {
    if (!this.client) throw new Error("session not connected");

    switch (action.type) {
      case "click": {
        const button = action.button ?? "left";
        const modifiers = modifierMask(action.modifiers);
        const clickCount = action.clickCount ?? 1;
        await this.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: action.x,
          y: action.y,
          button,
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
          clickCount,
          modifiers,
        });
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: action.x,
          y: action.y,
          button,
          buttons: 0,
          clickCount,
          modifiers,
        });
        return;
      }
      case "mousemove": {
        const buttons = (action.buttons ?? []).reduce((acc, b) => {
          if (b === "left") return acc | 1;
          if (b === "right") return acc | 2;
          if (b === "middle") return acc | 4;
          return acc;
        }, 0);
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: action.x,
          y: action.y,
          buttons,
          modifiers: modifierMask(action.modifiers),
        });
        this.lastMouseX = action.x;
        this.lastMouseY = action.y;
        this.scheduleHoverCheck();
        return;
      }
      case "scroll": {
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: action.x,
          y: action.y,
          deltaX: action.deltaX,
          deltaY: action.deltaY,
        });
        return;
      }
      case "type": {
        await this.send("Input.insertText", { text: action.text });
        return;
      }
      case "key": {
        const desc = keyDescriptorFor(action.key, action.code);
        const modifiers = modifierMask(action.modifiers);
        const downEvent = {
          type: "keyDown",
          modifiers,
          key: desc.key,
          code: desc.code,
          windowsVirtualKeyCode: desc.keyCode,
          nativeVirtualKeyCode: desc.keyCode,
          text: desc.text,
          unmodifiedText: desc.text,
        };
        const upEvent = {
          type: "keyUp",
          modifiers,
          key: desc.key,
          code: desc.code,
          windowsVirtualKeyCode: desc.keyCode,
          nativeVirtualKeyCode: desc.keyCode,
        };
        if (action.phase === "down") {
          await this.send("Input.dispatchKeyEvent", downEvent);
        } else if (action.phase === "up") {
          await this.send("Input.dispatchKeyEvent", upEvent);
        } else {
          await this.send("Input.dispatchKeyEvent", downEvent);
          await this.send("Input.dispatchKeyEvent", upEvent);
        }
        return;
      }
      case "navigate":
        await this.send("Page.navigate", { url: action.url });
        return;
      case "reload":
        await this.send("Page.reload", { ignoreCache: action.ignoreCache ?? false });
        return;
      case "back": {
        const history = await this.send<{
          currentIndex: number;
          entries: Array<{ id: number }>;
        }>("Page.getNavigationHistory");
        const idx = history.currentIndex;
        if (idx > 0) {
          const entry = history.entries[idx - 1];
          if (entry) await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        }
        return;
      }
      case "forward": {
        const history = await this.send<{
          currentIndex: number;
          entries: Array<{ id: number }>;
        }>("Page.getNavigationHistory");
        const idx = history.currentIndex;
        if (idx < history.entries.length - 1) {
          const entry = history.entries[idx + 1];
          if (entry) await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        }
        return;
      }
      case "switchTab":
        await this.switchToTarget(action.tabId);
        return;
      case "newTab":
        await this.newTab(action.url);
        return;
      case "closeTab":
        await this.closeTab(action.tabId);
        return;
      case "refocus":
        await this.refocus();
        return;
      case "mouseleave":
        // Cursor left the bridge's screen frame entirely. If there's a
        // hovered link still showing, start the auto-clear countdown — the
        // user might be moving down to copy it, but if they don't come back,
        // the URL shouldn't sit there forever.
        if (this.lastHoveredHref !== null) this.armHoverIdle();
        return;
      case "reviveTab":
        // Force the discarded tab back to life by reloading its renderer.
        // This is destructive (drops in-page state), so the UI prompts before
        // dispatching it.
        if (this.sessionId) {
          try {
            await this.send("Page.reload", { ignoreCache: false });
          } catch (err) {
            console.warn("[browser-interface] reviveTab reload failed:", err);
          }
        }
        return;
    }
  }

  async close(): Promise<void> {
    await this.stopScreencast();
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.sessionId = null;
    this.targetId = null;
  }
}
