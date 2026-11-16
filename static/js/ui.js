// RAG Academy – gemeinsame UI-Helfer (DOM, Markdown, Szenen, Effekte)

let markedParse = null;

/** Lädt marked als ES-Modul vom CDN; ohne Netz wird ein einfacher Fallback benutzt. */
export async function initMarkdown() {
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js');
    const marked = mod.marked || mod.default;
    marked.setOptions({ gfm: true, breaks: false });
    markedParse = (s) => marked.parse(s);
  } catch (err) {
    console.warn('marked konnte nicht geladen werden – einfacher Markdown-Fallback aktiv.', err);
    markedParse = null;
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fallbackMarkdown(md) {
  const blocks = String(md).split(/\n{2,}/);
  return blocks.map((b) => {
    if (/^```/.test(b)) return `<pre><code>${esc(b.replace(/^```\w*\n?|```$/g, ''))}</code></pre>`;
    let t = esc(b)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    if (/^#{1,6} /.test(b)) { const n = b.match(/^#+/)[0].length; return `<h${n + 2}>${t.replace(/^#+ /, '')}</h${n + 2}>`; }
    if (/^[-*] /m.test(b)) return '<ul>' + t.split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>';
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

export function renderMarkdown(md) {
  if (md == null || md === '') return '';
  try {
    return markedParse ? markedParse(String(md)) : fallbackMarkdown(md);
  } catch {
    return fallbackMarkdown(md);
  }
}

/** Element-Helfer: h('div.card#id', {attrs}, ...children) */
export function h(sel, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const tag = (m && m[1]) || 'div';
  const node = document.createElement(tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') node.classList.add(part.slice(1));
      else node.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function md(markdown, cls = 'md') {
  return h('div', { class: cls, html: renderMarkdown(markdown) });
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const reducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pct(v, digits = 0) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  return `${(Number(v) * 100).toFixed(digits)} %`;
}

export function fmtNum(v, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  return Number(v).toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ---------- Toasts ---------- */
export function toast(message, kind = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = h('div.toast', { class: `toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  }, ms);
}

/* ---------- Szenen (Three.js über Registry von Agent D) ---------- */
let registryPromise = null;
function loadRegistry() {
  if (!registryPromise) {
    registryPromise = import('./three/index.js').catch((err) => {
      registryPromise = null; // später erneut versuchen
      throw err;
    });
  }
  return registryPromise;
}

const SCENE_LABELS = {
  pipeline: 'RAG-Pipeline',
  vectorspace: 'Vektorraum',
  agents: 'Agenten',
  timeline: 'Zeitachse',
  hallucination: 'Halluzinations-Check',
};

/**
 * Montiert eine Szene sicher. Liefert immer ein Objekt mit update/dispose
 * (bei Fehlern ein Platzhalter-Stub mit no-op-Methoden).
 */
export async function mountScene(name, container, data = null, opts = {}) {
  if (!name || !container) return stubScene();
  container.classList.add('scene-host');
  const loading = h('div.scene-loading', { role: 'status' }, `${SCENE_LABELS[name] || name} wird geladen …`);
  container.appendChild(loading);
  try {
    const reg = await loadRegistry();
    if (typeof reg.mountScene !== 'function') throw new Error('mountScene fehlt in three/index.js');
    const scene = await reg.mountScene(name, container, data, { reducedMotion: reducedMotion(), ...opts });
    loading.remove();
    if (!scene) throw new Error('Szene lieferte kein Objekt');
    let disposed = false;
    return new Proxy(scene, {
      get(target, prop) {
        if (prop === 'dispose') {
          return () => {
            if (disposed) return;
            disposed = true;
            try { target.dispose && target.dispose(); } catch (e) { console.warn(e); }
          };
        }
        const v = target[prop];
        if (typeof v === 'function') {
          return (...args) => {
            if (disposed) return undefined;
            try { return v.apply(target, args); } catch (e) { console.warn(`Szene ${name}.${String(prop)}:`, e); return undefined; }
          };
        }
        return v;
      },
    });
  } catch (err) {
    console.warn(`Szene „${name}“ nicht verfügbar:`, err);
    loading.remove();
    container.appendChild(
      h('div.scene-placeholder', { role: 'img', 'aria-label': `${SCENE_LABELS[name] || name} – Visualisierung nicht verfügbar` },
        h('span.scene-placeholder-icon', { 'aria-hidden': 'true' }, '◌'),
        h('span', `${SCENE_LABELS[name] || name}: Visualisierung gerade nicht verfügbar.`)),
    );
    return stubScene();
  }
}

function stubScene() {
  const noop = () => {};
  return { update: noop, dispose: noop, play: noop, event: noop, stub: true };
}

/* ---------- Effekte ---------- */
export function floatXP(anchor, amount) {
  if (!amount) return;
  const rect = anchor.getBoundingClientRect();
  const el = h('div.xp-float', { 'aria-hidden': 'true' }, `+${amount} XP`);
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top + window.scrollY}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), reducedMotion() ? 1500 : 1700);
}

export function shake(node) {
  if (!node || reducedMotion()) return;
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
  setTimeout(() => node.classList.remove('shake'), 600);
}

export function confetti() {
  if (reducedMotion()) return;
  const canvas = h('canvas.confetti', { 'aria-hidden': 'true' });
  document.body.appendChild(canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  let c = null;
  try { c = canvas.getContext('2d'); } catch { c = null; }
  if (!c) { canvas.remove(); return; }
  c.scale(dpr, dpr);
  const colors = ['#7c5cff', '#2bd9a0', '#f5b942', '#e8e9f3', '#a995ff', '#ff5c7a'];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3,
    y: H * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 13 - 4,
    r: Math.random() * 6 + 3,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    col: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  function frame(now) {
    const t = now - start;
    c.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      c.save();
      c.globalAlpha = Math.max(0, 1 - t / 2600);
      c.translate(p.x, p.y); c.rotate(p.rot);
      c.fillStyle = p.col;
      c.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      c.restore();
    }
    if (t < 2600) requestAnimationFrame(frame); else canvas.remove();
  }
  requestAnimationFrame(frame);
}

/** Lade-/Fehlerzustand für Views */
export function loadingBlock(text = 'Wird geladen …') {
  return h('div.loading', { role: 'status' }, h('span.spinner', { 'aria-hidden': 'true' }), text);
}

export function errorBlock(err, retry) {
  return h('div.error-block', { role: 'alert' },
    h('p', h('strong', 'Das hat nicht geklappt. '), err && err.message ? err.message : String(err)),
    retry ? h('button.btn', { type: 'button', onclick: retry }, 'Erneut versuchen') : null);
}

/** Metrik-Metadaten (deutsche Bezeichnungen) */
export const METRICS = {
  faithfulness: { label: 'Faithfulness', hint: 'Anteil der Antwort, der durch den Kontext belegt ist' },
  context_precision: { label: 'Kontext-Präzision', hint: 'Anteil relevanter Chunks im Kontext' },
  answer_relevance: { label: 'Antwort-Relevanz', hint: 'Wie gut die Antwort zur Frage passt' },
  freshness_score: { label: 'Aktualität', hint: 'Wie aktuell die genutzten Quellen sind' },
  stale_in_context: { label: 'Veraltete Chunks', hint: 'Anzahl veralteter Chunks im Kontext', count: true, lowerBetter: true },
  recall_at_k: { label: 'Recall@k', hint: 'Anteil relevanter Dokumente unter den Top-k' },
  precision_at_k: { label: 'Precision@k', hint: 'Anteil der Top-k, die relevant sind' },
  mrr: { label: 'MRR', hint: 'Mittlerer reziproker Rang des ersten Treffers' },
};

export function metricLabel(key) {
  return (METRICS[key] && METRICS[key].label) || key;
}

export function metricValue(key, v) {
  if (METRICS[key] && METRICS[key].count) return fmtNum(v, 0);
  return typeof v === 'number' && v <= 1.0001 && v >= 0 ? pct(v) : fmtNum(v);
}

export const STAGE_LABELS = {
  chunking: 'Chunking',
  embedding: 'Embedding',
  retrieval: 'Retrieval',
  freshness: 'Aktualität',
  rerank: 'Reranking',
  generation: 'Generierung',
  verification: 'Verifikation',
};

export const AGENT_INFO = {
  planner: { icon: '🧭', label: 'Planer' },
  retriever: { icon: '🔎', label: 'Retriever' },
  generator: { icon: '✍️', label: 'Generator' },
  verifier: { icon: '🛡️', label: 'Prüfer' },
  orchestrator: { icon: '🎛️', label: 'Orchestrator' },
};

export const TASK_TYPES = {
  quiz: { icon: '❓', label: 'Quiz' },
  better: { icon: '⚖️', label: 'A/B-Entscheidung' },
  order: { icon: '🔢', label: 'Reihenfolge' },
  spot: { icon: '🔍', label: 'Halluzination finden' },
  tune: { icon: '🎚️', label: 'Feintuning' },
  freshness: { icon: '⏳', label: 'Aktualität' },
  code: { icon: '⌨️', label: 'Code-Lücken' },
  explain: { icon: '💬', label: 'Erklären' },
  boss: { icon: '👾', label: 'Bosskampf' },
};

export function difficultyDots(n) {
  const d = Math.max(1, Math.min(3, Number(n) || 1));
  const names = ['leicht', 'mittel', 'schwer'];
  return h('span.difficulty', { role: 'img', 'aria-label': `Schwierigkeit: ${names[d - 1]}`, title: `Schwierigkeit: ${names[d - 1]}` },
    [1, 2, 3].map((i) => h('span', { class: i <= d ? 'pip on' : 'pip', 'aria-hidden': 'true' })));
}

/** Lazy-Mount einer Szene, sobald der Container sichtbar wird. Gibt dispose-Funktion zurück. */
export function lazyScene(container, name, data, opts) {
  let scene = null;
  let disposed = false;
  let io = null;
  const go = async () => {
    if (scene || disposed) return;
    scene = mountScene(name, container, data, opts);
    const s = await scene;
    if (disposed) s.dispose();
  };
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); go(); }
    }, { rootMargin: '200px' });
    io.observe(container);
  } else {
    go();
  }
  return {
    get scene() { return scene; },
    dispose() {
      disposed = true;
      if (io) io.disconnect();
      if (scene) scene.then((s) => s.dispose());
    },
  };
}
