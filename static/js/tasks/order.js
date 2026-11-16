// Aufgabentyp „order“ – Elemente in die richtige Reihenfolge bringen (Drag & Drop + Tastatur)

import { h, shuffle } from '../ui.js';

export function render(container, task, ctx) {
  const items = task.items || [];
  let order = shuffle(items.map((i) => i.id));
  // Nicht zufällig schon in Originalreihenfolge starten
  if (items.length > 1 && order.every((id, i) => id === items[i].id)) order = [...order.slice(1), order[0]];
  const byId = new Map(items.map((i) => [i.id, i]));
  let locked = false;
  let dragId = null;

  const live = h('p.sr-only', { 'aria-live': 'assertive' });
  const list = h('ol.order-list', { 'aria-label': 'Reihenfolge, mit Hoch/Runter-Knöpfen oder per Ziehen sortieren' });
  container.append(h('p.muted.order-tip', 'Ziehe die Karten oder nutze die Pfeil-Knöpfe. Ganz oben steht der erste Schritt.'), list, live);

  function move(id, delta, focusDir) {
    const i = order.indexOf(id);
    const j = i + delta;
    if (locked || i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    draw();
    live.textContent = `„${byId.get(id).text}“ ist jetzt an Position ${j + 1} von ${order.length}.`;
    const btn = list.querySelector(`[data-id="${CSS.escape(id)}"] .${focusDir}`) || list.querySelector(`[data-id="${CSS.escape(id)}"] button:not([disabled])`);
    if (btn) btn.focus();
  }

  function draw(result) {
    list.innerHTML = '';
    order.forEach((id, i) => {
      const it = byId.get(id);
      const li = h('li.order-item', { 'data-id': id, draggable: locked ? 'false' : 'true' },
        h('span.order-pos', { 'aria-hidden': 'true' }, String(i + 1)),
        h('span.order-grip', { 'aria-hidden': 'true' }, '⋮⋮'),
        h('span.order-text', { html: ctx.renderMarkdown(it.text).replace(/^<p>|<\/p>\s*$/g, '') }),
        h('span.order-btns',
          h('button.icon-btn.up', { type: 'button', disabled: locked || i === 0, 'aria-label': `„${it.text}“ nach oben`, onclick: () => move(id, -1, 'up') }, '▲'),
          h('button.icon-btn.down', { type: 'button', disabled: locked || i === order.length - 1, 'aria-label': `„${it.text}“ nach unten`, onclick: () => move(id, 1, 'down') }, '▼')));
      if (result) li.insertBefore(result(li, id, i), li.querySelector('.order-btns'));
      if (!locked) {
        li.addEventListener('dragstart', (e) => {
          dragId = id;
          li.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', id); } catch { /* ignore */ }
        });
        li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); list.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target')); });
        li.addEventListener('dragover', (e) => {
          if (!dragId || dragId === id) return;
          e.preventDefault();
          li.classList.add('drop-target');
        });
        li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          if (!dragId || dragId === id) return;
          const from = order.indexOf(dragId);
          const to = order.indexOf(id);
          order.splice(from, 1);
          order.splice(to, 0, dragId);
          draw();
        });
      }
      list.appendChild(li);
    });
  }
  draw();
  ctx.onReady(items.length > 0);

  return {
    getAnswer() { return { order: order.slice() }; },
    showResult(result) {
      locked = true;
      const correct = (result.details && result.details.order) || [];
      draw((li, id, i) => {
        const ok = correct[i] === id;
        li.classList.add(ok ? 'is-correct' : 'is-wrong');
        const pos = correct.indexOf(id);
        return h('span.order-verdict', ok ? '✓ richtig' : pos >= 0 ? `gehört an Position ${pos + 1}` : '✕');
      });
      if (correct.length) {
        container.appendChild(h('div.order-solution',
          h('h3', 'Richtige Reihenfolge'),
          h('ol', correct.map((id) => h('li', { html: ctx.renderMarkdown((byId.get(id) || { text: id }).text).replace(/^<p>|<\/p>\s*$/g, '') })))));
      }
    },
    dispose() {},
  };
}
