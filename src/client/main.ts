import type { ModifierKey, MouseButton, ServerMessage } from "../shared/protocol.js";
import { createBridge } from "./bridge.js";
import { setupFindBar } from "./find-bar.js";
import { setupPasteHelper } from "./paste-helper.js";
import { setupStatusBar } from "./statusbar.js";
import { setupTabs } from "./tabs.js";
import { setupToolbar } from "./toolbar.js";
import { setupTouch } from "./touch.js";

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
  pasteHelper: document.getElementById("paste-helper") as HTMLInputElement,
  findBar: document.getElementById("find-bar") as HTMLDivElement,
  findInput: document.getElementById("find-input") as HTMLInputElement,
  findCount: document.getElementById("find-count") as HTMLSpanElement,
  findPrev: document.getElementById("find-prev") as HTMLButtonElement,
  findNext: document.getElementById("find-next") as HTMLButtonElement,
  findClose: document.getElementById("find-close") as HTMLButtonElement,
  orientToggle: document.getElementById("orient-toggle") as HTMLButtonElement,
  sidebarResize: document.getElementById("sidebar-resize") as HTMLDivElement,
  tabSidebar: document.getElementById("tab-sidebar") as HTMLElement,
  vpMatchSize: document.getElementById("vp-match-size") as HTMLButtonElement,
  vpDesktopSize: document.getElementById("vp-desktop-size") as HTMLButtonElement,
};

let viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
let isVisible = true;
let activeTabId: string | null = null;
// Mirrors whether the remote has an editable input/textarea focused, kept
// in sync with the latest selection message. Drives helper focus on touch:
// on coarse-pointer devices we only want the OS keyboard up when there's
// somewhere to type, not on every tap.
let remoteHasField = false;
// Whether the remote's tracked mouse position is currently over an
// editable target — text-type input, textarea, or contenteditable.
// Updated from `hover` messages. The touch handler reads this on
// touchend to decide whether to focus the paste helper inside the
// gesture, popping the OS keyboard for editable targets only. Distinct
// from `cursor === 'text'` because plain page text glyphs also produce
// the I-beam cursor without being editable.
let lastCursorEditable = false;
// True between a touchstart-dispatched hover probe and the matching
// hover response — i.e., we don't yet know what the user just tapped.
// On a tap that lands while still in flight, the touch handler
// speculatively force-focuses the helper so a slow probe doesn't
// cost the user a second tap on a real field. The selection-handler
// blur path dismisses the keyboard ~100ms later if the click turned
// out to be on a non-editable. Net: every field works first-tap;
// non-editable taps only flash when the probe is unusually slow.
let probeInFlight = false;
const isCoarsePointer =
  typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

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
      document.title = msg.title ? `${msg.title} — browserface` : "browserface";
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
      document.title = msg.title ? `${msg.title} — browserface` : "browserface";
      statusBar.setLoading(msg.loading);
      return;
    case "tabs": {
      // Find state (cached ranges, highlights, count) belongs to the page
      // we attached to. Switching tabs invalidates all of it, so close the
      // bar — the user can re-open with Cmd-F on the new tab.
      const nextActive = msg.tabs.find((t) => t.active)?.id ?? null;
      if (activeTabId !== null && nextActive !== activeTabId && findBar.isVisible()) {
        findBar.hide();
      }
      activeTabId = nextActive;
      tabs.setTabs(msg.tabs);
      return;
    }
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
      // Mirror the remote's cursor on the screencast frame so hovering a
      // link shows pointer, an input shows the I-beam, etc.
      els.frame.style.cursor = msg.cursor || "default";
      lastCursorEditable = !!msg.editable;
      probeInFlight = false;
      console.log("[probe] hover-received", {
        cursor: msg.cursor,
        editable: !!msg.editable,
        href: msg.href,
      });
      return;
    case "selection":
      pasteHelper.setRemoteState({ text: msg.text, field: msg.field });
      // `editable` is the superset signal: input/textarea (which also set
      // `field`) AND contenteditable subtrees (which don't, because their
      // value/selection model doesn't fit the field tuple). Track this
      // separately so the mobile keyboard pops for ChatGPT-style
      // contenteditable composers, not just plain inputs.
      remoteHasField = !!msg.editable;
      // On coarse-pointer devices, sync the OS keyboard with the remote's
      // focused-field state. iOS leaves a transient user-activation window
      // open for ~5s after a tap, so a selection message that arrives
      // ~100ms later (the cdp-session selection-poll throttle) can still
      // pop the keyboard from a programmatic focus call. Blur on no-field
      // dismisses the keyboard when the user taps a non-editable area.
      // Desktop is unchanged — the helper stays focused unconditionally
      // there because it's the clipboard anchor.
      if (isCoarsePointer) {
        if (remoteHasField) pasteHelper.focus();
        else pasteHelper.blur();
      }
      return;
    case "findResult":
      findBar.setResult(msg.current, msg.total);
      return;
    case "error":
      console.warn("[bridge] server error:", msg.message);
      showToast(msg.message);
      return;
    case "ack":
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
// Re-anchor focus on the paste helper after another input gives it up
// (URL bar, find bar). On coarse pointers we suppress the call when the
// remote isn't on an editable field, so dismissing the URL bar on mobile
// doesn't immediately re-pop the OS keyboard via the helper.
function refocusPasteHelper() {
  if (!isCoarsePointer || remoteHasField) pasteHelper.focus();
}
const tabs = setupTabs({
  tabsEl: els.tabs,
  sidebarEl: els.tabSidebar,
  inactiveOverlay: els.inactiveOverlay,
  inactiveRevive: els.inactiveRevive,
  inactiveCancel: els.inactiveCancel,
  send: bridge.send,
  // After any tab switch / new-tab, dismiss the mobile overlay sidebar so
  // the user lands back on the page they just selected without an extra
  // tap to close. No-op on desktop or when the sidebar isn't open.
  onTabAction: () => closeMobileSidebar(),
});
const toolbar = setupToolbar({
  back: els.back,
  forward: els.forward,
  reload: els.reload,
  urlForm: els.urlForm,
  url: els.url,
  openExternal: els.openExternal,
  send: bridge.send,
  onUrlBlur: refocusPasteHelper,
});
const findBar = setupFindBar({
  bar: els.findBar,
  input: els.findInput,
  count: els.findCount,
  prevBtn: els.findPrev,
  nextBtn: els.findNext,
  closeBtn: els.findClose,
  send: bridge.send,
  onClose: refocusPasteHelper,
});
bridge.connect();

// ── Suppress Safari's swipe-to-navigate at the tab strip's edges ─────────
// CSS overscroll-behavior on html/body isn't honored by Safari for the
// trackpad page-swipe gesture, so we preventDefault wheel events on the
// tab strip when the user is overscrolling horizontally past either edge.
// Internal horizontal scrolling still works normally.
els.tabs.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const atLeft = els.tabs.scrollLeft <= 0;
    const atRight =
      els.tabs.scrollLeft + els.tabs.clientWidth >= els.tabs.scrollWidth - 1;
    if ((atLeft && e.deltaX < 0) || (atRight && e.deltaX > 0)) {
      e.preventDefault();
    }
  },
  { passive: false },
);

// ── Tab orientation (horizontal strip ⇄ vertical sidebar) ────────────────
const ORIENT_KEY = "browserface:orient";
const SIDEBAR_KEY = "browserface:sidebar-width";
const SIDEBAR_MIN = 80;
const SIDEBAR_MAX = 480;
// Below this, dragging snaps the sidebar shut and switches back to the
// horizontal strip. Acts as a "close by drag" affordance — drag the handle
// far enough left and the sidebar hides itself. Stays below MIN so a
// drag-to-min release doesn't immediately close.
const SIDEBAR_CLOSE_AT = 60;
// Width applied when opening the sidebar if the persisted width is too
// narrow to be useful (e.g., last drag landed at the minimum). Keeps
// customized larger widths intact.
const SIDEBAR_OPEN_DEFAULT = 240;
const SIDEBAR_OPEN_FLOOR = 180;

// Narrow-viewport breakpoint. The CSS half lives in style.css under the
// `MOBILE-BP-CSS` marker; media queries can't read CSS variables, so
// changing the value means editing both sides.
const MOBILE_BP = 701;
type Orient = "horizontal" | "vertical";
function applyOrient(o: Orient) {
  document.body.classList.toggle("orient-vertical", o === "vertical");
}
function closeMobileSidebar() {
  if (window.innerWidth >= MOBILE_BP) return;
  if (!document.body.classList.contains("orient-vertical")) return;
  applyOrient("horizontal");
  localStorage.setItem(ORIENT_KEY, "horizontal");
}
const storedOrient = localStorage.getItem(ORIENT_KEY);
applyOrient(storedOrient === "vertical" ? "vertical" : "horizontal");

// Tap-outside-to-close for the mobile overlay sidebar. Skipped on desktop
// (where vertical mode is a layout push, not an overlay) and skipped when
// the tap lands inside the sidebar or on the hamburger — the sidebar's
// own button handlers and the toggle button already manage those paths.
document.addEventListener("click", (e) => {
  if (window.innerWidth >= MOBILE_BP) return;
  if (!document.body.classList.contains("orient-vertical")) return;
  const target = e.target as Node;
  if (els.tabSidebar.contains(target)) return;
  if (els.orientToggle.contains(target)) return;
  closeMobileSidebar();
});

// Tap-anywhere-outside-the-frame → send Escape to the remote. Closes any
// open menu / dropdown / modal on the page, since clicking outside the
// frame area (status bar, stage letterbox, toolbar empty space, body
// padding) is the user's natural "dismiss" gesture but those clicks
// otherwise go nowhere — the remote never sees them. Skipped when the
// click lands inside the frame (handled by the touch / mouse path) or
// on an interactive bridge-UI control (buttons, links, inputs, ARIA
// button roles), so a button's own action runs without an extra
// Escape going to the remote.
document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  if (!target) return;
  if (els.frame.contains(target)) return;
  if (target.closest("button, input, a, [role='button']")) return;
  bridge.send({ type: "key", key: "Escape", code: "Escape", phase: "press" });
});

function applySidebarWidth(px: number) {
  const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
  document.documentElement.style.setProperty("--tab-sidebar-width", `${clamped}px`);
  return clamped;
}
const storedWidth = Number(localStorage.getItem(SIDEBAR_KEY));
if (Number.isFinite(storedWidth) && storedWidth > 0) applySidebarWidth(storedWidth);

els.orientToggle.addEventListener("click", () => {
  const next: Orient = document.body.classList.contains("orient-vertical")
    ? "horizontal"
    : "vertical";
  applyOrient(next);
  localStorage.setItem(ORIENT_KEY, next);
  // Bump sub-comfortable widths up to a sane default on open — otherwise
  // a previous drag-to-min release leaves the sidebar reopening tiny.
  if (next === "vertical") {
    const cur = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--tab-sidebar-width"),
    );
    if (!Number.isFinite(cur) || cur < SIDEBAR_OPEN_FLOOR) {
      applySidebarWidth(SIDEBAR_OPEN_DEFAULT);
      localStorage.setItem(SIDEBAR_KEY, String(SIDEBAR_OPEN_DEFAULT));
    }
  }
  fitFrame();
});

// Sidebar resize: drag the handle, update the CSS variable on the fly,
// persist on release. fitFrame after each update so the screencast image
// re-fits the new stage width.
let sidebarDragging = false;
let sidebarStartX = 0;
let sidebarStartW = 0;
els.sidebarResize.addEventListener("mousedown", (e) => {
  e.preventDefault();
  sidebarDragging = true;
  sidebarStartX = e.clientX;
  const cur = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--tab-sidebar-width"),
  );
  sidebarStartW = Number.isFinite(cur) && cur > 0 ? cur : 220;
  els.sidebarResize.classList.add("dragging");
  document.body.classList.add("dragging-sidebar");
});
window.addEventListener("mousemove", (e) => {
  if (!sidebarDragging) return;
  const desired = sidebarStartW + (e.clientX - sidebarStartX);
  if (desired < SIDEBAR_CLOSE_AT) {
    // Drag-to-close: switch to horizontal and end the drag. The width itself
    // stays at its last sane value so re-opening the sidebar feels the same.
    sidebarDragging = false;
    els.sidebarResize.classList.remove("dragging");
    document.body.classList.remove("dragging-sidebar");
    applyOrient("horizontal");
    localStorage.setItem(ORIENT_KEY, "horizontal");
    fitFrame();
    return;
  }
  applySidebarWidth(desired);
  fitFrame();
});
window.addEventListener("mouseup", () => {
  if (!sidebarDragging) return;
  sidebarDragging = false;
  els.sidebarResize.classList.remove("dragging");
  document.body.classList.remove("dragging-sidebar");
  const cur = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--tab-sidebar-width"),
  );
  if (Number.isFinite(cur) && cur > 0) localStorage.setItem(SIDEBAR_KEY, String(Math.round(cur)));
});

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
  // Reset the frame's cursor so the bridge UI's own areas (toolbar, etc.)
  // aren't stuck mirroring a remote pointer/text-cursor.
  els.frame.style.cursor = "";
});

// Re-anchor focus once at startup so the first keystroke after page load
// already lands on the paste-helper. Toolbar handles the URL-bar blur path
// via its onUrlBlur callback. Skipped on coarse pointers — focusing the
// hidden helper at load on mobile would mark it as the active element
// before any field exists on the remote, which suppresses the keyboard
// pop later when the selection handler calls focus() on it again.
window.addEventListener("load", () => {
  if (!isCoarsePointer) pasteHelper.focus();
});

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
  refocusPasteHelper();
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

// ── Touch (coarse pointer) ───────────────────────────────────────────────────
//
// Set up regardless of pointer kind so a desktop with a touchscreen still
// works; nothing here fires unless the user actually touches.
setupTouch({
  frame: els.frame,
  send: bridge.send,
  pointToViewport,
  getRemoteToLocalScale: () => {
    const local = els.frame.clientWidth;
    return local > 0 ? viewport.width / local : 1;
  },
  onProbeStart: () => {
    probeInFlight = true;
  },
  focusPasteHelperOnTap: () => {
    // Force-focus the helper inside the touch gesture if we have any
    // signal that the tap might land on an editable target:
    //   - lastCursorEditable: the touchstart probe completed and said
    //     yes (deterministic).
    //   - remoteHasField: the remote was already on a field before the
    //     tap (covers tapping the same input twice).
    //   - probeInFlight: the touchstart probe hasn't returned yet, so
    //     we don't know — speculate. Selection handler dismisses the
    //     keyboard ~100ms later if the click turned out non-editable.
    // Everything else: don't focus, so plain text / image taps don't
    // flash the keyboard. Uses forceFocus (blur + focus) so iOS sees
    // a fresh focus transition even when the helper was already
    // focused from a prior selection-handler call.
    if (lastCursorEditable || remoteHasField || probeInFlight) {
      pasteHelper.forceFocus();
    }
  },
});

// ── Viewport size buttons ────────────────────────────────────────────────────
//
// Two one-tap shortcuts that ship `setViewport`:
//
//   - Match size (always visible — replaces the old drag handle): resizes
//     the remote so it fills what the user can actually see. On desktop
//     that's the frame area (stage − in-stage status bar) so there's no
//     letterboxing around the screencast; on mobile that's the window
//     itself, because `body { height: 100% }` measures iOS Safari's
//     layout viewport (which includes the URL-bar zone), and using it
//     would leave the remote rendered taller than the visible viewport.
//
//   - Desktop size (narrow screens only): remote = (1280, 1280 × phone-
//     aspect). Wide enough that responsive sites pick the desktop layout,
//     kept at the visible viewport's aspect so the screencast fills the
//     screen without big letterboxing. Trade-off on a phone: tall content
//     area, more scrolling than a real desktop window.
const DESKTOP_PRESET_WIDTH = 1280;
function matchSizeArea(): { w: number; h: number } {
  // Below the narrow breakpoint, prefer the visual viewport (or innerWidth/
  // innerHeight). Mobile-designed pages expect to render at the phone's
  // actual screen dims; using the smaller frame area would silently shrink
  // them and the visual viewport handles iOS URL-bar collapse for free.
  if (window.innerWidth < MOBILE_BP) {
    const vv = window.visualViewport;
    return {
      w: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
      h: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
    };
  }
  // Desktop: subtract the in-stage status bar so the screencast fills the
  // frame box at 1:1. Tab strip + toolbar live outside the stage already.
  const statusbar = document.querySelector(".statusbar") as HTMLElement | null;
  const statusH = statusbar ? statusbar.offsetHeight : 0;
  return {
    w: Math.max(1, els.stage.clientWidth),
    h: Math.max(1, els.stage.clientHeight - statusH),
  };
}
els.vpMatchSize.addEventListener("click", () => {
  const { w, h } = matchSizeArea();
  bridge.send({ type: "setViewport", width: w, height: h });
});
els.vpDesktopSize.addEventListener("click", () => {
  // Desktop-size is only visible at narrow widths, so the aspect always
  // comes from the phone's visible viewport — pinning to matchSizeArea
  // means the desktop-width window stays at the same shape as the
  // user's screen, no letterboxing when the frame fits to it.
  const { w, h } = matchSizeArea();
  bridge.send({
    type: "setViewport",
    width: DESKTOP_PRESET_WIDTH,
    height: Math.round((DESKTOP_PRESET_WIDTH * h) / w),
  });
});

