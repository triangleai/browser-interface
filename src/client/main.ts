import type {
  ClientAction,
  ClientActionMessage,
  ModifierKey,
  ServerMessage,
  TabInfo,
} from "../shared/protocol.js";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

const els = {
  tabs: document.getElementById("tabs") as HTMLElement,
  back: document.getElementById("back") as HTMLButtonElement,
  forward: document.getElementById("forward") as HTMLButtonElement,
  reload: document.getElementById("reload") as HTMLButtonElement,
  urlForm: document.getElementById("url-form") as HTMLFormElement,
  url: document.getElementById("url") as HTMLInputElement,
  openExternal: document.getElementById("open-external") as HTMLButtonElement,
  status: document.getElementById("status") as HTMLSpanElement,
  cdpEndpoint: document.getElementById("cdp-endpoint") as HTMLSpanElement,
  loadingIndicator: document.getElementById("loading-indicator") as HTMLSpanElement,
  fps: document.getElementById("fps") as HTMLSpanElement,
  hoverLink: document.getElementById("hover-link") as HTMLAnchorElement,
  stage: document.getElementById("stage") as HTMLElement,
  frame: document.getElementById("frame") as HTMLDivElement,
  screen: document.getElementById("screen") as HTMLImageElement,
  placeholder: document.getElementById("placeholder") as HTMLDivElement,
  inactiveOverlay: document.getElementById("inactive-overlay") as HTMLDivElement,
  inactiveRevive: document.getElementById("inactive-revive") as HTMLButtonElement,
  inactiveCancel: document.getElementById("inactive-cancel") as HTMLButtonElement,
  toast: document.getElementById("toast") as HTMLDivElement,
  resizeHandle: document.getElementById("resize-handle") as HTMLButtonElement,
  resizeReadout: document.getElementById("resize-readout") as HTMLDivElement,
};

let viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
let urlEditing = false;
let nextActionId = 1;
let isVisible = true;
let lastTabs: TabInfo[] = [];

function setStatus(state: ConnectionState, label?: string) {
  els.status.dataset.state = state;
  els.status.textContent =
    label ??
    {
      connecting: "connecting…",
      connected: "connected",
      disconnected: "disconnected",
      error: "error",
    }[state];
}

function fitFrame() {
  // Sets the framed image element to the largest size that fits the stage,
  // preserving the aspect ratio of the remote viewport. The status bar lives
  // inside the stage now (so it can sit flush below the frame), so we need to
  // subtract its measured height from the available vertical space.
  const statusbar = document.querySelector(".statusbar") as HTMLElement | null;
  const statusH = statusbar ? statusbar.offsetHeight : 0;
  const availW = els.stage.clientWidth;
  const availH = els.stage.clientHeight - statusH;
  const aspect = viewport.width / viewport.height;
  let w = availW;
  let h = w / aspect;
  if (h > availH) {
    h = availH;
    w = h * aspect;
  }
  els.frame.style.width = `${Math.max(0, Math.floor(w))}px`;
  els.frame.style.height = `${Math.max(0, Math.floor(h))}px`;
}

function pointToViewport(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = els.frame.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / rect.width;
  const yRatio = (e.clientY - rect.top) / rect.height;
  return {
    x: Math.max(0, Math.min(viewport.width, xRatio * viewport.width)),
    y: Math.max(0, Math.min(viewport.height, yRatio * viewport.height)),
  };
}

function modifiersFromEvent(e: KeyboardEvent | MouseEvent | WheelEvent): ModifierKey[] {
  const mods: ModifierKey[] = [];
  if (e.altKey) mods.push("Alt");
  if (e.ctrlKey) mods.push("Control");
  if (e.metaKey) mods.push("Meta");
  if (e.shiftKey) mods.push("Shift");
  return mods;
}

class Bridge {
  private ws: WebSocket | null = null;
  private retryDelay = 500;
  private intentionallyClosed = false;

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    setStatus("connecting");

    ws.addEventListener("open", () => {
      this.retryDelay = 500;
      setStatus("connected");
      ws.send(
        JSON.stringify({
          type: "hello",
          client: `human-${Math.random().toString(36).slice(2, 8)}`,
          role: "human",
        }),
      );
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      this.handleServerMessage(msg);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      if (this.intentionallyClosed) return;
      setStatus("disconnected");
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(5000, this.retryDelay * 2);
    });

    ws.addEventListener("error", () => {
      setStatus("error");
    });
  }

  send(action: ClientAction): string | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const id = String(nextActionId++);
    const msg: ClientActionMessage = {
      type: "action",
      id,
      action,
    };
    this.ws.send(JSON.stringify(msg));
    return id;
  }

  private handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "ready":
        viewport = msg.viewport;
        if (!urlEditing) els.url.value = msg.url;
        document.title = msg.title ? `${msg.title} — Browser Interface` : "Browser Interface";
        els.cdpEndpoint.textContent = msg.cdpEndpoint ?? "";
        fitFrame();
        return;
      case "screenshot": {
        viewport = {
          width: msg.width,
          height: msg.height,
          deviceScaleFactor: msg.deviceScaleFactor,
        };
        const mime = msg.format === "png" ? "image/png" : "image/jpeg";
        els.screen.src = `data:${mime};base64,${msg.data}`;
        els.placeholder.classList.add("hidden");
        // If frames are arriving, the tab is alive — clear any stale inactive prompt.
        hideInactiveOverlay();
        recordFrame();
        fitFrame();
        return;
      }
      case "page":
        if (!urlEditing) els.url.value = msg.url;
        document.title = msg.title ? `${msg.title} — Browser Interface` : "Browser Interface";
        els.loadingIndicator.hidden = !msg.loading;
        return;
      case "tabs":
        lastTabs = msg.tabs;
        renderTabs(msg.tabs);
        return;
      case "visibility":
        if (msg.visible !== isVisible) {
          isVisible = msg.visible;
          document.body.classList.toggle("out-of-focus", !isVisible);
          renderTabs(lastTabs);
        }
        return;
      case "inactive":
        showInactiveOverlay();
        return;
      case "hover":
        els.hoverLink.textContent = msg.href ?? "";
        els.hoverLink.title = msg.href ?? "";
        // Real anchor href so left-click opens in the user's current browser
        // and right-click → "Copy Link Address" works.
        if (msg.href) {
          els.hoverLink.href = msg.href;
        } else {
          els.hoverLink.removeAttribute("href");
        }
        return;
      case "error":
        console.warn("[bridge] server error:", msg.message);
        showToast(msg.message);
        if (msg.id !== undefined && msg.id === viewportInFlightId) {
          viewportInFlightId = null;
          maybeSendViewport();
        }
        return;
      case "ack":
        if (msg.id !== undefined && msg.id === viewportInFlightId) {
          viewportInFlightId = null;
          maybeSendViewport();
        }
        return;
    }
  }
}

const bridge = new Bridge();
bridge.connect();

// ── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs(tabs: TabInfo[]) {
  els.tabs.replaceChildren();
  for (const tab of tabs) {
    const el = document.createElement("button");
    el.type = "button";
    const dimmed = tab.active && !isVisible;
    el.className = `tab${tab.active ? " active" : ""}${dimmed ? " dimmed" : ""}`;
    el.title = dimmed
      ? `${tab.title || tab.url}\n${tab.url}\n(click to bring back to front in Chrome)`
      : `${tab.title || tab.url}\n${tab.url}`;

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || hostnameOf(tab.url) || tab.url || "(untitled)";
    el.appendChild(title);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      bridge.send({ type: "closeTab", tabId: tab.id });
    });
    el.appendChild(close);

    el.addEventListener("click", () => {
      if (!tab.active) {
        // Clear any inactive prompt left over from the previous tab so it
        // doesn't linger over the new one until the timeout re-fires.
        hideInactiveOverlay();
        bridge.send({ type: "switchTab", tabId: tab.id });
      } else {
        // Re-clicking the active tab refocuses it in the user's real Chrome —
        // the bridge already attaches here, this just brings it to foreground.
        bridge.send({ type: "refocus" });
      }
    });
    els.tabs.appendChild(el);
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "new-tab";
  newBtn.textContent = "+";
  newBtn.title = "New tab";
  newBtn.addEventListener("click", () => bridge.send({ type: "newTab" }));
  els.tabs.appendChild(newBtn);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// ── Inactive-tab overlay ─────────────────────────────────────────────────────

function showInactiveOverlay() {
  els.inactiveOverlay.hidden = false;
}

function hideInactiveOverlay() {
  els.inactiveOverlay.hidden = true;
}

els.inactiveRevive.addEventListener("click", () => {
  bridge.send({ type: "reviveTab" });
  hideInactiveOverlay();
});
els.inactiveCancel.addEventListener("click", hideInactiveOverlay);

// ── FPS meter ────────────────────────────────────────────────────────────────

const frameTimes: number[] = [];
function recordFrame() {
  frameTimes.push(performance.now());
}
function refreshFps() {
  const now = performance.now();
  while (frameTimes.length && now - frameTimes[0]! > 1000) frameTimes.shift();
  // Format kept consistent ("N fps" or "— fps") so the FPS box width doesn't
  // appear to fluctuate next to the CDP endpoint.
  els.fps.textContent = frameTimes.length === 0 ? "— fps" : `${frameTimes.length} fps`;
}
setInterval(refreshFps, 500);

// ── Toast (transient error display) ──────────────────────────────────────────

let toastTimer: number | undefined;
function showToast(message: string, durationMs = 4000) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, durationMs);
}

// ── Layout ───────────────────────────────────────────────────────────────────

window.addEventListener("resize", fitFrame);
new ResizeObserver(fitFrame).observe(els.stage);

// ── Resize handle ────────────────────────────────────────────────────────────

// Drag state for the status-bar resize grip. We capture the cursor's starting
// screen position and the remote viewport at drag-start, then treat further
// cursor movement as a delta on the remote dimensions. The local frame is
// not sized from the cursor — fitFrame keeps auto-fitting the stage at the
// remote's new aspect each time a screencast frame arrives.
//
// Adaptive pacing: only one outstanding setViewport in flight at a time.
// mousemove updates `pendingViewport`; we send immediately if no prior
// request is in flight, otherwise wait for that one's ack and then send the
// latest pending. Send rate auto-adapts to whatever Chrome can keep up with
// — a fixed-interval throttle was previously starving the screencast
// pipeline during fast drags because Chrome can't reflow + paint + screencast
// at 20Hz on heavy pages.
let resizing = false;
let resizeDragStart: {
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  pxPerCssX: number;
  pxPerCssY: number;
} | null = null;
let pendingViewport: { width: number; height: number } | null = null;
let lastSentViewport: { width: number; height: number } | null = null;
let viewportInFlightId: string | null = null;
const MIN_REMOTE_W = 320;
const MIN_REMOTE_H = 240;

function maybeSendViewport() {
  if (!pendingViewport) return;
  if (viewportInFlightId !== null) return;
  const dims = pendingViewport;
  if (
    lastSentViewport &&
    dims.width === lastSentViewport.width &&
    dims.height === lastSentViewport.height
  ) {
    pendingViewport = null;
    return;
  }
  pendingViewport = null;
  lastSentViewport = dims;
  const id = bridge.send({ type: "setViewport", width: dims.width, height: dims.height });
  if (id !== null) viewportInFlightId = id;
}

function queueViewportUpdate(width: number, height: number) {
  pendingViewport = { width, height };
  maybeSendViewport();
}

function updateResizeReadout(remoteW: number, remoteH: number) {
  els.resizeReadout.textContent = `${remoteW} × ${remoteH}`;
}

els.resizeHandle.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = els.frame.getBoundingClientRect();
  resizeDragStart = {
    startX: e.clientX,
    startY: e.clientY,
    startW: viewport.width,
    startH: viewport.height,
    pxPerCssX: viewport.width / rect.width,
    pxPerCssY: viewport.height / rect.height,
  };
  resizing = true;
  document.body.classList.add("resizing");
  els.resizeReadout.hidden = false;
  updateResizeReadout(viewport.width, viewport.height);
});

window.addEventListener("mousemove", (e) => {
  if (!resizeDragStart) return;
  e.preventDefault();
  const dx = e.clientX - resizeDragStart.startX;
  const dy = e.clientY - resizeDragStart.startY;
  const remoteW = Math.max(
    MIN_REMOTE_W,
    Math.round(resizeDragStart.startW + dx * resizeDragStart.pxPerCssX),
  );
  const remoteH = Math.max(
    MIN_REMOTE_H,
    Math.round(resizeDragStart.startH + dy * resizeDragStart.pxPerCssY),
  );
  queueViewportUpdate(remoteW, remoteH);
  updateResizeReadout(remoteW, remoteH);
});

window.addEventListener("mouseup", (e) => {
  if (!resizeDragStart) return;
  if (e.button !== 0) return;
  resizeDragStart = null;
  resizing = false;
  document.body.classList.remove("resizing");
  els.resizeReadout.hidden = true;
  // The latest cursor delta is already in `pendingViewport`; if the previous
  // request is still in flight, maybeSendViewport will pick it up when the
  // ack arrives. No explicit flush needed.
  maybeSendViewport();
});

// Touch the `resizing` flag via void so TS doesn't flag it unused — it's
// available for future code that might want to suppress unrelated work
// during a drag (e.g. hover lookups).
void resizing;

// ── Mouse / scroll ───────────────────────────────────────────────────────────

const mouseTarget = els.frame;

mouseTarget.addEventListener("contextmenu", (e) => e.preventDefault());

mouseTarget.addEventListener("mouseleave", () => {
  // Lets the server start its hovered-link auto-clear timer without waiting
  // for further mousemoves. Without this, a URL hovered just before the
  // cursor exits the frame would linger indefinitely.
  bridge.send({ type: "mouseleave" });
});

mouseTarget.addEventListener("mousedown", (e) => {
  e.preventDefault();
  els.stage.focus();
});

mouseTarget.addEventListener("click", (e) => {
  e.preventDefault();
  if (!isVisible) {
    // The screen frame is stale (Chrome stops compositing backgrounded tabs).
    // Treat any click as "wake this tab back up" rather than a misdirected
    // click on a frozen image.
    bridge.send({ type: "refocus" });
    return;
  }
  const { x, y } = pointToViewport(e);
  bridge.send({
    type: "click",
    x,
    y,
    button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    clickCount: e.detail || 1,
    modifiers: modifiersFromEvent(e),
  });
});

mouseTarget.addEventListener("auxclick", (e) => {
  if (e.button !== 1 && e.button !== 2) return;
  e.preventDefault();
  if (!isVisible) {
    bridge.send({ type: "refocus" });
    return;
  }
  const { x, y } = pointToViewport(e);
  bridge.send({
    type: "click",
    x,
    y,
    button: e.button === 2 ? "right" : "middle",
    clickCount: e.detail || 1,
    modifiers: modifiersFromEvent(e),
  });
});

let lastMoveAt = 0;
mouseTarget.addEventListener("mousemove", (e) => {
  if (!isVisible) return; // don't dispatch into a stale frame
  // Throttle to ~30 fps to avoid drowning the bridge in mousemove traffic.
  const now = performance.now();
  if (now - lastMoveAt < 33) return;
  lastMoveAt = now;
  const { x, y } = pointToViewport(e);
  bridge.send({ type: "mousemove", x, y, modifiers: modifiersFromEvent(e) });
});

mouseTarget.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (!isVisible) {
      bridge.send({ type: "refocus" });
      return;
    }
    const { x, y } = pointToViewport(e);
    bridge.send({
      type: "scroll",
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  },
  { passive: false },
);

// ── Keyboard ─────────────────────────────────────────────────────────────────

function isUrlBarFocused(): boolean {
  return document.activeElement === els.url;
}

function handleKey(e: KeyboardEvent, phase: "down" | "up") {
  if (isUrlBarFocused()) return;
  // Let the user copy/refresh out of the page using browser shortcuts.
  if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) return;
  e.preventDefault();
  if (!isVisible) {
    if (phase === "down") bridge.send({ type: "refocus" });
    return;
  }
  // Single printable chars on keydown go through Input.insertText for IME-correct text.
  if (
    phase === "down" &&
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    bridge.send({ type: "type", text: e.key });
    return;
  }
  bridge.send({
    type: "key",
    key: e.key,
    code: e.code,
    modifiers: modifiersFromEvent(e),
    phase,
  });
}

window.addEventListener("keydown", (e) => handleKey(e, "down"));
window.addEventListener("keyup", (e) => handleKey(e, "up"));

// ── Toolbar ──────────────────────────────────────────────────────────────────

els.back.addEventListener("click", () => bridge.send({ type: "back" }));
els.forward.addEventListener("click", () => bridge.send({ type: "forward" }));
els.reload.addEventListener("click", () => bridge.send({ type: "reload" }));

els.url.addEventListener("focus", () => {
  urlEditing = true;
});
els.url.addEventListener("blur", () => {
  urlEditing = false;
});

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

els.urlForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalizeUrl(els.url.value);
  if (!url) return;
  bridge.send({ type: "navigate", url });
  els.url.blur();
});

els.openExternal.addEventListener("click", () => {
  // Open the address-bar URL in whatever browser the bridge UI is running in
  // (Safari, the user's daily Chrome window, etc.) — different from "navigate"
  // which sends the URL into the bridged Chrome session.
  const url = normalizeUrl(els.url.value);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
});
