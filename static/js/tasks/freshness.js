// Aufgabentyp „freshness“ – welche Information ist aktuell? Dokumente als Zeitstrahl

import { h, md, fmtDate } from '../ui.js';

let uid = 0;

export function render(container, task, ctx) {
  const name = `fresh-${++uid}`;
  const docs = (task.documents || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const asOf = task.as_of || '2026-11-16';
  const docCards = new Map();
  const optRows = new Map();
  let scene = null;

  if (task.question) container.appendChild(h('p.fresh-question', h('span', { 'aria-hidden': 'true' }, '❔ '), h('strong', task.question)));

  const sceneHost = h('div.scene-panel.scene-panel-xs', { role: 'region', 'aria-label': 'Zeitachse der Dokumente' });
  container.appendChild(sceneHost);
  scene = ctx.mountScene('timeline', sceneHost, {
    documents: docs.map((d) => ({ id: d.id, title: d.title, date: d.date, superseded_by: d.superseded_by ?? null })),
    as_of: asOf,
  }, { context: 'freshness' });

  const strip = h('ol.doc-timeline', { 'aria-label': 'Dokumente nach Datum' });
  for (const d of docs) {
    const card = h('li.doc-tl-card', { tabindex: '-1' },
      h('span.doc-tl-date', fmtDate(d.date)),
      h('div.doc-tl-body',
        h('div.doc-tl-head',
          h('strong', d.title),
          h('span.doc-tl-meta', [d.source, d.version ? `Version ${d.version}` : null].filter(Boolean).join(', '))),
        h('p.doc-tl-text', d.text)));
    const highlight = () => scene.then((s) => s.highlight?.(d.id));
    card.tabIndex = 0;
    card.addEventListener('mouseenter', highlight);
    card.addEventListener('focusin', highlight);
    docCards.set(d.id, card);
    strip.appendChild(card);
  }
  container.appendChild(strip);

  const fs = h('fieldset.choice-list', h('legend.choice-legend', 'Welche Antwort ist richtig?'));
  for (const o of task.options || []) {
    const input = h('input', { type: 'radio', name, value: o.id, id: `${name}-${o.id}` });
    input.addEventListener('change', () => ctx.onReady(true));
    const row = h('label.choice', { for: input.id }, input, h('span.choice-mark', { 'aria-hidden': 'true' }),
      h('span.choice-body', h('span.choice-text', { html: ctx.renderMarkdown(o.text).replace(/^<p>|<\/p>\s*$/g, '') })));
    optRows.set(o.id, { row, input });
    fs.appendChild(row);
  }
  container.appendChild(fs);

  function chosen() {
    for (const [id, r] of optRows) if (r.input.checked) return id;
    return null;
  }

  return {
    getAnswer() {
      const c = chosen();
      return c ? { choice: c } : null;
    },
    showResult(result) {
      const d = result.details || {};
      const mine = chosen();
      for (const [id, r] of optRows) {
        r.input.disabled = true;
        r.row.classList.add(id === d.correct ? 'is-correct' : id === mine ? 'is-wrong' : 'is-neutral');
      }
      if (d.why) container.appendChild(h('div.why-box', h('h3', 'Warum?'), md(d.why, 'md prose')));
    },
    dispose() { if (scene) scene.then((s) => s.dispose()); },
  };
}
