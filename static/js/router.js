// RAG Academy – minimaler Hash-Router mit Aufräum-Unterstützung

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
    if (cleanup) {
      try { await cleanup(); } catch (e) { console.warn('Aufräumen fehlgeschlagen', e); }
      cleanup = null;
    }
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
    }
  }

  window.addEventListener('hashchange', run);
  return { start: run, refresh: run };
}

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
