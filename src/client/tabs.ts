import type { ClientAction, TabInfo } from "../shared/protocol.js";

// Tab strip + inactive-tab overlay. The overlay lives next to the tabs
// because it's logically a per-tab state ("the active tab is discarded —
// reactivate?") and shares lifecycle with switching tabs (an inactive
// prompt left over from the previous tab gets cleared on switch).
//
// The list is rendered into both `tabsEl` (the always-visible horizontal
// strip) and an optional `sidebarEl` (the mobile overlay sidebar). Each
// container gets its own freshly-built buttons so listeners attach
// correctly — sharing the same DOM nodes across containers isn't
// possible. `onTabAction` fires after a tab switch / new-tab so the
// caller can dismiss the mobile sidebar overlay.
export interface TabsOptions {
  tabsEl: HTMLElement;
  sidebarEl?: HTMLElement | null;
  inactiveOverlay: HTMLElement;
  inactiveRevive: HTMLElement;
  inactiveCancel: HTMLElement;
  send: (action: ClientAction) => string | null;
  onTabAction?: () => void;
}

export interface TabsController {
  // Render a fresh tab list. Triggered by `tabs` server messages.
  setTabs: (tabs: TabInfo[]) => void;
  // Update the dimmed state of the active tab. Triggered when the bridge's
  // attached tab moves between foreground / background in real Chrome.
  setVisibility: (visible: boolean) => void;
  showInactive: () => void;
  hideInactive: () => void;
}

export function setupTabs(opts: TabsOptions): TabsController {
  const { tabsEl, sidebarEl, inactiveOverlay, inactiveRevive, inactiveCancel, send, onTabAction } =
    opts;
  let lastTabs: TabInfo[] = [];
  let isVisible = true;

  function showInactive() {
    inactiveOverlay.hidden = false;
  }

  function hideInactive() {
    inactiveOverlay.hidden = true;
  }

  inactiveRevive.addEventListener("click", () => {
    send({ type: "reviveTab" });
    hideInactive();
  });
  inactiveCancel.addEventListener("click", hideInactive);

  function fireTabAction() {
    if (onTabAction) onTabAction();
  }

  function renderInto(target: HTMLElement) {
    target.replaceChildren();
    for (const tab of lastTabs) {
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
        send({ type: "closeTab", tabId: tab.id });
      });
      el.appendChild(close);

      el.addEventListener("click", () => {
        if (!tab.active) {
          // Clear any inactive prompt left over from the previous tab so it
          // doesn't linger over the new one until the timeout re-fires.
          hideInactive();
          send({ type: "switchTab", tabId: tab.id });
        } else {
          // Re-clicking the active tab refocuses it in the user's real Chrome
          // — the bridge already attaches here, this just brings it forward.
          send({ type: "refocus" });
        }
        fireTabAction();
      });
      target.appendChild(el);
    }
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "new-tab";
    newBtn.textContent = "+";
    newBtn.title = "New tab";
    newBtn.addEventListener("click", () => {
      send({ type: "newTab" });
      fireTabAction();
    });
    target.appendChild(newBtn);
  }

  function render() {
    renderInto(tabsEl);
    if (sidebarEl) renderInto(sidebarEl);
  }

  return {
    setTabs(tabs) {
      lastTabs = tabs;
      render();
    },
    setVisibility(visible) {
      if (visible === isVisible) return;
      isVisible = visible;
      render();
    },
    showInactive,
    hideInactive,
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
