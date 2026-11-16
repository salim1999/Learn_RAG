// Aufgabentyp „better“ – welche von zwei Varianten ist besser? (+ optional Live-Vergleich)

import { h, md, loadingBlock, errorBlock } from '../ui.js';
import { renderRunSummary } from '../ragview.js';

let uid = 0;

export function render(container, task, ctx) {
  const name = `better-${++uid}`;
  let disposed = false;
  if (task.scenario) container.appendChild(h('div.scenario', h('h3', 'Szenario'), md(task.scenario, 'md prose')));

  const cards = {};
  const grid = h('div.ab-grid', { role: 'radiogroup', 'aria-label': 'Variante wählen' });
  for (const key of ['a', 'b']) {
    const v = task[`variant_${key}`] || {};
    const input = h('input.sr-only', { type: 'radio', name, value: key, id: `${name}-${key}` });
    const verdict = h('span.ab-verdict', { hidden: true });
    const card = h('label.ab-card', { for: input.id },
      input,
      h('span.ab-letter', { 'aria-hidden': 'true' }, key.toUpperCase()),
      h('span.ab-label', v.label || `Variante ${key.toUpperCase()}`),
      md(v.description || '', 'md ab-desc'),
      verdict);
    input.addEventListener('change', update);
    cards[key] = { card, input, verdict };
    grid.appendChild(card);
  }
  container.appendChild(grid);

  const reason = h('textarea.textarea', { id: `${name}-reason`, rows: '3', maxlength: '1000', placeholder: 'Warum ist diese Variante besser? (optional, hilft beim Lernen)' });
  container.appendChild(h('div.field', h('label', { for: reason.id }, 'Deine Begründung'), reason));

  const live = h('div.ab-live');
  container.appendChild(live);

  function choice() {
    return cards.a.input.checked ? 'a' : cards.b.input.checked ? 'b' : null;
  }
  function update() {
    for (const k of ['a', 'b']) cards[k].card.classList.toggle('is-selected', cards[k].input.checked);
    ctx.onReady(!!choice());
  }

  async function runLive() {
    const r = task.run;
    if (!r) return;
    live.append(h('h3', 'Live-Vergleich beider Pipelines'), h('p.muted', `Frage: „${r.query}“`));
    const slot = h('div');
    live.appendChild(slot);
    slot.appendChild(loadingBlock('Beide Pipelines laufen …'));
    try {
      const [ra, rb] = await Promise.all([
        ctx.api.ragRun({ ...(r.config_a || {}), query: r.query }),
        ctx.api.ragRun({ ...(r.config_b || {}), query: r.query }),
      ]);
      if (disposed) return;
      slot.innerHTML = '';
      slot.appendChild(h('div.ab-compare',
        renderRunSummary(ra, { title: `A: ${(task.variant_a || {}).label || 'Variante A'}` }),
        renderRunSummary(rb, { title: `B: ${(task.variant_b || {}).label || 'Variante B'}`, compare: ra.metrics })));
    } catch (err) {
      if (disposed) return;
      slot.innerHTML = '';
      slot.appendChild(errorBlock(err));
    }
  }

  return {
    getAnswer() {
      const c = choice();
      return c ? { choice: c, reason: reason.value.trim() } : null;
    },
    showResult(result) {
      const d = result.details || {};
      const mine = choice();
      for (const k of ['a', 'b']) {
        const { card, input, verdict } = cards[k];
        input.disabled = true;
        const isC = d.correct === k;
        card.classList.add(isC ? 'is-correct' : k === mine ? 'is-wrong' : 'is-neutral');
        if (isC || k === mine) {
          verdict.hidden = false;
          verdict.textContent = isC ? 'Bessere Variante' : 'Deine Wahl';
        }
      }
      reason.disabled = true;
      if (d.why) container.insertBefore(h('div.why-box', h('h3', 'Warum?'), md(d.why, 'md prose')), live);
      runLive();
    },
    dispose() { disposed = true; },
  };
}
