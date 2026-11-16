// Boss: ein serverseitiger Versuch mit drei Leben, Wiederholung fehlgeschlagener Schritte.
import { h, append, md, shake, errorBlock, loadingBlock } from '../ui.js';

export function render(container, task, ctx) {
  const steps = task.steps || [];
  const maxLives = Number(task.lives) || 3;
  let lives = maxLives;
  let current = 0;
  let sub = null;
  let subToken = 0;
  let over = false;
  let disposed = false;
  const stepResults = [];

  const hearts = h('div.hearts', { role: 'img' });
  const stepInfo = h('span.boss-stepinfo');
  const track = h('ol.boss-track', { 'aria-hidden': 'true' }, steps.map(() => h('li')));
  const stepHost = h('div.boss-step');
  const after = h('div.boss-after');
  append(container,
    task.story ? h('div.boss-story', md(task.story, 'md prose')) : null,
    h('div.boss-status', hearts, stepInfo, track), stepHost, after);

  function drawHearts(lost) {
    hearts.replaceChildren();
    hearts.setAttribute('aria-label', `${lives} von ${maxLives} Leben`);
    for (let i = 0; i < maxLives; i++) {
      const alive = i < lives;
      hearts.appendChild(h('span', { class: `heart${alive ? '' : ' lost'}${lost && i === lives ? ' just-lost' : ''}`, 'aria-hidden': 'true' }, alive ? '♥' : '♡'));
    }
  }

  function drawTrack() {
    [...track.children].forEach((li, i) => {
      li.className = i === current && !over ? 'now' : stepResults[i] != null ? (stepResults[i] ? 'won' : 'lost') : '';
    });
  }

  async function showStep(i, focus = true) {
    const my = ++subToken;
    if (sub) { try { sub.dispose(); } catch { /* already removed */ } sub = null; }
    current = i;
    stepHost.replaceChildren();
    after.replaceChildren();
    drawTrack();
    const step = steps[i];
    stepInfo.textContent = `Schritt ${i + 1} von ${steps.length}`;
    ctx.onReady(false);
    if (!step || disposed) return;
    append(stepHost,
      h('h3.boss-step-title', step.title || `Schritt ${i + 1}`),
      step.prompt ? md(step.prompt, 'md prose') : null);
    const body = h('div.boss-step-body');
    stepHost.appendChild(body);
    try {
      const mod = await import(`./${step.type}.js`);
      if (disposed || my !== subToken) return;
      sub = mod.render(body, step, { ...ctx, onReady: (b) => {
        if (!disposed && my === subToken && !over) ctx.onReady(b);
      } });
    } catch (err) {
      console.error(err);
      if (!disposed && my === subToken) body.appendChild(errorBlock(new Error(`Schritt-Typ „${step.type}“ kann nicht angezeigt werden.`)));
    }
    if (focus && !disposed && my === subToken) stepHost.querySelector('input, button, textarea, select')?.focus();
  }

  async function startAttempt() {
    const my = ++subToken;
    ctx.onReady(false);
    stepInfo.textContent = 'Neuer Boss-Versuch';
    stepHost.replaceChildren(loadingBlock('Bosskampf wird vorbereitet …'));
    try {
      const state = await ctx.api.restartBoss(ctx.level.id, task.id);
      if (disposed || my !== subToken) return;
      lives = state.lives_left ?? maxLives;
      drawHearts(false);
      showStep(0, false);
    } catch (err) {
      if (!disposed && my === subToken) stepHost.replaceChildren(errorBlock(err, startAttempt));
    }
  }

  drawHearts(false);
  startAttempt();

  return {
    getAnswer() {
      if (!sub || over) return null;
      const answer = sub.getAnswer();
      return answer == null ? null : { step: current, answer };
    },
    showResult(result) {
      const d = result.details || {};
      const stepIdx = typeof d.step === 'number' ? d.step : current;
      const ok = !!d.step_correct;
      stepResults[stepIdx] = ok;
      for (const i of d.solved_steps || []) stepResults[i] = true;
      const previousLives = lives;
      lives = typeof d.lives_left === 'number' ? d.lives_left : ok ? lives : Math.max(0, lives - 1);
      drawHearts(lives < previousLives);
      if (lives < previousLives) shake(hearts);
      ctx.onReady(false);
      const step = steps[stepIdx] || {};
      if (sub) {
        sub.showResult({ correct: ok, score: d.step_score ?? (ok ? 1 : 0), xp_awarded: 0,
          feedback: '', explanation: step.explanation || '', details: d.step_details || {} });
      }
      if (result.explanation || step.explanation) after.appendChild(h('div.why-box',
        h('h3', ok ? 'Treffer' : 'Noch ein Versuch'), md(result.explanation || step.explanation, 'md prose')));
      over = !!d.finished || lives <= 0;
      drawTrack();
      if (over) {
        const solved = stepResults.filter(Boolean).length;
        const won = d.won ?? solved === steps.length;
        after.appendChild(h('div', { class: `boss-final ${won ? 'won' : 'lost'}` },
          h('span.boss-final-icon', { 'aria-hidden': 'true' }, won ? '🏆' : '💀'),
          h('div', h('strong', won ? 'Boss besiegt!' : 'Keine Leben mehr – starte einen neuen Versuch.'),
            h('p', `${solved} von ${steps.length} Schritten gelöst.`))));
      } else {
        // Ein falscher Schritt bleibt offen: Die Korrektur kostet keinen weiteren
        // Versuch, bis sie tatsächlich erneut eingereicht wird.
        const next = ok ? steps.findIndex((_, i) => !stepResults[i]) : stepIdx;
        const btn = h('button.btn.btn-primary', { type: 'button', onclick: () => showStep(next) },
          ok ? `Weiter zu Schritt ${next + 1}` : `Schritt ${stepIdx + 1} erneut versuchen`);
        after.appendChild(h('div.btn-row', btn));
        requestAnimationFrame(() => { if (!disposed) btn.focus(); });
      }
    },
    dispose() {
      disposed = true;
      subToken++;
      if (sub) { try { sub.dispose(); } catch { /* already removed */ } }
    },
  };
}
