// Aufgabentyp „spot“ – halluzinierte Sätze in einer Antwort finden

import { h } from '../ui.js';

export function render(container, task, ctx) {
  const context = task.context || [];
  const sentences = task.answer_sentences || [];
  const selected = new Set();
  const btns = new Map();
  let scene = null;
  let locked = false;

  container.appendChild(h('div.spot-layout',
    h('section.spot-context', { 'aria-labelledby': 'spot-ctx-h' },
      h('h3#spot-ctx-h', 'Kontext (abgerufene Quellen)'),
      h('ol.spot-docs', context.map((c) => h('li.spot-doc', h('span.spot-doc-id', c.id), h('p', c.text))))),
    h('section.spot-answer', { 'aria-labelledby': 'spot-ans-h' },
      h('h3#spot-ans-h', 'Antwort des Modells'),
      h('p.muted', 'Markiere jeden Satz, der nicht durch den Kontext belegt ist.'),
      (() => {
        const p = h('div.spot-sentences');
        for (const s of sentences) {
          const note = h('span.spot-note', { hidden: true });
          const b = h('button.spot-sent', {
            type: 'button',
            'aria-pressed': 'false',
            onclick: () => {
              if (locked) return;
              if (selected.has(s.id)) selected.delete(s.id); else selected.add(s.id);
              b.setAttribute('aria-pressed', String(selected.has(s.id)));
              b.classList.toggle('is-flagged', selected.has(s.id));
            },
          }, h('span.spot-flag', { 'aria-hidden': 'true' }, '⚑'), h('span', s.text));
          btns.set(s.id, { b, note });
          p.append(h('div.spot-row', b, note));
        }
        return p;
      })())));

  const sceneHost = h('div.scene-panel.scene-panel-sm', { hidden: true, role: 'region', 'aria-label': 'Halluzinations-Visualisierung' });
  container.appendChild(sceneHost);

  // Auch „keine Halluzination“ ist eine gültige Antwort
  ctx.onReady(sentences.length > 0);

  return {
    getAnswer() { return { selected: [...selected] }; },
    async showResult(result) {
      locked = true;
      const d = result.details || {};
      const hall = new Set(d.hallucinated || []);
      const notes = d.notes || {};
      for (const [id, { b, note }] of btns) {
        b.disabled = true;
        const isH = hall.has(id);
        const isS = selected.has(id);
        let cls; let label;
        if (isH && isS) { cls = 'is-correct'; label = 'Gefunden: halluziniert.'; }
        else if (isH && !isS) { cls = 'is-missed'; label = 'Übersehen: dieser Satz ist halluziniert.'; }
        else if (!isH && isS) { cls = 'is-wrong'; label = 'Falscher Alarm: dieser Satz ist belegt.'; }
        else { cls = 'is-ok'; label = ''; }
        b.classList.add(cls);
        if (label || notes[id]) {
          note.hidden = false;
          note.innerHTML = '';
          if (label) note.appendChild(h('strong', `${label} `));
          if (notes[id]) note.appendChild(h('span', { html: ctx.renderMarkdown(notes[id]) }));
        }
      }
      sceneHost.hidden = false;
      scene = ctx.mountScene('hallucination', sceneHost, {
        context: context,
        answer_sentences: sentences,
        hallucinated: [...hall],
      }, { context: 'spot' });
    },
    dispose() {
      if (scene) scene.then((s) => s.dispose());
    },
  };
}
