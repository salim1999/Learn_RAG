// Registry für alle 3D-Szenen. Verwendung:
//   import { mountScene } from './three/index.js';
//   const handle = await mountScene('pipeline', el, runResponse, {});
//   handle.update(data); handle.play?.(); handle.dispose();
const SCENES = {
  vectorspace: () => import('./vectorspace.js'),
  pipeline: () => import('./pipeline.js'),
  agents: () => import('./agents.js'),
  timeline: () => import('./timeline.js'),
  hallucination: () => import('./hallucination.js'),
};

export const SCENE_NAMES = Object.freeze(Object.keys(SCENES));

let webglOk = null;
export function isWebGLAvailable() {
  if (webglOk !== null) return webglOk;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    webglOk = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { webglOk = false; }
  return webglOk;
}

/** Ersatzanzeige, wenn WebGL fehlt – gleiche Schnittstelle wie eine Szene (alle Methoden no-op). */
function fallback(container, name, reason) {
  const el = document.createElement('div');
  el.className = 'rag3d-fallback';
  Object.assign(el.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px', height: '100%',
    padding: '16px', textAlign: 'center', color: '#e8e9f3', opacity: '0.75',
    font: '500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
    border: '1px dashed rgba(124,92,255,0.5)', borderRadius: '12px',
  });
  el.textContent = `3D-Visualisierung „${name}“ nicht verfügbar: ${reason}`;
  container.appendChild(el);
  const noop = () => {};
  return new Proxy({ update: noop, dispose: () => el.remove(), fallback: true }, {
    get: (target, prop) => (prop in target ? target[prop] : typeof prop === 'string' ? noop : undefined),
  });
}

/**
 * Montiert eine Szene in `container`.
 * @param {string} name – 'vectorspace' | 'pipeline' | 'agents' | 'timeline' | 'hallucination'
 * @param {HTMLElement} container
 * @param {object|null} data – siehe CONTRACTS.md, Abschnitt 4 (null ⇒ Demo)
 * @param {object} opts – szenenspezifisch, optional `opts.stage` für createStage-Optionen
 * @returns {Promise<{update(data), dispose(), ...extras}>}
 */
export async function mountScene(name, container, data = null, opts = {}) {
  const loader = Object.prototype.hasOwnProperty.call(SCENES, name) ? SCENES[name] : null;
  if (!loader) {
    throw new Error(`Unbekannte 3D-Szene „${name}“. Verfügbar sind: ${SCENE_NAMES.join(', ')}.`);
  }
  if (!container || !(container instanceof Element)) {
    throw new Error(`3D-Szene „${name}“: Es wurde kein gültiges Container-Element übergeben.`);
  }
  if (!isWebGLAvailable()) return fallback(container, name, 'WebGL wird von diesem Browser nicht unterstützt.');
  const mod = await loader();
  try {
    return mod.mount(container, data ?? null, opts || {});
  } catch (err) {
    console.error(`[3D] Szene „${name}“ konnte nicht gestartet werden:`, err);
    return fallback(container, name, err?.message || 'Unbekannter Fehler');
  }
}
