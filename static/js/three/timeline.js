// Zeitachse 2022–2026: Dokumente als Karten über ihrem Datum, Kanten zu superseded_by,
// as_of als leuchtende „Jetzt“-Ebene, Recency-Decay-Kurve 0.5^(Alter/Halbwertszeit).
// data = {documents:[{id,title,date,superseded_by}], as_of, highlight?, half_life_days?} oder null (Demo).
// Extra: highlight(id|null).
import * as THREE from 'three';
import {
  createStage, COLORS, Ease, createLabel, createGlowSprite, disposeObject, shared, docColor, makeTube, setTubeProgress, truncate,
} from './scene.js';

const W = 11;          // Breite der Achse
const DAY = 86400000;

function parseDate(s) {
  if (s instanceof Date) return s.getTime();
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(s ?? ''));
  if (m) return Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
const fmt = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`; };

const DEMO = {
  as_of: '2026-11-16',
  documents: [
    { id: 'd01', title: 'Preisliste 2022', date: '2022-02-10', superseded_by: 'd05' },
    { id: 'd02', title: 'API-Referenz v1', date: '2022-05-03', superseded_by: 'd06' },
    { id: 'd03', title: 'Support-Richtlinie 2022', date: '2022-09-20', superseded_by: 'd09' },
    { id: 'd04', title: 'Sicherheits-FAQ', date: '2023-01-15', superseded_by: null },
    { id: 'd05', title: 'Preisliste 2023', date: '2023-04-01', superseded_by: 'd10' },
    { id: 'd06', title: 'API-Referenz v2', date: '2023-08-12', superseded_by: 'd11' },
    { id: 'd07', title: 'Limits & Kontingente', date: '2024-01-08', superseded_by: 'd12' },
    { id: 'd08', title: 'Onboarding-Leitfaden', date: '2024-03-22', superseded_by: null },
    { id: 'd09', title: 'Support-Richtlinie 2024', date: '2024-06-30', superseded_by: null },
    { id: 'd10', title: 'Preisliste 2025', date: '2025-01-02', superseded_by: null },
    { id: 'd11', title: 'API-Referenz v3', date: '2025-05-19', superseded_by: null },
    { id: 'd12', title: 'Limits & Kontingente 2026', date: '2026-02-14', superseded_by: null },
    { id: 'd13', title: 'Statusseite & SLA', date: '2026-07-01', superseded_by: null },
  ],
};

export function mount(container, data = null, opts = {}) {
  const stage = createStage(container, {
    cameraPosition: [0, 2.1, 10], target: [0, 1.45, 0], autoRotate: false,
    azimuthRange: 0.6, minPolar: 0.9, maxPolar: 1.9, ...(opts.stage || {}),
  });
  const { scene } = stage;
  stage.fit(W + 1.4, 4.9);
  const glowTex = stage.glowTexture();
  const cardGeo = stage.track(shared(new THREE.BoxGeometry(0.46, 0.3, 0.025)));
  const coneGeo = stage.track(shared(new THREE.ConeGeometry(0.045, 0.13, 8)));
  const UP = new THREE.Vector3(0, 1, 0);

  let world = null;       // Gruppe aller datenabhängigen Objekte
  let cards = new Map();  // id → card
  let edges = [];
  let gen = 0;
  let highlighted = null;
  let demoTimer = null;
  let isDemo = false;
  const hiGlow = createGlowSprite(glowTex, COLORS.accent, 1.1, 0);
  const hiLabel = createLabel('', { anchor: 'bottom', size: 12, opacity: 0, maxWidth: 220, border: `1px solid ${COLORS.accent}` });
  scene.add(hiGlow, hiLabel);

  function build(d) {
    const myGen = ++gen;
    if (world) disposeObject(world);
    cards = new Map(); edges = []; highlighted = null;
    hiGlow.material.opacity = 0; hiLabel.setOpacity(0);
    world = new THREE.Group();
    scene.add(world);

    const docs = (Array.isArray(d.documents) ? d.documents : []).map((doc) => ({ ...doc, t: parseDate(doc.date) })).filter((doc) => doc.id != null);
    const asOf = parseDate(d.as_of) ?? Date.now();
    const halfLife = Math.max(1, +(d.half_life_days ?? opts.halfLifeDays ?? 365));
    const times = docs.map((x) => x.t).filter((t) => t != null);
    const y0 = Math.min(2022, ...times.map((t) => new Date(t).getUTCFullYear()));
    const y1 = Math.max(2026, new Date(asOf).getUTCFullYear(), ...times.map((t) => new Date(t).getUTCFullYear()));
    const tStart = Date.UTC(y0, 0, 1), tEnd = Date.UTC(y1 + 1, 0, 1);
    const xOf = (t) => -W / 2 + ((t - tStart) / (tEnd - tStart)) * W;

    // Achse + Jahresmarken
    const axisMat = new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.8 });
    const axis = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, 0.03, 0.03), axisMat);
    world.add(axis);
    const tickGeo = new THREE.BoxGeometry(0.02, 0.22, 0.02);
    const smallTickGeo = new THREE.BoxGeometry(0.012, 0.09, 0.012);
    for (let y = y0; y <= y1 + 1; y++) {
      const x = xOf(Date.UTC(y, 0, 1));
      const tick = new THREE.Mesh(tickGeo, axisMat);
      tick.position.set(x, 0, 0);
      world.add(tick);
      if (y <= y1) {
        const lab = createLabel(String(y), { anchor: 'top', size: 12, bg: null, color: COLORS.muted });
        lab.position.set(xOf(Date.UTC(y, 6, 1)), -0.15, 0);
        world.add(lab);
        for (let q = 1; q < 4; q++) {
          const st = new THREE.Mesh(smallTickGeo, axisMat);
          st.position.set(xOf(Date.UTC(y, q * 3, 1)), 0, 0);
          world.add(st);
        }
      }
    }

    // Recency-Decay-Kurve (hinter den Karten)
    const ZC = -0.9, BASE = 0.2, H = 2.6;
    const xNow = xOf(asOf);
    const pts = [], strip = [];
    const N = 90;
    for (let i = 0; i <= N; i++) {
      const t = tStart + ((asOf - tStart) * i) / N;
      const w = Math.pow(0.5, (asOf - t) / DAY / halfLife);
      const p = new THREE.Vector3(xOf(t), BASE + w * H, ZC);
      pts.push(p);
      strip.push(p.x, BASE, ZC, p.x, p.y, ZC);
    }
    const decayCurve = new THREE.CatmullRomCurve3(pts);
    const decayMat = new THREE.MeshBasicMaterial({ color: COLORS.ok, transparent: true, opacity: 0.9, depthWrite: false });
    const decayTube = makeTube(decayCurve, 0.016, decayMat, 120, 5);
    world.add(decayTube);
    const areaGeo = new THREE.BufferGeometry();
    areaGeo.setAttribute('position', new THREE.Float32BufferAttribute(strip, 3));
    const idx = [];
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    areaGeo.setIndex(idx);
    const area = new THREE.Mesh(areaGeo, new THREE.MeshBasicMaterial({ color: COLORS.ok, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
    world.add(area);
    const baseLine = new THREE.Mesh(new THREE.BoxGeometry(xNow - xOf(tStart), 0.008, 0.008), new THREE.MeshBasicMaterial({ color: COLORS.ok, transparent: true, opacity: 0.25 }));
    baseLine.position.set((xNow + xOf(tStart)) / 2, BASE, ZC);
    world.add(baseLine);
    const decayLabel = createLabel(`Recency-Gewicht = 0,5^(Alter / ${halfLife} Tage)`, { size: 11, color: COLORS.ok, border: `1px solid ${COLORS.ok}55` });
    decayLabel.position.set(xOf(tStart) + 1.9, BASE + H * 0.55, ZC);
    world.add(decayLabel);
    // Halbwertszeit-Marke
    const tHalf = asOf - halfLife * DAY;
    if (tHalf > tStart) {
      const hp = new THREE.Vector3(xOf(tHalf), BASE + 0.5 * H, ZC);
      const dot = createGlowSprite(glowTex, COLORS.ok, 0.35, 0.9);
      dot.position.copy(hp);
      const hl = createLabel('½', { anchor: 'bottom', size: 11, color: COLORS.ok, bg: null });
      hl.position.copy(hp).add(new THREE.Vector3(0, 0.1, 0));
      world.add(dot, hl);
    }
    const oneLab = createLabel('1,0', { size: 10, color: COLORS.ok, bg: null });
    oneLab.position.set(xNow + 0.22, BASE + H, ZC);
    world.add(oneLab);

    // „Jetzt“-Ebene
    const nowGroup = new THREE.Group();
    nowGroup.position.x = xNow;
    const nowMat = new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const nowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 3.6), nowMat);
    nowPlane.rotation.y = Math.PI / 2;
    nowPlane.position.y = 1.5;
    const nowEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.3, 3.6)), new THREE.LineBasicMaterial({ color: '#b5a4ff', transparent: true, opacity: 0.7 }));
    nowEdge.rotation.y = Math.PI / 2;
    nowEdge.position.y = 1.5;
    const nowGlow = createGlowSprite(glowTex, COLORS.accent, 1.2, 0.9);
    const nowLabel = createLabel(`Jetzt · ${fmt(asOf)}`, { anchor: 'bottom', size: 12, color: '#ffffff', border: `1px solid ${COLORS.accent}` });
    nowLabel.position.y = 3.35;
    nowGroup.add(nowPlane, nowEdge, nowGlow, nowLabel);
    world.add(nowGroup);

    // Ketten-Farbe (Wurzel der superseded_by-Kette)
    const byId = new Map(docs.map((x) => [String(x.id), x]));
    const prevOf = new Map();
    for (const doc of docs) if (doc.superseded_by != null && byId.has(String(doc.superseded_by))) prevOf.set(String(doc.superseded_by), String(doc.id));
    const rootOf = (id) => { let cur = id, guard = 0; while (prevOf.has(cur) && guard++ < 50) cur = prevOf.get(cur); return cur; };

    // Karten (Spuren gegen Überlappung)
    const sorted = docs.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const laneEnd = [];
    const MAX_LANES = 6;
    const stemPos = [];
    sorted.forEach((doc, order) => {
      const id = String(doc.id);
      const x = doc.t != null ? xOf(doc.t) : xOf(tStart) - 0.3;
      let lane = laneEnd.findIndex((e) => e + 0.52 <= x);
      if (lane === -1) { lane = laneEnd.length; laneEnd.push(x); } else laneEnd[lane] = x;
      const z = lane >= MAX_LANES ? -0.35 * Math.floor(lane / MAX_LANES) : 0;
      const y = 0.5 + (lane % MAX_LANES) * 0.42;
      const stale = doc.superseded_by != null && doc.superseded_by !== '';
      const future = doc.t != null && doc.t > asOf;
      const base = stale ? new THREE.Color(COLORS.stale) : docColor(rootOf(id));
      const mat = new THREE.MeshStandardMaterial({
        color: base, emissive: base, emissiveIntensity: stale ? 0.15 : 0.45, roughness: 0.4, metalness: 0.1,
        transparent: true, opacity: stale ? 0.42 : future ? 0.6 : 0.95, depthWrite: !stale,
      });
      const mesh = new THREE.Mesh(cardGeo, mat);
      const target = new THREE.Vector3(x, y, z);
      mesh.position.copy(target).add(new THREE.Vector3(0, 1.6, 0));
      mesh.scale.setScalar(0.001);
      mesh.userData.docId = id;
      const label = createLabel(id, { size: 10, bg: null, color: stale ? COLORS.stale : '#ffffff', opacity: stale ? 0.7 : 1 });
      label.position.copy(target).add(new THREE.Vector3(0, 0, 0.03));
      label.visible = false;
      world.add(mesh, label);
      stemPos.push(x, 0.02, z, x, y - 0.15, z);
      const w = doc.t != null ? Math.pow(0.5, Math.max(0, asOf - doc.t) / DAY / halfLife) : null;
      const card = { id, doc, mesh, mat, label, target, stale, weight: w, baseEI: mat.emissiveIntensity, baseOpacity: mat.opacity, hi: 0 };
      cards.set(id, card);
      stage.tween({
        delay: (stage.reducedMotion ? 0 : 0.07) * order, duration: stage.reducedMotion ? 0.2 : 0.6, ease: Ease.outBack,
        onUpdate: (k) => { if (myGen !== gen) return; mesh.position.lerpVectors(target.clone().add(new THREE.Vector3(0, 1.6, 0)), target, Math.min(1, k)); mesh.scale.setScalar(Math.max(0.001, k)); },
        onComplete: () => { if (myGen === gen) label.visible = true; },
      });
    });
    const stemGeo = new THREE.BufferGeometry();
    stemGeo.setAttribute('position', new THREE.Float32BufferAttribute(stemPos, 3));
    world.add(new THREE.LineSegments(stemGeo, new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.25 })));

    // Kanten alt → neu
    const startEdges = (stage.reducedMotion ? 0 : 0.07) * sorted.length + 0.4;
    let ei = 0;
    for (const c of cards.values()) {
      const nid = c.doc.superseded_by != null ? String(c.doc.superseded_by) : null;
      const n = nid && cards.get(nid);
      if (!n) continue;
      const a = c.target.clone().add(new THREE.Vector3(0.12, 0.15, 0));
      const b = n.target.clone().add(new THREE.Vector3(-0.12, 0.15, 0));
      const mid = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.45 + Math.min(1, a.distanceTo(b) * 0.12), 0.35));
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.stale, transparent: true, opacity: 0.55, depthWrite: false });
      const tube = makeTube(curve, 0.011, mat, 32, 4);
      setTubeProgress(tube, 0);
      const cone = new THREE.Mesh(coneGeo, mat);
      cone.position.copy(curve.getPoint(1));
      cone.quaternion.setFromUnitVectors(UP, curve.getTangent(1).normalize());
      cone.visible = false;
      const dot = createGlowSprite(glowTex, COLORS.stale, 0.22, 0.9);
      dot.visible = false;
      world.add(tube, cone, dot);
      const edge = { from: c.id, to: n.id, curve, tube, cone, dot, mat, phase: Math.random(), ready: false };
      edges.push(edge);
      stage.tween({
        delay: startEdges + ei++ * 0.12, duration: stage.reducedMotion ? 0.2 : 0.7, ease: Ease.inOutCubic,
        onUpdate: (k) => { if (myGen === gen) setTubeProgress(tube, k); },
        onComplete: () => { if (myGen !== gen) return; cone.visible = true; dot.visible = !stage.reducedMotion; edge.ready = true; },
      });
    }

    if (d.highlight) stage.after(startEdges + 0.3, () => { if (myGen === gen) setHighlight(d.highlight); });
  }

  function setHighlight(id) {
    highlighted = id != null ? String(id) : null;
    const c = highlighted && cards.get(highlighted);
    if (!c) { hiGlow.material.opacity = 0; hiLabel.setOpacity(0); highlighted = null; return; }
    hiGlow.position.copy(c.target).add(new THREE.Vector3(0, 0, -0.05));
    hiGlow.material.color.set(c.stale ? COLORS.stale : COLORS.accent);
    hiLabel.position.copy(c.target).add(new THREE.Vector3(0, 0.26, 0));
    const succ = c.doc.superseded_by ? ` → ersetzt durch ${c.doc.superseded_by}` : ' · aktuell';
    hiLabel.setText(`${c.id}: ${truncate(c.doc.title || '', 48)}${c.stale ? ' ⚠' : ''}${succ}`);
    hiLabel.setBorder(c.stale ? COLORS.stale : COLORS.accent);
    hiLabel.setOpacity(1);
  }

  // Hover
  stage.setHover({
    targets: () => [...cards.values()].map((c) => c.mesh),
    describe: (hit) => {
      const c = cards.get(hit.object.userData.docId);
      if (!c) return null;
      const lines = [];
      if (c.doc.date) lines.push(`Datum: ${c.doc.t != null ? fmt(c.doc.t) : c.doc.date}${c.doc.version ? ` · Version ${c.doc.version}` : ''}`);
      if (c.doc.source) lines.push(`Quelle: ${c.doc.source}`);
      if (c.doc.superseded_by) lines.push(`⚠ veraltet – ersetzt durch ${c.doc.superseded_by}`);
      const prev = [...cards.values()].filter((o) => String(o.doc.superseded_by) === c.id).map((o) => o.id);
      if (prev.length) lines.push(`ersetzt: ${prev.join(', ')}`);
      if (c.weight != null) lines.push(`Recency-Gewicht: ${c.weight.toFixed(2).replace('.', ',')}`);
      return { key: c.id, title: `${c.id} · ${c.doc.title || ''}`, color: c.stale ? COLORS.stale : COLORS.text, lines };
    },
  });

  stage.onFrame((dt, t) => {
    const rm = stage.reducedMotion;
    for (const c of cards.values()) {
      const target = c.id === highlighted ? 1 : 0;
      c.hi += (target - c.hi) * Math.min(1, dt * 6);
      if (c.mesh.scale.x > 0.99 || c.hi > 0.01) {
        const s = 1 + 0.4 * c.hi;
        if (c.mesh.scale.x >= 0.99) c.mesh.scale.setScalar(s);
      }
      c.mat.emissiveIntensity = c.baseEI + c.hi * 0.6;
      c.mat.opacity = c.baseOpacity + (1 - c.baseOpacity) * c.hi * 0.6;
    }
    for (const e of edges) {
      const on = highlighted && (e.from === highlighted || e.to === highlighted);
      e.mat.opacity = on ? 1 : highlighted ? 0.3 : 0.55;
      if (e.ready && !rm) {
        const k = (t * 0.45 + e.phase) % 1;
        e.curve.getPoint(k, e.dot.position);
        e.dot.material.opacity = Math.sin(k * Math.PI) * (on ? 1 : 0.7);
      }
    }
    if (highlighted) hiGlow.material.opacity = 0.65 + (rm ? 0 : 0.2 * Math.sin(t * 3));
  });

  function startDemo() {
    isDemo = true;
    build(DEMO);
    const chain = ['d01', 'd05', 'd10', 'd02', 'd06', 'd11', 'd07', 'd12'];
    let i = 0;
    const step = () => { setHighlight(chain[i++ % chain.length]); demoTimer = stage.after(2.6, step); };
    demoTimer = stage.after(2.8, step);
  }

  function update(newData) {
    demoTimer?.cancel(); demoTimer = null;
    isDemo = false;
    if (!newData) { startDemo(); return; }
    build(newData);
  }

  update(data);

  return {
    update,
    highlight(id) { demoTimer?.cancel(); demoTimer = null; setHighlight(id); },
    dispose() { gen++; stage.dispose(); },
  };
}
