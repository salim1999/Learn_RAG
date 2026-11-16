// RAG Academy – Einstiegspunkt: Markdown, HUD, Router

import { initMarkdown, toast } from './ui.js';
import { loadStatus, loadProgress } from './state.js';
import { initHud } from './hud.js';
import { createRouter } from './router.js';
import { viewMap } from './view_map.js';
import { viewLevel } from './view_level.js';
import { viewTask } from './view_task.js';
import { viewPlayground } from './view_playground.js';
import { viewAgents } from './view_agents.js';
import { viewCorpus } from './view_corpus.js';

const routes = [
  { name: 'map', nav: 'map', pattern: /^\/?$/, view: viewMap, title: 'Sternenkarte' },
  { name: 'task', nav: 'map', pattern: /^\/level\/(?<id>\d+)\/task\/(?<taskId>[\w-]+)\/?$/, view: viewTask, title: 'Aufgabe' },
  { name: 'level', nav: 'map', pattern: /^\/level\/(?<id>\d+)\/?$/, view: viewLevel, title: 'Level' },
  { name: 'playground', nav: 'playground', pattern: /^\/playground\/?$/, view: viewPlayground, title: 'RAG-Labor' },
  { name: 'agents', nav: 'agents', pattern: /^\/agents\/?$/, view: viewAgents, title: 'Agenten-Arena' },
  { name: 'corpus', nav: 'corpus', pattern: /^\/corpus\/?$/, view: viewCorpus, title: 'Wissensbasis' },
];

async function boot() {
  const main = document.getElementById('main');
  initHud(document.getElementById('hud'));
  const skip = document.querySelector('.skip-link');
  if (skip) skip.addEventListener('click', (e) => { e.preventDefault(); main.focus(); });

  await Promise.all([initMarkdown(), loadStatus(), loadProgress()]);

  let first = true;
  const router = createRouter(main, routes, {
    onNavigate({ route }) {
      document.title = `${route.title} – RAG Academy`;
      for (const a of document.querySelectorAll('.mainnav a')) {
        if (a.dataset.nav === route.nav) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      window.scrollTo({ top: 0 });
      if (!first) main.focus({ preventScroll: true });
      first = false;
    },
  });
  await router.start();

  // Status gelegentlich auffrischen (z.B. wenn der Server später startet)
  setInterval(() => { if (document.visibilityState === 'visible') loadStatus(); }, 60000);
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(e.reason && e.reason.message ? e.reason.message : 'Unerwarteter Fehler', 'error');
});

boot();
