// In-page scripts for find-on-page. The find bar in the bridge UI sends a
// `find` action; the server runs `buildFindScript(...)` against the remote.
// On close, the bar sends `findStop`, which runs FIND_STOP_SCRIPT.

// Walks visible text once per query change to collect a Range list, paints
// all matches via the CSS Custom Highlight API (yellow), highlights the
// current match on top (orange), and advances the current index on
// subsequent calls without re-walking. Returns { current, total } so the
// bar can show "X of Y".
export function buildFindScript(query: string, backward: boolean, fromStart: boolean): string {
  return `(() => {
    const query = ${JSON.stringify(query)};
    const backward = ${backward};
    const fromStart = ${fromStart};
    function ensureStyle() {
      if (document.getElementById('__bridge-find-style')) return;
      const st = document.createElement('style');
      st.id = '__bridge-find-style';
      st.textContent =
        '::highlight(bridge-find-all) { background-color: #ffd33d; color: #000; }' +
        '::highlight(bridge-find-current) { background-color: #ff8c1a; color: #000; }';
      document.head.appendChild(st);
    }
    function clearHighlights() {
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('bridge-find-all');
        CSS.highlights.delete('bridge-find-current');
      }
    }
    if (!query) {
      clearHighlights();
      delete window.__bridgeFind;
      return { current: 0, total: 0 };
    }
    let state = window.__bridgeFind;
    const needsRefresh = !state || state.query !== query || fromStart;
    if (needsRefresh) {
      // Walk visible text nodes (descending into open shadow roots) and
      // build a flat string with index→node mapping, then collect Range
      // objects for every occurrence of the query.
      const nodes = [];
      const parts = [];
      let total = 0;
      function visit(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const v = node.nodeValue || '';
          if (!v) return;
          const parent = node.parentElement;
          if (parent) {
            const tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
            const cs = window.getComputedStyle(parent);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
          }
          nodes.push({ node, start: total });
          parts.push(v);
          total += v.length;
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
          const cs = window.getComputedStyle(node);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          if (node.shadowRoot) visit(node.shadowRoot);
        }
        for (let c = node.firstChild; c; c = c.nextSibling) visit(c);
      }
      visit(document.body);
      const flat = parts.join('').toLowerCase();
      const q = query.toLowerCase();
      function locate(pos) {
        let lo = 0, hi = nodes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (nodes[mid].start <= pos) lo = mid;
          else hi = mid - 1;
        }
        return { node: nodes[lo].node, offset: pos - nodes[lo].start };
      }
      const ranges = [];
      let pos = 0;
      while (q && (pos = flat.indexOf(q, pos)) !== -1) {
        const a = locate(pos);
        const b = locate(pos + q.length);
        const r = document.createRange();
        try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); ranges.push(r); } catch (_) {}
        pos += q.length;
      }
      state = { query, ranges, current: -1 };
      window.__bridgeFind = state;
    }
    if (state.ranges.length === 0) {
      clearHighlights();
      return { current: 0, total: 0 };
    }
    if (state.current === -1) {
      state.current = 0;
    } else {
      const step = backward ? -1 : 1;
      state.current = (state.current + step + state.ranges.length) % state.ranges.length;
    }
    ensureStyle();
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set('bridge-find-all', new Highlight(...state.ranges));
      CSS.highlights.set('bridge-find-current', new Highlight(state.ranges[state.current]));
    }
    const cur = state.ranges[state.current];
    const rect = cur.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
      const target = cur.startContainer.parentElement || document.body;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return { current: state.current + 1, total: state.ranges.length };
  })()`;
}

// Tears down the visible find state on close: removes highlights and the
// injected stylesheet, and promotes the active match to a regular text
// selection (Chrome's behavior — leaves matched text selected for Cmd-C).
// We deliberately keep window.__bridgeFind in place so a later Cmd-G can
// resume from the same query and position rather than re-walking from the
// top.
export const FIND_STOP_SCRIPT = `(() => {
  const state = window.__bridgeFind;
  if (state && state.current >= 0 && state.ranges && state.ranges[state.current]) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      try { sel.addRange(state.ranges[state.current]); } catch (_) {}
    }
  }
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('bridge-find-all');
    CSS.highlights.delete('bridge-find-current');
  }
  const st = document.getElementById('__bridge-find-style');
  if (st) st.remove();
})()`;
