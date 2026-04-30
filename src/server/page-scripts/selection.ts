// In-page expression for the selection / focused-field probe. Runs in the
// page's main world via Runtime.evaluate. Returns the current selection text
// plus:
//   - `field` (value + caret range) when the focused element is an
//     <input>/<textarea> — drives the desktop helper's value mirror.
//   - `editable` (boolean) for any editable focus, including
//     contenteditable elements that don't fit the field model. Drives
//     mobile OS-keyboard pop on the client (it focuses the paste helper
//     when an editable target is focused, regardless of whether we have
//     a usable value/selection mirror for it).
// JSON-encoded so we can ship a structured value through Runtime.evaluate's
// returnByValue without dealing with object-graph serialization.
export const SELECTION_PROBE = `JSON.stringify((() => {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    const v = ae.value || '';
    const s = ae.selectionStart || 0;
    const e = ae.selectionEnd || 0;
    return {
      text: v.slice(s, e),
      field: { value: v, selectionStart: s, selectionEnd: e },
      editable: true,
    };
  }
  const sel = document.getSelection();
  const text = sel ? sel.toString() : '';
  // isContentEditable returns true for contenteditable subtrees,
  // including inherited contenteditable="true" from an ancestor.
  const editable = !!(ae && ae.isContentEditable);
  return editable ? { text, editable: true } : { text };
})())`;
