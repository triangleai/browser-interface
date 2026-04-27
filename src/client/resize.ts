import type { ClientAction } from "../shared/protocol.js";

// Status-bar drag handle that resizes the remote viewport.
//
// The local frame is *not* sized from the cursor — the screencast pipeline
// drives that via fitFrame() on every incoming frame. Here we just capture
// the cursor's starting screen position and the remote viewport at drag-
// start, then translate further cursor movement into a delta on the remote
// dimensions and ship setViewport actions to the server.
//
// Adaptive pacing: only one outstanding setViewport in flight at a time.
// mousemove updates `pendingViewport`; we send immediately if no prior
// request is in flight, otherwise wait for that one's ack and then send the
// latest pending. Send rate auto-adapts to whatever Chrome can keep up with
// — a fixed-interval throttle was previously starving the screencast
// pipeline during fast drags because Chrome can't reflow + paint + screencast
// at 20Hz on heavy pages. The caller wires `notifyResolved` to be called
// from its ack/error handler so we know when the in-flight request is done.
export interface ResizeOptions {
  handle: HTMLElement;
  readout: HTMLElement;
  frame: HTMLElement;
  getViewport: () => { width: number; height: number };
  send: (action: ClientAction) => string | null;
}

export interface ResizeController {
  // Called from the bridge's ack/error message handler. Returns true if the
  // id matched an in-flight setViewport (so the caller can know it consumed
  // the message). Either way, any pending viewport is flushed.
  notifyResolved: (id: string) => boolean;
}

const MIN_REMOTE_W = 320;
const MIN_REMOTE_H = 240;

export function setupResize(opts: ResizeOptions): ResizeController {
  const { handle, readout, frame, getViewport, send } = opts;

  let dragStart: {
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    pxPerCssX: number;
    pxPerCssY: number;
  } | null = null;
  let pendingViewport: { width: number; height: number } | null = null;
  let lastSentViewport: { width: number; height: number } | null = null;
  let inFlightId: string | null = null;

  function flushPending() {
    if (!pendingViewport) return;
    if (inFlightId !== null) return;
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
    const id = send({ type: "setViewport", width: dims.width, height: dims.height });
    if (id !== null) inFlightId = id;
  }

  function queueUpdate(width: number, height: number) {
    pendingViewport = { width, height };
    flushPending();
  }

  function updateReadout(remoteW: number, remoteH: number) {
    readout.textContent = `${remoteW} × ${remoteH}`;
  }

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = frame.getBoundingClientRect();
    const v = getViewport();
    dragStart = {
      startX: e.clientX,
      startY: e.clientY,
      startW: v.width,
      startH: v.height,
      pxPerCssX: v.width / rect.width,
      pxPerCssY: v.height / rect.height,
    };
    document.body.classList.add("resizing");
    readout.hidden = false;
    updateReadout(v.width, v.height);
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragStart) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.startX;
    const dy = e.clientY - dragStart.startY;
    const remoteW = Math.max(
      MIN_REMOTE_W,
      Math.round(dragStart.startW + dx * dragStart.pxPerCssX),
    );
    const remoteH = Math.max(
      MIN_REMOTE_H,
      Math.round(dragStart.startH + dy * dragStart.pxPerCssY),
    );
    queueUpdate(remoteW, remoteH);
    updateReadout(remoteW, remoteH);
  });

  window.addEventListener("mouseup", (e) => {
    if (!dragStart) return;
    if (e.button !== 0) return;
    dragStart = null;
    document.body.classList.remove("resizing");
    readout.hidden = true;
    // Latest cursor delta is already in pendingViewport; if a previous
    // request is in flight, flushPending will pick it up on the ack.
    flushPending();
  });

  return {
    notifyResolved(id: string): boolean {
      if (id !== inFlightId) return false;
      inFlightId = null;
      flushPending();
      return true;
    },
  };
}
