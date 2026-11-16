// Aufgabentyp „tune“ – Pipeline-Parameter per Slider einstellen, bis die Ziel-Metrik erreicht ist

import { h, fmtNum, metricLabel, metricValue } from '../ui.js';
import { renderTrace, renderMetrics, renderChunks } from '../ragview.js';

let uid = 0;

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function decimals(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

export function render(container, task, ctx) {
  const id = `tune-${++uid}`;
  const params = task.params || [];
  const values = {};
  const inputs = [];
  let scene = null;
  const target = task.target || {};

  container.appendChild(h('div.tune-head',
    task.query ? h('p.tune-query', h('span.muted', 'Testfrage: '), h('strong', `„${task.query}“`)) : null,
    target.metric
      ? h('p.tune-target', h('span.target-icon', { 'aria-hidden': 'true' }, '🎯'),
        ' Ziel: ', h('strong', target.label || metricLabel(target.metric)), ` ≥ ${metricValue(target.metric, target.threshold)}`)
      : null));

  const form = h('div.sliders');
  params.forEach((p, i) => {
    const base = getPath(task.base_config || {}, p.name);
    const start = p.default ?? base ?? p.min;
    values[p.name] = Number(start);
    const dec = decimals(p.step ?? 1);
    const out = h('output.slider-value', { for: `${id}-${i}` }, fmtNum(values[p.name], dec));
    const input = h('input.slider', {
      type: 'range', id: `${id}-${i}`, min: String(p.min), max: String(p.max), step: String(p.step ?? 1), value: String(start),
      'aria-describedby': `${id}-${i}-range`,
    });
    const fill = () => input.style.setProperty('--fill', `${((Number(input.value) - p.min) / ((p.max - p.min) || 1)) * 100}%`);
    input.addEventListener('input', () => {
      values[p.name] = Number(input.value);
      out.textContent = fmtNum(values[p.name], dec);
      input.setAttribute('aria-valuetext', fmtNum(values[p.name], dec));
      fill();
    });
    fill();
    inputs.push(input);
    form.appendChild(h('div.slider-field',
      h('div.slider-top', h('label', { for: input.id }, p.label || p.name), out),
      input,
      h('div.slider-range#' + `${id}-${i}-range`, h('span', `${fmtNum(p.min, dec)}`), h('code', p.name), h('span', `${fmtNum(p.max, dec)}`))));
  });
  container.appendChild(form);

  const resultBox = h('div.tune-result');
  container.appendChild(resultBox);
  ctx.onReady(params.length > 0);

  return {
    getAnswer() {
      return { params: { ...values } };
    },
    showResult(result) {
      inputs.forEach((i) => { i.disabled = true; });
      const d = result.details || {};
      const thr = Number(target.threshold) || 0;
      const v = Number(d.metric_value) || 0;
      const reached = v >= thr;
      const scaleMax = Math.max(1, v, thr);
      resultBox.innerHTML = '';
      resultBox.append(
        h('div', { class: `target-gauge ${reached ? 'is-reached' : 'is-missed'}` },
          h('div.gauge-row',
            h('span', target.label || metricLabel(target.metric)),
            h('strong', `${metricValue(target.metric, v)} `, h('span.muted', `/ Ziel ${metricValue(target.metric, thr)}`))),
          h('div.gauge', { role: 'img', 'aria-label': `Erreicht ${metricValue(target.metric, v)}, Ziel ${metricValue(target.metric, thr)}` },
            h('span.gauge-fill', { style: { width: `${(v / scaleMax) * 100}%` } }),
            h('span.gauge-mark', { style: { left: `${(thr / scaleMax) * 100}%` } }))),
        d.metrics ? renderMetrics(d.metrics) : null);
      const run = d.run;
      if (run) {
        resultBox.append(
          h('h3', 'Mini-Trace deines Laufs'),
          renderTrace(run.trace, { compact: true }),
          h('details.tune-chunks', h('summary', `Abgerufene Chunks (${(run.chunks || []).length})`), renderChunks(run.chunks, { compact: true })));
        const host = h('div.scene-panel.scene-panel-sm', { role: 'region', 'aria-label': 'Pipeline-Visualisierung' });
        resultBox.appendChild(host);
        scene = ctx.mountScene('pipeline', host, run, { context: 'tune' });
        scene.then((s) => s.play && s.play());
      }
    },
    dispose() { if (scene) scene.then((s) => s.dispose()); },
  };
}
