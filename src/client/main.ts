import type { ModifierKey, ServerMessage } from "../shared/protocol.js";
import { createBridge } from "./bridge.js";
import { setupPasteHelper } from "./paste-helper.js";
import { setupResize } from "./resize.js";
import { setupStatusBar } from "./statusbar.js";
import { setupTabs } from "./tabs.js";
import { setupToolbar } from "./toolbar.js";

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
  pasteHelper: document.getElementById("paste-helper") as HTMLInputElement,
};

let viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
let isVisible = true;

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

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "ready":
      viewport = msg.viewport;
      toolbar.setUrl(msg.url);
      document.title = msg.title ? `${msg.title} — Browser Interface` : "Browser Interface";
      statusBar.setCdpEndpoint(msg.cdpEndpoint ?? "");
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
      tabs.hideInactive();
      statusBar.recordFrame();
      fitFrame();
      return;
    }
    case "page":
      toolbar.setUrl(msg.url);
      document.title = msg.title ? `${msg.title} — Browser Interface` : "Browser Interface";
      statusBar.setLoading(msg.loading);
      return;
    case "tabs":
      tabs.setTabs(msg.tabs);
      return;
    case "visibility":
      if (msg.visible !== isVisible) {
        isVisible = msg.visible;
        document.body.classList.toggle("out-of-focus", !isVisible);
        tabs.setVisibility(msg.visible);
      }
      return;
    case "inactive":
      tabs.showInactive();
      return;
    case "hover":
      statusBar.setHoverLink(msg.href);
      return;
    case "selection":
      pasteHelper.setRemoteSelection(msg.text);
      return;
    case "error":
      console.warn("[bridge] server error:", msg.message);
      showToast(msg.message);
      if (msg.id !== undefined) resize.notifyResolved(msg.id);
      return;
    case "ack":
      if (msg.id !== undefined) resize.notifyResolved(msg.id);
      return;
  }
}

const statusBar = setupStatusBar({
  status: els.status,
  cdpEndpoint: els.cdpEndpoint,
  loadingIndicator: els.loadingIndicator,
  fps: els.fps,
  hoverLink: els.hoverLink,
});
const bridge = createBridge({
  setStatus: statusBar.setStatus,
  onMessage: handleServerMessage,
});
const pasteHelper = setupPasteHelper({
  el: els.pasteHelper,
  send: bridge.send,
  isUrlBarFocused: () => document.activeElement === els.url,
  debug: true,
});
const resize = setupResize({
  handle: els.resizeHandle,
  readout: els.resizeReadout,
  frame: els.frame,
  getViewport: () => viewport,
  send: bridge.send,
});
const tabs = setupTabs({
  tabsEl: els.tabs,
  inactiveOverlay: els.inactiveOverlay,
  inactiveRevive: els.inactiveRevive,
  inactiveCancel: els.inactiveCancel,
  send: bridge.send,
});
const toolbar = setupToolbar({
  back: els.back,
  forward: els.forward,
  reload: els.reload,
  urlForm: els.urlForm,
  url: els.url,
  openExternal: els.openExternal,
  send: bridge.send,
  onUrlBlur: () => pasteHelper.focus(),
});
bridge.connect();

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
  pasteHelper.focus();
});

// Re-anchor focus once at startup so the first keystroke after page load
// already lands on the paste-helper. Toolbar handles the URL-bar blur path
// via its onUrlBlur callback.
window.addEventListener("load", () => pasteHelper.focus());

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

