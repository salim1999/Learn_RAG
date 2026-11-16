// RAG Academy – wiederverwendbare Darstellungen für RUN_RESPONSE (Trace, Chunks, Antwort, Metriken)

import { h, fmtDate, fmtNum, metricLabel, metricValue, METRICS, STAGE_LABELS, reducedMotion } from './ui.js';

let uid = 0;

/** Animierte Stufenleiste der Pipeline */
export function renderTrace(trace, { animate = true, compact = false } = {}) {
  const list = h('ol', { class: `trace${compact ? ' trace-compact' : ''}${animate && !reducedMotion() ? ' trace-animate' : ''}`, 'aria-label': 'Pipeline-Ablauf' });
  (trace || []).forEach((st, i) => {
    const prims = st.data && typeof st.data === 'object'
      ? Object.entries(st.data).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6)
      : [];
    const fallback = isFallback(st);
    list.appendChild(h('li', { class: `trace-step${fallback ? ' is-fallback' : ''}`, style: { '--i': String(i) }, 'data-stage': st.stage },
      h('span.trace-dot', { 'aria-hidden': 'true' }),
      h('div.trace-body',
        h('div.trace-row',
          h('span.trace-stage', st.title || STAGE_LABELS[st.stage] || st.stage),
          st.ms != null ? h('span.trace-ms', `${fmtNum(st.ms, 1)} ms`) : null),
        fallback ? h('span.trace-fallback', { title: st.message || '' }, '⚠ Fallback') : null,
        (!compact || fallback) && st.message ? h('p.trace-msg', st.message) : null,
        !compact && prims.length
          ? h('dl.trace-data', prims.map(([k, v]) => h('div', h('dt', k), h('dd', typeof v === 'number' ? fmtNum(v, 3) : String(v)))))
          : null)));
  });
  return list;
}

/** Erkennt Fallback-Hinweise im Trace (z.B. „GPU nicht erreichbar → TF-IDF-Fallback“) */
export function isFallback(st) {
  if (!st) return false;
  const d = st.data || {};
  if (d.fallback === true || typeof d.fallback === 'string' || d.gpu_fallback === true) return true;
  return /fallback|nicht erreichbar/i.test(`${st.message || ''} ${st.title || ''}`);
}

/** Liste abgerufener Chunks, veraltete markiert */
export function renderChunks(chunks, { idPrefix = `c${++uid}`, compact = false } = {}) {
  if (!chunks || !chunks.length) return h('p.muted', 'Keine Chunks abgerufen.');
  const maxScore = Math.max(...chunks.map((c) => c.score || 0), 1e-9);
  return h('ol.chunks', { 'aria-label': 'Abgerufene Chunks' }, chunks.map((c, i) =>
    h('li', { class: `chunk${c.stale ? ' is-stale' : ''}`, id: `${idPrefix}-${c.id}` },
      h('div.chunk-head',
        h('span.chunk-rank', { 'aria-label': `Rang ${c.rank ?? i + 1}` }, String(c.rank ?? i + 1)),
        h('div.chunk-title-wrap',
          h('span.chunk-title', c.title || c.doc_id),
          h('span.chunk-sub', `${c.id}, ${fmtDate(c.date)}`)),
        c.stale
          ? h('span.tag.tag-stale', { title: c.superseded_by ? `Ersetzt durch ${c.superseded_by}` : 'Veraltet' },
            '⏳ veraltet', c.superseded_by ? ` → ${c.superseded_by}` : '')
          : null),
      h('div.scorebar', { role: 'img', 'aria-label': `Score ${fmtNum(c.score, 3)}` },
        h('span', { style: { width: `${Math.max(4, ((c.score || 0) / maxScore) * 100)}%` } }),
        h('em', fmtNum(c.score, 3))),
      compact
        ? null
        : h('details.chunk-text', h('summary', 'Text anzeigen'), h('p', c.text || '')))));
}

/** Antwort mit Satz-Grounding-Farben und Zitaten */
export function renderAnswer(answer, chunks, { idPrefix } = {}) {
  if (!answer) return h('p.muted', 'Keine Antwort.');
  const rankOf = new Map((chunks || []).map((c, i) => [c.id, c.rank ?? i + 1]));
  const wrap = h('div', { class: `answer${answer.abstained ? ' is-abstained' : ''}` });
  if (answer.abstained) {
    wrap.appendChild(h('p.abstain-banner', h('span', { 'aria-hidden': 'true' }, '🛑 '),
      h('strong', 'Enthaltung: '), 'Der Kontext reicht nicht für eine belegte Antwort – das System antwortet lieber nicht, statt zu halluzinieren.'));
  }
  const sentences = answer.sentences && answer.sentences.length ? answer.sentences : null;
  if (!sentences) {
    wrap.appendChild(h('p.answer-text', answer.text || ''));
    return wrap;
  }
  const p = h('p.answer-text');
  sentences.forEach((s) => {
    const g = typeof s.grounding === 'number' ? s.grounding : (s.supported ? 1 : 0);
    const cls = s.supported ? (g >= 0.6 ? 'sent-ok' : 'sent-weak') : 'sent-bad';
    const span = h('span', {
      class: `sent ${cls}`,
      style: { '--g': String(Math.max(0.15, Math.min(1, g))) },
      title: `Grounding ${Math.round(g * 100)} %${s.supported ? ', belegt' : ', nicht belegt'}`,
    }, s.text);
    p.appendChild(span);
    for (const cid of s.citations || []) {
      const r = rankOf.get(cid);
      const label = r != null ? String(r) : cid;
      const target = idPrefix ? `${idPrefix}-${cid}` : null;
      p.appendChild(h(target ? 'a' : 'span', {
        class: 'cite',
        href: target ? `#${target}` : null,
        title: `Quelle ${cid}`,
        'aria-label': `Quelle ${cid}`,
        onclick: target ? (e) => {
          e.preventDefault();
          const el = document.getElementById(target);
          if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
        } : null,
      }, `[${label}]`));
    }
    p.appendChild(document.createTextNode(' '));
  });
  wrap.appendChild(p);
  wrap.appendChild(h('p.legend',
    h('span.sent.sent-ok', 'belegt'), ' ', h('span.sent.sent-weak', 'schwach belegt'), ' ', h('span.sent.sent-bad', 'nicht belegt')));
  return wrap;
}

/** Metrik-Karten; mit `compare` (zweites Metrik-Objekt) wird die Differenz B−A gezeigt */
export function renderMetrics(metrics, { compare = null, order = null } = {}) {
  const keys = order || Object.keys(metrics || {});
  const grid = h('div.metrics');
  for (const k of keys) {
    if (!metrics || metrics[k] == null) continue;
    const v = metrics[k];
    const meta = METRICS[k] || {};
    let delta = null;
    if (compare && typeof compare[k] === 'number' && typeof v === 'number') {
      const diff = v - compare[k];
      const better = meta.lowerBetter ? diff < 0 : diff > 0;
      const same = Math.abs(diff) < 1e-6;
      const txt = meta.count ? fmtNum(diff, 0) : `${(diff * 100).toFixed(0)} Pkt.`;
      delta = h('span', { class: `metric-delta ${same ? 'same' : better ? 'up' : 'down'}` },
        same ? '±0' : `${diff > 0 ? '+' : ''}${txt}`);
    }
    const isFrac = !meta.count && typeof v === 'number' && v >= 0 && v <= 1.0001;
    grid.appendChild(h('div.metric', { title: meta.hint || '' },
      h('span.metric-label', metricLabel(k)),
      h('span.metric-value', metricValue(k, v), delta),
      isFrac ? h('span.metric-bar', { 'aria-hidden': 'true' }, h('span', { style: { width: `${v * 100}%` } })) : null));
  }
  if (!grid.childNodes.length) return h('p.muted', 'Keine Metriken.');
  return grid;
}

/** Kompaktes Ergebnis eines Laufs (für A/B-Spalten und Aufgaben) */
export function renderRunSummary(run, { title, compare = null, idPrefix } = {}) {
  const pref = idPrefix || `r${++uid}`;
  return h('div.run-summary',
    title ? h('h3.run-title', title) : null,
    renderMetrics(run.metrics, { compare }),
    h('h4', 'Antwort'),
    renderAnswer(run.answer, run.chunks, { idPrefix: pref }),
    h('h4', 'Kontext'),
    renderChunks(run.chunks, { idPrefix: pref, compact: true }));
}
