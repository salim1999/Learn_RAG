// RAG Academy – Aufgaben-Ansicht (#/level/:id/task/:taskId)

import { api } from './api.js';
import {
  append, h, md, clear, loadingBlock, errorBlock, mountScene, renderMarkdown, toast,
  floatXP, confetti, shake, TASK_TYPES, difficultyDots,
} from './ui.js';
import { getLevel, setProgress, levelProgress } from './state.js';
import { levelErrorView } from './view_level.js';

/** Szenen, die ein Aufgabenmodul nach dem Ergebnis bereits selbst zeigt */
const SELF_VISUAL = { spot: 'hallucination', freshness: 'timeline', tune: 'pipeline' };

export function sceneDataFor(visual, result) {
  const run = result && result.details && result.details.run;
  if (!run) return null;
  if (visual === 'vectorspace' || visual === 'pipeline') return run;
  if (visual === 'hallucination' && run.answer) return { sentences: run.answer.sentences || [], chunks: (run.chunks || []).map((c) => ({ id: c.id, title: c.title })) };
  return null;
}

export async function viewTask(root, { id, taskId }, { alive }) {
  root.appendChild(loadingBlock('Aufgabe wird geladen …'));
  let level;
  try {
    level = await getLevel(id);
  } catch (err) {
    if (!alive()) return;
    clear(root);
    levelErrorView(root, err, id);
    return;
  }
  const tasks = level.tasks || [];
  const idx = tasks.findIndex((t) => String(t.id) === String(taskId));
  const task = tasks[idx];
  if (!task) {
    if (!alive()) return;
    clear(root).appendChild(h('section.locked-view',
      h('h1.display', 'Aufgabe nicht gefunden'),
      h('a.btn.btn-primary', { href: `#/level/${level.id}` }, 'Zurück zum Level')));
    return;
  }

  let mod;
  try {
    mod = await import(`./tasks/${task.type}.js`);
  } catch (err) {
    if (!alive()) return;
    clear(root).appendChild(errorBlock(new Error(`Aufgabentyp „${task.type}“ kann nicht angezeigt werden.`)));
    console.error(err);
    return;
  }
  if (!alive()) return;
  clear(root);
  root.style.setProperty('--lvl', level.color || 'var(--accent)');

  const info = TASK_TYPES[task.type] || { icon: '•', label: task.type };
  const best = (levelProgress(level.id).best_scores || {})[task.id];
  const extraScenes = [];

  root.appendChild(h('nav.crumbs', { 'aria-label': 'Brotkrumen' },
    h('a', { href: '#/' }, 'Sternenkarte'), h('span', { 'aria-hidden': 'true' }, ' / '),
    h('a', { href: `#/level/${level.id}` }, `Level ${level.id}: ${level.title}`), h('span', { 'aria-hidden': 'true' }, ' / '),
    h('span', { 'aria-current': 'page' }, `Aufgabe ${idx + 1} von ${tasks.length}`)));

  const head = h('header.task-head',
    h('div.task-head-meta',
      h('span.task-type-pill', h('span', { 'aria-hidden': 'true' }, info.icon), ' ', info.label),
      difficultyDots(task.difficulty),
      h('span.task-xp', `${task.xp} XP`),
      best != null ? h('span.task-best', `Bestwert ${Math.round(best * 100)} %`) : null),
    h('h1.display.task-title-big', task.title),
    task.prompt ? md(task.prompt, 'md prose task-prompt') : null);
  root.appendChild(head);

  const stage = h('section.task-stage', { 'aria-label': 'Aufgabe' });
  const checkBtn = h('button.btn.btn-primary.btn-check', { type: 'button', disabled: true }, 'Prüfen');
  const hintBox = h('div.hint-box', { hidden: true, id: 'hint-box', role: 'note' });
  const hintBtn = task.hint
    ? h('button.btn.btn-ghost', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'hint-box' }, h('span', { 'aria-hidden': 'true' }, '💡'), ' Hinweis')
    : null;
  const actions = h('div.task-actions', hintBtn, h('span.kbd-tip.muted', h('kbd', 'Strg'), '+', h('kbd', 'Enter'), ' prüft'), checkBtn);
  const resultPanel = h('section.result-panel', { 'aria-live': 'polite', hidden: true, tabindex: '-1', 'aria-label': 'Ergebnis' });

  root.append(stage, hintBox, actions, resultPanel);

  if (hintBtn) {
    hintBtn.addEventListener('click', () => {
      const open = hintBox.hidden;
      hintBox.hidden = !open;
      hintBtn.setAttribute('aria-expanded', String(open));
      if (open && !hintBox.firstChild) hintBox.append(h('strong', 'Hinweis: '), md(task.hint, 'md hint-text'));
    });
  }

  let ready = false;
  let busy = false;
  let finished = false;
  const ctx = {
    api,
    level,
    mountScene,
    renderMarkdown,
    onReady(b) {
      ready = !!b;
      checkBtn.disabled = !ready || busy || finished;
    },
  };

  let handle;
  try {
    handle = mod.render(stage, task, ctx);
  } catch (err) {
    console.error(err);
    stage.appendChild(errorBlock(new Error('Die Aufgabe konnte nicht aufgebaut werden.')));
    return;
  }

  async function check() {
    if (!ready || busy || finished) return;
    const answer = handle.getAnswer();
    if (answer == null) { toast('Bitte zuerst eine Antwort geben.', 'info'); return; }
    busy = true;
    stage.inert = true;
    checkBtn.disabled = true;
    checkBtn.classList.add('is-busy');
    checkBtn.textContent = 'Wird geprüft …';
    let result;
    try {
      result = await api.submit(level.id, task.id, answer);
    } catch (err) {
      toast(err.message, 'error');
      busy = false;
      stage.inert = false;
      checkBtn.classList.remove('is-busy');
      checkBtn.textContent = 'Prüfen';
      checkBtn.disabled = !ready;
      return;
    }
    busy = false;
    stage.inert = false;
    checkBtn.classList.remove('is-busy');
    checkBtn.textContent = 'Prüfen';
    if (!alive()) return;
    if (result.progress) setProgress(result.progress);

    const isBoss = task.type === 'boss';
    const d = result.details || {};
    const bossDone = isBoss && (d.finished || d.lives_left === 0);
    const tuneAgain = task.type === 'tune' && !result.correct;
    finished = isBoss ? bossDone : !tuneAgain;

    // Das Modul zuerst: Boss ruft für den nächsten Schritt ggf. onReady() auf
    ready = false;
    try { handle.showResult(result); } catch (err) { console.error(err); }

    renderResult(result, { isBoss, bossDone });
    checkBtn.disabled = !ready || finished;
    if (finished) actions.hidden = true;

    if (result.xp_awarded > 0) floatXP(finished ? resultPanel : checkBtn, result.xp_awarded);
    const stepOk = isBoss ? d.step_correct : result.correct;
    if (finished && result.score >= 0.999) confetti();
    else if (!stepOk) shake(stage);
  }

  function renderResult(result, { isBoss, bossDone }) {
    clear(resultPanel);
    extraScenes.splice(0).forEach((s) => s.then((x) => x.dispose()));
    resultPanel.hidden = false;
    const d = result.details || {};
    const ok = isBoss && !bossDone ? d.step_correct : result.correct;
    const score = Math.round((result.score || 0) * 100);
    let verdict;
    if (isBoss && !bossDone) verdict = ok ? 'Treffer! Schritt geschafft.' : 'Autsch – dieser Schritt ging daneben.';
    else if (result.score >= 0.999) verdict = 'Perfekt gelöst!';
    else if (result.correct) verdict = 'Richtig!';
    else if (result.score > 0) verdict = `Teilweise richtig (${score} %)`;
    else verdict = 'Leider nicht richtig.';

    const cls = ok ? 'result-ok' : result.score > 0 && !(isBoss && !bossDone) ? 'result-partial' : 'result-bad';
    resultPanel.className = `result-panel ${cls}`;
    append(resultPanel,
      h('div.result-head',
        h('span.result-icon', { 'aria-hidden': 'true' }, ok ? '✓' : result.score > 0 && !(isBoss && !bossDone) ? '◐' : '✕'),
        h('div',
          h('h2.result-title', verdict),
          !(isBoss && !bossDone)
            ? h('p.result-sub', `Punktzahl ${score} %`, result.xp_awarded > 0 ? `, +${result.xp_awarded} XP` : (result.score > 0 ? ', keine neuen XP (Bestwert nicht übertroffen)' : ''))
            : null)),
      result.feedback ? md(result.feedback, 'md result-feedback') : null,
      (!isBoss || bossDone) && result.explanation
        ? h('div.explanation', h('h3', 'Erklärung'), md(result.explanation, 'md prose'))
        : null);

    const visual = task.visual && task.visual !== 'null' ? task.visual : null;
    if (visual && (!isBoss || bossDone) && SELF_VISUAL[task.type] !== visual) {
      const host = h('div.scene-panel.scene-panel-sm');
      resultPanel.appendChild(h('figure.result-visual', host));
      extraScenes.push(mountScene(visual, host, sceneDataFor(visual, result), { context: 'result' }));
    }

    if (!isBoss || bossDone) {
      const next = tasks[idx + 1];
      const nextLevelId = Number(level.id) + 1;
      const p = result.progress && result.progress.levels;
      const nextLevelOpen = p && p[String(nextLevelId)] && p[String(nextLevelId)].unlocked;
      const row = h('div.btn-row.result-actions',
        task.type === 'tune' && !result.correct
          ? h('button.btn.btn-primary', { type: 'button', onclick: () => {
            stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
            stage.querySelector('input[type="range"]')?.focus({ preventScroll: true });
          } }, 'Parameter weiter anpassen')
          : next
          ? h('a.btn.btn-primary', { href: `#/level/${level.id}/task/${encodeURIComponent(next.id)}` }, 'Weiter zur nächsten Aufgabe')
          : nextLevelOpen
            ? h('a.btn.btn-primary', { href: `#/level/${nextLevelId}` }, `Weiter zu Level ${nextLevelId}`)
            : h('a.btn.btn-primary', { href: `#/level/${level.id}` }, 'Weiter zur Level-Übersicht'),
        h('button.btn', { type: 'button', onclick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }, 'Nochmal versuchen'),
        next || nextLevelOpen ? h('a.btn.btn-ghost', { href: `#/level/${level.id}` }, 'Level-Übersicht') : null);
      resultPanel.appendChild(row);
      requestAnimationFrame(() => {
        resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const first = row.querySelector('a,button');
        if (first) first.focus({ preventScroll: true });
      });
    }
  }

  checkBtn.addEventListener('click', check);
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); check(); }
  };
  document.addEventListener('keydown', onKey);

  return () => {
    document.removeEventListener('keydown', onKey);
    extraScenes.forEach((s) => s.then((x) => x.dispose()));
    try { handle.dispose(); } catch (e) { console.warn(e); }
  };
}
