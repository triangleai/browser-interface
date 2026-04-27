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
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
    const target = normalizeUrl(url.value);
    if (!target) return;
    send({ type: "navigate", url: target });
    url.blur();
  });

  // Open the address-bar URL in whatever browser the bridge UI is running
  // in (Safari, the user's daily Chrome, etc.) — distinct from "navigate",
  // which sends the URL into the bridged Chrome session.
  openExternal.addEventListener("click", () => {
    const target = normalizeUrl(url.value);
    if (!target) return;
    window.open(target, "_blank", "noopener,noreferrer");
  });

  return {
    setUrl(value) {
      if (urlEditing) return;
      url.value = value;
    },
  };
}
