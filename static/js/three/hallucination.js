// Halluzinationen: Antwort-Sätze als Blöcke, Quellen-Chunks als Säulen.
// Belegte Sätze hängen an grünen Fäden zu ihren Quellen, unbelegte flackern rot und zerfallen.
// data = {sentences:[{text,supported,citations}], chunks:[{id,title}]}
//      | spot-Task {context:[{id,text}], answer_sentences:[{id,text}], hallucinated?:[ids]}
//      | RUN_RESPONSE (answer.sentences + chunks) | null (Demo)
import * as THREE from 'three';
import {
  createStage, COLORS, Ease, createLabel, createGlowSprite, disposeObject, shared, docColor,
  makeTube, setTubeProgress, addLegend, truncate, smoothstep,
} from './scene.js';

const DEMO = {
  chunks: [
    { id: 'd10#0', title: 'Preisliste 2025', text: 'Der Pro-Plan kostet 29 € pro Monat und enthält alle Basisfunktionen.' },
    { id: 'd07#1', title: 'Limits & Kontingente', text: 'Im Pro-Plan stehen 500 GB Speicher und 10 Projekte zur Verfügung.' },
    { id: 'd09#0', title: 'Support-Richtlinie', text: 'Der Support antwortet per E-Mail innerhalb von 24 Stunden.' },
  ],
  sentences: [
    { text: 'Der Pro-Plan kostet 29 € pro Monat.', supported: true, citations: ['d10#0'] },
    { text: 'Er enthält 500 GB Speicher.', supported: true, citations: ['d07#1'] },
    { text: 'Studierende erhalten 50 % Rabatt.', supported: false, citations: [] },
    { text: 'Der Support antwortet innerhalb von 24 Stunden.', supported: true, citations: ['d09#0'] },
  ],
};

const tokens = (s) => new Set((String(s || '').toLowerCase().match(/[a-zäöüß0-9]+/g) || []).filter((w) => w.length >= 3 || /\d/.test(w)));

/** Wortüberlappung Satz ↔ Chunk für Daten ohne Zitate. */
function overlapCitations(text, chunks, max = 2) {
  const st = tokens(text);
  if (!st.size) return [];
  return chunks
    .map((c) => { const ct = tokens(c.text || c.title); let n = 0; for (const w of st) if (ct.has(w)) n++; return { id: c.id, s: n / st.size }; })
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.id);
}

export function normalize(d) {
  if (!d) d = DEMO;
  if (d.answer && Array.isArray(d.answer.sentences)) d = { sentences: d.answer.sentences, chunks: d.chunks || [] };
  let sentences = [], chunks = [];
  if (Array.isArray(d.answer_sentences)) {
    chunks = (d.context || []).map((c, i) => ({ id: String(c.id ?? `c${i + 1}`), title: c.title ?? '', text: c.text ?? '' }));
    const hall = d.hallucinated ?? d.solution?.hallucinated ?? d.details?.hallucinated ?? null;
    const set = Array.isArray(hall) ? new Set(hall.map(String)) : null;
    sentences = d.answer_sentences.map((s, i) => {
      const id = String(s.id ?? `s${i + 1}`);
      const supported = set ? !set.has(id) : null;
      return { id, text: s.text ?? '', supported, citations: supported === false ? [] : overlapCitations(s.text, chunks) };
    });
  } else {
    chunks = (Array.isArray(d.chunks) ? d.chunks : []).map((c, i) => ({ id: String(c.id ?? `c${i + 1}`), title: c.title ?? '', text: c.text ?? '' }));
    sentences = (Array.isArray(d.sentences) ? d.sentences : []).map((s, i) => {
      const cits = Array.isArray(s.citations) ? s.citations.map(String) : [];
      const supported = s.supported ?? (cits.length ? true : null);
      return { id: String(s.id ?? `s${i + 1}`), text: s.text ?? '', supported, citations: cits.length ? cits : supported ? overlapCitations(s.text, chunks) : [], grounding: s.grounding };
    });
    const known = new Set(chunks.map((c) => c.id));
    for (const s of sentences) for (const c of s.citations) if (!known.has(c)) { known.add(c); chunks.push({ id: c, title: '', text: '' }); }
  }
  return { sentences: sentences.slice(0, 10), chunks: chunks.slice(0, 12) };
}

export function mount(container, data = null, opts = {}) {
  const stage = createStage(container, {
    cameraPosition: [0, 0.2, 8], target: [0, -0.25, 0], autoRotate: false,
    azimuthRange: 0.65, minPolar: 0.9, maxPolar: 2.0, ...(opts.stage || {}),
  });
  const { scene } = stage;
  const glowTex = stage.glowTexture();
  const pillarGeo = stage.track(shared(new THREE.CylinderGeometry(0.17, 0.17, 1, 20)));

  addLegend(stage, [
    { color: COLORS.ok, label: 'belegt (Faden zur Quelle)', shape: 'square' },
    { color: COLORS.error, label: 'unbelegt → Halluzination', shape: 'square' },
    { color: COLORS.accent, label: 'Quell-Chunk' },
  ]);

  let world = null;
  let blocks = [];
  let pillars = new Map();
  let threads = [];
  let gen = 0;
  let fitW = 8, sGapCur = 1.5, cGapCur = 1;
  const FIT_H = 4.8;
  /** Pixel pro Welteinheit (ungefähr, auf Höhe der Inhalte) → Label-Breiten anpassen. */
  function relayoutLabels() {
    const { width: w, height: h } = stage.size;
    const ppu = Math.min(w / (fitW * 1.08), h / (FIT_H * 1.08));
    for (const b of blocks) b.text.element.style.maxWidth = Math.max(70, sGapCur * ppu * 0.94) + 'px';
    for (const p of pillars.values()) p.label.element.style.maxWidth = Math.max(60, cGapCur * ppu * 0.94) + 'px';
  }
  stage.onResize(relayoutLabels);

  const Y_S = 1.15, Y_C = -0.95, PILLAR_H = 0.9;

  function build(raw) {
    const myGen = ++gen;
    if (world) disposeObject(world);
    world = new THREE.Group();
    scene.add(world);
    blocks = []; pillars = new Map(); threads = [];
    const { sentences, chunks } = normalize(raw);
    const nS = Math.max(1, sentences.length), nC = Math.max(1, chunks.length);
    const sGap = Math.min(1.75, Math.max(1.05, 9 / nS));
    const bw = sGap * 0.82;
    const cGap = Math.min(1.6, Math.max(0.75, 9 / nC));
    const width = Math.max(sGap * nS, cGap * nC);
    sGapCur = sGap; cGapCur = cGap;
    fitW = width + 0.6;
    stage.fit(fitW, FIT_H);
    const blockGeo = new THREE.BoxGeometry(bw, 0.4, 0.16);

    // Säulen
    chunks.forEach((c, i) => {
      const x = (i - (nC - 1) / 2) * cGap;
      const col = docColor(c.id.split('#')[0]);
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.85 });
      const mesh = new THREE.Mesh(pillarGeo, mat);
      mesh.scale.set(1, PILLAR_H, 1);
      mesh.position.set(x, Y_C - PILLAR_H / 2, -0.3);
      mesh.userData.chunkId = c.id;
      const cap = createGlowSprite(glowTex, col, 0.7, 0.35);
      cap.position.set(x, Y_C + 0.02, -0.3);
      const label = createLabel(`${c.id}${c.title ? ' · ' + truncate(c.title, 24) : ''}`, { anchor: 'top', size: 11, maxWidth: Math.max(90, cGap * 80) });
      label.position.set(x, Y_C - PILLAR_H - 0.08, -0.3);
      world.add(mesh, cap, label);
      pillars.set(c.id, { c, mesh, mat, cap, label, top: new THREE.Vector3(x, Y_C + 0.02, -0.3), lit: 0, baseEI: 0.25 });
    });

    // Satz-Blöcke
    sentences.forEach((s, i) => {
      const x = (i - (nS - 1) / 2) * sGap;
      const state = s.supported === true ? 'ok' : s.supported === false ? 'bad' : 'unknown';
      const color = state === 'ok' ? COLORS.ok : state === 'bad' ? COLORS.error : COLORS.accent;
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(blockGeo, mat);
      const home = new THREE.Vector3(x, Y_S, 0);
      mesh.position.copy(home);
      mesh.userData.sentenceIdx = i;
      const tag = createLabel(`S${i + 1} ${state === 'ok' ? '✓' : state === 'bad' ? '✗' : '?'}`, { size: 12, bg: null, color: '#0d0e1c', weight: 800 });
      mesh.add(tag);
      const text = createLabel(truncate(s.text, 70), { anchor: 'bottom', size: 11, weight: 500, maxWidth: Math.max(100, sGap * 78), color: state === 'bad' ? '#ffc2cd' : COLORS.text, border: `1px solid ${color}66` });
      text.position.set(x, Y_S + 0.32 + (nS > 4 && i % 2 ? 0.42 : 0), 0);
      world.add(mesh, text);
      const glow = createGlowSprite(glowTex, color, bw * 1.5, 0.18);
      glow.position.set(x, Y_S, -0.15);
      world.add(glow);
      const b = { s, i, state, mesh, mat, glow, home, text, tag, phase: Math.random() * 10, decay: 0, ps: null };
      if (state === 'bad') b.ps = makeDust(b, bw);
      blocks.push(b);

      // Fäden
      s.citations.forEach((cid, j) => {
        const p = pillars.get(cid);
        if (!p) return;
        const a = new THREE.Vector3(x, Y_S - 0.2, 0);
        const bpt = p.top.clone();
        const curve = new THREE.CubicBezierCurve3(a, a.clone().add(new THREE.Vector3(0, -0.7, 0.35)), bpt.clone().add(new THREE.Vector3(0, 0.75, 0.35)), bpt);
        const okThread = state === 'ok';
        const tmat = new THREE.MeshBasicMaterial({ color: okThread ? COLORS.ok : COLORS.accent, transparent: true, opacity: okThread ? 0.9 : 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
        const tube = makeTube(curve, okThread ? 0.016 : 0.008, tmat, 40, 5);
        setTubeProgress(tube, 0);
        const dot = createGlowSprite(glowTex, okThread ? COLORS.ok : COLORS.accent, 0.28, 0);
        world.add(tube, dot);
        const th = { tube, tmat, dot, curve, base: tmat.opacity, ready: false, phase: Math.random(), pillar: p, ok: okThread };
        threads.push(th);
        stage.tween({
          delay: 0.3 + i * 0.25 + j * 0.1, duration: stage.reducedMotion ? 0.2 : 0.9, ease: Ease.inOutCubic,
          onUpdate: (k) => { if (myGen === gen) setTubeProgress(tube, k); },
          onComplete: () => { if (myGen !== gen) return; th.ready = true; p.lit = 1; },
        });
      });
    });
    relayoutLabels();
  }

  // ---- Zerfalls-Partikel
  function makeDust(b, bw) {
    const M = stage.reducedMotion ? 16 : 70;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(M * 3), col = new Float32Array(M * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.09, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.frustumCulled = false;
    world.add(pts);
    const life = new Float32Array(M).fill(-1), vel = new Float32Array(M * 3);
    return { pts, geo, pos, col, life, vel, M, bw, acc: 0, color: new THREE.Color(COLORS.error) };
  }

  function updateDust(b, dt, rate) {
    const d = b.ps; if (!d) return;
    d.acc += rate * dt;
    for (let i = 0; i < d.M; i++) {
      const i3 = i * 3;
      if (d.life[i] < 0) {
        if (d.acc >= 1) {
          d.acc -= 1;
          d.life[i] = 1;
          const s = b.mesh.scale.x;
          d.pos[i3] = b.mesh.position.x + (Math.random() - 0.5) * d.bw * s;
          d.pos[i3 + 1] = b.mesh.position.y + (Math.random() - 0.5) * 0.4 * s;
          d.pos[i3 + 2] = b.mesh.position.z + (Math.random() - 0.5) * 0.16;
          d.vel[i3] = (Math.random() - 0.5) * 0.5;
          d.vel[i3 + 1] = 0.15 + Math.random() * 0.5;
          d.vel[i3 + 2] = (Math.random() - 0.5) * 0.5;
        } else { d.col[i3] = d.col[i3 + 1] = d.col[i3 + 2] = 0; continue; }
      }
      d.life[i] -= dt / 1.6;
      d.vel[i3 + 1] -= dt * 0.25;
      d.pos[i3] += d.vel[i3] * dt; d.pos[i3 + 1] += d.vel[i3 + 1] * dt; d.pos[i3 + 2] += d.vel[i3 + 2] * dt;
      const a = Math.max(0, d.life[i]);
      d.col[i3] = d.color.r * a; d.col[i3 + 1] = d.color.g * a; d.col[i3 + 2] = d.color.b * a;
    }
    if (d.acc > 1) d.acc = 1;
    d.geo.attributes.position.needsUpdate = true;
    d.geo.attributes.color.needsUpdate = true;
  }

  // ---- Hover
  stage.setHover({
    targets: () => [...blocks.map((b) => b.mesh), ...[...pillars.values()].map((p) => p.mesh)],
    describe: (hit) => {
      const u = hit.object.userData;
      if (u.sentenceIdx != null) {
        const b = blocks[u.sentenceIdx];
        if (!b) return null;
        const lines = [b.s.text];
        if (b.state === 'ok') lines.push(`✓ belegt durch: ${b.s.citations.join(', ') || '–'}`);
        else if (b.state === 'bad') lines.push('✗ keine Quelle stützt diesen Satz – Halluzination');
        else lines.push('? noch nicht bewertet');
        if (b.s.grounding != null) lines.push(`Grounding: ${Number(b.s.grounding).toFixed(2)}`);
        return { key: 's' + b.i, title: `Satz S${b.i + 1}`, color: b.state === 'ok' ? COLORS.ok : b.state === 'bad' ? COLORS.error : COLORS.text, lines };
      }
      if (u.chunkId != null) {
        const p = pillars.get(u.chunkId);
        if (!p) return null;
        const lines = [];
        if (p.c.title) lines.push(p.c.title);
        if (p.c.text) lines.push(truncate(p.c.text, 180));
        const by = blocks.filter((b) => b.s.citations.includes(p.c.id)).map((b) => `S${b.i + 1}`);
        lines.push(by.length ? `zitiert von ${by.join(', ')}` : 'von keinem Satz zitiert');
        return { key: 'c' + p.c.id, title: `Quelle ${p.c.id}`, lines };
      }
      return null;
    },
  });

  // ---- Frame
  const PERIOD = 10;
  stage.onFrame((dt, t) => {
    const rm = stage.reducedMotion;
    for (const b of blocks) {
      if (b.state === 'bad') {
        // Zyklus: intakt → zerfällt → Rest → setzt sich neu zusammen
        const ph = ((t + b.phase) % PERIOD);
        const decay = rm ? 0.55 : smoothstep(1.5, 6.5, ph) * (1 - smoothstep(8.0, 9.6, ph));
        b.decay = decay;
        const flicker = rm ? 0.75 : 0.55 + 0.45 * Math.abs(Math.sin(t * 13 + b.phase) * Math.sin(t * 7.3 + b.phase * 2));
        b.mat.opacity = Math.max(0.1, (1 - decay * 0.85) * flicker);
        b.mat.emissiveIntensity = 0.3 + flicker * 0.6;
        const s = 1 - decay * 0.7;
        b.mesh.scale.set(s, s, s);
        b.mesh.position.y = b.home.y + (rm ? 0.1 : 0.1 + Math.sin(t * 1.3 + b.phase) * 0.08);
        b.mesh.rotation.z = rm ? 0 : Math.sin(t * 0.9 + b.phase) * 0.06;
        b.glow.material.opacity = 0.12 + flicker * 0.25 * (1 - decay * 0.6);
        b.glow.position.y = b.mesh.position.y;
        b.tag.setOpacity(1 - decay * 0.8);
        const emitting = !rm && ph > 1.5 && ph < 7.5;
        updateDust(b, dt, emitting ? 26 : 0);
      } else if (b.state === 'ok') {
        b.mesh.position.y = b.home.y;
        b.glow.material.opacity = 0.2 + (rm ? 0 : 0.08 * Math.sin(t * 2 + b.i));
      } else {
        b.mesh.position.y = b.home.y + (rm ? 0 : Math.sin(t * 1.1 + b.phase) * 0.03);
      }
    }
    for (const th of threads) {
      if (!th.ready) continue;
      th.tmat.opacity = th.base * (rm ? 1 : 0.75 + 0.25 * Math.sin(t * 3 + th.phase * 6));
      if (!rm) {
        const k = (t * 0.5 + th.phase) % 1;
        th.curve.getPoint(k, th.dot.position);
        th.dot.material.opacity = Math.sin(k * Math.PI) * (th.ok ? 1 : 0.5);
      }
    }
    for (const p of pillars.values()) {
      p.mat.emissiveIntensity = p.baseEI + p.lit * (0.35 + (rm ? 0 : 0.15 * Math.sin(t * 2.5)));
      p.cap.material.opacity = 0.25 + p.lit * 0.45;
    }
  });

  function update(newData) { build(newData); }
  update(data);

  return {
    update,
    dispose() { gen++; stage.dispose(); },
  };
}
