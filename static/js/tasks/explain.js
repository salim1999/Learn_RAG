// Aufgabentyp „explain“ – Freitext-Erklärung, Bewertung per Rubrik oder Claude

import { h, md } from '../ui.js';

let uid = 0;
const MIN = 30;
const MAX = 2000;

export function render(container, task, ctx) {
  const id = `explain-${++uid}`;
  if (task.question) container.appendChild(h('div.explain-question', md(task.question, 'md prose')));
  const ta = h('textarea.textarea.explain-text', {
    id, rows: '8', maxlength: String(MAX),
    placeholder: 'Erkläre in eigenen Worten. Nenne die wichtigsten Begriffe und warum sie zählen.',
    'aria-describedby': `${id}-count`,
  });
  const counter = h('span.char-count#' + `${id}-count`, { 'aria-live': 'polite' });
  const updateCount = () => {
    const n = ta.value.trim().length;
    counter.textContent = n < MIN ? `${n} / ${MAX} Zeichen, noch ${MIN - n} bis zum Prüfen` : `${n} / ${MAX} Zeichen`;
    counter.classList.toggle('is-short', n < MIN);
    ctx.onReady(n >= MIN);
  };
  ta.addEventListener('input', updateCount);
  container.appendChild(h('div.field', h('label', { for: id }, 'Deine Erklärung'), ta, counter));
  updateCount();
  const resultBox = h('div.explain-result');
  container.appendChild(resultBox);

  return {
    getAnswer() {
      const t = ta.value.trim();
      return t.length >= MIN ? { text: t } : null;
    },
    showResult(result) {
      ta.readOnly = true;
      const d = result.details || {};
      resultBox.innerHTML = '';
      resultBox.append(
        h('p.graded-by', d.graded_by === 'claude'
          ? [h('span.chip.chip-llm', h('span.dot', { 'aria-hidden': 'true' }), 'Bewertet von Claude')]
          : [h('span.chip.chip-offline', h('span.dot', { 'aria-hidden': 'true' }), 'Bewertet per Stichwort-Rubrik')]),
        h('div.concepts',
          (d.hits || []).length ? h('div', h('h3', 'Getroffen'), h('ul.concept-list', d.hits.map((c) => h('li.concept.hit', h('span', { 'aria-hidden': 'true' }, '✓ '), c)))) : null,
          (d.misses || []).length ? h('div', h('h3', 'Fehlt noch'), h('ul.concept-list', d.misses.map((c) => h('li.concept.miss', h('span', { 'aria-hidden': 'true' }, '○ '), c)))) : null),
        d.model_answer ? h('div.model-answer', h('h3', 'Musterantwort'), md(d.model_answer, 'md prose')) : null);
    },
    dispose() {},
  };
}
