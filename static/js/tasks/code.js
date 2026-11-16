// Aufgabentyp „code“ – Lückentext im Code (kein exec, Vergleich serverseitig)

import { h } from '../ui.js';

let uid = 0;

export function render(container, task, ctx) {
  const id = `code-${++uid}`;
  const blanks = new Map((task.blanks || []).map((b) => [String(b.id), b]));
  const inputs = new Map();
  const template = String(task.template || '');
  const parts = template.split(/\{\{\s*(\w+)\s*\}\}/);

  const code = h('code', { class: `language-${task.language || 'python'}` });
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      code.appendChild(document.createTextNode(part));
    } else {
      const b = blanks.get(part) || { id: part, placeholder: '' };
      const ph = b.placeholder || '…';
      const input = h('input.code-blank', {
        type: 'text', id: `${id}-${part}`, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
        placeholder: ph, 'aria-label': `Lücke ${part}${b.placeholder ? ` (${b.placeholder})` : ''}`,
        size: String(Math.max(6, Math.min(40, ph.length + 2))),
      });
      input.addEventListener('input', () => {
        input.size = Math.max(6, Math.min(48, Math.max(input.value.length, ph.length) + 2));
        ctx.onReady([...inputs.values()].every((x) => x.input.value.trim() !== ''));
      });
      const wrap = h('span.blank-wrap', h('span.blank-num', { 'aria-hidden': 'true' }, part), input);
      inputs.set(part, { input, wrap });
      code.appendChild(wrap);
    }
  });

  container.appendChild(h('div.codeblock',
    h('div.codeblock-bar', h('span', task.language || 'python'), h('span.muted', `${inputs.size} Lücke${inputs.size === 1 ? '' : 'n'}`)),
    h('pre', code)));
  const solution = h('div.code-solution');
  container.appendChild(solution);
  ctx.onReady(inputs.size === 0);

  return {
    getAnswer() {
      const out = {};
      for (const [k, { input }] of inputs) out[k] = input.value;
      return { blanks: out };
    },
    showResult(result) {
      const d = result.details || {};
      const per = d.per_blank || {};
      const exp = d.expected || {};
      const rows = [];
      for (const [k, { input, wrap }] of inputs) {
        input.readOnly = true;
        const ok = !!per[k];
        wrap.classList.add(ok ? 'is-correct' : 'is-wrong');
        input.setAttribute('aria-invalid', String(!ok));
        if (!ok && exp[k] != null) {
          wrap.appendChild(h('span.blank-expected', { title: 'Erwartet' }, Array.isArray(exp[k]) ? exp[k][0] : String(exp[k])));
        }
        rows.push(h('li', { class: ok ? 'ok' : 'bad' },
          h('span.blank-num', k), ok ? ' richtig' : ' erwartet: ',
          !ok && exp[k] != null ? h('code', Array.isArray(exp[k]) ? exp[k].join('  oder  ') : String(exp[k])) : null));
      }
      solution.appendChild(h('ul.blank-results', { 'aria-label': 'Auswertung der Lücken' }, rows));
    },
    dispose() {},
  };
}
