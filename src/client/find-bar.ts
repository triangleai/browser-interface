import type { ClientAction } from "../shared/protocol.js";

// Owns the bridge UI's find-on-page bar. Chrome's native find is part of
// browser chrome and isn't part of the screencast, so we run the search
// ourselves: Cmd-F opens this bar, typing here sends `find` actions to the
// server, and the server's window.find() call selects + scrolls to the match
// inside the remote — which the screencast captures normally.

export interface FindBarOptions {
  bar: HTMLElement;
  input: HTMLInputElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  send: (action: ClientAction) => string | null;
  onClose: () => void;
}

export interface FindBar {
  show: () => void;
  hide: () => void;
  isVisible: () => boolean;
}

export function setupFindBar(opts: FindBarOptions): FindBar {
  const { bar, input, prevBtn, nextBtn, closeBtn, send, onClose } = opts;

  let lastQuery = "";
  let debounce: number | undefined;

  function find(direction: "next" | "prev", fromStart = false) {
    const query = input.value;
    if (!query) return;
    send({ type: "find", query, direction, fromStart });
    lastQuery = query;
  }

  function show() {
    if (bar.hidden) bar.hidden = false;
    input.focus({ preventScroll: true });
    input.select();
  }
  function hide() {
    if (debounce !== undefined) {
      window.clearTimeout(debounce);
      debounce = undefined;
    }
    bar.hidden = true;
    send({ type: "findStop" });
    onClose();
  }
  function isVisible() {
    return !bar.hidden;
  }

  // Incremental search while typing. Debounced so a fast typist doesn't
  // flood the wire with one find per keystroke. Each keystroke restarts
  // from the top so an edit can't skip matches earlier in the document
  // than the previous match's position.
  input.addEventListener("input", () => {
    if (debounce !== undefined) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => find("next", true), 180);
  });

  // Find-bar-local keystrokes shouldn't reach the page-level keydown path —
  // typing in the find input is for the find input.
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      find(e.shiftKey ? "prev" : "next");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
      return;
    }
  });

  prevBtn.addEventListener("click", () => find("prev"));
  nextBtn.addEventListener("click", () => find("next"));
  closeBtn.addEventListener("click", () => hide());

  // The find bar sits inside the .frame element which has a mousedown
  // listener that forwards clicks to the remote — without this, clicking
  // any button or the input would also click through to the underlying
  // remote page. Stopping mouse events at the bar contains them.
  for (const evt of ["mousedown", "mouseup", "click", "wheel"] as const) {
    bar.addEventListener(evt, (e) => e.stopPropagation());
  }

  // Window-level capture so we beat both the host browser's own find shortcut
  // and the paste-helper's keydown handler. Cmd-F opens; Cmd-G advances;
  // Shift-Cmd-G goes backward.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey) return;
      if (e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        show();
        return;
      }
      if (e.key === "g") {
        if (!lastQuery && !isVisible()) return;
        e.preventDefault();
        e.stopPropagation();
        if (!isVisible()) {
          input.value = lastQuery;
          show();
        }
        find(e.shiftKey ? "prev" : "next");
      }
    },
    true,
  );

  return { show, hide, isVisible };
}
