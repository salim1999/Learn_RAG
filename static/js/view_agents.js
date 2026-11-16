// RAG Academy – Agenten-Arena (#/agents): Live-Stream der Agenten, Szene + Log, Antwort + Quellen

import { api } from './api.js';
import { h, clear, mountScene, toast, AGENT_INFO } from './ui.js';
import { state } from './state.js';
import { suggestionChips, DEFAULT_CONFIG } from './configform.js';
import { renderAnswer, renderChunks } from './ragview.js';

const STATUS_LABEL = { start: 'startet', done: 'fertig', fail: 'Fehlschlag', retry: 'neuer Versuch' };

export async function viewAgents(root, params, { alive }) {
  let stop = null;
  let scene = null;
  const llmOn = !!(state.status && state.status.llm_enabled);

  root.appendChild(h('header.page-head',
    h('h1.display', 'Agenten-Arena'),
    h('p.lead', 'Ein Team aus Planer, Retriever, Generator und Prüfer beantwortet deine Frage. Schlägt die Prüfung fehl, startet der Orchestrator eine neue Runde.')));

  const query = h('input.input', { type: 'text', id: 'ag-query', value: DEFAULT_CONFIG.query, autocomplete: 'off' });
  const maxIt = h('input.input.input-num', { type: 'number', id: 'ag-max', min: '1', max: '6', value: '3' });
  const forceFail = h('input', { type: 'checkbox', id: 'ag-fail' });
  const useLlm = h('input', { type: 'checkbox', id: 'ag-llm', disabled: !llmOn });
  const startBtn = h('button.btn.btn-primary', { type: 'submit' }, 'Agenten starten');
  const stopBtn = h('button.btn.btn-ghost', { type: 'button', disabled: true }, 'Abbrechen');

  const form = h('form.agents-form', { 'aria-label': 'Agenten-Lauf' },
    h('div.field.grow', h('label', { for: 'ag-query' }, 'Frage'), query, suggestionChips((q) => { query.value = q; query.focus(); })),
    h('div.agents-opts',
      h('div.field', h('label', { for: 'ag-max' }, 'Max. Runden'), maxIt),
      h('div.field.check-field', h('label.switch', { for: 'ag-fail' }, forceFail, h('span.switch-track', { 'aria-hidden': 'true' }), h('span', 'Erste Prüfung scheitern lassen'))),
      h('div.field.check-field', h('label.switch', { for: 'ag-llm', title: llmOn ? '' : 'Claude ist nicht aktiv' }, useLlm, h('span.switch-track', { 'aria-hidden': 'true' }), h('span', llmOn ? 'Claude verwenden' : 'Claude verwenden (nicht verfügbar)')))),
    h('div.btn-row', startBtn, stopBtn));
  root.appendChild(form);

  const sceneHost = h('div.scene-panel.agents-scene', { role: 'region', 'aria-label': 'Agenten-Visualisierung' });
  const log = h('ol.agent-log', { 'aria-live': 'polite', 'aria-label': 'Live-Protokoll' });
  const logWrap = h('section.agent-log-wrap', h('h2', 'Live-Protokoll'), log);
  const resultBox = h('section.agent-result', { 'aria-live': 'polite' });
  root.append(h('div.arena', sceneHost, logWrap), resultBox);
  log.appendChild(h('li.log-empty.muted', 'Noch kein Lauf. Starte die Agenten, um ihre Schritte live zu verfolgen.'));

  function freshScene() {
    if (scene) scene.then((s) => s.dispose());
    clear(sceneHost);
    scene = mountScene('agents', sceneHost, null, { context: 'arena' });
    return scene;
  }
  freshScene();

  function addLog(evt) {
    const info = AGENT_INFO[evt.agent] || { icon: '•', label: evt.agent || 'System' };
    const li = h('li', { class: `log-item status-${evt.status || 'info'} agent-${evt.agent || 'x'}` },
      h('span.log-icon', { 'aria-hidden': 'true' }, info.icon),
      h('div.log-body',
        h('div.log-head',
          h('strong', info.label),
          evt.iteration ? h('span.log-iter', `Runde ${evt.iteration}`) : null,
          evt.status ? h('span.log-status', STATUS_LABEL[evt.status] || evt.status) : null),
        evt.message ? h('p', evt.message) : null));
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function finish() {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stop = null;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = query.value.trim();
    if (!q) { toast('Bitte eine Frage eingeben.', 'info'); query.focus(); return; }
    if (stop) stop();
    clear(log);
    clear(resultBox);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    // Szene nicht abwarten: Events werden in Reihenfolge nachgereicht, sobald sie bereit ist
    const sc = freshScene();
    stop = api.agentsStream({
      query: q,
      max_iterations: Math.max(1, Math.min(6, Number(maxIt.value) || 3)),
      force_fail_first: forceFail.checked,
      use_llm: useLlm.checked && llmOn,
    }, (evt) => {
      if (!alive()) return;
      if (evt.type !== 'error') sc.then((s) => s.event && s.event(evt));
      if (evt.type === 'step') addLog(evt);
      else if (evt.type === 'final') { showFinal(evt); finish(); }
      else if (evt.type === 'error') {
        log.appendChild(h('li.log-item.status-fail', h('span.log-icon', { 'aria-hidden': 'true' }, '⚠'), h('div.log-body', h('p', evt.message))));
        finish();
      }
    });
  });

  stopBtn.addEventListener('click', () => {
    if (stop) stop();
    log.appendChild(h('li.log-item.status-retry', h('span.log-icon', { 'aria-hidden': 'true' }, '⏹'), h('div.log-body', h('p', 'Lauf abgebrochen.'))));
    finish();
  });

  function showFinal(evt) {
    clear(resultBox);
    resultBox.append(
      h('div.agent-final-head',
        h('h2', evt.abstained ? 'Die Agenten enthalten sich' : 'Antwort der Agenten'),
        h('span.chip', `${evt.iterations || 1} Runde${(evt.iterations || 1) === 1 ? '' : 'n'}`)),
      renderAnswer(evt.answer || { text: '', abstained: evt.abstained }, evt.chunks, { idPrefix: 'ag' }),
      h('h3', 'Quellen'),
      renderChunks(evt.chunks || [], { idPrefix: 'ag' }));
  }

  return () => {
    if (stop) stop();
    if (scene) scene.then((s) => s.dispose());
  };
}
