import CDP from "chrome-remote-interface";
import { EventEmitter } from "node:events";
import type {
  ClientAction,
  FindResultMessage,
  HoverMessage,
  InactiveTabMessage,
  ModifierKey,
  MouseButton,
  PageStateMessage,
  ScreenshotMessage,
  SelectionMessage,
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
  // Cap emitted frames per second. Frames arriving faster than 1/maxFps after
  // the last emit are dropped (Chrome is still acked so the stream keeps
  // flowing — we just don't re-broadcast the in-between frames). 0 or
  // undefined disables the cap.
  maxFps?: number;
  // Deprecated: pre-screencast polling interval. Honored as a hint to compute
  // everyNthFrame if `everyNthFrame` itself isn't set.
  screenshotIntervalMs?: number;
  // Optional viewport override applied via Emulation.setDeviceMetricsOverride.
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
}

// Selection probe payload — what the in-page expression below returns,
// mirrored on both the cache field and the broadcast event body.
type SelectionPayload = {
  text: string;
  field?: {
    value: string;
    selectionStart: number;
    selectionEnd: number;
  };
  editable?: boolean;
};

function selectionPayloadEqual(a: SelectionPayload, b: SelectionPayload): boolean {
  if (a.text !== b.text) return false;
  if (!!a.editable !== !!b.editable) return false;
  const af = a.field;
  const bf = b.field;
  if (!af && !bf) return true;
  if (!af || !bf) return false;
  return (
    af.value === bf.value &&
    af.selectionStart === bf.selectionStart &&
    af.selectionEnd === bf.selectionEnd
  );
}

// Runs in the page's main world. Returns the current selection text, plus:
//   - `field` (value + caret range) when the focused element is an
//     <input>/<textarea> — drives the desktop helper's value mirror.
//   - `editable` (boolean) for any editable focus, including
//     contenteditable elements that don't fit the field model. Drives
//     mobile OS-keyboard pop on the client (it focuses the paste helper
//     when an editable target is focused, regardless of whether we have
//     a usable value/selection mirror for it).
// JSON-encoded so we can ship a structured value through Runtime.evaluate's
// returnByValue without dealing with object-graph serialization.
const SELECTION_PROBE = `JSON.stringify((() => {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    const v = ae.value || '';
    const s = ae.selectionStart || 0;
    const e = ae.selectionEnd || 0;
    return {
      text: v.slice(s, e),
      field: { value: v, selectionStart: s, selectionEnd: e },
      editable: true,
    };
  }
  const sel = document.getSelection();
  const text = sel ? sel.toString() : '';
  // isContentEditable returns true for contenteditable subtrees,
  // including inherited contenteditable="true" from an ancestor.
  const editable = !!(ae && ae.isContentEditable);
  return editable ? { text, editable: true } : { text };
})())`;

// Builds an in-page expression for find-on-page. Walks visible text once per
// query change to collect a Range list, paints all matches via the CSS
// Custom Highlight API (yellow), highlights the current match on top
// (orange), and advances the current index on subsequent calls without
// re-walking. Returns { current, total } so the bar can show "X of Y".
function findOnPageScript(query: string, backward: boolean, fromStart: boolean): string {
  return `(() => {
    const query = ${JSON.stringify(query)};
    const backward = ${backward};
    const fromStart = ${fromStart};
    function ensureStyle() {
      if (document.getElementById('__bridge-find-style')) return;
      const st = document.createElement('style');
      st.id = '__bridge-find-style';
      st.textContent =
        '::highlight(bridge-find-all) { background-color: #ffd33d; color: #000; }' +
        '::highlight(bridge-find-current) { background-color: #ff8c1a; color: #000; }';
      document.head.appendChild(st);
    }
    function clearHighlights() {
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('bridge-find-all');
        CSS.highlights.delete('bridge-find-current');
      }
    }
    if (!query) {
      clearHighlights();
      delete window.__bridgeFind;
      return { current: 0, total: 0 };
    }
    let state = window.__bridgeFind;
    const needsRefresh = !state || state.query !== query || fromStart;
    if (needsRefresh) {
      // Walk visible text nodes (descending into open shadow roots) and
      // build a flat string with index→node mapping, then collect Range
      // objects for every occurrence of the query.
      const nodes = [];
      const parts = [];
      let total = 0;
      function visit(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const v = node.nodeValue || '';
          if (!v) return;
          const parent = node.parentElement;
          if (parent) {
            const tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
            const cs = window.getComputedStyle(parent);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
          }
          nodes.push({ node, start: total });
          parts.push(v);
          total += v.length;
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
          const cs = window.getComputedStyle(node);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          if (node.shadowRoot) visit(node.shadowRoot);
        }
        for (let c = node.firstChild; c; c = c.nextSibling) visit(c);
      }
      visit(document.body);
      const flat = parts.join('').toLowerCase();
      const q = query.toLowerCase();
      function locate(pos) {
        let lo = 0, hi = nodes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (nodes[mid].start <= pos) lo = mid;
          else hi = mid - 1;
        }
        return { node: nodes[lo].node, offset: pos - nodes[lo].start };
      }
      const ranges = [];
      let pos = 0;
      while (q && (pos = flat.indexOf(q, pos)) !== -1) {
        const a = locate(pos);
        const b = locate(pos + q.length);
        const r = document.createRange();
        try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); ranges.push(r); } catch (_) {}
        pos += q.length;
      }
      state = { query, ranges, current: -1 };
      window.__bridgeFind = state;
    }
    if (state.ranges.length === 0) {
      clearHighlights();
      return { current: 0, total: 0 };
    }
    if (state.current === -1) {
      state.current = 0;
    } else {
      const step = backward ? -1 : 1;
      state.current = (state.current + step + state.ranges.length) % state.ranges.length;
    }
    ensureStyle();
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set('bridge-find-all', new Highlight(...state.ranges));
      CSS.highlights.set('bridge-find-current', new Highlight(state.ranges[state.current]));
    }
    const cur = state.ranges[state.current];
    const rect = cur.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
      const target = cur.startContainer.parentElement || document.body;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return { current: state.current + 1, total: state.ranges.length };
  })()`;
}

// Tears down the visible find state on close: removes highlights and the
// injected stylesheet, and promotes the active match to a regular text
// selection (Chrome's behavior — leaves matched text selected for Cmd-C).
// We deliberately keep window.__bridgeFind in place so a later Cmd-G can
// resume from the same query and position rather than re-walking from the
// top.
const FIND_STOP_SCRIPT = `(() => {
  const state = window.__bridgeFind;
  if (state && state.current >= 0 && state.ranges && state.ranges[state.current]) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      try { sel.addRange(state.ranges[state.current]); } catch (_) {}
    }
  }
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('bridge-find-all');
    CSS.highlights.delete('bridge-find-current');
  }
  const st = document.getElementById('__bridge-find-style');
  if (st) st.remove();
})()`;

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

// Map a (key, modifiers) pair to Chromium editor commands. CDP exposes a
// `commands` array on Input.dispatchKeyEvent that the renderer executes
// alongside the synthesized event — necessary for chords like Cmd-A whose
// behavior is implemented as an editor command, not via the DOM keypress.
function editorCommandsFor(key: string, mods?: ModifierKey[]): string[] {
  const meta = !!mods?.includes("Meta");
  const ctrl = !!mods?.includes("Control");
  const k = key.toLowerCase();
  if (meta && k === "a") return ["SelectAll"];
  if (ctrl && k === "a") return ["MoveToBeginningOfLine"];
  if (ctrl && k === "e") return ["MoveToEndOfLine"];
  if (ctrl && k === "k") return ["DeleteToEndOfParagraph"];
  if (ctrl && k === "y") return ["Yank"];
  return [];
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
  selection: (msg: SelectionMessage) => void;
  findResult: (msg: FindResultMessage) => void;
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
  // Monotonic timestamp (ms) of the last frame we emitted to listeners. Used
  // by the maxFps cap to gate emission; 0 means "no frame emitted yet" so the
  // first frame always passes.
  private lastFrameEmittedAt = 0;
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
  private lastCursor: string = "default";
  // Whether the last hover landed on an editable target (input, textarea,
  // contenteditable). Mirrored to the client so the touch handler can
  // decide synchronously whether a tap should pop the OS keyboard.
  private lastHoveredEditable: boolean = false;
  // Cached Browser.getWindowForTarget result for the attached tab. Looked up
  // lazily on first setViewport, then reused for subsequent resize ticks so a
  // drag doesn't re-roundtrip per move. Cleared on tab switch.
  private windowId: number | null = null;
  // Set true after the first user-driven setViewport on this connection. Used
  // to one-shot Emulation.clearDeviceMetricsOverride so any --width/--height
  // CLI override doesn't keep clamping the rendered viewport once the user
  // takes manual control via the resize handle.
  private clearedEmulation = false;
  // Chrome-bar offset between OS-window dims (what Browser.setWindowBounds
  // accepts) and content-area dims (what the user actually sees, and what
  // the bridge UI's resize handle is sized in). Computed on first resize via
  // getWindowBounds vs window.innerWidth/innerHeight, then reused so a drag
  // doesn't get re-measured every tick. In headless this is (0, 0); in real
  // Chrome the height diff is the URL/tabs/bookmarks bar (~80–150px). Null
  // means "not yet measured." Cleared on tab switch.
  private chromeBarWidthDiff: number | null = null;
  private chromeBarHeightDiff: number | null = null;
  // Cached snapshot of remote selection / focused-field state. Pushed to
  // clients on change so a copy event's synchronous clipboardData
  // population doesn't have to wait for a CDP round-trip, and so the
  // paste-helper input can mirror a focused remote text field for arrow-
  // key navigation. Refreshed after click/key dispatches that could
  // change either.
  private lastSelectionState: SelectionPayload = { text: "" };
  private selectionPollTimer: NodeJS.Timeout | null = null;
  private selectionPollPending = false;

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
        console.warn(`[browserface] enable ${domain} failed:`, err);
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
      console.warn("[browserface] Target.setDiscoverTargets failed:", err);
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
                console.error("[browserface] auto-switch failed:", err),
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
        // We must ack every frame or Chrome stops sending them. Ack happens
        // even for frames we drop below — keeping the stream alive so the
        // *next* frame arrives in time for the cap window to elapse.
        void this.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(
          () => {},
        );
        // FPS cap: drop frames that arrive faster than 1/maxFps after the
        // previous emit. A fast-updating page (e.g. 60 Hz canvas) would
        // otherwise spam every consumer with frames the user can't perceive,
        // burning CPU on JSON.stringify of a multi-hundred-KB base64 payload.
        const maxFps = this.opts.maxFps;
        if (maxFps && maxFps > 0) {
          const minIntervalMs = 1000 / maxFps;
          const now = Date.now();
          if (now - this.lastFrameEmittedAt < minIntervalMs) return;
          this.lastFrameEmittedAt = now;
        }
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
        this.send<{
          result: { value?: { href: string | null; cursor: string; editable?: boolean } };
        }>(
          "Runtime.evaluate",
          {
            // elementFromPoint returns the topmost element at the coords. We
            // collect three pieces of info: the nearest anchor's href (for
            // the status-bar hover URL), an effective cursor — first by
            // walking ancestors looking for a non-`auto` computed cursor,
            // then by inferring from the element's role for common cases
            // (links, inputs/textareas, contenteditable) — and an
            // `editable` flag that's true only when the hover is over an
            // input/textarea/contenteditable target. The flag is distinct
            // from `cursor === 'text'` because plain page text *also*
            // produces an I-beam cursor (when the point is inside a glyph
            // rect), and the client needs to tell the two cases apart for
            // decisions like whether a tap should pop the OS keyboard.
            expression: `(()=>{
              const el = document.elementFromPoint(${x}, ${y});
              if (!el) return { href: null, cursor: 'default', editable: false };
              let cursor = 'auto';
              let editable = false;
              for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
                const cs = window.getComputedStyle(cur);
                if (cs.cursor && cs.cursor !== 'auto') { cursor = cs.cursor; break; }
              }
              if (cursor === 'auto') {
                if (el.closest('a[href]')) cursor = 'pointer';
                else if (el.closest('textarea, [contenteditable=true], [contenteditable=""]')) {
                  cursor = 'text';
                  editable = true;
                }
                else if (el.closest('input')) {
                  const t = (el.closest('input').getAttribute('type') || 'text').toLowerCase();
                  const isTextInput = (t === 'text' || t === 'search' || t === 'email' || t === 'url' || t === 'tel' || t === 'password' || t === 'number');
                  cursor = isTextInput ? 'text' : 'default';
                  editable = isTextInput;
                } else {
                  // Plain page text — show the I-beam only when the point is
                  // actually inside a glyph rect, not just somewhere over a
                  // text-containing element. Browsers do roughly this: hover
                  // over the word → I-beam; hover the line gap, paragraph
                  // margin, or trailing whitespace beyond the line → default.
                  // We get the nearest caret position, build a 1-char range
                  // adjacent to it, and check whether the point is inside any
                  // of its client rects.
                  let isText = false;
                  try {
                    const cp = document.caretPositionFromPoint
                      ? document.caretPositionFromPoint(${x}, ${y})
                      : (document.caretRangeFromPoint && document.caretRangeFromPoint(${x}, ${y}));
                    const node = cp && (cp.offsetNode || cp.startContainer);
                    const offset = cp ? (cp.offset !== undefined ? cp.offset : (cp.startOffset || 0)) : 0;
                    if (node && node.nodeType === 3) {
                      const text = node.nodeValue || '';
                      const p = node.parentElement;
                      const us = p ? (window.getComputedStyle(p).userSelect || window.getComputedStyle(p).webkitUserSelect) : '';
                      if (us !== 'none') {
                        const r = document.createRange();
                        const inRects = (s, e) => {
                          if (s < 0 || e > text.length || s >= e) return false;
                          r.setStart(node, s);
                          r.setEnd(node, e);
                          const rs = r.getClientRects();
                          for (let i = 0; i < rs.length; i++) {
                            const rr = rs[i];
                            if (${x} >= rr.left && ${x} <= rr.right && ${y} >= rr.top && ${y} <= rr.bottom) return true;
                          }
                          return false;
                        };
                        if (inRects(offset, offset + 1) || inRects(offset - 1, offset)) isText = true;
                      }
                    }
                  } catch (_) {}
                  cursor = isText ? 'text' : 'default';
                }
              }
              const a = el.closest('a');
              return { href: (a && a.href) || null, cursor, editable };
            })()`,
            returnByValue: true,
          },
        ),
        500,
      )) as {
        result?: { value?: { href: string | null; cursor: string; editable?: boolean } };
      } | null;
      const v = evalRes?.result?.value;
      if (!v) return;
      const href = v.href;
      const cursor = v.cursor || "default";
      const editable = !!v.editable;
      if (
        href !== this.lastHoveredHref ||
        cursor !== this.lastCursor ||
        editable !== this.lastHoveredEditable
      ) {
        this.lastHoveredHref = href;
        this.lastCursor = cursor;
        this.lastHoveredEditable = editable;
        this.emit("hover", { type: "hover", href, cursor, editable });
      }
    } catch {
      // ignore — CDP can be momentarily busy mid-navigation
    }
  }

  // Leading-edge throttle for the selection-text lookup. Identical shape to
  // scheduleHoverCheck: fire immediately, then enforce a cooldown, with any
  // refresh requests during the cooldown coalescing into one trailing poll.
  private scheduleSelectionPoll() {
    if (this.selectionPollTimer) {
      this.selectionPollPending = true;
      return;
    }
    void this.checkSelection();
    this.selectionPollTimer = setTimeout(() => {
      this.selectionPollTimer = null;
      if (this.selectionPollPending) {
        this.selectionPollPending = false;
        this.scheduleSelectionPoll();
      }
    }, 100);
  }

  private async checkSelection(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      const evalRes = (await withTimeout(
        this.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
          expression: SELECTION_PROBE,
          returnByValue: true,
        }),
        500,
      )) as { result?: { value?: unknown } } | null;
      const json = typeof evalRes?.result?.value === "string" ? evalRes.result.value : "";
      let parsed: SelectionPayload;
      try {
        parsed = json ? (JSON.parse(json) as SelectionPayload) : { text: "" };
      } catch {
        return;
      }
      if (selectionPayloadEqual(parsed, this.lastSelectionState)) return;
      this.lastSelectionState = parsed;
      this.emit("selection", { type: "selection", ...parsed });
    } catch {
      // ignore — CDP can be momentarily busy mid-navigation
    }
  }

  getSelectionText(): string {
    return this.lastSelectionState.text;
  }

  private clearHover() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hoverPending = false;
    if (
      this.lastHoveredHref !== null ||
      this.lastCursor !== "default" ||
      this.lastHoveredEditable
    ) {
      this.lastHoveredHref = null;
      this.lastCursor = "default";
      this.lastHoveredEditable = false;
      this.emit("hover", { type: "hover", href: null, cursor: "default", editable: false });
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
      // Clear find highlights on the outgoing tab so its yellow/orange
      // overlays don't linger when the user switches back. Fire-and-forget;
      // the script no-ops if there was no find state.
      rawSend(
        this.client,
        "Runtime.evaluate",
        { expression: FIND_STOP_SCRIPT, returnByValue: true },
        oldSessionId,
      ).catch(() => {});
      // Fire-and-forget — the new session is already established and a slow
      // detach on the old session shouldn't block the switch.
      rawSend(this.client, "Target.detachFromTarget", { sessionId: oldSessionId }).catch(
        () => {},
      );
    }

    this.sessionId = attached.sessionId;
    this.targetId = targetId;
    // Different tabs can live in different OS windows (split Chrome window
    // setups), so invalidate the cached windowId and chrome-bar measurements.
    // Re-fetched on the next setViewport.
    this.windowId = null;
    this.chromeBarWidthDiff = null;
    this.chromeBarHeightDiff = null;

    // Domain enables are best-effort and timeout-bounded — if a domain doesn't
    // come back within a short window the page is probably wedged, but we
    // still want to update the UI (so the user sees the tab switch happened)
    // and let the inactive-tab detection downstream handle the recovery flow.
    for (const domain of ["Page", "DOM", "Runtime", "Network"]) {
      try {
        await withTimeout(this.send(`${domain}.enable`), DOMAIN_TIMEOUT_MS);
      } catch (err) {
        console.warn(`[browserface] enable ${domain} failed:`, err);
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
      console.error("[browserface] startScreencast failed:", err);
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
        // A click can change DOM selection (caret repositioned, anchor links,
        // shift-click range extension, etc.). Refresh the cached selection so
        // the human's next Cmd-C has up-to-date text in clipboardData.
        this.scheduleSelectionPoll();
        return;
      }
      case "mousedown": {
        const button = action.button ?? "left";
        await this.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: action.x,
          y: action.y,
          button,
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
          clickCount: action.clickCount ?? 1,
          modifiers: modifierMask(action.modifiers),
        });
        // No selection poll on press — selection isn't finalized until the
        // matching mouseup. A drag-select extends through mousemoves and
        // settles on release; polling here would fire mid-gesture.
        return;
      }
      case "mouseup": {
        const button = action.button ?? "left";
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: action.x,
          y: action.y,
          button,
          buttons: 0,
          clickCount: action.clickCount ?? 1,
          modifiers: modifierMask(action.modifiers),
        });
        this.scheduleSelectionPoll();
        return;
      }
      case "mousemove": {
        const buttonsHeld = action.buttons ?? [];
        const buttons = buttonsHeld.reduce((acc, b) => {
          if (b === "left") return acc | 1;
          if (b === "right") return acc | 2;
          if (b === "middle") return acc | 4;
          return acc;
        }, 0);
        // CDP treats a mouseMoved with `button: "none"` (the default) as a
        // hover. To extend a drag-select on the page side we have to name
        // the button that's currently held — without this Chrome sees a
        // press, then unrelated motion, then a release, and the selection
        // never extends.
        const button: MouseButton | "none" = buttonsHeld[0] ?? "none";
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: action.x,
          y: action.y,
          button,
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
        // Refresh the cached selection / field state so the client's helper
        // mirror catches up with the just-inserted text.
        this.scheduleSelectionPoll();
        return;
      }
      case "key": {
        const desc = keyDescriptorFor(action.key, action.code);
        const modifiers = modifierMask(action.modifiers);
        // CDP synthetic key events fire DOM keydowns but don't always invoke
        // the renderer's editor commands. The `commands` array tells Chrome to
        // also execute the named editing command after the synthesized event,
        // which is what makes Cmd-A actually select all (and similar) work.
        const commands = editorCommandsFor(action.key, action.modifiers);
        console.log("[browserface] key", {
          phase: action.phase,
          key: action.key,
          code: action.code,
          modifiers: action.modifiers,
          commands,
        });
        const downEvent: Record<string, unknown> = {
          type: "keyDown",
          modifiers,
          key: desc.key,
          code: desc.code,
          windowsVirtualKeyCode: desc.keyCode,
          nativeVirtualKeyCode: desc.keyCode,
          text: desc.text,
          unmodifiedText: desc.text,
        };
        if (commands.length > 0) downEvent.commands = commands;
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
        // Shift+Arrow, Ctrl/Cmd+A, etc. change the DOM selection. Refresh
        // the cached selection text after the key dispatch so subsequent
        // Cmd-C events get the new range. Throttled, so a held arrow key
        // doesn't flood CDP.
        this.scheduleSelectionPoll();
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
        if (this.lastHoveredHref !== null) this.clearHover();
        return;
      case "find": {
        const query = action.query;
        if (!query) return;
        const backward = action.direction === "prev";
        const fromStart = !!action.fromStart;
        const expr = findOnPageScript(query, backward, fromStart);
        const res = await this.send<{ result?: { value?: { current?: number; total?: number } } }>(
          "Runtime.evaluate",
          { expression: expr, returnByValue: true },
        );
        const v = res?.result?.value;
        this.emit("findResult", {
          type: "findResult",
          current: typeof v?.current === "number" ? v.current : 0,
          total: typeof v?.total === "number" ? v.total : 0,
        });
        return;
      }
      case "findStop":
        await this.send("Runtime.evaluate", {
          expression: FIND_STOP_SCRIPT,
          returnByValue: true,
        });
        return;
      case "setViewport": {
        const targetContentW = Math.max(200, Math.round(action.width));
        const targetContentH = Math.max(150, Math.round(action.height));
        if (!this.client || !this.targetId) return;
        // First resize on this connection: drop any --width/--height emulation
        // override so the natural content area drives the screencast viewport.
        // Otherwise Browser.setWindowBounds would resize the OS window but the
        // page would keep rendering at the original CLI-pinned dimensions.
        if (!this.clearedEmulation) {
          this.clearedEmulation = true;
          try {
            await this.send("Emulation.clearDeviceMetricsOverride", {});
          } catch {
            // No prior override → CDP returns an error. Fine to ignore.
          }
        }
        if (this.windowId === null) {
          try {
            const res = (await rawSend(this.client, "Browser.getWindowForTarget", {
              targetId: this.targetId,
            })) as { windowId: number };
            this.windowId = res.windowId;
          } catch (err) {
            console.warn("[browserface] getWindowForTarget failed:", err);
            return;
          }
        }
        // First resize: figure out the chrome-bar offset so subsequent
        // setWindowBounds calls hit the requested *content* size, not a
        // chrome-bar-shrunken version. We compare the OS-window dims (from
        // Browser.getWindowBounds) against the content-area dims (from
        // window.innerWidth/innerHeight) — the difference is the chrome
        // height (URL+tabs+bookmarks) plus any horizontal frame padding.
        if (this.chromeBarHeightDiff === null) {
          let osW = 0;
          let osH = 0;
          let contentW = 0;
          let contentH = 0;
          try {
            const { bounds } = (await rawSend(this.client, "Browser.getWindowBounds", {
              windowId: this.windowId,
            })) as { bounds: { width: number; height: number } };
            osW = bounds.width;
            osH = bounds.height;
          } catch (err) {
            console.warn("[browserface] getWindowBounds failed:", err);
          }
          try {
            const evalRes = (await this.send("Runtime.evaluate", {
              expression:
                "JSON.stringify({w: window.innerWidth, h: window.innerHeight})",
              returnByValue: true,
            })) as { result: { value?: unknown } };
            const v = JSON.parse(String(evalRes.result.value ?? "{}"));
            if (typeof v.w === "number") contentW = v.w;
            if (typeof v.h === "number") contentH = v.h;
          } catch (err) {
            console.warn("[browserface] innerWidth eval failed:", err);
          }
          this.chromeBarWidthDiff =
            osW > 0 && contentW > 0 ? Math.max(0, osW - contentW) : 0;
          this.chromeBarHeightDiff =
            osH > 0 && contentH > 0 ? Math.max(0, osH - contentH) : 0;
        }
        try {
          await rawSend(this.client, "Browser.setWindowBounds", {
            windowId: this.windowId,
            bounds: {
              width: targetContentW + (this.chromeBarWidthDiff ?? 0),
              height: targetContentH + (this.chromeBarHeightDiff ?? 0),
              windowState: "normal",
            },
          });
        } catch (err) {
          console.warn("[browserface] setWindowBounds failed:", err);
        }
        // Push a one-shot frame at the new dims. Chrome's screencast only
        // emits when the page paints, so a fully-painted static page doesn't
        // produce a fresh Page.screencastFrame just because its window
        // resized — the user would see a stale frame box (sized by fitFrame
        // to the new aspect) until they scrolled or clicked. captureCurrent-
        // Frame uses Page.captureScreenshot, which captures the live render
        // unconditionally. Update the cached viewport first so the emitted
        // ScreenshotMessage carries the new dims; the next real screencast
        // frame will overwrite if Chrome lands on something different.
        this.viewport = {
          ...this.viewport,
          width: targetContentW,
          height: targetContentH,
        };
        try {
          const refresh = await this.captureCurrentFrame();
          if (refresh) this.emit("screenshot", refresh);
        } catch (err) {
          console.warn("[browserface] post-setViewport capture failed:", err);
        }
        return;
      }
      case "reviveTab":
        // Force the discarded tab back to life by reloading its renderer.
        // This is destructive (drops in-page state), so the UI prompts before
        // dispatching it.
        if (this.sessionId) {
          try {
            await this.send("Page.reload", { ignoreCache: false });
          } catch (err) {
            console.warn("[browserface] reviveTab reload failed:", err);
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
