#!/usr/bin/env node
/**
 * Repeatable browser QA for a disposable local database.
 * RAG_SMOKE_ALLOW_RESET=1 RAG_SMOKE_URL=http://127.0.0.1:8765 node scripts/browser_smoke.cjs
 * Uses installed Playwright and Chromium; never requires a cloud API key.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, request } = require('playwright');

const BASE = process.env.RAG_SMOKE_URL || 'http://127.0.0.1:8765';
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.RAG_SMOKE_ARTIFACTS || '/tmp/rag-browser-smoke';
const levels = fs.readdirSync(path.join(ROOT, 'app/content/levels'))
  .filter((name) => /^level_\d+\.json$/.test(name))
  .map((name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'app/content/levels', name), 'utf8')))
  .sort((a, b) => a.id - b.id);
const types = ['quiz', 'better', 'order', 'spot', 'tune', 'freshness', 'code', 'explain', 'boss'];
const seenTypes = new Set();
const errors = [];
const blockedExternal = new Set();
let browser;
let api;
let page;

function answerFor(task) {
  const s = task.solution || {};
  switch (task.type) {
    case 'quiz': return { selected: s.correct };
    case 'better': return { choice: s.correct, reason: s.why || 'Diese Pipeline nutzt belegte Quellen und prüft ihre Antwort.' };
    case 'freshness': return { choice: s.correct };
    case 'order': return { order: s.order };
    case 'spot': return { selected: s.hallucinated };
    case 'tune': return { params: s.example_params };
    case 'code': return { blanks: Object.fromEntries(Object.entries(s.blanks).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) };
    case 'explain': return { text: s.model_answer };
    default: throw new Error(`No solution adapter for ${task.type}`);
  }
}

async function json(url, opts) {
  const response = await api.fetch(url, opts);
  const text = await response.text();
  assert(response.ok(), `${opts?.method || 'GET'} ${url}: ${response.status()} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function route(hash, title) {
  await page.evaluate((target) => { window.location.hash = target; }, hash);
  const heading = page.locator('main h1').filter({ hasText: title });
  await heading.waitFor({ state: 'visible' });
  assert.equal(await heading.count(), 1, `One heading for ${hash}`);
  await page.waitForFunction(() => !document.querySelector('main .loading'));
}

async function fillTask(scope, task) {
  const answer = answerFor(task);
  seenTypes.add(task.type);
  switch (task.type) {
    case 'quiz':
      for (const value of answer.selected) await scope.locator(`label.choice:has(input[value=${JSON.stringify(value)}])`).click();
      break;
    case 'better':
      await scope.locator(`label.ab-card:has(input[value=${JSON.stringify(answer.choice)}])`).click();
      await scope.locator('textarea').fill('Belegte, aktuelle Quellen ermöglichen eine nachvollziehbare Antwort; die Pipeline prüft ihre Aussagen.');
      break;
    case 'freshness':
      await scope.locator(`label.choice:has(input[value=${JSON.stringify(answer.choice)}])`).click();
      break;
    case 'order':
      for (let position = 0; position < answer.order.length; position++) {
        const id = answer.order[position];
        for (let tries = 0; tries < answer.order.length; tries++) {
          const actual = await scope.locator('.order-item').evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
          const current = actual.indexOf(id);
          assert(current >= 0, `Order item ${id} exists`);
          if (current === position) break;
          await scope.locator(`.order-item[data-id=${JSON.stringify(id)}] .up`).click();
        }
      }
      assert.deepEqual(await scope.locator('.order-item').evaluateAll((nodes) => nodes.map((n) => n.dataset.id)), answer.order);
      break;
    case 'spot':
      for (const id of answer.selected) {
        const index = task.answer_sentences.findIndex((s) => s.id === id);
        assert(index >= 0, `Spot sentence ${id} exists`);
        await scope.locator('.spot-sent').nth(index).click();
      }
      break;
    case 'tune':
      for (let index = 0; index < task.params.length; index++) {
        const param = task.params[index];
        const value = answer.params[param.name] ?? param.default ?? param.min;
        await scope.locator('input[type=range]').nth(index).fill(String(value));
      }
      break;
    case 'code':
      for (const [id, value] of Object.entries(answer.blanks)) {
        await scope.locator(`input.code-blank[id$=${JSON.stringify('-' + id)}]`).fill(value);
      }
      break;
    case 'explain': await scope.locator('textarea.explain-text').fill(answer.text); break;
  }
}

async function submitInBrowser(level, task) {
  const responsePromise = page.waitForResponse((r) => r.url().endsWith(`/api/levels/${level.id}/tasks/${task.id}/submit`) && r.request().method() === 'POST');
  const button = page.getByRole('button', { name: 'Prüfen', exact: true });
  await button.waitFor({ state: 'visible' });
  assert(await button.isEnabled(), `${task.id} submit enabled`);
  await button.click();
  const response = await responsePromise;
  const result = await response.json();
  assert(response.ok(), `${task.id}: ${JSON.stringify(result)}`);
  await page.locator('.result-panel:not([hidden])').waitFor({ state: 'visible' });
  return result;
}

async function clickSubmit(level, task, expectedStep) {
  const result = await submitInBrowser(level, task);
  if (expectedStep == null) assert.equal(result.score, 1, `${task.id} browser solution earns full score: ${JSON.stringify(result.details)}`);
  else {
    assert.equal(result.details.step, expectedStep);
    assert.equal(result.details.step_correct, true, `${task.id}/${expectedStep}: ${JSON.stringify(result.details)}`);
  }
  return result;
}

async function solveInBrowser(level, task) {
  await route(`#/level/${level.id}/task/${task.id}`, task.title);
  if (task.type === 'boss') {
    seenTypes.add('boss');
    for (let index = 0; index < task.steps.length; index++) {
      const step = task.steps[index];
      const host = page.locator('.boss-step-body');
      await page.locator('.boss-step-title').filter({ hasText: step.title }).waitFor();
      await fillTask(host, step);
      const result = await clickSubmit(level, task, index);
      if (index === task.steps.length - 1) {
        assert.equal(result.score, 1, 'Boss full score');
        assert.equal(result.details.finished, true, 'Boss finishes');
        await page.locator('.boss-final.won').waitFor({ state: 'visible' });
      } else await page.getByRole('button', { name: `Weiter zu Schritt ${index + 2}`, exact: true }).click();
    }
  } else {
    await fillTask(page.locator('.task-stage'), task);
    await clickSubmit(level, task);
    if (task.type === 'better' && task.run) {
      await page.locator('.ab-compare').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.ab-compare .run-summary').count(), 2, 'Both live A/B pipeline summaries render');
    }
  }
  // Null optional children must never leak into the interface as literal text nodes.
  const literalNulls = await page.locator('main').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode()) if (walker.currentNode.textContent.trim() === 'null') count++;
    return count;
  });
  assert.equal(literalNulls, 0, `${task.id} renders no literal null nodes`);
}

async function unlockCourse() {
  let expectedXp = levels[0].tasks.reduce((total, task) => total + task.xp, 0);
  for (const level of levels) {
    const publicLevel = await json(`/api/levels/${level.id}`);
    assert(!JSON.stringify(publicLevel).includes('"solution"'), `Level ${level.id} hides nested solutions`);
    for (const task of level.tasks) {
      if (task.type === 'boss') {
        const restarted = await api.post(`/api/levels/${level.id}/tasks/${task.id}/restart`, { data: {} });
        // Older app builds may not have restart yet, but current implementation should.
        assert(restarted.ok(), `Boss ${task.id} explicit restart endpoint`);
        for (let step = 0; step < task.steps.length; step++) {
          const result = await json(`/api/levels/${level.id}/tasks/${task.id}/submit`, {
            method: 'POST', data: { answer: { step, answer: answerFor(task.steps[step]) } },
          });
          assert.equal(result.details.step_correct, true, `${task.id} API step ${step}`);
          if (step === task.steps.length - 1) assert.equal(result.score, 1, `${task.id} API full score`);
        }
      } else {
        const result = await json(`/api/levels/${level.id}/tasks/${task.id}/submit`, { method: 'POST', data: { answer: answerFor(task) } });
        assert.equal(result.score, 1, `${task.id} API full score`);
      }
    }
    if (level.id > 1) expectedXp += level.tasks.reduce((total, task) => total + task.xp, 0);
    const progress = await json('/api/progress');
    assert.equal(progress.levels[level.id].stars, 3, `Level ${level.id} has three stars`);
    assert.equal(progress.player.xp, expectedXp, 'XP awarded once per task');
    if (level.id < levels.length) assert.equal(progress.levels[level.id + 1].unlocked, true, `Level ${level.id + 1} unlocked`);
  }
}

async function checkRetryFlows() {
  const boss = levels.flatMap((level) => level.tasks.filter((task) => task.type === 'boss' && task.steps[0].type === 'quiz').map((task) => ({ level, task })))[0];
  assert(boss, 'Boss begins with a quiz for life-loss test');
  await route(`#/level/${boss.level.id}/task/${boss.task.id}`, boss.task.title);
  const first = boss.task.steps[0];
  const wrong = first.options.find((option) => !first.solution.correct.includes(option.id));
  assert(wrong, 'Wrong boss choice available');
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('.boss-step-title').filter({ hasText: first.title }).waitFor();
    await page.locator(`.boss-step-body label.choice:has(input[value=${JSON.stringify(wrong.id)}])`).click();
    const result = await submitInBrowser(boss.level, boss.task);
    assert.equal(result.details.step, 0, 'Failed boss step does not advance');
    assert.equal(result.details.step_correct, false);
    assert.equal(result.details.lives_left, 2 - attempt, 'Exactly one life lost per wrong submission');
    if (attempt < 2) await page.getByRole('button', { name: 'Schritt 1 erneut versuchen', exact: true }).click();
    else {
      assert.equal(result.details.finished, true, 'Three failures finish attempt');
      await page.locator('.boss-final.lost').waitFor();
    }
  }
  await page.getByRole('button', { name: 'Nochmal versuchen', exact: true }).click();
  await page.locator('.hearts[aria-label="3 von 3 Leben"]').waitFor();
  await page.locator('.boss-step-body label.choice').first().waitFor();
  await fillTask(page.locator('.boss-step-body'), first);
  const corrected = await clickSubmit(boss.level, boss.task, 0);
  assert.equal(corrected.details.lives_left, 3, 'Restart restores all lives');

  // Find an actual failing parameter configuration through the real pipeline API,
  // then submit those values through sliders and recover without reloading.
  let tuneCase;
  for (const level of levels) {
    for (const task of level.tasks.filter((task) => task.type === 'tune')) {
      const params = Object.fromEntries(task.params.map((param) => [param.name, param.min]));
      const result = await json(`/api/levels/${level.id}/tasks/${task.id}/submit`, { method: 'POST', data: { answer: { params } } });
      if (!result.correct) { tuneCase = { level, task, params }; break; }
    }
    if (tuneCase) break;
  }
  assert(tuneCase, 'At least one tune task has a nontrivial target');
  await route(`#/level/${tuneCase.level.id}/task/${tuneCase.task.id}`, tuneCase.task.title);
  for (let index = 0; index < tuneCase.task.params.length; index++) {
    await page.locator('.task-stage input[type=range]').nth(index).fill(String(tuneCase.params[tuneCase.task.params[index].name]));
  }
  const missed = await submitInBrowser(tuneCase.level, tuneCase.task);
  assert.equal(missed.correct, false, 'Tuning initial parameters miss target');
  assert(await page.getByRole('button', { name: 'Prüfen', exact: true }).isEnabled(), 'Tuning can be submitted again');
  for (const input of await page.locator('.task-stage input[type=range]').all()) assert(await input.isEnabled(), 'Tuning sliders stay editable');
  await fillTask(page.locator('.task-stage'), tuneCase.task);
  await clickSubmit(tuneCase.level, tuneCase.task);
  console.log('PASS: boss three-life failure/restart and tune failure/recovery without reload');
}

async function checkMarkdown() {
  const result = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/static/js/ui.js');
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('<script>window.__rag_xss=1</script><img src=x onerror="window.__rag_xss=2"><a href="javascript:alert(1)" onclick="alert(1)">bad</a>\n\n**safe** \n\n```python\nprint("ok")\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    const state = {
      active: !!host.querySelector('script,img,[onerror],[onclick],a[href^="javascript:"]'),
      strong: host.querySelector('strong')?.textContent,
      code: host.querySelector('pre code')?.textContent,
      table: !!host.querySelector('table'),
      executed: window.__rag_xss || 0,
    };
    return state;
  });
  assert.equal(result.active, false, 'Markdown contains no active HTML');
  assert.equal(result.executed, 0, 'Markdown script never executes');
  assert.equal(result.strong, 'safe', 'Markdown strong preserved');
  assert(result.code.includes('print("ok")'), 'Markdown fenced code preserved');
  assert.equal(result.table, true, 'Markdown table preserved');
}

async function checkScenes() {
  const sceneNames = ['vectorspace', 'pipeline', 'agents', 'timeline', 'hallucination'];
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    for (const scene of sceneNames) {
      const result = await page.evaluate(async ({ name }) => {
        const { mountScene } = await import('/static/js/three/index.js');
        const host = document.createElement('div');
        Object.assign(host.style, { width: '640px', height: '400px', position: 'fixed', top: '0', left: '0', zIndex: 10000 });
        document.body.appendChild(host);
        const handle = await mountScene(name, host, null, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const canvas = host.querySelector('canvas');
        const state = { fallback: !!handle.fallback, canvas: !!canvas, width: canvas?.width || 0, height: canvas?.height || 0 };
        handle.play?.();
        if (name === 'agents') {
          handle.event?.({ type: 'step', agent: 'verifier', iteration: 1, status: 'fail', message: 'Test-Ablehnung', payload: {} });
          handle.event?.({ type: 'step', agent: 'orchestrator', iteration: 2, status: 'retry', message: 'Neuer Versuch', payload: {} });
        }
        handle.dispose();
        state.cleaned = host.querySelectorAll('canvas, .rag3d-label').length === 0;
        host.remove();
        return state;
      }, { name: scene });
      assert.equal(result.fallback, false, `${scene}: WebGL renders (${reducedMotion})`);
      assert.equal(result.canvas, true, `${scene}: canvas exists`);
      assert(result.width > 0 && result.height > 0, `${scene}: nonempty canvas`);
      assert.equal(result.cleaned, true, `${scene}: dispose removes canvas/labels`);
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function main() {
  assert.equal(process.env.RAG_SMOKE_ALLOW_RESET, '1', 'Run only with a disposable database; set RAG_SMOKE_ALLOW_RESET=1 to confirm');
  assert.equal(new URL(BASE).hostname, '127.0.0.1', 'This smoke runner resets progress and accepts localhost only');
  assert.equal(levels.length, 14, 'Fourteen local curriculum levels');
  fs.mkdirSync(OUT, { recursive: true });
  api = await request.newContext({ baseURL: BASE });
  const status = await json('/api/status');
  assert.equal(status.llm_enabled, false, 'Test server runs without Claude key');
  await json('/api/progress/reset', { method: 'POST' });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // External CDNs and LLM services are unavailable during every browser assertion.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(BASE).origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    blockedExternal.add(url.origin);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Deine Reise durch RAG' }).waitFor();
  await page.getByText('Offline-Modus', { exact: true }).waitFor();
  assert.equal(await page.locator('.map-node').count(), 14);
  assert.equal(await page.locator('.map-node:not(.locked)').count(), 1);
  const mapPositions = await page.locator('.map-node').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  assert.equal(new Set(mapPositions).size, 14, 'Map nodes occupy fourteen distinct vertical positions');
  assert(mapPositions.every((value, index) => index === 0 || value - mapPositions[index - 1] >= 80), 'Map nodes never overlap');
  await page.screenshot({ path: path.join(OUT, 'map-desktop.png'), fullPage: true });

  // A complete first level is played through the actual UI; no score is seeded.
  for (const task of levels[0].tasks) await solveInBrowser(levels[0], task);
  const firstProgress = await json('/api/progress');
  assert.equal(firstProgress.levels['1'].stars, 3);
  assert.equal(firstProgress.levels['2'].unlocked, true);
  assert.equal(firstProgress.player.xp, levels[0].tasks.reduce((sum, task) => sum + task.xp, 0));
  console.log('PASS: Level 1 completed through browser, XP/stars/unlock verified');

  await unlockCourse();
  for (const level of levels) {
    await route(`#/level/${level.id}`, level.title);
    assert.equal(await page.locator('.task-list .task-link').count(), level.tasks.length, `Level ${level.id} all tasks visible`);
    for (const scene of await page.locator('.theory .scene-panel').all()) {
      await scene.scrollIntoViewIfNeeded();
      await scene.locator('canvas').waitFor({ state: 'visible' });
    }
    console.log(`PASS: level ${level.id} page/tasks/theory scenes`);
  }
  console.log('PASS: all 14 level pages and their theory visualizations');

  for (const type of types) {
    if (seenTypes.has(type)) continue;
    const candidates = levels.flatMap((level) => level.tasks.filter((task) => task.type === type).map((task) => ({ level, task })));
    assert(candidates.length > 0, `Public task type ${type} exists`);
    await solveInBrowser(candidates[0].level, candidates[0].task);
  }
  assert.deepEqual([...seenTypes].sort(), [...types].sort(), 'All nine task modules exercised');
  console.log('PASS: quiz, better/live A-B, order, spot, tune, freshness, code, explain, boss');

  await route('#/playground', 'RAG-Labor');
  await page.getByRole('button', { name: 'Pipeline ausführen', exact: true }).click();
  await page.getByRole('heading', { name: 'Metriken', exact: true }).waitFor();
  for (const name of ['Vektorraum', 'Pipeline', 'Grounding']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.locator('#pg-scene-panel canvas').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pg-scene-panel .rag3d-fallback').count(), 0);
  }
  await page.screenshot({ path: path.join(OUT, 'labor-desktop.png'), fullPage: true });

  await route('#/agents', 'Agenten-Arena');
  await page.locator('#ag-fail').check({ force: true });
  await page.getByRole('button', { name: 'Agenten starten', exact: true }).click();
  await page.locator('.agent-result h2').waitFor({ state: 'visible', timeout: 30000 });
  assert(await page.locator('.agent-log .status-fail').count() > 0, 'Verifier rejection visible');
  assert(await page.locator('.agent-log .status-retry').count() > 0, 'Retry loop visible');
  assert(await page.locator('.agent-result').innerText().then((text) => /[23] Runden/.test(text)), 'Retry completes within three rounds');
  assert.equal(await page.locator('.agents-scene .rag3d-fallback').count(), 0);
  await page.screenshot({ path: path.join(OUT, 'agents-desktop.png'), fullPage: true });
  console.log('PASS: lab renders three live data scenes, SSE forces verifier failure/retry');

  await checkRetryFlows();
  await checkMarkdown();
  await checkScenes();
  await page.setViewportSize({ width: 390, height: 844 });
  await route('#/', 'Deine Reise durch RAG');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile map has no horizontal overflow');
  await page.screenshot({ path: path.join(OUT, 'map-mobile.png'), fullPage: true });
  await route('#/level/1', levels[0].title);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile level has no horizontal overflow');
  await page.screenshot({ path: path.join(OUT, 'level-mobile.png'), fullPage: true });

  assert.equal(blockedExternal.size, 0, `Offline app never attempts external resources: ${[...blockedExternal].join(', ')}`);
  assert.deepEqual(errors, [], `No browser errors: ${errors.join('\n')}`);
  const finalProgress = await json('/api/progress');
  assert(finalProgress.player.badges.some((badge) => badge.id === 'graduate'), 'Graduation badge awarded');
  const summary = {
    passed: true, levels: levels.length, taskTypes: [...seenTypes].sort(),
    scenes: ['vectorspace', 'pipeline', 'agents', 'timeline', 'hallucination'],
    modes: ['offline', 'reduced-motion', 'desktop', 'mobile'], browserErrors: errors,
    xp: finalProgress.player.xp, badges: finalProgress.player.badges.map((badge) => badge.id),
    screenshots: OUT,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(async (error) => {
  if (page) {
    try { await page.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true }); } catch {}
  }
  console.error(error.stack || error);
  if (errors.length) console.error('Browser errors:', JSON.stringify(errors, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
  await api?.dispose();
});
