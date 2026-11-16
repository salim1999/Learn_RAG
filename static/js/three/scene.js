// Gemeinsame Helfer für alle 3D-Szenen der RAG Academy.
// Nur über die Import-Map: 'three' und 'three/addons/...'.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export { THREE, CSS2DObject };

// ---------------------------------------------------------------- Farben
export const COLORS = {
  accent: '#7c5cff',
  ok: '#2bd9a0',
  error: '#ff5c7a',
  stale: '#f5b942',
  text: '#e8e9f3',
  muted: '#8b90b8',
  grey: '#6c7090',
  panel: 'rgba(16, 17, 34, 0.78)',
};

/** Stabile Farbe je doc_id (kühle Töne, Gelb bleibt für „veraltet“ reserviert). */
export function docColor(docId) {
  const s = String(docId ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  const u = (h >>> 0) / 4294967295;
  const v = ((h >>> 8) & 255) / 255;
  const hue = (165 + u * 200) % 360; // 165°..365° → Türkis, Blau, Violett, Pink, Rot (kein Gelb)
  return new THREE.Color().setHSL(hue / 360, 0.6 + 0.3 * v, 0.56 + 0.16 * (1 - v));
}

// ---------------------------------------------------------------- Mathe / Easing
export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export const Ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
};

/** Glockenkurve: 0 → 1 → 0 innerhalb von [0, width]. */
export const bump = (x, width = 1) => (x <= 0 || x >= width ? 0 : Math.sin((x / width) * Math.PI));

export function prefersReducedMotion() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

export function truncate(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------- Texturen
/** Weicher radialer Glow (weiß, wird per Material eingefärbt). */
export function makeGlowTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Vierstrahliger Stern mit Kern-Glow. */
export function makeStarTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const h = size / 2;
  const radial = (r, a) => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  };
  ctx.translate(h, h);
  for (const [sx, sy] of [[1, 0.07], [0.07, 1]]) {
    ctx.save(); ctx.scale(sx, sy);
    ctx.fillStyle = radial(h, 1);
    ctx.beginPath(); ctx.arc(0, 0, h, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = radial(h * 0.45, 1);
  ctx.beginPath(); ctx.arc(0, 0, h * 0.45, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Additiver Glow-Sprite. */
export function createGlowSprite(texture, color = COLORS.accent, size = 1, opacity = 1) {
  const mat = new THREE.SpriteMaterial({
    map: texture, color: new THREE.Color(color), transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(size, size, 1);
  return s;
}

// ---------------------------------------------------------------- Labels
/**
 * CSS2D-Beschriftung. Text wird immer per textContent gesetzt (kein HTML).
 * opts: {color, size, bg, border, weight, maxWidth, anchor:'center'|'top'|'bottom', className, opacity}
 */
export function createLabel(text, opts = {}) {
  const el = document.createElement('div');
  el.className = 'rag3d-label' + (opts.className ? ' ' + opts.className : '');
  Object.assign(el.style, {
    font: `${opts.weight ?? 600} ${opts.size ?? 12}px/1.25 system-ui, -apple-system, "Segoe UI", sans-serif`,
    color: opts.color ?? COLORS.text,
    background: opts.bg === undefined ? COLORS.panel : opts.bg,
    border: opts.border ?? (opts.bg === null ? 'none' : '1px solid rgba(124,92,255,0.35)'),
    padding: opts.bg === null ? '0' : '2px 7px',
    borderRadius: '7px',
    whiteSpace: opts.maxWidth ? 'normal' : 'nowrap',
    maxWidth: opts.maxWidth ? opts.maxWidth + 'px' : '',
    textAlign: 'center',
    pointerEvents: 'none',
    userSelect: 'none',
    textShadow: '0 1px 3px rgba(0,0,0,0.7)',
    transition: 'opacity .25s ease, color .25s ease, border-color .25s ease',
    opacity: String(opts.opacity ?? 1),
  });
  el.textContent = text ?? '';
  const obj = new CSS2DObject(el);
  if (opts.anchor === 'top') obj.center.set(0.5, 0);       // Label hängt unter dem Punkt
  else if (opts.anchor === 'bottom') obj.center.set(0.5, 1); // Label steht über dem Punkt
  obj.setText = (t) => { if (el.textContent !== t) el.textContent = t; };
  obj.setColor = (c) => { el.style.color = c; };
  obj.setBorder = (c) => { el.style.borderColor = c; };
  obj.setOpacity = (o) => { el.style.opacity = String(o); };
  return obj;
}

// ---------------------------------------------------------------- Geometrie-Helfer
/** Zylinder mit Basis im Ursprung entlang +Y (Länge 1) – für wachsende Strahlen. */
export function makeBeamGeometry(radius = 1, radial = 6) {
  const g = new THREE.CylinderGeometry(radius, radius, 1, radial, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

const _Y = new THREE.Vector3(0, 1, 0);
const _tmpDir = new THREE.Vector3();
/** Richtet einen Beam-Mesh von a nach b aus; progress 0..1 bestimmt die Länge. */
export function aimBeam(mesh, a, b, progress = 1, radius = 0.01) {
  _tmpDir.subVectors(b, a);
  const len = _tmpDir.length();
  if (len < 1e-6) { mesh.visible = false; return; }
  mesh.visible = progress > 0.001;
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(_Y, _tmpDir.divideScalar(len));
  mesh.scale.set(radius, len * progress, radius);
}

/** Tube entlang einer Kurve; drawRange-Wachstum über setTubeProgress(). */
export function makeTube(curve, radius, material, segments = 48, radial = 5) {
  const geo = new THREE.TubeGeometry(curve, segments, radius, radial, false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.userData.tubeIndexCount = geo.index ? geo.index.count : geo.attributes.position.count;
  return mesh;
}
export function setTubeProgress(mesh, k) {
  const total = mesh.userData.tubeIndexCount;
  const n = Math.floor(clamp01(k) * total / 6) * 6;
  mesh.geometry.setDrawRange(0, n);
  mesh.visible = n > 0;
}

// ---------------------------------------------------------------- Dispose
function disposeMaterial(m, force) {
  if (!m || (m.userData?.shared && !force)) return;
  for (const key in m) {
    const v = m[key];
    if (v && v.isTexture && (!v.userData?.shared || force)) v.dispose();
  }
  m.dispose();
}

/** Entfernt ein Objekt und gibt Geometrien/Materialien frei (geteilte bleiben, s. userData.shared). */
export function disposeObject(obj, force = false) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry && (!o.geometry.userData?.shared || force)) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => disposeMaterial(m, force));
      else disposeMaterial(o.material, force);
    }
    if (o.isInstancedMesh) o.dispose(); // gibt Instanz-Buffer im Renderer frei
    if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
  });
  if (obj.parent) obj.parent.remove(obj);
}

/** Markiert Ressource als geteilt (disposeObject lässt sie stehen; stage.dispose räumt sie ab). */
export function shared(res) { res.userData = res.userData || {}; res.userData.shared = true; return res; }

// ---------------------------------------------------------------- Stage
/**
 * createStage(container, opts) → { scene, camera, renderer, labelRenderer, controls, clock, wrap,
 *   reducedMotion, time, onFrame(fn), onResize(fn), onDispose(fn), tween(), after(), wait(),
 *   fit(w,h,depth), setHover(cfg), glowTexture(), starTexture(), track(res), size, dispose() }
 *
 * opts: fov, cameraPosition [x,y,z], target [x,y,z], autoRotate (true), autoRotateSpeed (0.35),
 *       controls (true), zoom (false), pan (false), labels (true), lights (true), minHeight (280),
 *       maxPixelRatio (2), reducedMotion (auto)
 */
export function createStage(container, opts = {}) {
  if (!container || !(container instanceof Element)) throw new Error('3D-Szene: Kein gültiger Container übergeben.');
  const reducedMotion = opts.reducedMotion ?? prefersReducedMotion();

  const wrap = document.createElement('div');
  wrap.className = 'rag3d-stage';
  Object.assign(wrap.style, {
    position: 'relative', width: '100%', height: '100%',
    minHeight: (opts.minHeight ?? 280) + 'px', overflow: 'hidden',
  });
  container.appendChild(wrap);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    wrap.remove();
    throw new Error('WebGL ist in diesem Browser nicht verfügbar.');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', outline: 'none' });
  canvas.setAttribute('aria-hidden', 'true');
  wrap.appendChild(canvas);

  let labelRenderer = null;
  if (opts.labels !== false) {
    labelRenderer = new CSS2DRenderer();
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', overflow: 'hidden' });
    wrap.appendChild(labelRenderer.domElement);
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 45, 1, 0.05, 300);
  const target = new THREE.Vector3(...(opts.target ?? [0, 0, 0]));
  camera.position.set(...(opts.cameraPosition ?? [0, 1.5, 6]));
  camera.lookAt(target);

  if (opts.lights !== false) {
    scene.add(new THREE.HemisphereLight(0xcfd2ff, 0x1a1530, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6);
    dl.position.set(3, 5, 4);
    scene.add(dl);
  }

  let controls = null;
  let autoRotatePause = null;
  if (opts.controls !== false) {
    controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableZoom = !!opts.zoom; // Standard aus, damit Seiten-Scrollen nicht abgefangen wird
    controls.enablePan = !!opts.pan;
    controls.rotateSpeed = 0.6;
    controls.autoRotate = !reducedMotion && opts.autoRotate !== false;
    controls.autoRotateSpeed = opts.autoRotateSpeed ?? 0.35;
    if (opts.minPolar != null) controls.minPolarAngle = opts.minPolar;
    if (opts.maxPolar != null) controls.maxPolarAngle = opts.maxPolar;
    if (opts.azimuthRange != null) {
      controls.minAzimuthAngle = -opts.azimuthRange;
      controls.maxAzimuthAngle = opts.azimuthRange;
    }
    controls.update();
    // Nach Benutzer-Interaktion Auto-Rotate kurz pausieren
    controls.addEventListener('start', () => {
      if (!controls.autoRotate && !autoRotatePause) return;
      controls.autoRotate = false;
      if (autoRotatePause) autoRotatePause.cancel();
      autoRotatePause = after(6, () => { autoRotatePause = null; controls.autoRotate = !reducedMotion && opts.autoRotate !== false; });
    });
  }

  const clock = new THREE.Clock(false);
  let time = 0;
  let raf = 0;
  let disposed = false;
  let frameFns = [];
  const resizeFns = [];
  const disposeFns = [];
  const tracked = new Set();
  let tweens = [];
  const size = { width: 1, height: 1 };

  // ---- Kamera-Fit
  let fitBox = null;
  function applyFit() {
    if (!fitBox) return;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const dH = fitBox.h / 2 / tan;
    const dW = fitBox.w / 2 / (tan * camera.aspect);
    const d = Math.max(dH, dW) * fitBox.margin + fitBox.depth / 2;
    const t = controls ? controls.target : target;
    const dir = camera.position.clone().sub(t);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();
    camera.position.copy(t).addScaledVector(dir, d);
    if (controls) { controls.minDistance = d * 0.45; controls.maxDistance = d * 2.2; }
  }

  // ---- Resize
  function resize() {
    if (disposed) return;
    const w = Math.max(1, wrap.clientWidth);
    const h = Math.max(1, wrap.clientHeight);
    if (w === size.width && h === size.height) return;
    size.width = w; size.height = h;
    renderer.setSize(w, h, false);
    labelRenderer?.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyFit();
    for (const fn of resizeFns) fn(w, h);
    if (!raf) renderOnce();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(wrap);
  if (!ro) window.addEventListener('resize', resize);

  // ---- Sichtbarkeit (Tab + Viewport)
  let tabVisible = !document.hidden;
  let inView = true;
  const onVisibility = () => { tabVisible = !document.hidden; sync(); };
  document.addEventListener('visibilitychange', onVisibility);
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => { inView = entries[entries.length - 1].isIntersecting; sync(); }, { threshold: 0 })
    : null;
  io?.observe(wrap);

  function sync() {
    const run = !disposed && tabVisible && inView;
    if (run && !raf) { clock.start(); raf = requestAnimationFrame(frame); }
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; clock.stop(); }
  }

  // ---- Hover / Raycasting
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false, pointerDirty = false, px = 0, py = 0, hoverFrame = 0;
  let hoverCfg = null, tooltip = null, lastHoverKey = null;
  function onPointerMove(e) {
    const r = canvas.getBoundingClientRect();
    px = e.clientX - r.left; py = e.clientY - r.top;
    pointer.set((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1);
    pointerInside = true; pointerDirty = true;
  }
  function onPointerLeave() { pointerInside = false; pointerDirty = true; }
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'rag3d-tooltip';
    Object.assign(tooltip.style, {
      position: 'absolute', left: '0', top: '0', zIndex: '3', pointerEvents: 'none', display: 'none',
      maxWidth: '280px', padding: '7px 10px', borderRadius: '9px',
      background: 'rgba(14, 15, 30, 0.94)', border: '1px solid rgba(124,92,255,0.55)',
      color: COLORS.text, font: '500 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    });
    wrap.appendChild(tooltip);
    return tooltip;
  }
  function showTooltip(info) {
    const tt = ensureTooltip();
    const key = info.key ?? (info.title + '|' + (info.lines || []).join('|'));
    if (key !== lastHoverKey) {
      lastHoverKey = key;
      tt.replaceChildren();
      const t = document.createElement('div');
      t.style.fontWeight = '700';
      if (info.color) t.style.color = info.color;
      t.textContent = info.title ?? '';
      tt.appendChild(t);
      for (const line of info.lines || []) {
        const d = document.createElement('div');
        d.style.opacity = '0.85';
        d.textContent = line;
        tt.appendChild(d);
      }
    }
    tt.style.display = 'block';
    const w = tt.offsetWidth, h = tt.offsetHeight;
    let x = px + 14, y = py + 14;
    if (x + w > size.width - 4) x = Math.max(4, px - w - 14);
    if (y + h > size.height - 4) y = Math.max(4, py - h - 14);
    tt.style.transform = `translate(${x}px, ${y}px)`;
  }
  function hideTooltip() {
    if (tooltip) tooltip.style.display = 'none';
    lastHoverKey = null;
    canvas.style.cursor = '';
  }
  function runHover() {
    if (!hoverCfg) return;
    hoverFrame++;
    if (!pointerDirty && !(pointerInside && hoverFrame % 8 === 0)) return;
    pointerDirty = false;
    if (!pointerInside) { hideTooltip(); hoverCfg.onHover?.(null); return; }
    raycaster.setFromCamera(pointer, camera);
    if (hoverCfg.pointsThreshold != null) raycaster.params.Points.threshold = hoverCfg.pointsThreshold;
    const targets = (typeof hoverCfg.targets === 'function' ? hoverCfg.targets() : hoverCfg.targets) || [];
    const hits = targets.length ? raycaster.intersectObjects(targets, hoverCfg.recursive ?? false) : [];
    for (const hit of hits) {
      const info = hoverCfg.describe(hit);
      if (info) { showTooltip(info); canvas.style.cursor = 'help'; hoverCfg.onHover?.(hit, info); return; }
    }
    hideTooltip();
    hoverCfg.onHover?.(null);
  }

  // ---- Timer & Tweens (laufen in Szenenzeit → pausieren mit dem Loop)
  function tween({ duration = 1, delay = 0, ease = Ease.inOutCubic, onStart, onUpdate, onComplete } = {}) {
    const tw = { start: time + delay, duration: Math.max(1e-4, duration), ease, onStart, onUpdate, onComplete, started: false, done: false };
    tw.cancel = () => { tw.done = true; };
    tweens.push(tw);
    return tw;
  }
  function after(seconds, fn) { return tween({ duration: 1e-4, delay: seconds, ease: Ease.linear, onComplete: fn }); }
  function wait(seconds) { return new Promise((res) => after(seconds, res)); }
  function runTweens() {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (tw.done) { tweens.splice(i, 1); continue; }
      if (time < tw.start) continue;
      if (!tw.started) { tw.started = true; tw.onStart?.(); }
      const k = clamp01((time - tw.start) / tw.duration);
      tw.onUpdate?.(tw.ease(k), k);
      if (k >= 1) {
        tw.done = true;
        tweens.splice(i, 1);
        tw.onComplete?.();
      }
    }
  }

  // ---- Loop
  function renderOnce() {
    if (disposed) return;
    renderer.render(scene, camera);
    labelRenderer?.render(scene, camera);
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 1 / 15);
    time += dt;
    runTweens();
    const fns = frameFns;
    for (let i = 0; i < fns.length; i++) {
      try { fns[i](dt, time); } catch (e) { console.error('[3D] Frame-Fehler:', e); frameFns = frameFns.filter((f) => f !== fns[i]); }
    }
    controls?.update(dt);
    runHover();
    renderOnce();
  }

  const stage = {
    scene, camera, renderer, labelRenderer, controls, clock, wrap, canvas: canvas, reducedMotion, size, raycaster,
    get time() { return time; },
    get disposed() { return disposed; },
    onFrame(fn) { frameFns = [...frameFns, fn]; return () => { frameFns = frameFns.filter((f) => f !== fn); }; },
    onResize(fn) { resizeFns.push(fn); },
    onDispose(fn) { disposeFns.push(fn); },
    tween, after, wait,
    fit(w, h, depth = 0, margin = 1.08) { fitBox = { w, h, depth, margin }; applyFit(); },
    setHover(cfg) { hoverCfg = cfg; if (!cfg) hideTooltip(); },
    track(res) { if (res) tracked.add(res); return res; },
    _glow: null, _star: null,
    glowTexture() { return this._glow || (this._glow = stage.track(shared(makeGlowTexture()))); },
    starTexture() { return this._star || (this._star = stage.track(shared(makeStarTexture()))); },
    renderOnce,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const fn of disposeFns) { try { fn(); } catch (e) { console.error(e); } }
      tweens = []; frameFns = [];
      ro?.disconnect();
      if (!ro) window.removeEventListener('resize', resize);
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      controls?.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => disposeMaterial(m, true));
        // InstancedMesh owns instanceMatrix/instanceColor buffers in addition
        // to its geometry. renderer.dispose alone does not release its objects.
        if (o.isInstancedMesh) o.dispose();
        if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
      });
      for (const r of tracked) { try { r.dispose?.(); } catch { /* ignorieren */ } }
      tracked.clear();
      scene.clear();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* ignorieren */ }
      wrap.remove();
    },
  };

  resize();
  sync();
  return stage;
}

/** Kleine Legende unten links (DOM-Overlay im Stage-Wrapper). items: [{color, label, shape?}] */
export function addLegend(stage, items, position = 'bottom-left') {
  const el = document.createElement('div');
  el.className = 'rag3d-legend';
  const [v, h] = position.split('-');
  Object.assign(el.style, {
    position: 'absolute', [v]: '8px', [h]: '10px', zIndex: '2', pointerEvents: 'none',
    display: 'flex', flexWrap: 'wrap', gap: '4px 12px', maxWidth: 'calc(100% - 20px)',
    font: '500 11px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif', color: COLORS.text, opacity: '0.85',
  });
  for (const it of items) {
    const row = document.createElement('span');
    row.style.display = 'inline-flex'; row.style.alignItems = 'center'; row.style.gap = '5px';
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '9px', height: '9px', borderRadius: it.shape === 'square' ? '2px' : '50%', background: it.color,
      boxShadow: `0 0 6px ${it.color}`, opacity: String(it.opacity ?? 1), display: 'inline-block',
    });
    const txt = document.createElement('span');
    txt.textContent = it.label;
    row.append(dot, txt);
    el.appendChild(row);
  }
  stage.wrap.appendChild(el);
  return el;
}
