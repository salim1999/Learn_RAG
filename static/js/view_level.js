// RAG Academy – Level-Ansicht (#/level/:id): Theorie, Merkkarten, Szenen, Aufgabenliste

import { h, md, clear, loadingBlock, errorBlock, lazyScene, TASK_TYPES, difficultyDots } from './ui.js';
import { getLevel, levelProgress } from './state.js';

export function levelErrorView(root, err, id) {
  if (err && err.status === 403) {
    root.appendChild(h('section.locked-view',
      h('div.locked-orb', { 'aria-hidden': 'true' }, '🔒'),
      h('h1.display', `Level ${id} ist noch gesperrt`),
      h('p.lead', `Erreiche mindestens 70 % in Level ${Number(id) - 1}, um diesen Stern freizuschalten.`),
      h('div.btn-row',
        Number(id) > 1 ? h('a.btn.btn-primary', { href: `#/level/${Number(id) - 1}` }, `Zu Level ${Number(id) - 1}`) : null,
        h('a.btn', { href: '#/' }, 'Zur Sternenkarte'))));
  } else if (err && err.status === 404) {
    root.appendChild(h('section.locked-view',
      h('h1.display', 'Dieses Level gibt es nicht'),
      h('p.lead', 'Wähle ein Level auf der Sternenkarte.'),
      h('a.btn.btn-primary', { href: '#/' }, 'Zur Sternenkarte')));
  } else {
    root.appendChild(errorBlock(err, () => window.dispatchEvent(new HashChangeEvent('hashchange'))));
  }
}

export async function viewLevel(root, { id }, { alive }) {
  root.appendChild(loadingBlock('Level wird geladen …'));
  let level;
  try {
    level = await getLevel(id, { force: true });
  } catch (err) {
    if (!alive()) return;
    clear(root);
    levelErrorView(root, err, id);
    return;
  }
  if (!alive()) return;
  clear(root);

  const prog = levelProgress(level.id);
  const scenes = [];
  const theory = level.theory || [];
  const tasks = level.tasks || [];
  const color = level.color || 'var(--accent)';

  root.style.setProperty('--lvl', color);

  root.appendChild(h('nav.crumbs', { 'aria-label': 'Brotkrumen' },
    h('a', { href: '#/' }, 'Sternenkarte'), h('span', { 'aria-hidden': 'true' }, ' / '), h('span', { 'aria-current': 'page' }, `Level ${level.id}`)));

  root.appendChild(h('header.level-head',
    h('div.level-emblem', { 'aria-hidden': 'true' }, level.icon || '✦'),
    h('div',
      h('p.level-num', `Level ${level.id}`),
      h('h1.display', level.title),
      level.subtitle ? h('p.lead', level.subtitle) : null,
      h('p.level-progress-line',
        h('span.stars', { role: 'img', 'aria-label': `${prog.stars || 0} von 3 Sternen` },
          [0, 1, 2].map((i) => h('span', { class: i < (prog.stars || 0) ? 'star on' : 'star', 'aria-hidden': 'true' }, '★'))),
        h('span', `${Math.round((prog.score_pct || 0) * 100)} % erreicht`),
        tasks.length ? h('a.btn.btn-primary.btn-sm', { href: '#level-tasks' , onclick: (e) => { e.preventDefault(); document.getElementById('level-tasks')?.scrollIntoView({ behavior: 'smooth' }); document.getElementById('level-tasks-h')?.focus({ preventScroll: true }); } }, 'Zu den Aufgaben') : null))));

  // Inhaltsverzeichnis (die Theorie ist eine Abfolge)
  if (theory.length > 1) {
    root.appendChild(h('nav.toc', { 'aria-label': 'Abschnitte' },
      h('ol', theory.map((s, i) => h('li', h('a', {
        href: `#sec-${i}`,
        onclick: (e) => { e.preventDefault(); const t = document.getElementById(`sec-${i}`); t?.scrollIntoView({ behavior: 'smooth' }); t?.querySelector('h2')?.focus({ preventScroll: true }); },
      }, s.heading))))));
  }

  const theoryWrap = h('div.theory');
  theory.forEach((sec, i) => {
    const hasVisual = sec.visual && sec.visual !== 'null';
    const section = h('section.theory-sec#' + `sec-${i}`, { class: hasVisual ? 'has-visual' : '' },
      h('div.theory-text',
        h('h2', { tabindex: '-1' }, h('span.sec-num', { 'aria-hidden': 'true' }, String(i + 1)), sec.heading),
        md(sec.body_md, 'md prose'),
        sec.key_points && sec.key_points.length
          ? h('div.keycards', { role: 'list', 'aria-label': 'Merkkarten' },
            sec.key_points.map((kp) => h('div.keycard', { role: 'listitem' },
              h('span.keycard-mark', { 'aria-hidden': 'true' }, '✦'), md(kp, 'md keycard-text'))))
          : null));
    if (hasVisual) {
      const host = h('div.scene-panel', { 'aria-label': `Visualisierung: ${sec.heading}`, role: 'region' });
      section.appendChild(h('figure.theory-visual', host));
      scenes.push(lazyScene(host, sec.visual, null, { context: 'theory', level: level.id }));
    }
    theoryWrap.appendChild(section);
  });
  root.appendChild(theoryWrap);

  // Aufgaben
  const best = prog.best_scores || {};
  const taskList = h('ol.task-list');
  tasks.forEach((t, i) => {
    const info = TASK_TYPES[t.type] || { icon: '•', label: t.type };
    const b = best[t.id];
    const state = b == null ? 'open' : b >= 0.999 ? 'done' : 'partial';
    const stateText = state === 'done' ? 'Gelöst' : state === 'partial' ? `Bestwert ${Math.round(b * 100)} %` : 'Offen';
    taskList.appendChild(h('li', { class: `task-item task-${state}${t.type === 'boss' ? ' task-boss' : ''}` },
      h('a.task-link', { href: `#/level/${level.id}/task/${encodeURIComponent(t.id)}` },
        h('span.task-idx', { 'aria-hidden': 'true' }, String(i + 1)),
        h('span.task-body',
          h('span.task-title', t.title),
          h('span.task-meta',
            h('span.task-type', h('span', { 'aria-hidden': 'true' }, info.icon), ' ', info.label),
            difficultyDots(t.difficulty),
            h('span.task-xp', `${t.xp} XP`))),
        h('span.task-state', { 'data-state': state }, stateText))));
  });
  root.appendChild(h('section.level-tasks#level-tasks', { 'aria-labelledby': 'level-tasks-h' },
    h('h2#level-tasks-h', { tabindex: '-1' }, 'Aufgaben'),
    tasks.length ? taskList : h('p.muted', 'Für dieses Level gibt es noch keine Aufgaben.')));

  return () => scenes.forEach((s) => s.dispose());
}
