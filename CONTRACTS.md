# RAG Academy – Verträge (verbindlich für alle Teil-Agenten)

UI-Sprache: **Deutsch**. Ein lokaler Spieler, keine Auth. Server: FastAPI, `python run.py` → http://localhost:8000.
Statische Dateien unter `/static/...`, `GET /` liefert `static/index.html`.

## Datei-Besitz (nur eigene Dateien bearbeiten!)
| Agent | Besitzt |
|---|---|
| A Backend | `app/**/*.py`, `tests/**`, `requirements.txt` (Ergänzungen) |
| B Inhalte | `app/content/**` (JSON) |
| C Frontend | `static/index.html`, `static/css/**`, `static/js/*.js`, `static/js/tasks/**` |
| D Three.js | `static/js/three/**` |

---
## 1. Korpus – `app/content/corpus/default.json`
```json
{ "id": "default", "title": "...", "as_of": "2026-11-16",
  "documents": [
    { "id": "d01", "title": "...", "source": "Handbuch v2", "date": "2024-03-01",
      "version": "2.0", "superseded_by": "d07" , "tags": ["pricing"],
      "text": "Mehrere Absätze Fließtext ..." }
  ] }
```
Thema: fiktive Firma **„NovaCloud“** (Produkt-Doku, Preise, Limits, API-Versionen, Support-Richtlinien, Sicherheits-FAQ) über 2022–2026 – bewusst mit veralteten Versionen (`superseded_by`), Widersprüchen, einem Dokument mit eingeschleuster Prompt-Injection (`tags: ["injection"]`), und Fragen, die der Korpus NICHT beantwortet (für Abstain). ~25–35 Dokumente, je 80–300 Wörter. `superseded_by` ist `null` oder eine Dokument-ID.

## 2. Level – `app/content/levels/level_XX.json` (XX = 01..14)
```json
{ "id": 1, "title": "Was ist RAG?", "subtitle": "...", "icon": "🧭", "color": "#7c5cff",
  "theory": [ { "heading": "...", "body_md": "Markdown", "key_points": ["..."],
                "visual": "pipeline|vectorspace|agents|timeline|hallucination|null" } ],
  "tasks": [ TASK, ... ] }
```
TASK gemeinsame Felder: `id` (z.B. `"l01t03"`), `type`, `title`, `prompt` (Markdown), `xp` (int, 10–60), `difficulty` (1–3), `hint` (optional), `explanation` (Markdown, wird NACH dem Absenden gezeigt), `visual` (optional, Szene nach dem Absenden), `solution` (Objekt, **wird vom Server vor Auslieferung entfernt**).

### Aufgabentypen: Felder → Antwortformat (`answer`) → `solution`
| type | Zusätzliche Felder (öffentlich) | answer (Client → Server) | solution (geheim) |
|---|---|---|---|
| `quiz` | `options:[{id,text}]`, `multi:bool` | `{"selected":["a"]}` | `{"correct":["a"],"option_explanations":{"a":"..."}}` |
| `better` | `scenario` (md), `variant_a:{label,description}`, `variant_b:{...}`, optional `run:{query, config_a:PipelineConfig, config_b:PipelineConfig}` | `{"choice":"a","reason":"Freitext"}` | `{"correct":"a","why":"md"}` |
| `order` | `items:[{id,text}]` (Client mischt) | `{"order":["id",...]}` | `{"order":["id",...]}` |
| `spot` | `context:[{id,text}]`, `answer_sentences:[{id,text}]` | `{"selected":["s2"]}` | `{"hallucinated":["s2"],"notes":{"s2":"warum"}}` |
| `tune` | `query`, `params:[{name,label,min,max,step,default}]` (Namen = Pfade in PipelineConfig, z.B. `"chunking.size"`, `"retrieval.k"`, `"freshness.half_life_days"`, `"generation.abstain_threshold"`), `target:{metric,threshold,label}`, `base_config:PipelineConfig` | `{"params":{"retrieval.k":4}}` | `{"relevant_doc_ids":["d03"],"example_params":{...}}` |
| `freshness` | `question`, `documents:[{id,title,date,version,text,source}]`, `options:[{id,text}]` | `{"choice":"x"}` | `{"correct":"x","why":"md"}` |
| `code` | `language:"python"`, `template` (Code mit Platzhaltern `{{1}}`, `{{2}}`), `blanks:[{id:"1",placeholder}]` | `{"blanks":{"1":"..."}}` | `{"blanks":{"1":["np.dot(a, b)","a @ b"]}}` – AST-Whitelist mit begrenztem Interpreter und vordefinierten Testfällen; kein eval/exec. Für neue, noch nicht mit Testfällen hinterlegte Aufgaben: AST-normalisierter Mustervergleich |
| `explain` | `question` | `{"text":"..."}` | `{"rubric":[{"concept":"...","keywords":["..",".."]}],"model_answer":"md","pass_ratio":0.6}` |
| `boss` | `story` (md), `lives:3`, `steps:[TASK ohne boss]` | `{"step":0,"answer":{...}}` | in den Steps |

Bewertung (`score` 0..1): quiz=Jaccard (single: 0/1), better: richtige Wahl=1 (Begründung nur Feedback), order=Anteil korrekter Positionen (1 wenn exakt), spot=F1, tune: Server führt Pipeline aus; score=1 wenn `metric>=threshold` sonst metric/threshold, freshness 0/1, code=Anteil korrekter Lücken, explain=Anteil getroffener Rubrik-Konzepte (≥pass_ratio → 1; mit Claude: Claude-Bewertung), boss: pro Step; Task-Score = gelöste Steps/Steps.
`correct = score >= 0.999` (explain/tune: `score>=1`).
Metriken für `tune.target.metric`: `recall_at_k`, `precision_at_k`, `mrr`, `faithfulness`, `freshness_score`, `context_precision`.

## 3. HTTP-API (Präfix `/api`)
- `GET /api/status` → `{"llm_enabled":bool,"model":"<ANTHROPIC_MODEL>"|null,"version":"1.0","gpu_enabled":bool,"gpu_models":{"embedding":"intfloat/multilingual-e5-base","rerank":"BAAI/bge-reranker-v2-m3"}|{}}`
- `GET /api/gpu/warmup` → stößt Kaltstart des optionalen RunPod-Endpunkts an: `{"gpu_enabled","status":"disabled|warming|ready|error","message",...}`
- `GET /api/levels` → `[{id,title,subtitle,icon,color,task_count,unlocked,stars,score_pct}]`
- `GET /api/levels/{id}` → Level ohne `solution` (auch in boss-steps); gesperrt → 403 `{"detail":"Level gesperrt"}`
- `POST /api/levels/{id}/tasks/{task_id}/submit` body `{"answer":{...}}` →
  `{"correct":bool,"score":float,"xp_awarded":int,"feedback":"md","explanation":"md","details":{...},"progress":PROGRESS}`
  `details` je Typ: quiz `{correct:[..],option_explanations}`, better `{correct,why}`, order `{order}`, spot `{hallucinated,notes}`, tune `{metric_value,metrics,run:RUN_RESPONSE}`, freshness `{correct,why}`, code `{per_blank:{"1":true},expected:{"1":"..."}}`, explain `{hits:[concept],misses:[concept],model_answer,graded_by:"rubric"|"claude"}`, boss `{step,step_correct,lives_left,finished,step_details}`.
- `POST /api/levels/{id}/tasks/{task_id}/restart` → Boss-Versuch mit drei Leben und Schritt 0; Bestwerte/XP bleiben erhalten. Boss-Abgaben müssen die erste ungelöste Etappe betreffen. Nach Fehler kann dieselbe Etappe erneut versucht werden; nach Sieg oder Niederlage beginnt der nächste Versuch bei Schritt 0.
- `GET /api/progress` → PROGRESS; `POST /api/progress/reset`
  PROGRESS = `{"player":{"xp":int,"rank":"str","next_rank_xp":int|null,"streak_days":int,"badges":[{id,name,icon,description}]},"levels":{"1":{"unlocked":bool,"score_pct":float,"stars":0-3,"best_scores":{"l01t01":1.0}}}}`
  XP-Vergabe: `max(0, round(task.xp * new_best) - bereits_vergebene_task_xp)`; Bestwert und XP werden atomar gespeichert. Dadurch können Rundungen bei Teilpunkten keine zusätzlichen XP erzeugen. Level 1 immer offen; Level n offen wenn `score_pct(n-1) >= 0.7`. Sterne: ≥0.7→1, ≥0.85→2, 1.0→3. Ränge nach XP: 0 „Token-Lehrling“, 150 „Chunk-Schmied“, 400 „Vektor-Navigator“, 800 „Retrieval-Ritter“, 1300 „Grounding-Wächter“, 2000 „RAG-Architekt“, 3000 „Halluzinations-Bezwinger“.
- `GET /api/corpus` → `{id,title,as_of,documents:[...]}`
- `POST /api/rag/run` body PipelineConfig → RUN_RESPONSE
- `GET /api/agents/stream?query=...&max_iterations=3&force_fail_first=false&use_llm=false` → `text/event-stream`, je Event `data: <json>\n\n`:
  `{"type":"step","agent":"planner|retriever|generator|verifier|orchestrator","iteration":1,"status":"start|done|fail|retry","message":"deutscher Text","payload":{...}}`
  Abschluss `{"type":"final","answer":ANSWER,"abstained":bool,"iterations":int,"chunks":[CHUNK]}`. Server wartet ~0.35 s zwischen Events (für Animation).

### PipelineConfig (alle Felder optional, Defaults angegeben)
```json
{ "query": "Wie viel kostet der Pro-Plan?", "corpus": "default",
  "chunking":  {"strategy":"fixed|sentence|recursive", "size":300, "overlap":50},
  "retrieval": {"method":"tfidf|bm25|hybrid|dense|hybrid_dense", "k":4, "mmr":false, "mmr_lambda":0.7, "rerank":false,
                 "rerank_mode":"heuristic|cross_encoder"},
  "freshness": {"enabled":false, "half_life_days":365, "drop_superseded":false, "as_of":"2026-11-16"},
  "generation":{"mode":"extractive|llm", "strict_grounding":true, "abstain_threshold":0.2, "require_citations":true},
  "verify": true }
```
`size`/`overlap` in Zeichen.
Optionaler GPU-Modus (RunPod, nur mit `RUNPOD_API_KEY` + `RUNPOD_EMBED_ENDPOINT_ID`): `dense` = e5-Embeddings, `hybrid_dense` = BM25 + dense, `rerank_mode:"cross_encoder"` (wirkt nur mit `rerank:true`). Ohne GPU/bei Fehler Fallback auf `tfidf` bzw. `hybrid` / heuristisch; der Trace meldet das (z.B. „GPU nicht erreichbar → TF-IDF-Fallback“), `trace[retrieval].data.method` zeigt die tatsächlich genutzte Methode.

### RUN_RESPONSE
```json
{ "config": PipelineConfig,
  "trace": [ {"stage":"chunking|embedding|retrieval|freshness|rerank|generation|verification","title":"...","message":"...","ms":1.2,"data":{}} ],
  "chunks": [ CHUNK ],          // die abgerufenen top-k, in Rangfolge
  "answer": ANSWER,
  "metrics": {"faithfulness":0.9,"context_precision":0.75,"answer_relevance":0.6,"freshness_score":1.0,"stale_in_context":0},
  "points3d": [ {"id":"d01#0","doc_id":"d01","x":0.1,"y":-0.4,"z":0.2,"retrieved":true,"stale":false,"rank":1} ],
  "query3d": {"x":0,"y":0,"z":0} }
CHUNK  = {"id":"d01#0","doc_id":"d01","title":"...","text":"...","score":0.42,"date":"2024-03-01","stale":false,"superseded_by":null,"rank":1}
ANSWER = {"text":"...","abstained":false,"sentences":[{"text":"...","citations":["d01#0"],"grounding":0.82,"supported":true}]}
```
`points3d` = alle Chunks des Korpus (max. 400), PCA→3D, auf [-1,1] normiert; Query mit gleicher Projektion.

## 4. Three.js-Szenen – `static/js/three/<name>.js`
Import-Map in `index.html`:
```json
{"imports":{"three":"/static/vendor/three/build/three.module.js",
            "three/addons/":"/static/vendor/three/examples/jsm/"}}
```
Jede Szene: `export function mount(container, data = null, opts = {}) → { update(data), dispose(), ...extra }`.
`data = null` ⇒ eigene sinnvolle Demo-Animation. Canvas füllt `container` (ResizeObserver), `prefers-reduced-motion` respektieren, `dispose()` gibt alles frei. Gemeinsame Helfer in `static/js/three/scene.js`. Farben: Hintergrund transparent, Akzent `#7c5cff`, OK `#2bd9a0`, Fehler `#ff5c7a`, veraltet `#f5b942`, Text `#e8e9f3`.
| Szene | data |
|---|---|
| `vectorspace` | RUN_RESPONSE (nutzt `points3d`, `query3d`) |
| `pipeline` | RUN_RESPONSE oder null; extra `play()` |
| `agents` | null; extra `event(evt)` – nimmt Agenten-Stream-Events entgegen |
| `timeline` | `{documents:[{id,title,date,superseded_by}], as_of, highlight:"id"?}` |
| `hallucination` | `{sentences:[{text,supported,citations}], chunks:[{id,title}]}` oder spot-Task (`context`,`answer_sentences`,`hallucinated`) |
Eine Registry `static/js/three/index.js`: `export async function mountScene(name, container, data, opts)` (dynamischer import).

## 5. Frontend-Aufgabenmodule – `static/js/tasks/<type>.js`
`export function render(container, task, ctx) → { getAnswer(): object|null, showResult(result), dispose() }`
`ctx = { api, level, mountScene, renderMarkdown, onReady(bool) }` – `onReady(true)` sobald eine gültige Antwort vorliegt (aktiviert den „Prüfen“-Knopf). `api` = Wrapper aus `static/js/api.js`.
