import type { ClientAction } from "../shared/protocol.js";

// Owns the hidden (currently debug-visible) <input> that anchors clipboard
// behavior. Native Cmd-C copies straight off this element's selected value
// so the chord stays out of any JS call stack — that's what keeps macOS from
// escalating Cmd-letter chords to the Apple menu (Cmd-C/V/A → About This
// Mac). The element's value mirrors the remote DOM's selection padded with
// spaces (" <selection> ") so text-system motions land at distinguishable
// offsets we can detect via `selectionchange`.
export interface PasteHelperOptions {
  el: HTMLInputElement;
  send: (action: ClientAction) => string | null;
  // Bail out of focus-stealing and clipboard handling when the URL bar is
  // active — the URL bar should keep its own native input behavior.
  isUrlBarFocused: () => boolean;
  // When true, every state transition logs through `[clip]`-prefixed
  // console.log lines for debugging.
  debug?: boolean;
}

export interface PasteHelper {
  // Anchor focus on the helper and re-establish the content selection so
  // the next Cmd-C copies the right text. Call after any user gesture that
  // could have shifted focus into the screencast frame.
  focus: () => void;
  // Mirror new remote selection text into the helper. Call when a `selection`
  // server message arrives.
  setRemoteSelection: (text: string) => void;
}

export function setupPasteHelper(opts: PasteHelperOptions): PasteHelper {
  const { el, send, isUrlBarFocused } = opts;
  let lastRemoteSelection = "";

  const dbg = opts.debug
    ? (event: string, fields?: Record<string, unknown>) => {
        if (fields) console.log(`[clip] ${event}`, fields);
        else console.log(`[clip] ${event}`);
      }
    : (_event: string, _fields?: Record<string, unknown>) => {};

  function selectContent() {
    el.setSelectionRange(1, 1 + lastRemoteSelection.length);
  }

  function focus() {
    if (isUrlBarFocused()) return;
    const wasFocused = document.activeElement === el;
    if (!wasFocused) el.focus({ preventScroll: true });
    // Defensive value reset: covers initial focus before any selection
    // message arrives, and any state where the value drifted (paste,
    // accidental edits while the helper was visible during debugging).
    const expected = ` ${lastRemoteSelection} `;
    const dirty = el.value !== expected;
    if (dirty) el.value = expected;
    selectContent();
    dbg("focus-helper", {
      wasFocused,
      dirty,
      valueLen: el.value.length,
      selection: [el.selectionStart, el.selectionEnd],
    });
  }

  function setRemoteSelection(text: string) {
    lastRemoteSelection = text;
    el.value = ` ${text} `;
    dbg("server-selection", {
      textLen: text.length,
      textPreview: text.slice(0, 40),
      helperFocused: document.activeElement === el,
    });
    if (document.activeElement === el) selectContent();
  }

  // Detect text-system chords by watching how the user's selection lands
  // inside the padded value. Baseline = content selected (offsets 1..1+len).
  // Anything else maps to Cmd-A (full range), Ctrl-A/Home (caret at head),
  // or Ctrl-E/End (caret at tail). After forwarding the matching key action
  // to the remote, snap selection back to the baseline.
  document.addEventListener("selectionchange", () => {
    if (document.activeElement !== el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const len = el.value.length;
    const baseStart = 1;
    const baseEnd = 1 + lastRemoteSelection.length;
    if (start === baseStart && end === baseEnd) return;
    let detected: string | null = null;
    if (start === 0 && end === len) {
      detected = "cmd-a";
      send({ type: "key", key: "a", code: "KeyA", modifiers: ["Meta"], phase: "press" });
    } else if (start === 0 && end === 0) {
      detected = "ctrl-a";
      send({ type: "key", key: "a", code: "KeyA", modifiers: ["Control"], phase: "press" });
    } else if (start === len && end === len) {
      detected = "ctrl-e";
      send({ type: "key", key: "e", code: "KeyE", modifiers: ["Control"], phase: "press" });
    }
    dbg("selectionchange", { start, end, len, detected });
    selectContent();
  });

  // Cmd-V: route the system clipboard's plain text to the remote as an
  // IME-friendly insertText. preventDefault stops the local input from
  // also receiving the paste (which would shadow the remote-selection
  // mirror until the server pushed a fresh one).
  el.addEventListener("paste", (e) => {
    if (isUrlBarFocused()) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    dbg("paste-event", { textLen: text.length, textPreview: text.slice(0, 40) });
    if (text) send({ type: "type", text });
  });

  // Native copy off the input is what produces Cmd-C output. The listener
  // is observation-only (no preventDefault, no setData) — useful while the
  // pipeline is being debugged so we can see exactly what's about to land
  // on the system clipboard.
  el.addEventListener("copy", () => {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selected = el.value.slice(start, end);
    dbg("copy-event", { start, end, selectedLen: selected.length, selected });
  });

  return { focus, setRemoteSelection };
}
