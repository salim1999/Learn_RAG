// RAG Academy – Sternenkarte (#/): 14 Level als Pfad mit Lock-Status, Sternen, Fortschritt

import { api } from './api.js';
import { h, clear, loadingBlock, errorBlock, toast } from './ui.js';
import { state, setProgress, loadProgress } from './state.js';

const ROW = 128;

function starRow(n, label = true) {
  return h('span.stars', { 'aria-label': label ? `${n} von 3 Sternen` : null, role: label ? 'img' : null },
    [0, 1, 2].map((i) => h('span', { class: i < n ? 'star on' : 'star', 'aria-hidden': 'true' }, '★')));
}

function pathD(points) {
  if (!points.length) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const my = (a.y + b.y) / 2;
    d += ` C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
  }
  return d;
}

export async function viewMap(root, params, { alive }) {
  root.appendChild(loadingBlock('Sternenkarte wird geladen …'));
  let levels;
  try {
    [levels] = await Promise.all([api.levels(), state.progress ? null : loadProgress()]);
  } catch (err) {
    if (!alive()) return;
    clear(root).appendChild(errorBlock(err, () => viewMap(clear(root), params, { alive })));
    return;
  }
  if (!alive()) return;
  clear(root);

  levels = (levels || []).slice().sort((a, b) => a.id - b.id);
  const mastered = levels.filter((l) => l.stars >= 1).length;
  const current = levels.find((l) => l.unlocked && l.stars === 0) || levels.filter((l) => l.unlocked).pop();
  const totalStars = levels.reduce((s, l) => s + (l.stars || 0), 0);

  const header = h('section.map-intro',
    h('div.map-intro-text',
      h('h1.display', 'Deine Reise durch RAG'),
      h('p.lead', 'Jeder Stern ist ein Level. Erreiche 70 % in einem Level, um den nächsten Stern freizuschalten – vom ersten Chunk bis zum Agenten-Team, das Halluzinationen erkennt.')),
    h('dl.map-stats',
      h('div', h('dt', 'Gemeistert'), h('dd', `${mastered} / ${levels.length}`)),
      h('div', h('dt', 'Sterne'), h('dd', `${totalStars} / ${levels.length * 3}`)),
      current ? h('div', h('dt', 'Als Nächstes'), h('dd', h('a', { href: `#/level/${current.id}` }, current.title))) : null));
  root.appendChild(header);

  // Positionen: sanfte Schlangenlinie (x in % der Breite, y in px)
  const pts = levels.map((l, i) => ({
    x: 50 + Math.sin(i * 1.15 + 0.4) * 30,
    y: i * ROW + 70,
  }));
  const height = levels.length * ROW + 40;
  const lastUnlocked = levels.reduce((m, l, i) => (l.unlocked ? i : m), 0);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'map-path');
  svg.setAttribute('viewBox', `0 0 100 ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const full = document.createElementNS(svgNS, 'path');
  full.setAttribute('d', pathD(pts));
  full.setAttribute('class', 'map-path-all');
  full.setAttribute('vector-effect', 'non-scaling-stroke');
  const done = document.createElementNS(svgNS, 'path');
  done.setAttribute('d', pathD(pts.slice(0, lastUnlocked + 1)));
  done.setAttribute('class', 'map-path-done');
  done.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(full, done);

  const list = h('ol.starmap', { style: { '--map-h': `${height}px` }, 'aria-label': 'Level' });
  levels.forEach((l, i) => {
    const p = pts[i];
    const side = p.x > 50 ? 'left' : 'right';
    const isCurrent = current && current.id === l.id;
    const score = Math.round((l.score_pct || 0) * 100);
    const inner = [
      h('span.node-orb', { style: { '--lvl': l.color || 'var(--accent)' }, 'aria-hidden': 'true' },
        h('span.node-ring', { style: { '--p': String(score) } }),
        h('span.node-icon', l.unlocked ? (l.icon || '✦') : '🔒')),
      h('span.node-card',
        h('span.node-num', `Level ${l.id}`),
        h('span.node-title', l.title),
        l.unlocked
          ? h('span.node-meta', starRow(l.stars || 0), h('span.node-score', `${score} %`), h('span.node-tasks', `${l.task_count} Aufgaben`))
          : h('span.node-meta.locked-hint', `Schalte frei mit 70 % in Level ${l.id - 1}`)),
    ];
    const li = h('li', {
      class: `map-node side-${side}${l.unlocked ? '' : ' locked'}${isCurrent ? ' current' : ''}${l.stars === 3 ? ' perfect' : ''}`,
      style: { '--x': `${p.x}%`, '--y': `${p.y}px` },
    },
    l.unlocked
      ? h('a.node-link', { href: `#/level/${l.id}`, 'aria-label': `Level ${l.id}: ${l.title}, ${l.stars || 0} von 3 Sternen, ${score} Prozent${isCurrent ? ', aktuelles Level' : ''}` }, inner)
      : h('div.node-link', { 'aria-label': `Level ${l.id}: ${l.title}, gesperrt`, role: 'group' }, inner));
    list.appendChild(li);
  });

  const map = h('section.map-wrap', { 'aria-labelledby': 'map-h' },
    h('h2.sr-only#map-h', 'Level-Karte'),
    h('div.map-canvas', { style: { height: `${height}px` } }, svg, list));
  root.appendChild(map);

  const resetBtn = h('button.btn.btn-ghost.btn-danger', {
    type: 'button',
    onclick: async () => {
      if (!window.confirm('Gesamten Fortschritt (XP, Sterne, Abzeichen) zurücksetzen?')) return;
      try {
        const p = await api.reset();
        if (p && p.player) setProgress(p); else await loadProgress();
        toast('Fortschritt zurückgesetzt.', 'info');
        viewMap(clear(root), params, { alive });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  }, 'Fortschritt zurücksetzen');
  root.appendChild(h('footer.map-footer', h('p.muted', 'Tipp: Im RAG-Labor kannst du jede Pipeline-Einstellung frei ausprobieren.'), resetBtn));

  if (current) {
    requestAnimationFrame(() => {
      const el = list.querySelector('.current');
      if (el && current.id > 3) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }
}
