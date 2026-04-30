import type { ClientAction } from "../shared/protocol.js";

// Touch / coarse-pointer gesture handler for the screencast frame. The
// desktop pipeline (mousedown / mousemove / mouseup / wheel) doesn't
// translate to mobile usefully on its own — a single finger has to mean
// either "click" or "scroll", and the page has no way to disambiguate
// without help. This module handles the disambiguation:
//
//   - Single finger, no significant movement before lift  → click at the
//     contact point, then focus the paste helper so the OS keyboard
//     pops up.
//   - Single finger, movement past TAP_THRESHOLD_PX        → scroll the
//     remote, with deltas converted from local CSS pixels to remote
//     viewport pixels (so a 100px drag scrolls more on a frame that's
//     half the size of the remote viewport).
//   - Multi-finger anything                                → ignored
//     here; the browser handles pinch-zoom natively because the frame
//     CSS sets `touch-action: pinch-zoom`.
//
// We deliberately don't try to support drag-to-select-text on mobile in
// this first pass — that would conflict with drag-to-scroll, which is
// the dominant mobile gesture. Future work could route a long-press
// gesture into a selection.
export interface TouchOptions {
  frame: HTMLElement;
  send: (action: ClientAction) => string | null;
  // Convert (clientX, clientY) into remote viewport coords.
  pointToViewport: (e: { clientX: number; clientY: number }) => { x: number; y: number };
  // Ratio of remote-viewport pixels to local CSS pixels on the frame —
  // i.e. `viewport.width / frame.clientWidth`. Used to scale finger-drag
  // deltas into remote-pixel scroll deltas.
  getRemoteToLocalScale: () => number;
  // Whether the latest hover message from the server reported an
  // editable target at the tracked position. We dispatch a mousemove on
  // touchstart so the server's hover poll runs at the tap coords; this
  // getter returns the result inside the touchend handler, giving the
  // tap a synchronous predictor of "did the user tap into a field?".
  getLastCursorEditable: () => boolean;
  // Called from inside the tap's touchend handler so a focus call lands
  // gesture-bound (iOS only pops the OS keyboard when focus happens
  // synchronously inside a user gesture; a focus from a WebSocket
  // onmessage callback fired ~100ms later is silently rejected for
  // keyboard purposes). Receives a synchronous prediction of whether
  // the tap landed on an editable target (input, textarea, or
  // contenteditable) so the caller can decide whether to focus.
  focusPasteHelperOnTap: (predictedEditable: boolean) => void;
}

const TAP_THRESHOLD_PX = 10;

export function setupTouch(opts: TouchOptions): void {
  const {
    frame,
    send,
    pointToViewport,
    getRemoteToLocalScale,
    getLastCursorEditable,
    focusPasteHelperOnTap,
  } = opts;

  let activeId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let scrolling = false;

  function findChanged(touches: TouchList, id: number): Touch | null {
    for (let i = 0; i < touches.length; i++) {
      const t = touches.item(i);
      if (t && t.identifier === id) return t;
    }
    return null;
  }

  frame.addEventListener(
    "touchstart",
    (e) => {
      // Multi-touch: bail out so the browser can handle pinch-zoom. If we
      // had an in-flight single-finger gesture, abandon it.
      if (e.touches.length !== 1) {
        activeId = null;
        scrolling = false;
        return;
      }
      const t = e.touches[0]!;
      activeId = t.identifier;
      startX = lastX = t.clientX;
      startY = lastY = t.clientY;
      scrolling = false;
      // Probe the cursor at the tap location so the touchend handler has
      // a chance to know whether the tap landed on an editable target.
      // Mobile doesn't fire mousemove on its own — without this dispatch
      // the server's hover poll would never run and lastCursorEditable
      // would stay at its default. The probe runs in parallel with the
      // user's finger-hold, giving the server ~80–300ms of touch time
      // to round-trip a hover message before touchend fires. Best case
      // the result lands in time and the next tap on a field pops the
      // OS keyboard inside the gesture; worst case the user taps twice.
      const { x, y } = pointToViewport(t);
      send({ type: "mousemove", x, y, buttons: [] });
    },
    { passive: true },
  );

  frame.addEventListener(
    "touchmove",
    (e) => {
      if (activeId === null) return;
      // Finger count changed mid-gesture (became a pinch) — abandon.
      if (e.touches.length !== 1) {
        activeId = null;
        scrolling = false;
        return;
      }
      const t = findChanged(e.touches, activeId);
      if (!t) return;
      const dx = t.clientX - lastX;
      const dy = t.clientY - lastY;
      const totalDist = Math.hypot(t.clientX - startX, t.clientY - startY);
      if (!scrolling && totalDist > TAP_THRESHOLD_PX) scrolling = true;
      if (scrolling) {
        // Drag finger up → page scrolls down (deltaY positive). Same sign
        // convention as wheel events on desktop. Scale by remote/local
        // ratio so a drag in the bridge UI moves the remote page by an
        // equivalent amount in remote coords.
        const scale = getRemoteToLocalScale();
        const { x, y } = pointToViewport(t);
        send({
          type: "scroll",
          x,
          y,
          deltaX: -dx * scale,
          deltaY: -dy * scale,
        });
        lastX = t.clientX;
        lastY = t.clientY;
        // Suppress whatever default the browser would have done with a
        // single-finger drag (e.g. iOS rubber-band, pull-to-refresh).
        // touch-action on the frame already handles most of this; this
        // is belt-and-suspenders for browsers that ignore touch-action.
        e.preventDefault();
      }
    },
    { passive: false },
  );

  frame.addEventListener("touchend", (e) => {
    if (activeId === null) return;
    const ended = findChanged(e.changedTouches, activeId);
    activeId = null;
    if (!ended) {
      scrolling = false;
      return;
    }
    if (!scrolling) {
      // Tap — fire press + release at the start coords so the remote sees
      // a real click. Then ask the host to focus the paste helper inside
      // this gesture if the tap landed on an editable target. iOS only
      // pops the OS keyboard for focus calls that happen synchronously
      // inside a user gesture; a focus from a WebSocket onmessage
      // callback ~100ms later is silently rejected for keyboard
      // purposes. The `predictedEditable` boolean is set from the
      // touchstart-dispatched hover probe.
      const { x, y } = pointToViewport({ clientX: startX, clientY: startY });
      send({ type: "mousedown", x, y, button: "left", clickCount: 1 });
      send({ type: "mouseup", x, y, button: "left", clickCount: 1 });
      focusPasteHelperOnTap(getLastCursorEditable());
    }
    scrolling = false;
  });

  frame.addEventListener("touchcancel", () => {
    activeId = null;
    scrolling = false;
  });
}
