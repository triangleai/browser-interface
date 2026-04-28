import type { ClientAction, TabInfo } from "../shared/protocol.js";

// Tab strip + inactive-tab overlay. The overlay lives next to the tabs
// because it's logically a per-tab state ("the active tab is discarded —
// reactivate?") and shares lifecycle with switching tabs (an inactive
// prompt left over from the previous tab gets cleared on switch).
export interface TabsOptions {
  tabsEl: HTMLElement;
  inactiveOverlay: HTMLElement;
  inactiveRevive: HTMLElement;
  inactiveCancel: HTMLElement;
  send: (action: ClientAction) => string | null;
  // Optional persistent button rendered as the first child of the tab strip.
  // Re-prepended on every render so it scrolls with the tabs (the same way
  // the trailing "+" new-tab button does).
  leadingButton?: HTMLElement;
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
  const { tabsEl, inactiveOverlay, inactiveRevive, inactiveCancel, send, leadingButton } = opts;
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

  function render() {
    tabsEl.replaceChildren();
    if (leadingButton) tabsEl.appendChild(leadingButton);
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
      });
      tabsEl.appendChild(el);
    }
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "new-tab";
    newBtn.textContent = "+";
    newBtn.title = "New tab";
    newBtn.addEventListener("click", () => send({ type: "newTab" }));
    tabsEl.appendChild(newBtn);
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
