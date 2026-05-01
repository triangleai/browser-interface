import type { ConnectionState } from "./bridge.js";

// Bottom status bar: connection-state pill, page-load indicator, FPS
// meter, and the hover-link readout. The viewport-size preset buttons
// (match-size / desktop-size) are wired up in main.ts; this module owns
// the meter/status cluster inside footer.statusbar.
export interface StatusBarOptions {
  status: HTMLElement;
  loadingIndicator: HTMLElement;
  fps: HTMLElement;
  hoverLink: HTMLAnchorElement;
}

export interface StatusBarController {
  setStatus: (state: ConnectionState) => void;
  setLoading: (loading: boolean) => void;
  // null clears the readout (cursor not on any link); a string sets the
  // anchor's text + href so left-click opens in the user's browser and
  // right-click → "Copy Link Address" works.
  setHoverLink: (href: string | null) => void;
  // Stamp a frame timestamp for the FPS meter. Call from the screencast
  // message handler.
  recordFrame: () => void;
}

export function setupStatusBar(opts: StatusBarOptions): StatusBarController {
  const { status, loadingIndicator, fps, hoverLink } = opts;

  function setStatus(state: ConnectionState) {
    status.dataset.state = state;
    status.textContent = {
      connecting: "connecting…",
      connected: "connected",
      disconnected: "disconnected",
      error: "error",
    }[state];
  }

  // FPS meter: keep last second's frame timestamps; refresh display every
  // 500ms. Reads "idle" when no frames are arriving so the UI distinguishes
  // a paused screencast from a slow one.
  const frameTimes: number[] = [];
  function recordFrame() {
    frameTimes.push(performance.now());
  }
  setInterval(() => {
    const now = performance.now();
    while (frameTimes.length && now - frameTimes[0]! > 1000) frameTimes.shift();
    fps.textContent = frameTimes.length === 0 ? "idle" : `${frameTimes.length} fps`;
  }, 500);

  return {
    setStatus,
    setLoading(loading) {
      loadingIndicator.hidden = !loading;
    },
    setHoverLink(href) {
      hoverLink.textContent = href ?? "";
      hoverLink.title = href ?? "";
      if (href) {
        hoverLink.href = href;
      } else {
        hoverLink.removeAttribute("href");
      }
    },
    recordFrame,
  };
}
