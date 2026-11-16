// RAG Academy – Wissensbasis-Browser (#/corpus): Zeitachse + Filter + Dokument-Details

import { api } from './api.js';
import { append, h, clear, loadingBlock, errorBlock, mountScene, fmtDate } from './ui.js';

export async function viewCorpus(root, params, { alive }) {
  root.appendChild(loadingBlock('Wissensbasis wird geladen …'));
  let corpus;
  try {
    corpus = await api.corpus();
  } catch (err) {
    if (!alive()) return;
    clear(root).appendChild(errorBlock(err, () => window.dispatchEvent(new HashChangeEvent('hashchange'))));
    return;
  }
  if (!alive()) return;
  clear(root);

  const docs = (corpus.documents || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byId = new Map(docs.map((d) => [d.id, d]));
  const supersedes = new Map();
  for (const d of docs) if (d.superseded_by) supersedes.set(d.superseded_by, [...(supersedes.get(d.superseded_by) || []), d.id]);
  const tags = [...new Set(docs.flatMap((d) => d.tags || []))].sort();
  const sources = [...new Set(docs.map((d) => d.source).filter(Boolean))].sort();
  let selected = null;
  let scene = null;

  const staleCount = docs.filter((d) => d.superseded_by).length;
  root.appendChild(h('header.page-head',
    h('h1.display', corpus.title || 'Wissensbasis'),
    h('p.lead', `${docs.length} Dokumente der fiktiven Firma NovaCloud, Stand ${fmtDate(corpus.as_of)}. ${staleCount} davon wurden durch neuere Versionen ersetzt – genau diese Fallen muss ein gutes RAG-System erkennen.`)));

  const sceneHost = h('div.scene-panel.corpus-scene', { role: 'region', 'aria-label': 'Zeitachse aller Dokumente' });
  root.appendChild(sceneHost);
  const sceneData = (highlight) => ({
    documents: docs.map((d) => ({ id: d.id, title: d.title, date: d.date, superseded_by: d.superseded_by || null })),
    as_of: corpus.as_of,
    highlight: highlight || undefined,
  });
  scene = mountScene('timeline', sceneHost, sceneData(null), {
    context: 'corpus',
    onSelect: (id) => { if (byId.has(id)) select(id, 'scene'); },
  });

  const search = h('input.input', { type: 'search', id: 'cp-search', placeholder: 'Titel oder Text durchsuchen', autocomplete: 'off' });
  const tagSel = h('select.input', { id: 'cp-tag' }, h('option', { value: '' }, 'Alle Themen'), tags.map((t) => h('option', { value: t }, t)));
  const srcSel = h('select.input', { id: 'cp-src' }, h('option', { value: '' }, 'Alle Quellen'), sources.map((t) => h('option', { value: t }, t)));
  const statusSel = h('select.input', { id: 'cp-status' },
    h('option', { value: '' }, 'Aktuell und veraltet'),
    h('option', { value: 'current' }, 'Nur aktuelle'),
    h('option', { value: 'stale' }, 'Nur veraltete'));
  const count = h('p.muted.cp-count', { 'aria-live': 'polite' });
  root.appendChild(h('form.corpus-filters', { role: 'search', 'aria-label': 'Dokumente filtern', onsubmit: (e) => e.preventDefault() },
    h('div.field.grow', h('label', { for: 'cp-search' }, 'Suche'), search),
    h('div.field', h('label', { for: 'cp-tag' }, 'Thema'), tagSel),
    h('div.field', h('label', { for: 'cp-src' }, 'Quelle'), srcSel),
    h('div.field', h('label', { for: 'cp-status' }, 'Status'), statusSel)));
  root.appendChild(count);

  const list = h('div.corpus-list');
  const detail = h('aside.corpus-detail', { 'aria-live': 'polite', tabindex: '-1' },
    h('p.muted', 'Wähle ein Dokument, um den vollständigen Text und seine Versionskette zu sehen.'));
  root.appendChild(h('div.corpus-layout', list, detail));

  function matches(d) {
    const q = search.value.trim().toLowerCase();
    if (q && !(`${d.title} ${d.text} ${d.id}`.toLowerCase().includes(q))) return false;
    if (tagSel.value && !(d.tags || []).includes(tagSel.value)) return false;
    if (srcSel.value && d.source !== srcSel.value) return false;
    if (statusSel.value === 'current' && d.superseded_by) return false;
    if (statusSel.value === 'stale' && !d.superseded_by) return false;
    return true;
  }

  function drawList() {
    clear(list);
    const shown = docs.filter(matches);
    count.textContent = `${shown.length} von ${docs.length} Dokumenten`;
    if (!shown.length) {
      list.appendChild(h('div.empty-state', h('p', 'Kein Dokument passt zu diesen Filtern.'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => { search.value = ''; tagSel.value = ''; srcSel.value = ''; statusSel.value = ''; drawList(); } }, 'Filter zurücksetzen')));
      return;
    }
    const years = new Map();
    for (const d of shown) {
      const y = String(d.date || '').slice(0, 4) || 'ohne Datum';
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(d);
    }
    for (const [y, ds] of years) {
      list.appendChild(h('section.year-group',
        h('h2.year-label', y),
        h('ul.doc-list', ds.map((d) => h('li',
          h('button', {
            type: 'button',
            class: `doc-btn${d.superseded_by ? ' is-stale' : ''}${(d.tags || []).includes('injection') ? ' is-injection' : ''}${selected === d.id ? ' is-selected' : ''}`,
            'aria-pressed': String(selected === d.id),
            'data-id': d.id,
            onclick: () => select(d.id, 'list'),
          },
          h('span.doc-btn-date', fmtDate(d.date)),
          h('span.doc-btn-title', d.title),
          h('span.doc-btn-tags',
            d.superseded_by ? h('span.tag.tag-stale', 'veraltet') : h('span.tag.tag-ok', 'aktuell'),
            (d.tags || []).includes('injection') ? h('span.tag.tag-bad', 'Injection') : null)))))));
    }
  }

  function chain(d) {
    // Vorgänger rückwärts, Nachfolger vorwärts
    const before = [];
    let cur = d.id;
    const seen = new Set([cur]);
    while (supersedes.has(cur)) {
      const prev = supersedes.get(cur)[0];
      if (seen.has(prev)) break;
      seen.add(prev); before.unshift(prev); cur = prev;
    }
    const after = [];
    cur = d.superseded_by;
    while (cur && byId.has(cur) && !seen.has(cur)) { seen.add(cur); after.push(cur); cur = byId.get(cur).superseded_by; }
    return [...before, d.id, ...after];
  }

  function select(id, from) {
    selected = id;
    const d = byId.get(id);
    if (!d) return;
    scene.then((s) => s.update && s.update(sceneData(id)));
    for (const b of list.querySelectorAll('.doc-btn')) {
      const on = b.dataset.id === id;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', String(on));
    }
    clear(detail);
    const ch = chain(d);
    append(detail,
      h('div.detail-head',
        h('span.detail-id', d.id),
        h('h2', d.title),
        h('dl.detail-meta',
          h('div', h('dt', 'Datum'), h('dd', fmtDate(d.date))),
          d.version ? h('div', h('dt', 'Version'), h('dd', d.version)) : null,
          d.source ? h('div', h('dt', 'Quelle'), h('dd', d.source)) : null,
          (d.tags || []).length ? h('div', h('dt', 'Themen'), h('dd', d.tags.join(', '))) : null)),
      d.superseded_by
        ? h('p.notice.notice-stale', h('strong', 'Veraltet. '), 'Ersetzt durch ',
          h('button.linklike', { type: 'button', onclick: () => select(d.superseded_by, 'detail') }, byId.get(d.superseded_by)?.title || d.superseded_by), '.')
        : null,
      (d.tags || []).includes('injection')
        ? h('p.notice.notice-bad', h('strong', 'Achtung: '), 'Dieses Dokument enthält eine eingeschleuste Anweisung (Prompt-Injection). Ein sicheres RAG-System behandelt Kontext als Daten, nie als Befehl.')
        : null,
      ch.length > 1
        ? h('div.version-chain', h('h3', 'Versionskette'), h('ol', ch.map((cid) => {
          const c = byId.get(cid);
          return h('li', { class: cid === d.id ? 'is-current' : '' },
            cid === d.id
              ? h('strong', `${c.title} (${fmtDate(c.date)})`)
              : h('button.linklike', { type: 'button', onclick: () => select(cid, 'detail') }, `${c.title} (${fmtDate(c.date)})`));
        })))
        : null,
      h('div.detail-text', String(d.text || '').split(/\n{2,}/).map((p) => h('p', p))));
    if (from === 'list' && window.matchMedia('(max-width: 900px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (from === 'detail') detail.focus({ preventScroll: true });
  }

  for (const el of [tagSel, srcSel, statusSel]) el.addEventListener('change', drawList);
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(drawList, 150); });
  drawList();

  return () => { if (scene) scene.then((s) => s.dispose()); };
}
