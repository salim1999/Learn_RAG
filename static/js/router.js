// RAG Academy – minimaler Hash-Router mit Aufräum-Unterstützung

import { errorBlock } from './ui.js';

export function createRouter(root, routes, { onNavigate } = {}) {
  let cleanup = null;
  let token = 0;

  function match(hash) {
    const path = (hash.replace(/^#/, '') || '/').split('?')[0];
    for (const r of routes) {
      const m = path.match(r.pattern);
      if (m) return { route: r, params: m.groups || {}, path };
    }
    return null;
  }

  async function run() {
    const my = ++token;
    const previous = cleanup;
    cleanup = null;
    if (previous) {
      try { await previous(); } catch (e) { console.warn('Aufräumen fehlgeschlagen', e); }
    }
    if (my !== token) return;
    const found = match(location.hash) || match('#/');
    while (root.firstChild) root.removeChild(root.firstChild);
    root.className = `view view-${found.route.name}`;
    if (onNavigate) onNavigate(found);
    // Signal, mit dem Views prüfen können, ob sie noch aktuell sind
    const alive = () => my === token;
    try {
      const c = await found.route.view(root, found.params, { alive });
      if (!alive()) {
        if (typeof c === 'function') c();
        return;
      }
      cleanup = typeof c === 'function' ? c : null;
    } catch (err) {
      console.error(err);
      if (alive()) root.replaceChildren(errorBlock(err, run));
    }
  }

  window.addEventListener('hashchange', run);
  return { start: run, refresh: run };
}

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
