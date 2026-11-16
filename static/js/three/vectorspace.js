// Vektorraum: Chunks als leuchtende Punkte (farbig nach doc_id), Anfrage als Stern,
// Strahlen zu den top-k-Treffern mit Rang-Beschriftung, Hover-Tooltip.
// data = RUN_RESPONSE (points3d, query3d, chunks) oder null (Demo).
import * as THREE from 'three';
import {
  createStage, COLORS, Ease, createLabel, createGlowSprite, disposeObject, shared, docColor,
  makeBeamGeometry, aimBeam, addLegend, truncate,
} from './scene.js';

const S = 2.2; // Weltmaßstab für normierte Koordinaten [-1, 1]
const MAX_POINTS = 600;

export function mount(container, data = null, opts = {}) {
  const stage = createStage(container, { cameraPosition: [3.6, 2.4, 5.6], autoRotateSpeed: 0.3, ...(opts.stage || {}) });
  const { scene } = stage;
  stage.fit(S * 3.0, S * 2.7);

  const C_STALE = new THREE.Color(COLORS.stale);
  const C_WHITE = new THREE.Color('#ffffff');
  const tmpC = new THREE.Color();
  const tmpV = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();

  // ---- Rahmen
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(S * 2, S * 2, S * 2)),
    new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.14 }),
  );
  scene.add(frame);
  const grid = new THREE.GridHelper(S * 2, 10, COLORS.accent, COLORS.accent);
  grid.position.y = -S;
  grid.material.transparent = true;
  grid.material.opacity = 0.07;
  grid.material.depthWrite = false;
  scene.add(grid);

  const pointGeo = stage.track(shared(new THREE.IcosahedronGeometry(0.05, 1)));
  const beamGeo = stage.track(shared(makeBeamGeometry(1, 6)));
  const glowTex = stage.glowTexture();

  // ---- Anfrage-Stern
  const query = new THREE.Group();
  const qGlow = createGlowSprite(glowTex, COLORS.accent, 1.5, 0.75);
  const qStar = createGlowSprite(stage.starTexture(), '#d9ceff', 0.95, 1);
  const qCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  const qLabel = createLabel('Anfrage', { anchor: 'top', size: 12, color: '#ffffff', border: '1px solid rgba(124,92,255,0.8)' });
  qLabel.position.set(0, -0.28, 0);
  query.add(qGlow, qStar, qCore, qLabel);
  scene.add(query);
  const queryPos = query.position;

  addLegend(stage, [
    { color: COLORS.accent, label: 'Chunk (Farbe = Dokument)' },
    { color: COLORS.stale, label: 'veraltet', opacity: 0.6 },
    { color: '#ffffff', label: 'Anfrage' },
    { color: COLORS.ok, label: 'Top-k-Treffer' },
  ]);
  const projectionNote = document.createElement('div');
  Object.assign(projectionNote.style, {
    position: 'absolute', left: '10px', top: '8px', pointerEvents: 'none',
    color: COLORS.muted, font: '500 11px/1.4 system-ui, sans-serif',
    maxWidth: 'calc(100% - 20px)',
  });
  stage.wrap.appendChild(projectionNote);

  // ---- Zustand
  let items = [];
  let meshes = null;
  let rays = [];
  let gen = 0;
  let dirty = true;
  let transK = 1;
  let demoTimer = null;

  function colorFor(it) {
    tmpC.copy(it.color);
    if (it.stale) tmpC.lerp(C_STALE, 0.75);
    return tmpC;
  }

  function buildMeshes() {
    if (meshes) { disposeObject(meshes.fresh); disposeObject(meshes.stale); disposeObject(meshes.glow); }
    const fIdx = [], sIdx = [];
    items.forEach((it, i) => (it.stale ? sIdx : fIdx).push(i));
    const fresh = new THREE.InstancedMesh(pointGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, fIdx.length));
    const stale = new THREE.InstancedMesh(pointGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }), Math.max(1, sIdx.length));
    fresh.count = fIdx.length; stale.count = sIdx.length;
    fIdx.forEach((idx, j) => fresh.setColorAt(j, colorFor(items[idx])));
    sIdx.forEach((idx, j) => stale.setColorAt(j, colorFor(items[idx])));
    if (fresh.instanceColor) fresh.instanceColor.needsUpdate = true;
    if (stale.instanceColor) stale.instanceColor.needsUpdate = true;
    fresh.frustumCulled = stale.frustumCulled = false;

    const n = items.length;
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
    gGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
    gGeo.setDrawRange(0, n);
    const glow = new THREE.Points(gGeo, new THREE.PointsMaterial({
      size: 0.42, map: glowTex, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    glow.frustumCulled = false;
    scene.add(glow, fresh, stale);
    meshes = { fresh, stale, glow, fIdx, sIdx };
    dirty = true;
  }

  function writeInstances() {
    if (!meshes) return;
    const k = Ease.inOutCubic(transK);
    const pos = meshes.glow.geometry.attributes.position.array;
    const col = meshes.glow.geometry.attributes.color.array;
    const write = (mesh, list) => {
      for (let j = 0; j < list.length; j++) {
        const it = items[list[j]];
        tmpV.lerpVectors(it.from, it.to, k);
        it.cur.copy(tmpV);
        const base = it.spawn ? Math.max(0.001, k) : 1;
        const s = base * (1 + 0.9 * it.emph + 0.8 * it.flash);
        tmpS.set(s, s, s);
        tmpM.compose(tmpV, tmpQ, tmpS);
        mesh.setMatrixAt(j, tmpM);
        const i3 = list[j] * 3;
        pos[i3] = tmpV.x; pos[i3 + 1] = tmpV.y; pos[i3 + 2] = tmpV.z;
        colorFor(it);
        const bright = (it.stale ? 0.28 : 0.5) + 0.5 * it.emph + 0.6 * it.flash;
        if (it.emph > 0) tmpC.lerp(C_WHITE, 0.25 * it.emph);
        col[i3] = tmpC.r * bright * base; col[i3 + 1] = tmpC.g * bright * base; col[i3 + 2] = tmpC.b * bright * base;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
    };
    write(meshes.fresh, meshes.fIdx);
    write(meshes.stale, meshes.sIdx);
    meshes.glow.geometry.attributes.position.needsUpdate = true;
    meshes.glow.geometry.attributes.color.needsUpdate = true;
  }

  // ---- Strahlen
  function clearRays() {
    for (const r of rays) { r.tween?.cancel(); disposeObject(r.mesh); disposeObject(r.label); disposeObject(r.pulse); }
    rays = [];
    for (const it of items) { it.emph = 0; it.flash = 0; }
    dirty = true;
  }

  function showRays(myGen, delay = 0) {
    const hits = items.filter((it) => it.rank != null).sort((a, b) => a.rank - b.rank);
    hits.forEach((it, i) => {
      const color = it.stale ? COLORS.stale : i === 0 ? COLORS.ok : '#9f8bff';
      const mesh = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.visible = false;
      const pulse = createGlowSprite(glowTex, color, 0.35, 0.95);
      pulse.visible = false;
      const scoreTxt = it.score != null && isFinite(it.score) ? ` · ${Number(it.score).toFixed(2)}` : '';
      const label = createLabel(`#${it.rank}${scoreTxt}${it.stale ? ' ⚠' : ''}`, {
        anchor: 'bottom', size: 11, color: it.stale ? COLORS.stale : COLORS.text,
        border: `1px solid ${color}`,
      });
      label.position.copy(it.to).add(new THREE.Vector3(0, 0.12, 0));
      label.visible = false;
      scene.add(mesh, pulse, label);
      const ray = { mesh, pulse, label, it };
      if (stage.reducedMotion) {
        aimBeam(mesh, queryPos, it.to, 1, it.rank === 1 ? 0.014 : 0.009);
        label.visible = true;
        it.emph = 1;
        rays.push(ray);
        dirty = true;
        return;
      }
      const dur = stage.reducedMotion ? 0.25 : 0.55;
      ray.tween = stage.tween({
        delay: delay + i * (stage.reducedMotion ? 0.15 : 0.5), duration: dur, ease: Ease.outCubic,
        onStart: () => { pulse.visible = true; },
        onUpdate: (k) => {
          if (myGen !== gen) return;
          aimBeam(mesh, queryPos, it.to, k, it.rank === 1 ? 0.014 : 0.009);
          pulse.position.lerpVectors(queryPos, it.to, k);
        },
        onComplete: () => {
          if (myGen !== gen) return;
          pulse.visible = false;
          label.visible = true;
          it.flash = 1;
          stage.tween({ duration: 0.5, ease: Ease.outCubic, onUpdate: (k) => { it.emph = k; dirty = true; } });
        },
      });
      rays.push(ray);
    });
  }

  // ---- Daten
  function makeItem(src, to, prev) {
    const old = prev.get(src.id);
    return {
      ...src,
      color: docColor(src.doc_id),
      to,
      from: old ? old.cur.clone() : queryPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3)),
      cur: old ? old.cur.clone() : queryPos.clone(),
      spawn: !old,
      emph: 0, flash: 0,
    };
  }

  function parseRun(d) {
    const pts = Array.isArray(d.points3d) ? d.points3d.slice(0, MAX_POINTS) : [];
    const chunks = Array.isArray(d.chunks) ? d.chunks : [];
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const titleByDoc = new Map();
    chunks.forEach((c) => c.title && titleByDoc.set(c.doc_id, c.title));
    const titles = opts.titles || {};
    let list;
    if (pts.length) {
      let fallbackRank = 1;
      list = pts.map((p) => {
        const c = byId.get(p.id);
        const docId = p.doc_id ?? String(p.id).split('#')[0];
        const retrieved = p.retrieved ?? !!c;
        return {
          id: String(p.id), doc_id: docId,
          p: new THREE.Vector3(+p.x || 0, +p.y || 0, +p.z || 0),
          stale: !!(p.stale ?? c?.stale),
          rank: retrieved ? (p.rank ?? c?.rank ?? fallbackRank++) : null,
          score: c?.score ?? null,
          title: c?.title ?? p.title ?? titleByDoc.get(docId) ?? titles[docId] ?? '',
        };
      });
    } else {
      // Fallback ohne points3d: Treffer kreisförmig um die Anfrage, Abstand ~ (1 - score)
      list = chunks.map((c, i) => {
        const a = (i / Math.max(1, chunks.length)) * Math.PI * 2;
        const r = 0.25 + (1 - Math.min(1, Math.max(0, c.score ?? 0.5))) * 0.6;
        return { id: c.id, doc_id: c.doc_id, p: new THREE.Vector3(Math.cos(a) * r, Math.sin(a * 2) * 0.2, Math.sin(a) * r), stale: !!c.stale, rank: c.rank ?? i + 1, score: c.score, title: c.title ?? '' };
      });
    }
    const q = d.query3d || { x: 0, y: 0, z: 0 };
    return { list, q: new THREE.Vector3(+q.x || 0, +q.y || 0, +q.z || 0), text: d.config?.query ?? d.query ?? null };
  }

  function setQueryLabel(text) {
    qLabel.setText(text ? `Anfrage: „${truncate(text, 42)}“` : 'Anfrage');
  }

  function apply(parsed, { animateQuery = true } = {}) {
    const myGen = ++gen;
    clearRays();
    const prev = new Map(items.map((it) => [it.id, it]));
    const qFrom = queryPos.clone();
    const qTo = parsed.q.clone().multiplyScalar(S);
    items = parsed.list.map((src) => makeItem(src, src.p.clone().multiplyScalar(S), prev));
    buildMeshes();
    setQueryLabel(parsed.text);
    if (stage.reducedMotion) {
      queryPos.copy(qTo);
      transK = 1;
      showRays(myGen);
      writeInstances();
      dirty = false;
      stage.renderOnce();
      return;
    }
    transK = 0;
    const dur = stage.reducedMotion ? 0.3 : 1.2;
    stage.tween({
      duration: dur, ease: Ease.linear,
      onUpdate: (k) => {
        if (myGen !== gen) return;
        transK = k; dirty = true;
        if (animateQuery) queryPos.lerpVectors(qFrom, qTo, Ease.inOutCubic(k));
      },
      onComplete: () => {
        if (myGen !== gen) return;
        transK = 1; queryPos.copy(qTo); dirty = true;
        showRays(myGen, 0.1);
      },
    });
  }

  // ---- Demo
  function makeDemo() {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const docs = [
      { id: 'd01', title: 'Preisliste 2023', stale: true, c: [-0.45, 0.35, 0.2] },
      { id: 'd02', title: 'Preisliste 2025', stale: false, c: [-0.3, 0.5, 0.45] },
      { id: 'd03', title: 'API-Referenz v1', stale: true, c: [0.5, -0.2, -0.35] },
      { id: 'd04', title: 'API-Referenz v3', stale: false, c: [0.62, -0.05, -0.1] },
      { id: 'd05', title: 'Support-Richtlinie', stale: false, c: [0.05, -0.6, 0.55] },
      { id: 'd06', title: 'Sicherheits-FAQ', stale: false, c: [-0.1, 0.0, -0.65] },
    ];
    const list = [];
    for (const d of docs) {
      for (let i = 0; i < 18; i++) {
        const p = new THREE.Vector3(d.c[0] + gauss() * 0.14, d.c[1] + gauss() * 0.14, d.c[2] + gauss() * 0.14).clampScalar(-1, 1);
        list.push({ id: `${d.id}#${i}`, doc_id: d.id, p, stale: d.stale, rank: null, score: null, title: d.title });
      }
    }
    const queries = [
      { text: 'Wie viel kostet der Pro-Plan?', docs: ['d01', 'd02'] },
      { text: 'Welche API-Version ist aktuell?', docs: ['d03', 'd04'] },
      { text: 'Wie erreiche ich den Support?', docs: ['d05'] },
      { text: 'Werden Daten verschlüsselt?', docs: ['d06'] },
    ];
    return { list, docs, queries };
  }

  function startDemo() {
    const demo = makeDemo();
    if (stage.reducedMotion) {
      const q = demo.queries[0];
      const qPos = demo.docs.filter((d) => q.docs.includes(d.id))
        .reduce((a, d) => a.add(new THREE.Vector3(...d.c)), new THREE.Vector3())
        .divideScalar(q.docs.length);
      const hits = demo.list.slice().sort((a, b) => a.p.distanceTo(qPos) - b.p.distanceTo(qPos)).slice(0, 4);
      hits.forEach((it, i) => { it.rank = i + 1; });
      apply({ list: demo.list, q: qPos, text: q.text });
      return;
    }
    apply({ list: demo.list, q: new THREE.Vector3(0, 0, 0), text: null }, { animateQuery: false });
    // Erste Runde: keine Treffer (keine Ränge) → direkt Demo-Zyklus starten
    let qi = 0;
    const cycle = () => {
      const myGen = gen;
      const q = demo.queries[qi++ % demo.queries.length];
      clearRays();
      for (const it of items) it.rank = null;
      setQueryLabel(q.text);
      const centers = demo.docs.filter((d) => q.docs.includes(d.id)).map((d) => new THREE.Vector3(...d.c));
      const target = centers.reduce((a, c) => a.add(c), new THREE.Vector3()).divideScalar(centers.length)
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.15, 0.12, (Math.random() - 0.5) * 0.15)).multiplyScalar(S);
      const from = queryPos.clone();
      stage.tween({
        duration: stage.reducedMotion ? 0.4 : 1.6, ease: Ease.inOutCubic,
        onUpdate: (k) => { if (myGen === gen) queryPos.lerpVectors(from, target, k); },
        onComplete: () => {
          if (myGen !== gen) return;
          const scored = items.map((it) => ({ it, d: it.to.distanceTo(target) })).sort((a, b) => a.d - b.d).slice(0, 4);
          scored.forEach((s, i) => { s.it.rank = i + 1; s.it.score = Math.max(0, 1 - s.d / (S * 1.2)); });
          showRays(myGen);
          demoTimer = stage.after(5.2, () => { if (myGen === gen) cycle(); });
        },
      });
    };
    demoTimer = stage.after(1.4, cycle);
  }

  // ---- Hover
  stage.setHover({
    targets: () => (meshes ? [meshes.fresh, meshes.stale] : []),
    describe: (hit) => {
      if (hit.instanceId == null || !meshes) return null;
      const list = hit.object === meshes.fresh ? meshes.fIdx : meshes.sIdx;
      const it = items[list[hit.instanceId]];
      if (!it) return null;
      const lines = [];
      if (it.title) lines.push(it.title);
      lines.push(`Dokument: ${it.doc_id}`);
      lines.push(it.rank != null ? `Treffer Rang ${it.rank}${it.score != null ? ` · Score ${Number(it.score).toFixed(2)}` : ''}` : 'nicht abgerufen');
      if (it.stale) lines.push('⚠ veraltet (durch neuere Version ersetzt)');
      return { key: it.id, title: `Chunk ${it.id}`, color: '#' + colorFor(it).getHexString(), lines };
    },
  });

  // ---- Frame
  stage.onFrame((dt, t) => {
    const pulse = stage.reducedMotion ? 1 : 1 + 0.12 * Math.sin(t * 3.2);
    qStar.scale.setScalar(0.95 * pulse);
    qGlow.scale.setScalar(1.5 * (stage.reducedMotion ? 1 : 1 + 0.08 * Math.sin(t * 3.2 + 1)));
    if (!stage.reducedMotion) { qStar.material.rotation += dt * 0.35; qCore.rotation.y += dt * 1.2; }
    let flashing = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.flash > 0) { it.flash = Math.max(0, it.flash - dt * 2.2); flashing = true; }
    }
    if (dirty || flashing) { writeInstances(); dirty = false; }
    for (const r of rays) if (r.label.visible) r.label.position.copy(r.it.to).y += 0.12;
  });

  function update(newData) {
    demoTimer?.cancel(); demoTimer = null;
    projectionNote.textContent = !newData ? 'Demo: schematischer Vektorraum'
      : newData.config?.retrieval?.mmr ? 'PCA-Projektion · MMR wählt Relevanz und Vielfalt'
        : 'PCA-Projektion · Abstände in 3D sind nur eine Näherung';
    if (!newData) { startDemo(); return; }
    apply(parseRun(newData));
  }

  update(data);

  return {
    update,
    /** Strahlen-Animation erneut abspielen. */
    replay() { const myGen = ++gen; clearRays(); showRays(myGen); },
    dispose() { gen++; stage.dispose(); },
  };
}
