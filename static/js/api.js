// RAG Academy – HTTP-Wrapper für die Backend-API (siehe CONTRACTS.md §3)

const BASE = '/api';

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, 'Server nicht erreichbar. Läuft „python run.py“?');
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    let detail = data && typeof data === 'object' ? data.detail : data;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
    throw new ApiError(res.status, typeof detail === 'string' ? detail : `Fehler ${res.status}`);
  }
  return data;
}

export const api = {
  status: () => request('/status'),
  levels: () => request('/levels'),
  level: (id) => request(`/levels/${encodeURIComponent(id)}`),
  /**
   * Antwort einreichen. `answer` ist das Objekt aus getAnswer().
   * Für Boss-Aufgaben: answer = {step: i, answer: {...}} – wird unverändert durchgereicht.
   */
  submit: (levelId, taskId, answer) =>
    request(`/levels/${encodeURIComponent(levelId)}/tasks/${encodeURIComponent(taskId)}/submit`, {
      method: 'POST',
      body: { answer },
    }),
  submitBossStep: (levelId, taskId, step, answer) =>
    api.submit(levelId, taskId, { step, answer }),
  progress: () => request('/progress'),
  reset: () => request('/progress/reset', { method: 'POST' }),
  corpus: () => request('/corpus'),
  /** GPU-Endpoint (RunPod) aufwärmen – Kaltstart kann 1–3 Minuten dauern */
  gpuWarmup: () => request('/gpu/warmup'),
  ragRun: (config) => request('/rag/run', { method: 'POST', body: config || {} }),

  /**
   * Agenten-Stream via EventSource.
   * onEvent(evt) wird für jedes JSON-Event aufgerufen; zusätzlich
   * {type:"error", message} bei Verbindungsproblemen vor dem "final"-Event.
   * Rückgabe: Funktion zum Abbrechen.
   */
  agentsStream(params, onEvent) {
    const q = new URLSearchParams();
    const p = { max_iterations: 3, force_fail_first: false, use_llm: false, ...params };
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const es = new EventSource(`${BASE}/agents/stream?${q.toString()}`);
    let finished = false;
    const close = () => { finished = true; es.close(); };
    es.onmessage = (msg) => {
      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }
      if (evt && evt.type === 'final') {
        close();
      }
      onEvent(evt);
    };
    es.onerror = () => {
      if (finished) return;
      close();
      onEvent({ type: 'error', message: 'Verbindung zum Agenten-Stream unterbrochen.' });
    };
    return close;
  },
};

export default api;
