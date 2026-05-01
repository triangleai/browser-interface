import type { ClientAction } from "../shared/protocol.js";

// Top toolbar: nav buttons (back/forward/reload), URL bar with submit,
// and the open-in-current-browser button. Owns the urlEditing flag so
// remote-driven URL updates don't clobber whatever the user is typing.
export interface ToolbarOptions {
  back: HTMLButtonElement;
  forward: HTMLButtonElement;
  reload: HTMLButtonElement;
  urlForm: HTMLFormElement;
  url: HTMLInputElement;
  openExternal: HTMLButtonElement;
  send: (action: ClientAction) => string | null;
  // Fires when the URL bar loses focus, so the host can re-anchor focus
  // on the paste-helper without the toolbar needing to know about it.
  onUrlBlur: () => void;
}

export interface ToolbarController {
  // Update the URL bar's text from a server message. No-op while the user
  // is mid-edit so we don't yank what they're typing.
  setUrl: (url: string) => void;
  // Focus the URL bar with empty text — used when the UI opens a new tab,
  // mirroring Chrome's Cmd+T behavior (omnibox focused, ready to type).
  focusUrl: () => void;
}

// URLs the address bar should display as empty. Chrome's own omnibox
// hides the URL on the new-tab page; mirror that. about:blank stays
// visible — Chrome shows it literally and so do we.
const EMPTY_URL_DISPLAY = new Set(["chrome://newtab/"]);

// Decide whether the URL bar's contents should navigate (real URL) or fall
// back to a Google search (looks like a query). Mirrors what real browsers
// do — "github.com" navigates, "best pizza" searches. Returns "" for empty
// input. Heuristic:
//   - Has explicit scheme like https://, file://, about:, chrome://, mailto:
//     → pass through unchanged.
//   - Otherwise it has to be a single whitespace-free token that looks
//     host-shaped: contains a "." (so "github.com", "192.168.1.1") or is
//     "localhost" / "localhost:port".
//   - Anything else (multiple words, no dot, etc.) → Google search.
function buildNavigationTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(about|mailto|tel|chrome|view-source):/i.test(trimmed)) return trimmed;
  const isHostShaped =
    !/\s/.test(trimmed) &&
    (trimmed.includes(".") || /^localhost(:\d+)?(\/|$)/i.test(trimmed));
  if (isHostShaped) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function setupToolbar(opts: ToolbarOptions): ToolbarController {
  const { back, forward, reload, urlForm, url, openExternal, send, onUrlBlur } = opts;
  let urlEditing = false;

  back.addEventListener("click", () => send({ type: "back" }));
  forward.addEventListener("click", () => send({ type: "forward" }));
  reload.addEventListener("click", () => send({ type: "reload" }));

  url.addEventListener("focus", () => {
    urlEditing = true;
  });
  url.addEventListener("blur", () => {
    urlEditing = false;
    onUrlBlur();
  });

  urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const target = buildNavigationTarget(url.value);
    if (!target) return;
    send({ type: "navigate", url: target });
    url.blur();
  });

  // Open the address-bar URL in whatever browser the bridge UI is running
  // in (Safari, the user's daily Chrome, etc.) — distinct from "navigate",
  // which sends the URL into the bridged Chrome session.
  openExternal.addEventListener("click", () => {
    const target = buildNavigationTarget(url.value);
    if (!target) return;
    window.open(target, "_blank", "noopener,noreferrer");
  });

  return {
    setUrl(value) {
      if (urlEditing) return;
      url.value = EMPTY_URL_DISPLAY.has(value) ? "" : value;
    },
    focusUrl() {
      url.value = "";
      url.focus();
    },
  };
}
