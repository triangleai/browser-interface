import type { ModifierKey, MouseButton, ServerMessage } from "../shared/protocol.js";
import { createBridge } from "./bridge.js";
import { setupFindBar } from "./find-bar.js";
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
  findBar: document.getElementById("find-bar") as HTMLDivElement,
  findInput: document.getElementById("find-input") as HTMLInputElement,
  findCount: document.getElementById("find-count") as HTMLSpanElement,
  findPrev: document.getElementById("find-prev") as HTMLButtonElement,
  findNext: document.getElementById("find-next") as HTMLButtonElement,
  findClose: document.getElementById("find-close") as HTMLButtonElement,
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
      pasteHelper.setRemoteState({ text: msg.text, field: msg.field });
      return;
    case "findResult":
      findBar.setResult(msg.current, msg.total);
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
const findBar = setupFindBar({
  bar: els.findBar,
  input: els.findInput,
  count: els.findCount,
  prevBtn: els.findPrev,
  nextBtn: els.findNext,
  closeBtn: els.findClose,
  send: bridge.send,
  onClose: () => pasteHelper.focus(),
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

// Re-anchor focus once at startup so the first keystroke after page load
// already lands on the paste-helper. Toolbar handles the URL-bar blur path
// via its onUrlBlur callback.
window.addEventListener("load", () => pasteHelper.focus());

// Drag-aware pointer forwarding. We send distinct mousedown / mouseup so the
// remote sees press at one point and release at another — that's what makes
// drag-select work. While the button's held, mousemoves carry the active
// buttons array and skip throttling, since each frame can extend a text
// selection on the page and missing intermediate moves shows up as choppy
// selection edges. Outside a drag, mousemove is throttled (hover-only).
let dragging = false;

function mouseDbg(event: string, fields?: Record<string, unknown>) {
  if (fields) console.log(`[mouse] ${event}`, fields);
  else console.log(`[mouse] ${event}`);
}

function mouseButtonName(button: number): MouseButton {
  if (button === 2) return "right";
  if (button === 1) return "middle";
  return "left";
}

function mouseButtonsFromBits(bits: number): MouseButton[] {
  const buttons: MouseButton[] = [];
  if (bits & 1) buttons.push("left");
  if (bits & 2) buttons.push("right");
  if (bits & 4) buttons.push("middle");
  return buttons;
}

mouseTarget.addEventListener("mousedown", (e) => {
  e.preventDefault();
  pasteHelper.focus();
  mouseDbg("mousedown-event", { button: e.button, isVisible, detail: e.detail });
  if (!isVisible) {
    bridge.send({ type: "refocus" });
    return;
  }
  const { x, y } = pointToViewport(e);
  const id = bridge.send({
    type: "mousedown",
    x,
    y,
    button: mouseButtonName(e.button),
    clickCount: e.detail || 1,
    modifiers: modifiersFromEvent(e),
  });
  dragging = true;
  mouseDbg("mousedown-sent", { id, x, y, button: e.button });
});

// Listen on window so a release outside the frame (user dragged off the edge
// while text-selecting) still finalizes the gesture on the page side.
window.addEventListener("mouseup", (e) => {
  if (!dragging) {
    mouseDbg("mouseup-skip-not-dragging", { button: e.button });
    return;
  }
  dragging = false;
  if (!isVisible) return;
  const { x, y } = pointToViewport(e);
  const id = bridge.send({
    type: "mouseup",
    x,
    y,
    button: mouseButtonName(e.button),
    clickCount: e.detail || 1,
    modifiers: modifiersFromEvent(e),
  });
  mouseDbg("mouseup-sent", { id, x, y, button: e.button });
});

let lastMoveAt = 0;
let moveCounter = 0;
function dispatchMouseMove(e: MouseEvent) {
  if (!isVisible) return;
  const { x, y } = pointToViewport(e);
  const buttons = mouseButtonsFromBits(e.buttons);
  bridge.send({
    type: "mousemove",
    x,
    y,
    buttons,
    modifiers: modifiersFromEvent(e),
  });
  // Sample log so the console isn't drowned during a fast drag.
  moveCounter++;
  if (moveCounter % 10 === 1) {
    mouseDbg("mousemove-sample", { x, y, buttons, dragging, count: moveCounter });
  }
}

mouseTarget.addEventListener("mousemove", (e) => {
  if (dragging) return;
  const now = performance.now();
  if (now - lastMoveAt < 33) return;
  lastMoveAt = now;
  dispatchMouseMove(e);
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  dispatchMouseMove(e);
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

