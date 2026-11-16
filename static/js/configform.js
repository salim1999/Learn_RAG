// RAG Academy – Formular für alle PipelineConfig-Felder (wird im Labor und A/B-Vergleich genutzt)

import { h } from './ui.js';
import { state } from './state.js';

export const DEFAULT_CONFIG = {
  query: 'Wie viel kostet der Pro-Plan?',
  corpus: 'default',
  chunking: { strategy: 'recursive', size: 300, overlap: 50 },
  retrieval: { method: 'bm25', k: 4, mmr: false, mmr_lambda: 0.7, rerank: false, rerank_mode: 'heuristic' },
  freshness: { enabled: false, half_life_days: 365, drop_superseded: false, as_of: '2026-11-16' },
  generation: { mode: 'extractive', strict_grounding: true, abstain_threshold: 0.2, require_citations: true },
  verify: true,
};

export const QUERY_SUGGESTIONS = [
  'Wie viel kostet der Pro-Plan?',
  'Welche Rate-Limits gelten für die API v3?',
  'Wer ist der CEO von NovaCloud?',
  'Wie lange werden Backups aufbewahrt?',
  'Welche Support-Reaktionszeit gilt im Enterprise-Plan?',
  'Wird API v2 noch unterstützt?',
  'Wie aktiviere ich die Zwei-Faktor-Authentifizierung?',
];

export function cloneConfig(c) {
  return JSON.parse(JSON.stringify(c || DEFAULT_CONFIG));
}

const FIELDS = [
  {
    group: 'Chunking', key: 'chunking', fields: [
      { name: 'strategy', label: 'Strategie', type: 'select', options: [['fixed', 'Feste Länge'], ['sentence', 'Satzweise'], ['recursive', 'Rekursiv (Absatz → Satz)']] },
      { name: 'size', label: 'Chunk-Größe', type: 'range', min: 80, max: 1200, step: 20, unit: 'Zeichen' },
      { name: 'overlap', label: 'Überlappung', type: 'range', min: 0, max: 300, step: 10, unit: 'Zeichen' },
    ],
  },
  {
    group: 'Retrieval', key: 'retrieval', fields: [
      { name: 'method', label: 'Methode', type: 'select', options: [['tfidf', 'TF-IDF (Vektor)'], ['bm25', 'BM25 (Stichwort)'], ['hybrid', 'Hybrid (TF-IDF + BM25)'], ['dense', 'Dense-Embeddings (GPU)', 'gpu'], ['hybrid_dense', 'Hybrid Dense + BM25 (GPU)', 'gpu']] },
      { name: 'k', label: 'Top-k', type: 'range', min: 1, max: 12, step: 1 },
      { name: 'mmr', label: 'MMR (Vielfalt statt Duplikate)', type: 'check' },
      { name: 'mmr_lambda', label: 'MMR-λ (Relevanz vs. Vielfalt)', type: 'range', min: 0, max: 1, step: 0.05, dependsOn: 'mmr' },
      { name: 'rerank', label: 'Reranking', type: 'check' },
      { name: 'rerank_mode', label: 'Reranker', type: 'select', dependsOn: 'rerank', options: [['heuristic', 'Heuristisch (offline)'], ['cross_encoder', 'Cross-Encoder (GPU)', 'gpu']] },
    ],
  },
  {
    group: 'Aktualität', key: 'freshness', fields: [
      { name: 'enabled', label: 'Zeitlichen Abfall gewichten', type: 'check' },
      { name: 'half_life_days', label: 'Halbwertszeit', type: 'range', min: 30, max: 1460, step: 15, unit: 'Tage', dependsOn: 'enabled' },
      { name: 'drop_superseded', label: 'Ersetzte Dokumente verwerfen', type: 'check' },
      { name: 'as_of', label: 'Stichtag', type: 'date' },
    ],
  },
  {
    group: 'Generierung', key: 'generation', fields: [
      { name: 'mode', label: 'Modus', type: 'select', options: [['extractive', 'Extraktiv (offline)'], ['llm', 'LLM (Claude)']] },
      { name: 'strict_grounding', label: 'Strenges Grounding', type: 'check' },
      { name: 'abstain_threshold', label: 'Enthaltungs-Schwelle', type: 'range', min: 0, max: 1, step: 0.05 },
      { name: 'require_citations', label: 'Zitate erzwingen', type: 'check' },
    ],
  },
];

let uid = 0;

/**
 * Baut das Formular. opts.withQuery=false blendet das Query-Feld aus (A/B teilt die Frage).
 * Rückgabe { el, read(), set(cfg) }
 */
export function configForm(initial, { withQuery = true, title = null, onChange = null } = {}) {
  const id = `cfg-${++uid}`;
  const controls = [];
  const el = h('div.cfgform');
  const llmOn = !!(state.status && state.status.llm_enabled);
  const gpuOn = !!(state.status && state.status.gpu_enabled);

  if (title) el.appendChild(h('h3.cfg-title', title));

  let queryInput = null;
  if (withQuery) {
    queryInput = h('input.input', { type: 'text', id: `${id}-q`, list: `${id}-qs`, autocomplete: 'off' });
    el.appendChild(h('div.field',
      h('label', { for: queryInput.id }, 'Frage an die Wissensbasis'),
      queryInput,
      h('datalist#' + `${id}-qs`, QUERY_SUGGESTIONS.map((q) => h('option', { value: q }))),
      suggestionChips((q) => { queryInput.value = q; queryInput.focus(); onChange && onChange(); })));
  }

  for (const g of FIELDS) {
    const fs = h('fieldset.cfg-group', h('legend', g.group));
    for (const f of g.fields) {
      const fid = `${id}-${g.key}-${f.name}`;
      let input; let row;
      if (f.type === 'select') {
        input = h('select.input', { id: fid }, f.options.map(([v, l, needs]) => {
          const off = (v === 'llm' && !llmOn) || (needs === 'gpu' && !gpuOn);
          const why = needs === 'gpu' ? 'GPU-Endpoint nicht konfiguriert' : 'Claude ist nicht aktiv';
          return h('option', { value: v, disabled: off, title: off ? why : null }, off ? `${l} – nicht verfügbar` : l);
        }));
        if (f.options.some((o) => o[2] === 'gpu') && !gpuOn) input.title = 'GPU-Optionen deaktiviert: GPU-Endpoint nicht konfiguriert';
        row = h('div.field', h('label', { for: fid }, f.label), input);
      } else if (f.type === 'range') {
        input = h('input.slider', { type: 'range', id: fid, min: String(f.min), max: String(f.max), step: String(f.step) });
        const out = h('output.slider-value', { for: fid });
        const sync = () => {
          out.textContent = `${Number(input.value).toLocaleString('de-DE')}${f.unit ? ` ${f.unit}` : ''}`;
          input.style.setProperty('--fill', `${((input.value - f.min) / (f.max - f.min)) * 100}%`);
        };
        input.addEventListener('input', sync);
        input._sync = sync;
        row = h('div.field.slider-field', h('div.slider-top', h('label', { for: fid }, f.label), out), input);
      } else if (f.type === 'check') {
        input = h('input', { type: 'checkbox', id: fid });
        row = h('div.field.check-field', h('label.switch', { for: fid }, input, h('span.switch-track', { 'aria-hidden': 'true' }), h('span', f.label)));
      } else if (f.type === 'date') {
        input = h('input.input', { type: 'date', id: fid });
        row = h('div.field', h('label', { for: fid }, f.label), input);
      }
      input.addEventListener('change', () => { refreshDeps(); onChange && onChange(); });
      controls.push({ g: g.key, f, input, row });
      fs.appendChild(row);
    }
    el.appendChild(fs);
  }

  const verify = h('input', { type: 'checkbox', id: `${id}-verify` });
  verify.addEventListener('change', () => onChange && onChange());
  el.appendChild(h('fieldset.cfg-group', h('legend', 'Verifikation'),
    h('div.field.check-field', h('label.switch', { for: verify.id }, verify, h('span.switch-track', { 'aria-hidden': 'true' }), h('span', 'Antwort nachträglich prüfen')))));

  function refreshDeps() {
    for (const c of controls) {
      if (!c.f.dependsOn) continue;
      const dep = controls.find((x) => x.g === c.g && x.f.name === c.f.dependsOn);
      const on = dep && dep.input.checked;
      c.input.disabled = !on;
      c.row.classList.toggle('is-disabled', !on);
    }
  }

  function set(cfg) {
    const c = { ...cloneConfig(DEFAULT_CONFIG), ...cloneConfig(cfg) };
    if (queryInput) queryInput.value = c.query || '';
    for (const ctl of controls) {
      const v = ((c[ctl.g] || {})[ctl.f.name]) ?? DEFAULT_CONFIG[ctl.g][ctl.f.name];
      if (ctl.f.type === 'check') ctl.input.checked = !!v;
      else ctl.input.value = String(v);
      if (ctl.f.type === 'select') {
        const opt = [...ctl.input.options].find((o) => o.value === String(v));
        if (!opt || opt.disabled) ctl.input.value = String(DEFAULT_CONFIG[ctl.g][ctl.f.name]);
      }
      if (ctl.input._sync) ctl.input._sync();
    }
    verify.checked = c.verify !== false;
    refreshDeps();
  }

  function read() {
    const out = { corpus: 'default' };
    if (queryInput) out.query = queryInput.value.trim();
    for (const ctl of controls) {
      out[ctl.g] = out[ctl.g] || {};
      let v;
      if (ctl.f.type === 'check') v = ctl.input.checked;
      else if (ctl.f.type === 'range') v = Number(ctl.input.value);
      else v = ctl.input.value;
      if (ctl.f.type === 'date' && !v) v = DEFAULT_CONFIG.freshness.as_of;
      out[ctl.g][ctl.f.name] = v;
    }
    out.verify = verify.checked;
    return out;
  }

  set(initial || DEFAULT_CONFIG);
  return { el, read, set, queryInput };
}

export function suggestionChips(onPick) {
  return h('div.suggestions', { role: 'group', 'aria-label': 'Beispielfragen' },
    QUERY_SUGGESTIONS.slice(0, 5).map((q) => h('button.chip-btn', {
      type: 'button',
      onclick: () => onPick(q),
      title: q.includes('CEO') ? 'Diese Frage beantwortet die Wissensbasis nicht – ein gutes System enthält sich.' : null,
    }, q)));
}
