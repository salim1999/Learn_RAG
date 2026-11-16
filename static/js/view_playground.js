// RAG Academy – RAG-Labor (#/playground): Pipeline frei konfigurieren, Trace, Szenen, A/B-Vergleich

import { api } from './api.js';
import { h, clear, loadingBlock, errorBlock, mountScene, toast, metricLabel, metricValue, METRICS } from './ui.js';
import { state, loadStatus } from './state.js';
import { configForm, cloneConfig, DEFAULT_CONFIG, suggestionChips } from './configform.js';
import { renderTrace, renderChunks, renderAnswer, renderMetrics, renderRunSummary, isFallback } from './ragview.js';

const SCENE_TABS = [
  { name: 'vectorspace', label: 'Vektorraum' },
  { name: 'pipeline', label: 'Pipeline' },
  { name: 'hallucination', label: 'Grounding' },
];

const STORE_KEY = 'ragacademy.playground';

/** A/B-Vorlagen: liefern [configA, configB] aus einer Basis-Konfiguration */
const AB_PRESETS = [
  {
    label: 'Ohne vs. mit Aktualitäts-Filter', gpu: false, hint: 'Zeigt, wie veraltete Dokumente die Antwort verfälschen',
    make: (c) => [
      { ...c, freshness: { ...c.freshness, enabled: false, drop_superseded: false } },
      { ...c, freshness: { ...c.freshness, enabled: true, drop_superseded: true } },
    ],
  },
  {
    label: 'TF-IDF vs. Dense-Embeddings', gpu: true, hint: 'Lexikalisches gegen semantisches Retrieval (multilingual-e5)',
    make: (c) => [
      { ...c, retrieval: { ...c.retrieval, method: 'tfidf' } },
      { ...c, retrieval: { ...c.retrieval, method: 'dense' } },
    ],
  },
  {
    label: 'Heuristisch vs. Cross-Encoder-Rerank', gpu: true, hint: 'Einfaches Reranking gegen bge-reranker-v2-m3',
    make: (c) => [
      { ...c, retrieval: { ...c.retrieval, rerank: true, rerank_mode: 'heuristic' } },
      { ...c, retrieval: { ...c.retrieval, rerank: true, rerank_mode: 'cross_encoder' } },
    ],
  },
];

/** Knopf „GPU aufwärmen“ mit Statusanzeige */
function gpuWarmupBox(alive) {
  const gpuOn = !!(state.status && state.status.gpu_enabled);
  const statusEl = h('span.gpu-status', { role: 'status', 'aria-live': 'polite' },
    gpuOn ? 'Kaltstart kann 1–3 Minuten dauern.' : 'GPU-Endpoint nicht konfiguriert.');
  const btn = h('button.btn.btn-sm', {
    type: 'button',
    disabled: !gpuOn,
    title: gpuOn ? 'Startet die GPU-Modelle vor, damit der erste Lauf nicht wartet' : 'GPU-Endpoint nicht konfiguriert',
  }, h('span', { 'aria-hidden': 'true' }, '⚡'), ' GPU aufwärmen');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const t0 = Date.now();
    statusEl.className = 'gpu-status is-busy';
    const tick = setInterval(() => { statusEl.textContent = `Wärmt auf … ${Math.round((Date.now() - t0) / 1000)} s (Kaltstart 1–3 Minuten)`; }, 1000);
    statusEl.textContent = 'Wärmt auf … (Kaltstart 1–3 Minuten)';
    try {
      const res = await api.gpuWarmup();
      if (!alive()) return;
      const secs = Math.round((Date.now() - t0) / 1000);
      const status = res?.status || 'error';
      const msg = res?.message || res?.detail || '';
      const labels = { ready: 'GPU bereit', warming: 'GPU startet', disabled: 'GPU deaktiviert', error: 'GPU nicht bereit' };
      statusEl.className = `gpu-status ${status === 'ready' ? 'is-ok' : status === 'warming' ? 'is-busy' : 'is-bad'}`;
      statusEl.textContent = `${labels[status] || 'GPU-Status unbekannt'} nach ${secs} s${msg && typeof msg === 'string' ? `: ${msg}` : ''}`;
      loadStatus();
    } catch (err) {
      if (!alive()) return;
      statusEl.className = 'gpu-status is-bad';
      statusEl.textContent = `Aufwärmen fehlgeschlagen: ${err.message}`;
    } finally {
      clearInterval(tick);
      btn.disabled = false;
    }
  });
  return h('div.gpu-warmup', btn, statusEl);
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
function save(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

function sceneData(name, run) {
  if (name === 'hallucination') {
    return { sentences: (run.answer && run.answer.sentences) || [], chunks: (run.chunks || []).map((c) => ({ id: c.id, title: c.title })) };
  }
  return run;
}

export async function viewPlayground(root, params, { alive }) {
  let saved = loadSaved() || {};
  let mode = saved.mode === 'ab' ? 'ab' : 'single';
  let activeScene = null;
  let activeTab = SCENE_TABS.some((t) => t.name === saved.tab) ? saved.tab : 'vectorspace';
  let lastRun = null;
  let runToken = 0;

  root.appendChild(h('header.page-head',
    h('h1.display', 'RAG-Labor'),
    h('p.lead', 'Stell die Pipeline selbst ein und sieh zu, wie sich Chunking, Retrieval, Aktualität und Grounding auf die Antwort auswirken.')));

  const modeSwitch = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Modus' });
  const modes = [['single', 'Einzellauf'], ['ab', 'A/B-Vergleich']];
  for (const [m, label] of modes) {
    modeSwitch.appendChild(h('button.seg', {
      type: 'button', role: 'radio', 'aria-checked': String(mode === m), 'data-mode': m,
      onclick: () => { if (mode !== m) { mode = m; persist(); build(); } },
    }, label));
  }
  root.appendChild(h('div.toolbar', modeSwitch, gpuWarmupBox(alive)));

  const body = h('div.lab');
  root.appendChild(body);

  let formA = null;
  let formB = null;
  let sharedQuery = null;

  function persist() {
    saved = {
      mode,
      tab: activeTab,
      a: formA ? formA.read() : saved.a,
      b: formB ? formB.read() : saved.b,
      query: sharedQuery ? sharedQuery.value : saved.query,
    };
    save(saved);
  }

  function disposeScene() {
    if (activeScene) { activeScene.then((s) => s.dispose()); activeScene = null; }
  }

  function build() {
    disposeScene();
    runToken++;
    clear(body);
    for (const b of modeSwitch.querySelectorAll('.seg')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    if (mode === 'single') buildSingle(); else buildAB();
  }

  /* ---------- Einzellauf ---------- */
  function buildSingle() {
    formA = configForm(saved.a || DEFAULT_CONFIG, { onChange: persist });
    formB = null;
    sharedQuery = null;
    const runBtn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Pipeline ausführen');
    const resetBtn = h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { formA.set(DEFAULT_CONFIG); persist(); } }, 'Standardwerte');
    const form = h('form.lab-form', { 'aria-label': 'Pipeline-Konfiguration' }, formA.el, h('div.lab-form-actions', runBtn, resetBtn));
    const out = h('div.lab-out', { 'aria-live': 'polite' },
      h('div.empty-state', h('span.empty-icon', { 'aria-hidden': 'true' }, '⚗'),
        h('p', 'Wähle eine Frage und starte die Pipeline. Danach siehst du jede Stufe, die abgerufenen Chunks und wie gut jeder Satz der Antwort belegt ist.')));
    body.append(h('aside.lab-side', form), out);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cfg = formA.read();
      if (!cfg.query) { toast('Bitte eine Frage eingeben.', 'info'); formA.queryInput && formA.queryInput.focus(); return; }
      persist();
      const my = ++runToken;
      runBtn.disabled = true;
      disposeScene();
      clear(out).appendChild(loadingBlock('Pipeline läuft …'));
      try {
        const run = await api.ragRun(cfg);
        if (my !== runToken || !alive()) return;
        lastRun = run;
        renderSingle(out, run);
      } catch (err) {
        if (my !== runToken || !alive()) return;
        clear(out).appendChild(errorBlock(err));
      } finally {
        runBtn.disabled = false;
      }
    });
  }

  function renderSingle(out, run) {
    clear(out);
    const prefix = 'pg';
    const fb = (run.trace || []).filter(isFallback);
    out.appendChild(h('section.lab-sec', h('h2', 'Ablauf'),
      fb.length ? h('p.notice.notice-stale', { role: 'status' }, h('strong', 'Fallback aktiv: '), fb.map((st) => st.message || st.title).join(' ')) : null,
      renderTrace(run.trace)));

    // Szenen-Tabs
    const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Visualisierung' });
    const panel = h('div.scene-panel.lab-scene', { role: 'tabpanel', id: 'pg-scene-panel', tabindex: '0' });
    const tabBtns = SCENE_TABS.map((t) => h('button.tab', {
      type: 'button', role: 'tab', id: `pg-tab-${t.name}`, 'aria-controls': 'pg-scene-panel',
      'aria-selected': String(t.name === activeTab), tabindex: t.name === activeTab ? '0' : '-1',
      onclick: () => selectTab(t.name, true),
    }, t.label));
    tabs.append(...tabBtns);
    tabs.addEventListener('keydown', (e) => {
      const i = SCENE_TABS.findIndex((t) => t.name === activeTab);
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % SCENE_TABS.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + SCENE_TABS.length) % SCENE_TABS.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = SCENE_TABS.length - 1;
      if (j != null) { e.preventDefault(); selectTab(SCENE_TABS[j].name, true); tabBtns[j].focus(); }
    });
    function selectTab(name, user) {
      activeTab = name;
      if (user) persist();
      tabBtns.forEach((b, k) => {
        const on = SCENE_TABS[k].name === name;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      panel.setAttribute('aria-labelledby', `pg-tab-${name}`);
      disposeScene();
      clear(panel);
      activeScene = mountScene(name, panel, sceneData(name, run), { context: 'playground' });
      if (name === 'pipeline') activeScene.then((s) => s.play && s.play());
    }
    out.appendChild(h('section.lab-sec', h('div.lab-sec-head', h('h2', 'Visualisierung'), tabs), panel));
    selectTab(activeTab, false);

    out.appendChild(h('section.lab-sec', h('h2', 'Antwort'), renderAnswer(run.answer, run.chunks, { idPrefix: prefix })));
    out.appendChild(h('section.lab-sec', h('h2', 'Metriken'), renderMetrics(run.metrics)));
    const stale = (run.chunks || []).filter((c) => c.stale).length;
    out.appendChild(h('section.lab-sec',
      h('div.lab-sec-head', h('h2', `Kontext: ${(run.chunks || []).length} Chunks`),
        stale ? h('span.tag.tag-stale', `${stale} veraltet`) : null),
      renderChunks(run.chunks, { idPrefix: prefix })));
  }

  /* ---------- A/B-Vergleich ---------- */
  function buildAB() {
    const baseA = saved.a || DEFAULT_CONFIG;
    const baseB = saved.b || (() => {
      const c = cloneConfig(baseA);
      c.freshness = { ...c.freshness, enabled: true, drop_superseded: true };
      return c;
    })();
    sharedQuery = h('input.input', { type: 'text', id: 'ab-query', autocomplete: 'off', value: saved.query || baseA.query || DEFAULT_CONFIG.query });
    sharedQuery.addEventListener('change', persist);
    formA = configForm(baseA, { withQuery: false, title: 'Konfiguration A', onChange: persist });
    formB = configForm(baseB, { withQuery: false, title: 'Konfiguration B', onChange: persist });
    const runBtn = h('button.btn.btn-primary', { type: 'submit' }, 'A und B ausführen');
    const copyBtn = h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { formB.set(formA.read()); persist(); toast('B übernimmt die Werte von A.', 'info'); } }, 'A nach B kopieren');
    const out = h('div.ab-out', { 'aria-live': 'polite' });
    const gpuOn = !!(state.status && state.status.gpu_enabled);
    const presets = h('div.ab-presets', { role: 'group', 'aria-label': 'Vergleichs-Vorlagen' },
      h('span.muted', 'Vorlagen:'),
      AB_PRESETS.map((p) => h('button.chip-btn', {
        type: 'button',
        disabled: p.gpu && !gpuOn,
        title: p.gpu && !gpuOn ? 'GPU-Endpoint nicht konfiguriert' : p.hint,
        onclick: () => {
          const base = { ...formA.read(), query: sharedQuery.value };
          const [a, b] = p.make(cloneConfig(base));
          formA.set(a); formB.set(b); persist();
          toast(`Vorlage „${p.label}“ geladen.`, 'info');
        },
      }, p.label)));
    const form = h('form.ab-form', { 'aria-label': 'A/B-Konfiguration' },
      presets,
      h('div.field.ab-query',
        h('label', { for: 'ab-query' }, 'Gemeinsame Frage'),
        sharedQuery,
        suggestionChips((q) => { sharedQuery.value = q; persist(); })),
      h('div.ab-forms', formA.el, formB.el),
      h('div.lab-form-actions', runBtn, copyBtn));
    body.append(form, out);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = sharedQuery.value.trim();
      if (!q) { toast('Bitte eine Frage eingeben.', 'info'); sharedQuery.focus(); return; }
      persist();
      const my = ++runToken;
      runBtn.disabled = true;
      clear(out).appendChild(loadingBlock('Beide Pipelines laufen …'));
      try {
        const [ra, rb] = await Promise.all([api.ragRun({ ...formA.read(), query: q }), api.ragRun({ ...formB.read(), query: q })]);
        if (my !== runToken || !alive()) return;
        renderAB(out, ra, rb);
      } catch (err) {
        if (my !== runToken || !alive()) return;
        clear(out).appendChild(errorBlock(err));
      } finally {
        runBtn.disabled = false;
      }
    });
  }

  function renderAB(out, ra, rb) {
    clear(out);
    const keys = [...new Set([...Object.keys(ra.metrics || {}), ...Object.keys(rb.metrics || {})])];
    const table = h('table.diff-table',
      h('caption', 'Metriken im Vergleich (Differenz = B minus A)'),
      h('thead', h('tr', h('th', { scope: 'col' }, 'Metrik'), h('th', { scope: 'col' }, 'A'), h('th', { scope: 'col' }, 'B'), h('th', { scope: 'col' }, 'Differenz'))),
      h('tbody', keys.map((k) => {
        const a = (ra.metrics || {})[k];
        const b = (rb.metrics || {})[k];
        const meta = METRICS[k] || {};
        let diffCell = '–'; let cls = 'same';
        if (typeof a === 'number' && typeof b === 'number') {
          const d = b - a;
          cls = Math.abs(d) < 1e-6 ? 'same' : (meta.lowerBetter ? d < 0 : d > 0) ? 'up' : 'down';
          diffCell = Math.abs(d) < 1e-6 ? '±0' : `${d > 0 ? '+' : ''}${meta.count ? d.toFixed(0) : `${(d * 100).toFixed(0)} Pkt.`}`;
        }
        return h('tr',
          h('th', { scope: 'row' }, metricLabel(k)),
          h('td', a == null ? '–' : metricValue(k, a)),
          h('td', b == null ? '–' : metricValue(k, b)),
          h('td', h('span', { class: `metric-delta ${cls}` }, diffCell)));
      })));
    const changes = diffConfig(formA.read(), formB.read());
    out.append(
      h('section.lab-sec', h('h2', 'Unterschied auf einen Blick'),
        changes.length
          ? h('ul.cfg-diff', changes.map((c) => h('li', h('code', c.path), ': ', h('span.a', String(c.a)), ' gegen ', h('span.b', String(c.b)))))
          : h('p.muted', 'Beide Konfigurationen sind identisch.'),
        table),
      h('div.ab-compare',
        h('section.ab-col', renderRunSummary(ra, { title: 'A', idPrefix: 'abA' }), h('details.ab-trace', h('summary', 'Ablauf A'), renderTrace(ra.trace, { compact: true, animate: false }))),
        h('section.ab-col', renderRunSummary(rb, { title: 'B', compare: ra.metrics, idPrefix: 'abB' }), h('details.ab-trace', h('summary', 'Ablauf B'), renderTrace(rb.trace, { compact: true, animate: false })))));
  }

  build();
  return () => { runToken++; disposeScene(); lastRun = null; };
}

function diffConfig(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (k === 'query' || k === 'corpus') continue;
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    if (va && typeof va === 'object' && vb && typeof vb === 'object') out.push(...diffConfig(va, vb, `${prefix}${k}.`));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ path: `${prefix}${k}`, a: va, b: vb });
  }
  return out;
}
