// In-page expression for the hover probe. Built per-call because the cursor
// coords are baked into the script body — keeps the hot path fast (no
// Runtime.evaluate argument marshaling) and means the probe sees the exact
// coords the bridge cached, not whatever document.elementFromPoint thinks
// the "current" position is.
//
// The script collects three things:
//   - The nearest anchor's href (status-bar hover URL).
//   - An effective cursor: walk ancestors for a non-`auto` computed cursor,
//     then fall back to inferring from the element's role (link, input,
//     contenteditable). Plain page text falls back to the I-beam only when
//     the point is actually inside a glyph rect — not just over a
//     text-containing element — to mirror native browser behavior.
//   - An `editable` flag, true only when the hover lands on an
//     input/textarea/contenteditable target. Distinct from `cursor === 'text'`
//     because plain glyphs also produce the I-beam, and the client needs to
//     tell the two apart for decisions like whether a tap should pop the OS
//     keyboard.
export function buildHoverProbe(x: number, y: number): string {
  return `(()=>{
    const x = ${x}, y = ${y};
    const stack = document.elementsFromPoint(x, y);
    const top = stack[0];
    if (!top) return { href: null, cursor: 'default', editable: false };
    const TEXT_INPUT_TYPES = ['text','search','email','url','tel','password','number'];
    function isEditableEl(e) {
      if (!e) return false;
      if (e.tagName === 'TEXTAREA') return true;
      if (e.tagName === 'INPUT') {
        const t = (e.getAttribute('type') || 'text').toLowerCase();
        return TEXT_INPUT_TYPES.indexOf(t) !== -1;
      }
      if (e.isContentEditable) return true;
      // ARIA roles that ride on plain divs to act as text inputs —
      // ProseMirror / Lexical editors, custom searchboxes, etc.
      const role = e.getAttribute && e.getAttribute('role');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
      return false;
    }
    // Walk the stacked hit-list, not just the topmost element.
    // elementsFromPoint includes everything that geometrically
    // contains the point — the input, its wrapper div, body,
    // html — so a tap inside an input that's wrapped by a
    // styled container (icon + input flex row, etc.) still
    // finds the input even when the wrapper is the literal
    // pointer target.
    let editable = false;
    for (let i = 0; i < stack.length; i++) {
      if (isEditableEl(stack[i])) { editable = true; break; }
    }
    let cursor = 'auto';
    for (let cur = top; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const cs = window.getComputedStyle(cur);
      if (cs.cursor && cs.cursor !== 'auto') { cursor = cs.cursor; break; }
    }
    if (cursor === 'auto') {
      if (top.closest('a[href]')) cursor = 'pointer';
      else if (editable) cursor = 'text';
      else {
        // Plain page text — show the I-beam only when the point is
        // actually inside a glyph rect, not just somewhere over a
        // text-containing element. Browsers do roughly this: hover
        // over the word → I-beam; hover the line gap, paragraph
        // margin, or trailing whitespace beyond the line → default.
        // We get the nearest caret position, build a 1-char range
        // adjacent to it, and check whether the point is inside any
        // of its client rects.
        let isText = false;
        try {
          const cp = document.caretPositionFromPoint
            ? document.caretPositionFromPoint(${x}, ${y})
            : (document.caretRangeFromPoint && document.caretRangeFromPoint(${x}, ${y}));
          const node = cp && (cp.offsetNode || cp.startContainer);
          const offset = cp ? (cp.offset !== undefined ? cp.offset : (cp.startOffset || 0)) : 0;
          if (node && node.nodeType === 3) {
            const text = node.nodeValue || '';
            const p = node.parentElement;
            const us = p ? (window.getComputedStyle(p).userSelect || window.getComputedStyle(p).webkitUserSelect) : '';
            if (us !== 'none') {
              const r = document.createRange();
              const inRects = (s, e) => {
                if (s < 0 || e > text.length || s >= e) return false;
                r.setStart(node, s);
                r.setEnd(node, e);
                const rs = r.getClientRects();
                for (let i = 0; i < rs.length; i++) {
                  const rr = rs[i];
                  if (${x} >= rr.left && ${x} <= rr.right && ${y} >= rr.top && ${y} <= rr.bottom) return true;
                }
                return false;
              };
              if (inRects(offset, offset + 1) || inRects(offset - 1, offset)) isText = true;
            }
          }
        } catch (_) {}
        cursor = isText ? 'text' : 'default';
      }
    }
    const a = top.closest('a');
    return { href: (a && a.href) || null, cursor, editable };
  })()`;
}
