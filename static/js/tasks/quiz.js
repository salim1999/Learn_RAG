// Aufgabentyp „quiz“ – Single- oder Multiple-Choice

import { h } from '../ui.js';

let uid = 0;

export function render(container, task, ctx) {
  const name = `quiz-${++uid}`;
  const multi = !!task.multi;
  const options = task.options || [];
  const rows = new Map();

  const fieldset = h('fieldset.choice-list',
    h('legend.choice-legend', multi ? 'Wähle alle zutreffenden Antworten.' : 'Wähle genau eine Antwort.'));

  for (const opt of options) {
    const input = h('input', { type: multi ? 'checkbox' : 'radio', name, value: opt.id, id: `${name}-${opt.id}` });
    const note = h('div.choice-note', { hidden: true });
    const row = h('label.choice', { for: input.id },
      input,
      h('span.choice-mark', { 'aria-hidden': 'true' }),
      h('span.choice-body', h('span.choice-text', { html: ctx.renderMarkdown(opt.text).replace(/^<p>|<\/p>\s*$/g, '') }), note));
    input.addEventListener('change', () => ctx.onReady(selected().length > 0));
    rows.set(opt.id, { row, input, note });
    fieldset.appendChild(row);
  }
  container.appendChild(fieldset);

  function selected() {
    return [...rows.values()].filter((r) => r.input.checked).map((r) => r.input.value);
  }

  return {
    getAnswer() {
      const s = selected();
      return s.length ? { selected: s } : null;
    },
    showResult(result) {
      const d = result.details || {};
      const correct = new Set(d.correct || []);
      const expl = d.option_explanations || {};
      const sel = new Set(selected());
      for (const [id, r] of rows) {
        r.input.disabled = true;
        const isC = correct.has(id);
        const isS = sel.has(id);
        r.row.classList.add(isC ? 'is-correct' : isS ? 'is-wrong' : 'is-neutral');
        if (isC && !isS) r.row.classList.add('is-missed');
        const label = isC ? (isS ? 'Richtig gewählt.' : 'Diese Antwort wäre richtig gewesen.') : isS ? 'Diese Antwort ist falsch.' : '';
        if (label || expl[id]) {
          r.note.hidden = false;
          r.note.innerHTML = '';
          if (label) r.note.appendChild(h('strong', label + ' '));
          if (expl[id]) r.note.appendChild(h('span', { html: ctx.renderMarkdown(expl[id]) }));
        }
      }
    },
    dispose() {},
  };
}
