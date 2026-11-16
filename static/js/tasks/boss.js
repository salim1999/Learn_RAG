// Aufgabentyp „boss“ – Story + Leben + mehrere Schritte (nutzt die anderen Typmodule)

import { h, md, shake, errorBlock } from '../ui.js';

export function render(container, task, ctx) {
  const steps = task.steps || [];
  const maxLives = Number(task.lives) || 3;
  let lives = maxLives;
  let current = 0;
  let sub = null;
  let subToken = 0;
  let over = false;

  const hearts = h('div.hearts', { role: 'img' });
  const stepInfo = h('span.boss-stepinfo');
  const track = h('ol.boss-track', { 'aria-hidden': 'true' }, steps.map(() => h('li')));
  const stepHost = h('div.boss-step');
  const after = h('div.boss-after');

  container.append(
    task.story ? h('div.boss-story', md(task.story, 'md prose')) : null,
    h('div.boss-status', hearts, stepInfo, track),
    stepHost,
    after);

  function drawHearts(lost) {
    hearts.innerHTML = '';
    hearts.setAttribute('aria-label', `${lives} von ${maxLives} Leben`);
    for (let i = 0; i < maxLives; i++) {
      const alive = i < lives;
      hearts.appendChild(h('span', { class: `heart${alive ? '' : ' lost'}${lost && i === lives ? ' just-lost' : ''}`, 'aria-hidden': 'true' }, alive ? '♥' : '♡'));
    }
  }

  function drawTrack(results) {
    [...track.children].forEach((li, i) => {
      li.className = i === current && !over ? 'now' : results && results[i] != null ? (results[i] ? 'won' : 'lost') : '';
    });
  }
  const stepResults = [];

  async function showStep(i) {
    const my = ++subToken;
    if (sub) { try { sub.dispose(); } catch { /* ignore */ } sub = null; }
    current = i;
    stepHost.innerHTML = '';
    after.innerHTML = '';
    drawTrack(stepResults);
    const step = steps[i];
    stepInfo.textContent = `Schritt ${i + 1} von ${steps.length}`;
    ctx.onReady(false);
    if (!step) return;
    stepHost.append(
      h('h3.boss-step-title', step.title || `Schritt ${i + 1}`),
      step.prompt ? md(step.prompt, 'md prose') : null);
    const body = h('div.boss-step-body');
    stepHost.appendChild(body);
    try {
      const mod = await import(`./${step.type}.js`);
      if (my !== subToken) return;
      sub = mod.render(body, step, { ...ctx, onReady: (b) => { if (my === subToken && !over) ctx.onReady(b); } });
    } catch (err) {
      console.error(err);
      body.appendChild(errorBlock(new Error(`Schritt-Typ „${step.type}“ kann nicht angezeigt werden.`)));
    }
    const first = stepHost.querySelector('input, button, textarea, select');
    if (first && i > 0) first.focus({ preventScroll: false });
  }

  drawHearts(false);
  showStep(0);

  return {
    getAnswer() {
      if (!sub || over) return null;
      const a = sub.getAnswer();
      return a == null ? null : { step: current, answer: a };
    },
    showResult(result) {
      const d = result.details || {};
      const stepIdx = typeof d.step === 'number' ? d.step : current;
      const ok = !!d.step_correct;
      stepResults[stepIdx] = ok;
      const prevLives = lives;
      if (typeof d.lives_left === 'number') lives = d.lives_left;
      else if (!ok) lives = Math.max(0, lives - 1);
      drawHearts(lives < prevLives);
      if (lives < prevLives) shake(hearts);

      const step = steps[stepIdx] || {};
      if (sub) {
        try {
          sub.showResult({
            correct: ok,
            score: ok ? 1 : 0,
            xp_awarded: 0,
            feedback: '',
            explanation: step.explanation || '',
            details: d.step_details || {},
          });
        } catch (err) { console.error(err); }
      }
      if (step.explanation) after.appendChild(h('div.why-box', h('h3', ok ? 'Treffer' : 'Daneben'), md(step.explanation, 'md prose')));

      const nextIdx = stepIdx + 1;
      over = !!d.finished || lives <= 0 || nextIdx >= steps.length;
      drawTrack(stepResults);
      if (over) {
        ctx.onReady(false);
        const won = lives > 0 && stepResults.filter(Boolean).length === steps.length;
        const solved = stepResults.filter(Boolean).length;
        after.appendChild(h('div', { class: `boss-final ${won ? 'won' : lives <= 0 ? 'lost' : 'partial'}` },
          h('span.boss-final-icon', { 'aria-hidden': 'true' }, won ? '🏆' : lives <= 0 ? '💀' : '⚔️'),
          h('div',
            h('strong', won ? 'Boss besiegt!' : lives <= 0 ? 'Keine Leben mehr – der Boss hat gewonnen.' : 'Kampf beendet.'),
            h('p', `${solved} von ${steps.length} Schritten gelöst.`))));
      } else {
        const btn = h('button.btn.btn-primary', { type: 'button', onclick: () => showStep(nextIdx) }, `Weiter zu Schritt ${nextIdx + 1}`);
        after.appendChild(h('div.btn-row', btn));
        requestAnimationFrame(() => btn.focus());
      }
    },
    dispose() {
      subToken++;
      if (sub) { try { sub.dispose(); } catch { /* ignore */ } }
    },
  };
}
