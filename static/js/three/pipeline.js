// RAG-Pipeline: Stationen von links nach rechts, Partikel fließen hindurch.
// data = RUN_RESPONSE oder null (Demo-Schleife). Extra: play().
import * as THREE from 'three';
import {
  createStage, COLORS, Ease, createLabel, createGlowSprite, shared, docColor, bump, smoothstep, disposeObject,
} from './scene.js';

const SPACING = 1.6;
const MAX_CHUNKS = 22;
const MAX_SENTENCES = 10;

export function mount(container, data = null, opts = {}) {
  const stage = createStage(container, {
    cameraPosition: [0, 2.0, 9], target: [0, 0.1, 0], autoRotate: false,
    azimuthRange: 0.7, minPolar: 0.6, maxPolar: 1.75, ...(opts.stage || {}),
  });
  const { scene } = stage;
  const glowTex = stage.glowTexture();

  let stations = [];     // {key, x, group, body, glow, mats, events:[], spin}
  let stationGroup = null;
  let particles = [];    // {keys:[{t,p,s,c,e}], cur...}
  let T = 10;
  let playStart = 0;
  let loop = true;
  let phases = [];
  let summaryText = '';
  let flags = {};
  let docBreakT = 0.6;

  // ---- Partikel-Rendering (ein InstancedMesh + Glow-Points)
  const MAXP = MAX_CHUNKS + MAX_SENTENCES + 2;
  const pGeo = stage.track(shared(new THREE.BoxGeometry(1, 1, 1)));
  const pMesh = new THREE.InstancedMesh(pGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXP);
  pMesh.count = 0;
  pMesh.frustumCulled = false;
  pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3).setUsage(THREE.DynamicDrawUsage));
  gGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const pGlow = new THREE.Points(gGeo, new THREE.PointsMaterial({
    size: 0.5, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  pGlow.frustumCulled = false;
  scene.add(pMesh, pGlow);

  const caption = createLabel('', { size: 13, color: '#ffffff', border: '1px solid rgba(124,92,255,0.7)' });
  const summary = createLabel('', { size: 12, opacity: 0 });
  scene.add(caption, summary);

  // ---- Stationen
  const std = (color, emissive = color, ei = 0.25, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: ei, roughness: 0.45, metalness: 0.15, ...extra });

  function makeStation(key, label, x) {
    const group = new THREE.Group();
    group.position.set(x, 0, 0);
    const body = new THREE.Group();
    group.add(body);
    const mats = [];
    const add = (geo, mat, setup) => { const m = new THREE.Mesh(geo, mat); setup?.(m); body.add(m); if (!mats.includes(mat)) mats.push(mat); return m; };
    let spin = null;
    let glowColor = COLORS.accent;
    switch (key) {
      case 'doc': {
        const paper = std('#e3e6ff', COLORS.accent, 0.12);
        add(new THREE.BoxGeometry(0.62, 0.82, 0.06), paper);
        const ink = std(COLORS.accent, COLORS.accent, 0.6);
        for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(i === 0 ? 0.3 : 0.44, 0.04, 0.02), ink, (m) => m.position.set(i === 0 ? -0.07 : 0, 0.27 - i * 0.12, 0.04));
        break;
      }
      case 'chunk': {
        const mat = std('#b7b2ff', COLORS.accent, 0.35, { flatShading: true });
        const saw = add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 12), mat, (m) => { m.rotation.z = Math.PI / 2; });
        add(new THREE.TorusGeometry(0.42, 0.035, 6, 12), std('#ffffff', COLORS.accent, 0.4), (m) => { m.rotation.y = Math.PI / 2; });
        spin = (dt) => { saw.rotation.x += dt * 2.0; };
        break;
      }
      case 'embed': {
        const ico = add(new THREE.IcosahedronGeometry(0.38, 0), std('#8f78ff', COLORS.accent, 0.35, { flatShading: true }));
        const wire = add(new THREE.IcosahedronGeometry(0.46, 1), new THREE.MeshBasicMaterial({ color: COLORS.accent, wireframe: true, transparent: true, opacity: 0.35 }));
        spin = (dt) => { ico.rotation.y += dt * 0.8; ico.rotation.x += dt * 0.3; wire.rotation.y -= dt * 0.4; };
        break;
      }
      case 'index': {
        const mat = std('#5b4bd6', COLORS.accent, 0.3);
        const rim = std('#c9c0ff', COLORS.accent, 0.5);
        for (let i = 0; i < 3; i++) {
          add(new THREE.CylinderGeometry(0.38, 0.38, 0.17, 24), mat, (m) => { m.position.y = -0.24 + i * 0.24; });
          add(new THREE.TorusGeometry(0.38, 0.015, 4, 32), rim, (m) => { m.rotation.x = Math.PI / 2; m.position.y = -0.155 + i * 0.24; });
        }
        break;
      }
      case 'retr': {
        glowColor = '#3fc7e8';
        add(new THREE.TorusGeometry(0.36, 0.07, 10, 32), std('#3fc7e8', '#3fc7e8', 0.4), (m) => { m.rotation.y = Math.PI / 2; });
        const inner = add(new THREE.TorusGeometry(0.22, 0.02, 6, 24), std('#ffffff', '#3fc7e8', 0.6), (m) => { m.rotation.y = Math.PI / 2; });
        spin = (dt) => { inner.rotation.x += dt * 1.5; };
        break;
      }
      case 'fresh': {
        glowColor = COLORS.stale;
        add(new THREE.TorusGeometry(0.44, 0.05, 6, 4), std(COLORS.stale, COLORS.stale, 0.35), (m) => { m.rotation.y = Math.PI / 2; m.rotation.x = Math.PI / 4; });
        add(new THREE.PlaneGeometry(0.6, 0.6, 6, 6), new THREE.MeshBasicMaterial({ color: COLORS.stale, wireframe: true, transparent: true, opacity: 0.45 }), (m) => { m.rotation.y = Math.PI / 2; });
        break;
      }
      case 'llm': {
        const core = add(new THREE.DodecahedronGeometry(0.42, 0), std('#7c5cff', '#7c5cff', 0.55, { flatShading: true }));
        const halo = add(new THREE.TorusGeometry(0.58, 0.012, 4, 48), new THREE.MeshBasicMaterial({ color: '#b9a8ff', transparent: true, opacity: 0.6 }), (m) => { m.rotation.x = Math.PI / 2.4; });
        spin = (dt) => { core.rotation.y += dt * 0.5; core.rotation.z += dt * 0.2; halo.rotation.z += dt * 0.6; };
        break;
      }
      case 'verify': {
        const mat = std('#c6ccff', COLORS.accent, 0.3);
        add(new THREE.BoxGeometry(0.1, 0.95, 0.1), mat, (m) => m.position.set(0, 0, 0.34));
        add(new THREE.BoxGeometry(0.1, 0.95, 0.1), mat, (m) => m.position.set(0, 0, -0.34));
        add(new THREE.BoxGeometry(0.12, 0.1, 0.8), mat, (m) => m.position.set(0, 0.5, 0));
        add(new THREE.PlaneGeometry(0.58, 0.85), new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }), (m) => { m.rotation.y = Math.PI / 2; });
        break;
      }
      case 'answer': {
        glowColor = COLORS.ok;
        const mat = std('#d8fff2', COLORS.ok, 0.25);
        add(new THREE.BoxGeometry(0.72, 0.5, 0.12), mat, (m) => { m.position.y = 0.08; });
        add(new THREE.ConeGeometry(0.1, 0.22, 4), mat, (m) => { m.position.set(-0.18, -0.24, 0); m.rotation.z = Math.PI * 0.85; });
        break;
      }
      default: break;
    }
    const glow = createGlowSprite(glowTex, glowColor, 1.7, 0.08);
    glow.position.z = -0.25;
    group.add(glow);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.04, 32), new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.18, depthWrite: false }));
    base.position.y = -0.62;
    group.add(base);
    const lab = createLabel(label, { anchor: 'top', size: 12 });
    lab.position.set(0, -0.72, 0);
    group.add(lab);
    return { key, label, x, group, body, glow, glowBase: new THREE.Color(glowColor), mats, baseEI: mats.map((m) => m.emissiveIntensity ?? 0), events: [], spin, labelObj: lab };
  }

  function buildStations(keys) {
    if (stationGroup) disposeObject(stationGroup);
    stationGroup = new THREE.Group();
    const names = {
      doc: 'Dokument', chunk: 'Chunking', embed: 'Embedding', index: 'Vektor-Index', retr: 'Retrieval',
      fresh: 'Freshness-Filter', llm: 'LLM', verify: 'Verifier', answer: 'Antwort',
    };
    const x0 = -((keys.length - 1) * SPACING) / 2;
    stations = keys.map((k, i) => makeStation(k, names[k], x0 + i * SPACING));
    for (const s of stations) stationGroup.add(s.group);
    // Förderband
    const track = new THREE.Mesh(
      new THREE.BoxGeometry((keys.length - 1) * SPACING, 0.015, 0.015),
      new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.3 }),
    );
    track.position.y = -0.62;
    stationGroup.add(track);
    scene.add(stationGroup);
    const width = (keys.length - 1) * SPACING + 1.6;
    stage.fit(width, 3.4);
    caption.position.set(0, 1.45, 0);
    summary.position.set(0, -1.35, 0);
  }

  const st = (key) => stations.find((s) => s.key === key);
  const X = (key) => st(key)?.x ?? 0;

  // ---- Szenario aus Daten
  function scenario(d) {
    if (!d) {
      return {
        demo: true,
        chunks: [{ stale: false, doc_id: 'd02' }, { stale: false, doc_id: 'd02' }, { stale: false, doc_id: 'd05' }],
        dropped: 2, total: 12, freshOn: true, verifyOn: true,
        sentences: [{ supported: true, text: 'Der Pro-Plan kostet 29 € pro Monat.' }, { supported: true, text: 'Er enthält 500 GB Speicher.' }, { supported: false, text: 'Studierende erhalten 50 % Rabatt.' }],
        abstained: false, query: 'Wie viel kostet der Pro-Plan?',
      };
    }
    const chunks = Array.isArray(d.chunks) ? d.chunks : [];
    const freshOn = !!(d.config?.freshness?.enabled || d.config?.freshness?.drop_superseded);
    const verifyOn = d.config?.verify !== false;
    let dropped = 0;
    if (freshOn) {
      const tr = (d.trace || []).find((s) => s.stage === 'freshness');
      const td = tr?.data || {};
      for (const key of ['dropped', 'removed', 'filtered', 'dropped_ids', 'removed_ids', 'dropped_count', 'removed_count', 'n_dropped']) {
        const v = td[key];
        if (Array.isArray(v)) { dropped = v.length; break; }
        if (typeof v === 'number') { dropped = v; break; }
      }
    }
    const pts = Array.isArray(d.points3d) ? d.points3d.length : 0;
    return {
      demo: false, chunks, dropped: Math.max(0, dropped), total: pts, freshOn, verifyOn,
      llmUsed: !!(d.trace || []).find((s) => s.stage === 'generation')?.data?.llm_used,
      sentences: d.answer?.sentences || [], abstained: !!(d.answer?.abstained ?? d.abstained),
      query: d.config?.query ?? null,
    };
  }

  // ---- Keyframe-Skript bauen
  function build(sc) {
    const keys = ['doc', 'chunk', 'embed', 'index', 'retr'];
    if (sc.freshOn) keys.push('fresh');
    keys.push('llm');
    if (sc.verifyOn) keys.push('verify');
    keys.push('answer');
    buildStations(keys);
    if (!sc.demo) st('llm')?.labelObj.setText(sc.llmUsed ? 'Claude' : 'Generator (offline)');
    flags = sc;

    const V = (x, y = 0, z = 0) => new THREE.Vector3(x, y, z);
    const C = (c) => new THREE.Color(c);
    const SC = (a, b = a, c = a) => new THREE.Vector3(a, b, c);
    const ZERO = SC(0.0001);
    const cText = C('#e3e6ff'), cStale = C(COLORS.stale), cErr = C(COLORS.error), cOk = C(COLORS.ok), cGrey = C(COLORS.grey);
    particles = [];
    const events = (key, t, color, w = 0.7) => { const s = st(key); if (s) s.events.push({ t, color: C(color), w }); };

    const k = Math.min(sc.chunks.length, MAX_CHUNKS);
    const R = sc.freshOn ? Math.min(6, sc.dropped, Math.max(0, MAX_CHUNKS - k - 2)) : 0;
    const cand = k + R;
    const N = Math.min(MAX_CHUNKS, Math.max(cand + 3, Math.min(sc.total || 0, 16), 8));
    const rnd = (i, s) => { const v = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return v - Math.floor(v); };

    // Zeiten
    const tBreak = 0.6;
    docBreakT = tBreak;
    const tChunk = 1.7, tEmbed = 2.6, tIndex = 3.5, tRetr = 4.6;
    const tFresh = sc.freshOn ? 5.5 : tRetr;
    const tLLM = tFresh + 0.9;
    const tSent = tLLM + 0.7;
    events('doc', 0.3, COLORS.accent, 0.8);
    events('chunk', tChunk, COLORS.accent);
    events('embed', tEmbed, COLORS.accent);
    events('index', tIndex + 0.2, COLORS.accent, 0.9);
    events('retr', tRetr, '#3fc7e8', 0.9);
    events('llm', tLLM + 0.2, COLORS.accent, 1.1);

    // Chunks: Indizes 0..k-1 = Treffer, k..cand-1 = ausgesiebte, Rest bleibt im Index
    for (let i = 0; i < N; i++) {
      const isHit = i < k;
      const isDropped = !isHit && i < cand;
      const chunk = isHit ? sc.chunks[i] : null;
      const stale = isHit ? !!chunk?.stale : isDropped;
      const vecColor = chunk?.doc_id ? docColor(chunk.doc_id) : C().setHSL((0.62 + rnd(i, 3) * 0.25) % 1, 0.7, 0.64);
      const stagger = i * 0.035;
      const cols = 4, row = Math.floor(i / cols), col = i % cols;
      const inDoc = V(X('doc') - 0.21 + col * 0.14, 0.3 - row * 0.12 * (6 / Math.max(6, Math.ceil(N / cols))), 0.06);
      const s0 = SC(0.12, 0.1, 0.05), s1 = SC(0.13), sIdx = SC(0.085);
      const lvl = i % 3;
      const ang = rnd(i, 1) * Math.PI * 2;
      const inIndex = V(X('index') + Math.cos(ang) * 0.47, -0.24 + lvl * 0.24 + 0.1, Math.sin(ang) * 0.47);
      const keysP = [
        { t: tBreak - 0.01, p: inDoc, s: ZERO, c: cText },
        { t: tBreak, p: inDoc, s: s0, c: cText },
        { t: tBreak + 0.35, p: inDoc.clone().add(V((rnd(i, 2) - 0.3) * 0.4, (rnd(i, 4) - 0.5) * 0.5, 0.25 + rnd(i, 5) * 0.3)), s: s1, c: cText, e: Ease.outCubic },
        { t: tChunk + stagger, p: V(X('chunk'), (rnd(i, 6) - 0.5) * 0.5, (rnd(i, 7) - 0.5) * 0.5), s: s1, c: cText },
        { t: tEmbed + stagger, p: V(X('embed'), (rnd(i, 8) - 0.5) * 0.45, (rnd(i, 9) - 0.5) * 0.45), s: s1, c: vecColor },
        { t: tIndex + stagger, p: inIndex, s: sIdx, c: stale ? vecColor.clone().lerp(cStale, 0.7) : vecColor },
      ];
      if (isHit || isDropped) {
        const j = i;
        const tArr = tRetr + j * 0.07;
        const lane = V(0, ((j % 3) - 1) * 0.16, (Math.floor(j / 3) % 3 - 1) * 0.16);
        const hitColor = stale ? cStale : vecColor;
        keysP.push({ t: tRetr - 0.45 + j * 0.05, p: inIndex.clone().add(V(0, 0.25, 0)), s: SC(0.12), c: hitColor, e: Ease.outCubic });
        keysP.push({ t: tArr, p: V(X('retr'), 0, 0).add(lane), s: SC(0.14), c: hitColor });
        let tCur = tArr;
        if (sc.freshOn) {
          const tF = tFresh + j * 0.06;
          const atF = V(X('fresh') - 0.15, lane.y, lane.z);
          keysP.push({ t: tF, p: atF, s: SC(0.14), c: hitColor });
          tCur = tF;
          if (isDropped) {
            events('fresh', tF + 0.05, COLORS.error, 0.8);
            keysP.push({ t: tF + 0.2, p: atF.clone().add(V(-0.05, 0.05, 0)), s: SC(0.17), c: cErr });
            keysP.push({ t: tF + 0.35, p: atF.clone().add(V(-0.1, 0, 0)), s: SC(0.15), c: cErr });
            keysP.push({ t: tF + 1.0, p: V(X('fresh') - 0.35, -1.25, lane.z + 0.3), s: ZERO, c: cErr, e: Ease.inQuad });
            particles.push({ keys: keysP });
            continue;
          } else {
            events('fresh', tF + 0.05, stale ? COLORS.stale : COLORS.ok, 0.5);
          }
        }
        // weiter zum LLM und darin verschwinden
        const tL = Math.max(tCur + 0.4, tLLM + j * 0.06);
        keysP.push({ t: tL - 0.15, p: V(X('llm') - 0.45, lane.y * 0.6, lane.z * 0.6), s: SC(0.13), c: hitColor });
        keysP.push({ t: tL + 0.2, p: V(X('llm'), 0, 0), s: ZERO, c: hitColor, e: Ease.inCubic });
      } else {
        // bleibt im Index, wird gedimmt
        keysP.push({ t: tRetr, p: inIndex, s: sIdx, c: vecColor.clone().multiplyScalar(0.45) });
      }
      particles.push({ keys: keysP });
    }

    // Sätze
    let sentences = sc.sentences.slice(0, MAX_SENTENCES);
    let abstain = sc.abstained;
    if (!sentences.length && !abstain) sentences = [{ supported: true, text: '' }];
    if (abstain) sentences = [{ supported: null, text: 'Enthaltung' }];
    let passed = 0;
    const tEndArr = [];
    sentences.forEach((s, j) => {
      const t0 = tSent + j * 0.32;
      const sz = SC(0.34, 0.075, 0.075);
      const y = 0.32 - (j % 5) * 0.12;
      const start = V(X('llm') + 0.25, 0, 0);
      const keysP = [
        { t: t0 - 0.01, p: start, s: ZERO, c: cText },
        { t: t0 + 0.2, p: start.clone().add(V(0.2, y * 0.5, 0)), s: sz, c: cText, e: Ease.outCubic },
      ];
      const ok = s.supported !== false;
      const inAnswer = V(X('answer') + 0.02, 0.24 - (passed % 4) * 0.1 + 0.02, 0.1 + Math.floor(passed / 4) * 0.02);
      if (abstain) {
        keysP.push({ t: t0 + 1.4, p: V(X('answer'), 0.08, 0.1), s: SC(0.3, 0.12, 0.1), c: cGrey });
        events('answer', t0 + 1.45, COLORS.grey, 1);
        tEndArr.push(t0 + 1.4);
      } else if (sc.verifyOn) {
        const tv = t0 + 0.9;
        const atV = V(X('verify') - 0.2, y, 0);
        keysP.push({ t: tv, p: atV, s: sz, c: cText });
        if (ok) {
          events('verify', tv + 0.05, COLORS.ok, 0.6);
          keysP.push({ t: tv + 0.2, p: V(X('verify') + 0.1, y, 0), s: sz, c: cOk });
          keysP.push({ t: tv + 0.85, p: inAnswer, s: SC(0.5, 0.06, 0.05), c: cOk });
          events('answer', tv + 0.9, COLORS.ok, 0.6);
          passed++;
          tEndArr.push(tv + 0.85);
        } else {
          events('verify', tv + 0.05, COLORS.error, 0.8);
          keysP.push({ t: tv + 0.15, p: atV.clone().add(V(-0.02, 0, 0)), s: SC(0.36, 0.09, 0.09), c: cErr });
          keysP.push({ t: tv + 0.55, p: atV.clone().add(V(-0.75, 0.35, 0.15)), s: sz, c: cErr, e: Ease.outQuad });
          keysP.push({ t: tv + 1.3, p: atV.clone().add(V(-0.95, -1.2, 0.3)), s: ZERO, c: cErr, e: Ease.inQuad });
          tEndArr.push(tv + 1.3);
        }
      } else {
        keysP.push({ t: t0 + 1.5, p: inAnswer, s: SC(0.5, 0.06, 0.05), c: ok ? cOk : cErr });
        events('answer', t0 + 1.55, ok ? COLORS.ok : COLORS.error, 0.6);
        passed++;
        tEndArr.push(t0 + 1.5);
      }
      particles.push({ keys: keysP });
    });

    T = Math.max(...tEndArr, tLLM + 1) + 0.6;
    for (const s of stations) s.events.sort((a, b) => a.t - b.t);

    phases = [
      { t: 0, text: 'Dokument wird geladen' },
      { t: tBreak, text: 'Chunking: Dokument zerfällt in Chunks' },
      { t: tEmbed - 0.4, text: 'Embedding: Chunks werden zu Vektoren' },
      { t: tIndex - 0.3, text: 'Vektoren landen im Index' },
      { t: tRetr - 0.5, text: `Retrieval: Top-${k} ähnlichste Chunks` },
    ];
    if (sc.freshOn) phases.push({ t: tFresh - 0.2, text: sc.dropped ? `Freshness-Filter siebt ${sc.dropped} veraltete Chunks aus` : 'Freshness-Filter prüft Aktualität' });
    phases.push({ t: tLLM - 0.2, text: sc.demo ? 'LLM erzeugt Antwort aus dem Kontext' : sc.llmUsed ? 'Claude formuliert aus dem Kontext' : 'Generator übernimmt belegte Sätze aus dem Kontext' });
    if (sc.verifyOn && !abstain) phases.push({ t: tSent + 0.7, text: 'Verifier: belegte Sätze passieren, unbelegte prallen ab' });
    phases = phases.map((p, i) => ({ t: p.t, text: `${i + 1} · ${p.text}` }));
    phases.push({ t: T - 0.5, text: abstain ? 'Antwort: Enthaltung – zu wenig Beleg im Kontext' : 'Fertig: Antwort mit Belegen ✓' });

    const total = sentences.length;
    const staleIn = sc.chunks.filter((c) => c.stale).length;
    const parts = [`${k} Chunks im Kontext`];
    if (staleIn) parts.push(`${staleIn} veraltet ⚠`);
    if (sc.dropped) parts.push(`${sc.dropped} ausgesiebt (schematisch)`);
    if (abstain) parts.push('Enthaltung');
    else if (sc.verifyOn) parts.push(`${passed}/${total} Sätze belegt`);
    summaryText = parts.join(' · ');

    pMesh.count = particles.length;
    gGeo.setDrawRange(0, particles.length);
    for (let i = 0; i < particles.length; i++) pMesh.setColorAt(i, cText);
    if (pMesh.instanceColor) pMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  // ---- Auswertung pro Frame
  const tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  const tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpM = new THREE.Matrix4();
  const tmpGC = new THREE.Color();

  function evalParticle(p, t) {
    const ks = p.keys;
    if (t < ks[0].t) { tmpS.set(0.0001, 0.0001, 0.0001); tmpP.copy(ks[0].p); tmpC.copy(ks[0].c); return; }
    const last = ks[ks.length - 1];
    if (t >= last.t) { tmpP.copy(last.p); tmpS.copy(last.s); tmpC.copy(last.c); return; }
    let i = 0;
    while (i < ks.length - 2 && t >= ks[i + 1].t) i++;
    const a = ks[i], b = ks[i + 1];
    const raw = (t - a.t) / Math.max(1e-4, b.t - a.t);
    const k = (b.e || Ease.inOutQuad)(Math.min(1, Math.max(0, raw)));
    tmpP.lerpVectors(a.p, b.p, k);
    tmpS.lerpVectors(a.s, b.s, k);
    tmpC.copy(a.c).lerp(b.c, Math.min(1, raw * 1.5));
  }

  let lastPhase = -1;
  function render(t) {
    const pos = gGeo.attributes.position.array, col = gGeo.attributes.color.array;
    for (let i = 0; i < particles.length; i++) {
      evalParticle(particles[i], t);
      tmpE.set(t * 0.8 + i, t * 0.6 + i * 0.5, 0);
      tmpQ.setFromEuler(tmpE);
      tmpM.compose(tmpP, tmpQ, tmpS);
      pMesh.setMatrixAt(i, tmpM);
      pMesh.setColorAt(i, tmpC);
      const vis = tmpS.y > 0.01 ? 0.55 : 0;
      pos[i * 3] = tmpP.x; pos[i * 3 + 1] = tmpP.y; pos[i * 3 + 2] = tmpP.z;
      col[i * 3] = tmpC.r * vis; col[i * 3 + 1] = tmpC.g * vis; col[i * 3 + 2] = tmpC.b * vis;
    }
    pMesh.instanceMatrix.needsUpdate = true;
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
    gGeo.attributes.position.needsUpdate = true;
    gGeo.attributes.color.needsUpdate = true;

    // Stationen pulsieren
    for (const s of stations) {
      let v = 0, best = null;
      for (const e of s.events) {
        if (e.t > t + 0.01) break;
        const b = bump(t - e.t, 0.7) * e.w;
        if (b > v) { v = b; best = e; }
      }
      s.glow.material.opacity = 0.08 + v * 0.7;
      if (best) s.glow.material.color.copy(best.color); else s.glow.material.color.copy(s.glowBase);
      const sc = 1 + 0.12 * v;
      s.body.scale.setScalar(sc);
      for (let m = 0; m < s.mats.length; m++) if (s.mats[m].emissiveIntensity !== undefined) s.mats[m].emissiveIntensity = s.baseEI[m] + v * 0.8;
    }
    // Dokument „zerbricht“
    const docSt = st('doc');
    if (docSt) {
      const broken = smoothstep(docBreakT - 0.05, docBreakT + 0.3, t) * (1 - smoothstep(T - 0.2, T + 0.6, t));
      docSt.body.scale.multiplyScalar(1 - 0.7 * broken);
    }
    // Ausgabe-Station färben
    const ans = st('answer');
    if (ans && t > T - 0.6) {
      const c = flags.abstained ? COLORS.grey : COLORS.ok;
      ans.glow.material.color.set(c);
      ans.glow.material.opacity = Math.max(ans.glow.material.opacity, 0.35 + (stage.reducedMotion ? 0 : 0.1 * Math.sin(t * 3)));
    }
    // Phasen-Beschriftung
    let ph = 0;
    for (let i = 0; i < phases.length; i++) if (t >= phases[i].t) ph = i;
    if (ph !== lastPhase) { lastPhase = ph; caption.setText(phases[ph]?.text ?? ''); }
    summary.setText(summaryText);
    summary.setOpacity(t > T - 0.6 ? 1 : 0);
  }

  stage.onFrame((dt) => {
    for (const s of stations) if (s.spin && !stage.reducedMotion) s.spin(dt);
    // A settled diagram conveys the result without an endless conveyor belt
    // when the learner asks for reduced motion.
    if (stage.reducedMotion) return;
    let t = stage.time - playStart;
    if (t > T + 3.5 && loop) { play(); t = 0; }
    render(Math.min(t, T + 3.5));
  });

  function play() {
    playStart = stage.time;
    lastPhase = -1;
    if (stage.reducedMotion) {
      render(T + 0.5);
      stage.renderOnce();
    }
  }

  function update(newData) {
    const sc = scenario(newData);
    loop = opts.loop ?? sc.demo;
    build(sc);
    play();
  }

  update(data);

  return {
    update,
    play,
    dispose() { stage.dispose(); },
  };
}
