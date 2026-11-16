// Multi-Agenten-Loop: fünf Agenten im Pentagon, Nachrichten fliegen als Kometen,
// fail/retry → roter Blitz + Loop-Pfeil zurück zum Planer, final → Burst.
// data = null (Idle-Demo) oder Array von Events. Extra: event(evt), reset().
import * as THREE from 'three';
import {
  createStage, COLORS, Ease, createLabel, createGlowSprite, disposeObject, shared, makeTube, setTubeProgress, truncate,
} from './scene.js';

const R = 2.0;
const ORDER = ['orchestrator', 'planner', 'retriever', 'generator', 'verifier'];
const META = {
  orchestrator: { name: 'Orchestrator', color: '#7c5cff' },
  planner: { name: 'Planer', color: '#4fa8ff' },
  retriever: { name: 'Retriever', color: '#3fc7e8' },
  generator: { name: 'Generator', color: '#c77dff' },
  verifier: { name: 'Verifier (Prüfer)', color: '#5fe0b5' },
};
const ALIASES = { planer: 'planner', prüfer: 'verifier', pruefer: 'verifier', orchestrierer: 'orchestrator', generierer: 'generator' };

const DEMO = [
  { agent: 'orchestrator', status: 'start', iteration: 1, message: 'Neue Frage: „Welche API-Version ist aktuell?“' },
  { agent: 'planner', status: 'start', iteration: 1, message: 'Zerlege die Frage in Suchanfragen' },
  { agent: 'planner', status: 'done', iteration: 1, message: 'Plan: 2 Teilanfragen' },
  { agent: 'retriever', status: 'start', iteration: 1, message: 'Suche im Vektor-Index (k = 4)' },
  { agent: 'retriever', status: 'done', iteration: 1, message: '4 Chunks gefunden' },
  { agent: 'generator', status: 'start', iteration: 1, message: 'Formuliere Antwort mit Zitaten' },
  { agent: 'generator', status: 'done', iteration: 1, message: 'Entwurf mit 3 Sätzen' },
  { agent: 'verifier', status: 'start', iteration: 1, message: 'Prüfe Belege für jeden Satz' },
  { agent: 'verifier', status: 'fail', iteration: 1, message: 'Satz 2 stützt sich auf veraltete Quelle (API v1)' },
  { agent: 'orchestrator', status: 'retry', iteration: 2, message: 'Neuer Versuch – nur aktuelle Dokumente' },
  { agent: 'planner', status: 'start', iteration: 2, message: 'Plane neu mit Freshness-Filter' },
  { agent: 'planner', status: 'done', iteration: 2, message: 'Plan angepasst' },
  { agent: 'retriever', status: 'start', iteration: 2, message: 'Suche erneut (veraltete ausgeschlossen)' },
  { agent: 'retriever', status: 'done', iteration: 2, message: '3 aktuelle Chunks' },
  { agent: 'generator', status: 'start', iteration: 2, message: 'Neue Antwort mit Zitaten' },
  { agent: 'generator', status: 'done', iteration: 2, message: 'Entwurf mit 2 Sätzen' },
  { agent: 'verifier', status: 'start', iteration: 2, message: 'Prüfe Belege erneut' },
  { agent: 'verifier', status: 'done', iteration: 2, message: 'Alle Sätze belegt ✓' },
].map((e) => ({ type: 'step', ...e }));
DEMO.push({ type: 'final', abstained: false, iterations: 2 });

export function mount(container, data = null, opts = {}) {
  const stage = createStage(container, {
    cameraPosition: [0, 0.9, 7], target: [0, 0.3, 0], autoRotate: false, azimuthRange: 0.8, minPolar: 0.8, maxPolar: 2.3, ...(opts.stage || {}),
  });
  const { scene } = stage;
  stage.fit(R * 2 + 2.4, R * 2 + 2.6);
  const glowTex = stage.glowTexture();
  const root = new THREE.Group();
  scene.add(root);

  // ---- Knoten
  const nodes = {};
  const shapes = {
    orchestrator: () => new THREE.OctahedronGeometry(0.42, 0),
    planner: () => new THREE.TetrahedronGeometry(0.44, 0),
    retriever: () => new THREE.TorusKnotGeometry(0.22, 0.075, 64, 8),
    generator: () => new THREE.IcosahedronGeometry(0.38, 0),
    verifier: () => new THREE.CylinderGeometry(0.32, 0.32, 0.5, 6),
  };
  const ringGeo = stage.track(shared(new THREE.RingGeometry(0.5, 0.56, 48)));
  ORDER.forEach((key, i) => {
    const ang = Math.PI / 2 - (i * 2 * Math.PI) / 5;
    const pos = new THREE.Vector3(Math.cos(ang) * R, Math.sin(ang) * R, 0);
    const g = new THREE.Group();
    g.position.copy(pos);
    const color = new THREE.Color(META[key].color);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.2, flatShading: true });
    const mesh = new THREE.Mesh(shapes[key](), mat);
    const glow = createGlowSprite(glowTex, color, 1.8, 0.15);
    glow.position.z = -0.2;
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    const label = createLabel(META[key].name, { anchor: 'top', size: 12 });
    label.position.set(0, -0.62, 0);
    const bubble = createLabel('', { anchor: 'bottom', size: 11, maxWidth: 190, weight: 500, opacity: 0 });
    bubble.position.set(0, 0.62, 0);
    g.add(glow, mesh, ring, label, bubble);
    root.add(g);
    nodes[key] = { key, pos, g, mesh, mat, glow, ring, label, bubble, color, active: 0, activeTarget: 0, flash: 0, flashColor: new THREE.Color(), ringT: -1 };
  });

  // ---- Kanten (Ring) mit Pfeilspitzen
  const center = new THREE.Vector3();
  const edgeMat = new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.28, depthWrite: false });
  const coneGeo = stage.track(shared(new THREE.ConeGeometry(0.06, 0.16, 8)));
  const UP = new THREE.Vector3(0, 1, 0);
  function arcCurve(a, b, bulge = 0.35, z = 0.0) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const out = mid.clone().sub(center);
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
    out.normalize().multiplyScalar(bulge);
    return new THREE.QuadraticBezierCurve3(a.clone(), mid.add(out).setZ(z), b.clone());
  }
  function trimmed(curve, t0 = 0.17, t1 = 0.83) {
    const pts = []; for (let i = 0; i <= 24; i++) pts.push(curve.getPoint(t0 + (t1 - t0) * (i / 24)));
    return new THREE.CatmullRomCurve3(pts);
  }
  for (let i = 0; i < ORDER.length; i++) {
    const a = nodes[ORDER[i]].pos, b = nodes[ORDER[(i + 1) % ORDER.length]].pos;
    const curve = arcCurve(a, b, 0.25);
    const tube = makeTube(trimmed(curve), 0.012, edgeMat, 24, 4);
    root.add(tube);
    const cone = new THREE.Mesh(coneGeo, edgeMat);
    cone.position.copy(curve.getPoint(0.6));
    cone.quaternion.setFromUnitVectors(UP, curve.getTangent(0.6).normalize());
    root.add(cone);
  }

  // ---- Loop-Pfeil (Verifier → Planer)
  const loopCurveFull = new THREE.QuadraticBezierCurve3(
    nodes.verifier.pos.clone(), new THREE.Vector3(0.0, 0.35, 0.9), nodes.planner.pos.clone(),
  );
  const loopCurve = trimmed(loopCurveFull, 0.12, 0.86);
  const loopMat = new THREE.MeshBasicMaterial({ color: COLORS.error, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const loopTube = makeTube(loopCurve, 0.022, loopMat, 48, 5);
  setTubeProgress(loopTube, 0);
  const loopCone = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.24, 10), loopMat);
  loopCone.position.copy(loopCurve.getPoint(1));
  loopCone.quaternion.setFromUnitVectors(UP, loopCurve.getTangent(1).normalize());
  loopCone.visible = false;
  const loopLabel = createLabel('↺ Retry-Schleife', { size: 11, color: COLORS.error, border: `1px solid ${COLORS.error}`, opacity: 0 });
  loopLabel.position.copy(loopCurveFull.getPoint(0.5)).add(new THREE.Vector3(0, 0.18, 0));
  root.add(loopTube, loopCone, loopLabel);
  let loopVisible = 0;   // Zielwert
  let loopShown = 0;     // animierter Wert
  let loopFlash = 0;

  // ---- Mitte: Iteration + Status
  const iterLabel = createLabel('Iteration 1', { size: 15, weight: 700, bg: null, color: '#ffffff' });
  iterLabel.position.set(0, 0.12, 0);
  const statusLabel = createLabel('', { size: 12, opacity: 0, maxWidth: 220 });
  statusLabel.position.set(0, -0.45, 0);
  root.add(iterLabel, statusLabel);

  // ---- Effekte (Kometen, Blitze, Bursts)
  let fx = [];
  function addFx(obj, update) { const f = { obj, update, t0: stage.time, dead: false }; fx.push(f); return f; }

  function comet(curve, color, dur) {
    return new Promise((resolve) => {
      const head = createGlowSprite(glowTex, color, 0.55, 1);
      const core = createGlowSprite(glowTex, '#ffffff', 0.2, 1);
      head.add(core);
      core.scale.set(0.4, 0.4, 1);
      const TRAIL = 22;
      const pos = new Float32Array(TRAIL * 3), col = new Float32Array(TRAIL * 3);
      const p0 = curve.getPoint(0);
      for (let i = 0; i < TRAIL; i++) { pos[i * 3] = p0.x; pos[i * 3 + 1] = p0.y; pos[i * 3 + 2] = p0.z; }
      const c = new THREE.Color(color);
      for (let i = 0; i < TRAIL; i++) { const f = 1 - i / TRAIL; col[i * 3] = c.r * f; col[i * 3 + 1] = c.g * f; col[i * 3 + 2] = c.b * f; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const trail = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.2, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      const grp = new THREE.Group();
      grp.add(head, trail);
      root.add(grp);
      const tmp = new THREE.Vector3();
      let arrived = false;
      addFx(grp, (f, now) => {
        const k = Math.min(1, (now - f.t0) / dur);
        curve.getPoint(Ease.inOutQuad(k), tmp);
        head.position.copy(tmp);
        pos.copyWithin(3, 0, (TRAIL - 1) * 3);
        pos[0] = tmp.x; pos[1] = tmp.y; pos[2] = tmp.z;
        geo.attributes.position.needsUpdate = true;
        if (k >= 1 && !arrived) { arrived = true; resolve(); }
        if (k >= 1) {
          const fade = Math.max(0, 1 - (now - f.t0 - dur) / 0.35);
          trail.material.opacity = fade; head.material.opacity = fade; core.material.opacity = fade;
          if (fade <= 0) return false;
        }
        return true;
      });
    });
  }

  function lightning(node) {
    const N = 9;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(N * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: COLORS.error, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    const line2 = new THREE.Line(geo, mat);
    line2.scale.set(-1, 1, 1);
    const grp = new THREE.Group();
    grp.position.copy(node.pos);
    grp.add(line, line2);
    root.add(grp);
    let last = -1;
    const dur = stage.reducedMotion ? 0.35 : 0.7;
    addFx(grp, (f, now) => {
      const e = now - f.t0;
      if (e > dur) return false;
      const step = Math.floor(e / 0.06);
      if (step !== last) {
        last = step;
        for (let i = 0; i < N; i++) {
          const k = i / (N - 1);
          arr[i * 3] = (i === 0 || i === N - 1 ? 0 : (Math.random() - 0.5) * 0.35) + 0.15 * k;
          arr[i * 3 + 1] = 1.25 - k * 0.9;
          arr[i * 3 + 2] = 0.3;
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = stage.reducedMotion ? 0.9 : (step % 2 ? 1 : 0.35);
      }
      return true;
    });
  }

  function burst(pos, color, count = 90) {
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(0.8 + Math.random() * 1.6);
      vel[i * 3] = v.x; vel[i * 3 + 1] = v.y; vel[i * 3 + 2] = v.z;
      arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ size: 0.22, map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);
    let prev = stage.time;
    addFx(pts, (f, now) => {
      const e = now - f.t0, dt = now - prev; prev = now;
      if (e > 1.8) return false;
      const damp = Math.pow(0.12, dt);
      for (let i = 0; i < count * 3; i++) { arr[i] += vel[i] * dt; vel[i] *= damp; }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 1 - e / 1.8;
      return true;
    });
  }

  // ---- Zustand
  let iteration = 1;
  let maxIter = opts.maxIterations ?? null;
  let lastAgent = null;
  let failedAgent = null;
  let finished = false;
  let realMode = false;
  let epoch = 0;
  const queue = [];
  let busy = false;
  let disposed = false;

  function setIteration(n) {
    iteration = n;
    iterLabel.setText(`Iteration ${n}${maxIter ? ` / ${maxIter}` : ''}`);
    iterLabel.element.animate?.([{ transform: 'scale(1.35)', color: COLORS.stale }, { transform: 'scale(1)', color: '#ffffff' }], { duration: 600 });
  }
  function setActive(key) { for (const k of ORDER) nodes[k].activeTarget = k === key ? 1 : 0; }
  function flash(node, color, amount = 1) { node.flash = amount; node.flashColor.set(color); node.ringT = 0; }
  function showMessage(node, msg, color) {
    for (const k of ORDER) nodes[k].bubble.setOpacity(0);
    if (!msg) return;
    node.bubble.setText(truncate(msg, 80));
    node.bubble.setBorder(color || node.color.getStyle());
    node.bubble.setOpacity(1);
  }
  function setStatus(text, color) {
    statusLabel.setText(text || '');
    statusLabel.setOpacity(text ? 1 : 0);
    statusLabel.setColor(color || COLORS.text);
    statusLabel.setBorder(color || 'rgba(124,92,255,0.35)');
  }

  function resetState() {
    iteration = 1; lastAgent = null; failedAgent = null; finished = false;
    loopVisible = 0; loopFlash = 0;
    setIteration(1);
    setActive(null);
    setStatus('');
    for (const k of ORDER) { nodes[k].bubble.setOpacity(0); nodes[k].flash = 0; }
  }

  const normAgent = (a) => { const s = String(a || '').toLowerCase(); return nodes[s] ? s : ALIASES[s] || null; };
  const wait = (s) => stage.wait(s);

  function cometBetween(from, to, color, dur) {
    if (from === 'verifier' && to === 'planner') return comet(loopCurveFull, color, dur);
    return comet(arcCurve(nodes[from].pos, nodes[to].pos, from === to ? 0.8 : 0.3, 0.25), color, dur);
  }

  async function handle(e, speed, myEpoch) {
    if (e.type === '__demo_restart') {
      await wait(3.5);
      if (myEpoch !== epoch || realMode) return;
      resetState();
      enqueueDemo();
      return;
    }
    if (e.payload?.max_iterations && !opts.maxIterations) maxIter = e.payload.max_iterations;
    if (e.type === 'final') {
      const orch = 'orchestrator';
      if (lastAgent && lastAgent !== orch) await cometBetween(lastAgent, orch, COLORS.accent, 0.6 * speed);
      if (myEpoch !== epoch) return;
      setActive(null);
      lastAgent = orch;
      finished = true;
      const abst = !!(e.abstained ?? e.answer?.abstained);
      const color = abst ? COLORS.grey : COLORS.ok;
      for (const k of ORDER) flash(nodes[k], color, 0.7);
      burst(nodes.orchestrator.pos, color, stage.reducedMotion ? 30 : 90);
      burst(center, color, stage.reducedMotion ? 20 : 60);
      const it = e.iterations ?? iteration;
      setStatus(abst ? `Enthaltung nach ${it} Iteration${it === 1 ? '' : 'en'} – keine belastbare Antwort` : `✓ Antwort fertig nach ${it} Iteration${it === 1 ? '' : 'en'}`, color);
      showMessage(nodes.orchestrator, abst ? 'Ich kann das mit den Quellen nicht sicher beantworten.' : truncate(e.answer?.text || 'Antwort ist belegt und wird ausgegeben.', 80), color);
      await wait(1.0 * speed);
      return;
    }
    if (e.type !== 'step') return;
    const agent = normAgent(e.agent);
    if (!agent) return;
    const node = nodes[agent];
    if (finished && e.status === 'start') resetState();
    if (e.iteration && e.iteration !== iteration && e.status !== 'retry') setIteration(e.iteration);

    switch (e.status) {
      case 'start': {
        if (lastAgent && lastAgent !== agent) await cometBetween(lastAgent, agent, COLORS.accent, 0.55 * speed);
        if (myEpoch !== epoch) return;
        lastAgent = agent;
        setActive(agent);
        flash(node, node.color.getStyle(), 0.6);
        showMessage(node, e.message);
        await wait(0.3 * speed);
        break;
      }
      case 'done': {
        lastAgent = agent;
        flash(node, COLORS.ok, 0.8);
        showMessage(node, e.message, COLORS.ok);
        await wait(0.35 * speed);
        break;
      }
      case 'fail': {
        lastAgent = agent;
        failedAgent = agent;
        setActive(agent);
        lightning(node);
        flash(node, COLORS.error, 1.2);
        showMessage(node, e.message, COLORS.error);
        setStatus('✗ Prüfung fehlgeschlagen', COLORS.error);
        loopVisible = 1;
        await wait(0.8 * speed);
        break;
      }
      case 'retry': {
        const from = failedAgent || lastAgent || 'verifier';
        loopVisible = 1; loopFlash = 1;
        showMessage(node, e.message, COLORS.error);
        setStatus('↺ Neuer Versuch', COLORS.stale);
        if (from !== 'planner') await cometBetween(from, 'planner', COLORS.error, 0.8 * speed);
        if (myEpoch !== epoch) return;
        lastAgent = 'planner';
        failedAgent = null;
        flash(nodes.planner, COLORS.stale, 1);
        setIteration(e.iteration ?? iteration + 1);
        await wait(0.3 * speed);
        setStatus('');
        break;
      }
      default: {
        lastAgent = agent; setActive(agent); showMessage(node, e.message);
        await wait(0.3 * speed);
      }
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length && !disposed) {
      const e = queue.shift();
      const speed = e.__demo ? 1.15 : queue.length > 5 ? 0.4 : queue.length > 2 ? 0.65 : 1;
      try { await handle(e, speed, epoch); } catch (err) { console.error('[3D agents]', err); }
    }
    busy = false;
  }

  function enqueueDemo() {
    for (const e of DEMO) queue.push({ ...e, __demo: true });
    queue.push({ type: '__demo_restart', __demo: true });
    pump();
  }

  function event(evt) {
    if (!evt || typeof evt !== 'object' || disposed) return;
    if (!evt.__demo && !realMode) {
      realMode = true;
      epoch++;
      queue.length = 0;
      resetState();
    }
    queue.push(evt);
    pump();
  }

  function reset() {
    epoch++;
    queue.length = 0;
    resetState();
  }

  // ---- Frame
  stage.onFrame((dt, t) => {
    const rm = stage.reducedMotion;
    if (!rm) root.rotation.y = Math.sin(t * 0.25) * 0.18;
    for (const k of ORDER) {
      const n = nodes[k];
      n.active += (n.activeTarget - n.active) * Math.min(1, dt * 6);
      n.flash = Math.max(0, n.flash - dt * 1.6);
      const pulse = rm ? 0 : Math.sin(t * 6) * 0.5 + 0.5;
      const s = 1 + n.active * (0.12 + 0.1 * pulse) + n.flash * 0.15;
      n.mesh.scale.setScalar(s);
      if (!rm) { n.mesh.rotation.y += dt * (0.3 + n.active * 1.5); n.mesh.rotation.x += dt * 0.15; }
      n.mat.emissiveIntensity = 0.3 + n.active * 0.6 + n.flash * 0.8;
      n.glow.material.color.copy(n.color).lerp(n.flashColor, Math.min(1, n.flash));
      n.glow.material.opacity = 0.15 + n.active * 0.35 + n.flash * 0.5;
      n.glow.scale.setScalar(1.8 + n.active * 0.4 + n.flash * 0.6);
      // Puls-Ring
      if (n.ringT >= 0) {
        n.ringT += dt;
        const k = n.ringT / 0.8;
        if (k >= 1) { n.ringT = n.active > 0.5 && !rm ? 0 : -1; n.ring.material.opacity = 0; }
        else { n.ring.scale.setScalar(1 + k * 1.2); n.ring.material.opacity = (1 - k) * 0.8; n.ring.material.color.copy(n.flash > 0.05 ? n.flashColor : n.color); }
      }
    }
    // Loop-Pfeil
    loopShown += (loopVisible - loopShown) * Math.min(1, dt * 3);
    loopFlash = Math.max(0, loopFlash - dt * 0.8);
    setTubeProgress(loopTube, loopShown);
    loopCone.visible = loopShown > 0.95;
    loopMat.opacity = loopShown > 0.01 ? 0.35 + 0.45 * loopFlash + (rm ? 0 : 0.15 * Math.sin(t * 4)) : 0;
    loopLabel.setOpacity(loopShown > 0.5 ? 1 : 0);
    // Effekte
    if (fx.length) {
      const now = stage.time;
      for (const f of fx) if (!f.dead && f.update(f, now) === false) { f.dead = true; disposeObject(f.obj); }
      fx = fx.filter((f) => !f.dead);
    }
  });

  // ---- Start
  function update(newData) {
    const evts = Array.isArray(newData) ? newData : Array.isArray(newData?.events) ? newData.events : null;
    if (evts) { reset(); realMode = true; evts.forEach(event); }
    else if (!newData && !realMode) { reset(); enqueueDemo(); }
  }
  if (opts.maxIterations) setIteration(1);
  update(data);

  return {
    update,
    event,
    reset() { reset(); },
    dispose() { disposed = true; epoch++; queue.length = 0; stage.dispose(); },
  };
}
