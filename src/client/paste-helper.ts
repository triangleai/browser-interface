import type { ClientAction, ModifierKey } from "../shared/protocol.js";

// Owns the hidden (currently debug-visible) <input> that anchors clipboard
// behavior. Native Cmd-C copies straight off this element's selected value
// so the chord stays out of any JS call stack — that's what keeps macOS
// from escalating Cmd-letter chords to the Apple menu.
//
// Two display modes, driven by setRemoteState:
//
//   - "selection" mode (default): the helper mirrors the remote DOM's text
//     selection padded with spaces, " <selection> ", with the content range
//     pre-selected. Native Cmd-C copies the right text. A selectionchange
//     observer detects Cmd-A / Ctrl-A / Ctrl-E from how the selection lands
//     in the padded value and forwards them to the remote.
//
//   - "field" mode: the remote's focused element is an <input> / <textarea>.
//     The helper mirrors the field's full value plus selection range so
//     arrow-key navigation in the helper visually matches what the user
//     would see on the remote. The selectionchange detector is disabled
//     here — keystrokes that move the caret are forwarded directly via the
//     keydown handler, and the field's authoritative state comes back from
//     the server.
export interface PasteHelperOptions {
  el: HTMLInputElement;
  send: (action: ClientAction) => string | null;
  isUrlBarFocused: () => boolean;
  debug?: boolean;
}

// Shape mirrored straight from SelectionMessage minus the wire-protocol
// `type` field. Kept here to avoid a hard dependency on the server message
// type from this module.
export interface RemoteState {
  text: string;
  field?: {
    value: string;
    selectionStart: number;
    selectionEnd: number;
  };
}

export interface PasteHelper {
  focus: () => void;
  setRemoteState: (state: RemoteState) => void;
}

// Caret/selection-moving keys we forward as-is to the remote. preventDefault
// stops the local input from also responding (which would either drift the
// caret out of the baseline in selection mode or fight the field-mirror in
// field mode).
const NAV_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

// Non-character keys we forward in both modes — Escape closes remote dialogs,
// Tab moves focus inside the remote page, Enter submits/activates.
const CONTROL_KEYS = new Set(["Escape", "Tab", "Enter"]);

function modifiersFromEvent(e: KeyboardEvent): ModifierKey[] {
  const mods: ModifierKey[] = [];
  if (e.altKey) mods.push("Alt");
  if (e.ctrlKey) mods.push("Control");
  if (e.metaKey) mods.push("Meta");
  if (e.shiftKey) mods.push("Shift");
  return mods;
}

export function setupPasteHelper(opts: PasteHelperOptions): PasteHelper {
  const { el, send, isUrlBarFocused } = opts;

  // Authoritative remote state. Updated by setRemoteState; applied to the
  // <input> via applyState. lastProgrammaticSelection records what we last
  // wrote so the selectionchange observer can ignore our own writes.
  let state: RemoteState = { text: "" };
  let lastProgrammaticSelection: [number, number] = [0, 0];

  const dbg = opts.debug
    ? (event: string, fields?: Record<string, unknown>) => {
        if (fields) console.log(`[clip] ${event}`, fields);
        else console.log(`[clip] ${event}`);
      }
    : (_event: string, _fields?: Record<string, unknown>) => {};

  function expectedValue(): string {
    return state.field ? state.field.value : ` ${state.text} `;
  }

  function expectedSelection(): [number, number] {
    if (state.field) return [state.field.selectionStart, state.field.selectionEnd];
    return [1, 1 + state.text.length];
  }

  function applyState() {
    const value = expectedValue();
    if (el.value !== value) el.value = value;
    const [start, end] = expectedSelection();
    if (document.activeElement === el) el.setSelectionRange(start, end);
    lastProgrammaticSelection = [start, end];
  }

  function focus() {
    if (isUrlBarFocused()) return;
    const wasFocused = document.activeElement === el;
    if (!wasFocused) el.focus({ preventScroll: true });
    applyState();
    dbg("focus-helper", {
      wasFocused,
      mode: state.field ? "field" : "selection",
      valueLen: el.value.length,
      selection: [el.selectionStart, el.selectionEnd],
    });
  }

  function setRemoteState(next: RemoteState) {
    // Stale-mirror skip: when the user types faster than the server polls,
    // an in-flight selection event can arrive carrying the field's earlier
    // value (a prefix of what we already typed locally). Applying it would
    // wipe the un-confirmed tail and snap the caret back. Detect and drop
    // — a fresher mirror is on the way.
    if (
      next.field &&
      document.activeElement === el &&
      el.value.length > next.field.value.length &&
      el.value.startsWith(next.field.value)
    ) {
      dbg("server-selection-skip-stale", {
        localLen: el.value.length,
        mirrorLen: next.field.value.length,
      });
      return;
    }
    state = next;
    applyState();
    dbg("server-selection", {
      mode: next.field ? "field" : "selection",
      textLen: next.text.length,
      textPreview: next.text.slice(0, 40),
      fieldValueLen: next.field?.value.length,
      fieldSelection: next.field
        ? [next.field.selectionStart, next.field.selectionEnd]
        : undefined,
      helperFocused: document.activeElement === el,
    });
  }

  // Selection-state observer. In selection mode it detects text-system
  // chords (Cmd-A / Ctrl-A / Ctrl-E) by how the selection lands inside the
  // padded value and forwards the matching key action. In field mode it's
  // disabled — keystrokes are forwarded by the keydown handler and the
  // field's state is mirrored back by the server.
  document.addEventListener("selectionchange", () => {
    if (document.activeElement !== el) {
      dbg("selectionchange-skip", { reason: "helper-not-focused" });
      return;
    }
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const len = el.value.length;
    const mode = state.field ? "field" : "selection";
    if (
      start === lastProgrammaticSelection[0] &&
      end === lastProgrammaticSelection[1]
    ) {
      dbg("selectionchange-skip", {
        reason: "matches-programmatic",
        start,
        end,
        len,
        mode,
      });
      return;
    }
    // Cmd-A is detected in both modes — the padded baseline " <text> " in
    // selection mode and the field-mirrored value in field mode both sit
    // strictly inside [0, len], so a full-range selection only happens via
    // the chord. Ctrl-A / Ctrl-E are caret-positioning text-system commands
    // that only mean something inside an editable field, so we restrict
    // those to field mode.
    let detected: string | null = null;
    if (start === 0 && end === len && len > 0) {
      detected = "cmd-a";
      send({ type: "key", key: "a", code: "KeyA", modifiers: ["Meta"], phase: "press" });
    } else if (state.field && start === 0 && end === 0) {
      detected = "ctrl-a";
      send({ type: "key", key: "a", code: "KeyA", modifiers: ["Control"], phase: "press" });
    } else if (state.field && start === len && end === len) {
      detected = "ctrl-e";
      send({ type: "key", key: "e", code: "KeyE", modifiers: ["Control"], phase: "press" });
    }
    dbg("selectionchange", { start, end, len, mode, detected });
    applyState();
  });

  // Forward keystrokes to the remote. preventDefault keeps the local input's
  // caret pinned at our programmatic baseline; the authoritative post-keystroke
  // state comes back via setRemoteState.
  //
  // Skipped here:
  //  - pure modifier presses (Shift/Ctrl/Alt/Meta alone)
  //  - Cmd-letter chords — native paths handle these (Cmd-C/V via copy/paste
  //    events on the helper, Cmd-A via the selectionchange detector). Forwarding
  //    them via WebSocket.send inside the keydown stack also re-triggers the
  //    macOS Apple-menu escalation that the helper exists to avoid.
  //  - in selection mode, Ctrl-A / Ctrl-E — selectionchange detects those.
  //  - in field mode, plain printable keys — input events forward them as
  //    `type` actions so we don't double-send.
  el.addEventListener("keydown", (e) => {
    if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") {
      return;
    }
    if (e.metaKey) {
      dbg("keydown-cmd-chord", {
        key: e.key,
        code: e.code,
        mode: state.field ? "field" : "selection",
        defaultPrevented: e.defaultPrevented,
        helperValueLen: el.value.length,
      });
      return;
    }

    const modifiers = modifiersFromEvent(e);
    const forward = (label: string) => {
      e.preventDefault();
      send({ type: "key", key: e.key, code: e.code, modifiers, phase: "press" });
      dbg(label, { key: e.key, modifiers });
    };

    if (NAV_KEYS.has(e.key)) {
      forward("nav-key");
      return;
    }
    if (CONTROL_KEYS.has(e.key) || /^F\d{1,2}$/.test(e.key)) {
      forward("control-key");
      return;
    }
    if (e.key.length === 1) {
      if (state.field) {
        // Ctrl-K (kill-line) and Ctrl-Y (yank) modify content rather than
        // caret position, so selectionchange can't detect them — and letting
        // the local helper run them would corrupt the mirrored value before
        // the server's update arrives. Forward via keydown; preventDefault
        // keeps the helper stable while the server runs the editor command
        // on the remote (kill-ring is renderer-local).
        if (e.ctrlKey && (e.key === "k" || e.key === "y")) {
          forward("ctrl-text-cmd");
        }
        return;
      }
      if (e.ctrlKey && (e.key === "a" || e.key === "e")) return;
      forward("char-key");
    }
  });

  // In field mode, observe local edits and forward them to the remote so the
  // remote text input ends up with the same content. We don't preventDefault
  // the underlying keystroke — that gives the user immediate visual feedback
  // in the helper. The mirror update from the server confirms (and overrides
  // if the remote diverged, e.g. maxlength clamp). In selection mode the
  // helper isn't editable conceptually, so we ignore input events; any
  // accidental local mutation is reverted by the selectionchange handler's
  // applyState() snap-back.
  el.addEventListener("input", (e) => {
    if (!state.field) return;
    const ie = e as InputEvent;
    const inputType = ie.inputType;
    if (inputType === "insertFromPaste") return; // handled by paste listener
    if (inputType === "insertText" || inputType === "insertReplacementText") {
      if (typeof ie.data === "string" && ie.data.length > 0) {
        send({ type: "type", text: ie.data });
        dbg("input-text", { inputType, data: ie.data });
      }
      return;
    }
    if (inputType === "deleteContentBackward") {
      send({ type: "key", key: "Backspace", code: "Backspace", phase: "press" });
      dbg("input-delete", { direction: "backward" });
      return;
    }
    if (inputType === "deleteContentForward") {
      send({ type: "key", key: "Delete", code: "Delete", phase: "press" });
      dbg("input-delete", { direction: "forward" });
      return;
    }
    dbg("input-unhandled", { inputType, data: ie.data });
  });

  // Cmd-V: route the system clipboard's plain text to the remote as an
  // IME-friendly insertText. preventDefault stops the local input from also
  // receiving the paste (which would dirty its value and shadow the next
  // remote-state mirror until the server pushed a fresh one).
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

  return { focus, setRemoteState };
}
