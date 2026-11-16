# RAG Academy · Learn_RAG

Eine deutschsprachige, spielbare Lern-App für Retrieval-Augmented Generation. Von den Grundlagen über Halluzinationen und Quellenprüfung bis zu Agentic RAG, GraphRAG und Produktion.

**14 Level · 84 Aufgaben · 53 Boss-Etappen · 32 Dokumente · ohne API-Key nutzbar**

## Starten

Voraussetzung: Python 3.11 oder neuer. Für die einmalige Paketinstallation ist Internet nötig; anschließend laufen der Kurs, das RAG-Labor und die 3D-Szenen lokal.

```bash
git clone https://github.com/salim1999/Learn_RAG.git
cd Learn_RAG
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Unter Windows die Umgebung mit `.venv\Scripts\activate` aktivieren.

Öffne **http://localhost:8000**. Ein anderer Port ist mit `python run.py --port 8765` möglich; `--reload` aktiviert den Entwicklungsmodus. `RAG_ACADEMY_HOST` und `RAG_ACADEMY_PORT` können auch in `.env` stehen.

Die App ist für einen lokalen Spieler ausgelegt. Der Fortschritt bleibt in `data/progress.db` erhalten. `RAG_ACADEMY_DB` setzt einen anderen Speicherort. In der Sternenkarte lässt er sich zurücksetzen.

## Lernen und experimentieren

- **Sternenkarte:** 70 % in Level n öffnen Level n+1. Ab 70 / 85 / 100 % gibt es 1 / 2 / 3 Sterne. Bestleistungen vergeben insgesamt bis zu 3350 XP; Wiederholungen erzeugen keine zusätzlichen XP. Dazu kommen Ränge, Abzeichen und eine Tages-Streak.
- **Aufgaben:** Quiz mit Erklärungen pro Option, A/B-Entscheidungen mit Begründung, sortierbare Schritte mit Maus- und Tastaturbedienung, Halluzinationssuche, echtes Parameter-Tuning, Versionskonflikte, Python-Lücken und Freitext.
- **Boss:** Jedes Level endet mit einem mehrstufigen Szenario und drei Leben. Ein Fehler kostet ein Leben; der Schritt kann erneut versucht werden. Neue Versuche beginnen mit drei Leben, Bestwerte bleiben erhalten.
- **RAG-Labor:** Chunking, TF-IDF, BM25, Hybrid-Suche, MMR, Reranking, Zeitabschlag, Versionsfilter, Grounding und Zitierpflicht verändern eine echte kleine Pipeline. Antwort, Quellen, Metriken und Trace werden angezeigt.
- **Agenten-Arena:** Planner → Retriever → Generator → Verifier, maximal drei Runden. Die Option „Erste Prüfung scheitern lassen“ zeigt den Feedback-/Retry-Pfad. Ohne ausreichende Evidenz enthält sich das System.
- **Wissensbasis:** NovaCloud-Dokumente mit alten und neuen Versionen, Widersprüchen und einer absichtlich eingeschleusten Dokument-Anweisung.

Die fünf Three.js-Szenen zeigen Vektorraum, Pipeline, Agenten, Zeitachse und Satz-Quellen-Bindungen. Sie unterstützen Größenänderungen, `prefers-reduced-motion` und einen Text-Fallback ohne WebGL. Bibliotheken und Lizenzen sind unter `static/vendor/` enthalten; es werden keine CDNs benötigt.

## Was die Mini-Engine demonstriert

Offline verwendet die App lokale TF-IDF-Vektoren, BM25, heuristisches Reranking, extraktive Antworten und eine Token-/Zahlenprüfung. Das sind transparente Lehrverfahren: Ein hoher Grounding-Score ist kein semantischer Wahrheitsbeweis. Die PCA-Projektion auf drei Dimensionen ist eine Visualisierung, kein vollständiger Vektorraum.

A/B-Aufgaben mit einer ausführbaren Pipeline-Konfiguration starten beide Varianten und vergleichen reale Metriken. Architekturentscheidungen etwa zu Fine-Tuning, GraphRAG, Text-to-SQL, Zugriffsrechten oder Caching werden als konzeptionelle Vergleiche unterrichtet; die App betreibt dafür keine vollständigen Trainings-, Graph- oder SQL-Systeme.

Python-Lücken werden nicht als beliebiger Code ausgeführt: Ein begrenzter AST-Interpreter prüft freigegebene Ausdrücke an vorgegebenen Testfällen. Die erlaubten Operationen hängen von der konkreten Aufgabe ab. Freitext wird offline anhand einer sichtbaren Begriffs-Rubrik bewertet.

## Optional: Claude

Kopiere `.env.example` nach `.env` und setze nur bei Bedarf:

```dotenv
ANTHROPIC_API_KEY=dein_key
ANTHROPIC_MODEL=claude-opus-5-5
```

Mit Key zeigt die UI „Claude aktiv“. Freitext-Bewertungen nutzen Claude; im Labor lässt sich die Claude-Generierung wählen und in der Arena „Claude verwenden“ aktivieren. Ohne Key oder bei einem API-Fehler greift der Offline-Fallback. Im Pipeline-Trace ist erkennbar, welche Generierung tatsächlich lief.

Die Integration verwendet das offizielle `anthropic`-SDK mit adaptivem Thinking, `output_config.effort="low"`, strukturierter JSON-Ausgabe und dem Server-Fallback-Beta `server-side-fallback-2026-07-01`. Refusal, Rate-Limit-, Status- und Verbindungsfehler werden behandelt. Das Modell kann über `ANTHROPIC_MODEL` geändert werden. API-Zugang und Modellberechtigungen liegen beim eigenen Anthropic-Konto; der automatisierte Testlauf verwendet gemockte Antworten und verursacht keine Modellkosten.

Optional vorhandene RunPod-Endpunkte für Dense-Embeddings und Cross-Encoder können über `RUNPOD_API_KEY` und `RUNPOD_EMBED_ENDPOINT_ID` aktiviert werden. Ohne diese Konfiguration bleibt die lokale Pipeline nutzbar; nicht verfügbare GPU-Methoden werden im Trace als Fallback ausgewiesen.

## Tests

```bash
pytest -q
```

Die Tests verwenden temporäre Datenbanken und keine echten Claude-/GPU-Aufrufe. Sie prüfen unter anderem Retrieval, Chunking, Versionskonflikte, Abstain, Zitatprüfung, Agenten-Terminierung, Code-Ausdrücke sowie den vollständigen Kurs über die HTTP-API: alle Aufgaben lösen, Level freischalten, Sterne/XP prüfen und Fortschritt zurücksetzen.

Für die zusätzliche Browser-Abnahme sind Node.js und Playwright nötig:

```bash
npm ci
npx playwright install chromium
# Terminal 1: eine eigene, wegwerfbare Datenbank verwenden
ANTHROPIC_API_KEY= RUNPOD_API_KEY= RUNPOD_EMBED_ENDPOINT_ID= RAG_ACADEMY_DB=/tmp/rag-browser-progress.db RAG_ACADEMY_AGENT_DELAY=0.015 python run.py --port 8765
# Terminal 2: der Browser-Test setzt diesen Spielstand zurück
RAG_SMOKE_ALLOW_RESET=1 npm run test:browser
```

Wenn Chromium bereits installiert ist, kann `CHROMIUM_PATH` dessen Pfad setzen. Screenshots landen standardmäßig unter `/tmp/rag-browser-smoke`, alternativ unter `RAG_SMOKE_ARTIFACTS`.

Der Browser-Test spielt Level 1 vollständig, prüft alle neun Aufgabentypen, alle 14 Level-Seiten, Boss-Niederlage/Neustart, iteratives Tuning, Live-A/B, Agenten-Retry, alle fünf Szenen, Reduced Motion und die mobile Darstellung. Externe Netzwerkquellen bleiben dabei blockiert.

## Aufbau und API

```text
app/rag/           Chunking, Index, Retrieval, Generation, Evaluation, Verifikation
app/agents/        Claude-Adapter und SSE-Orchestrator
app/api/           HTTP-Endpunkte
app/content/       Level und NovaCloud-Korpus
static/js/tasks/   Neun Aufgabentypen
static/js/three/   Fünf Szenen mit gemeinsamem Lebenszyklus
schemas/           JSON-Schemas für Level/Aufgaben, Korpus und SSE-Events
tests/             Backend-, Inhalts- und Kurs-Abnahme
scripts/           Browser-Abnahme
```

Die interaktive API-Dokumentation liegt unter `/docs`, OpenAPI unter `/openapi.json`. Ausführliche Datenverträge stehen in [CONTRACTS.md](CONTRACTS.md). Wichtigste Routen:

| Route | Zweck |
|---|---|
| `GET /api/status` | Offline-/Claude-/GPU-Konfiguration |
| `GET /api/levels` | Karte mit Freischaltung und Bestwerten |
| `GET /api/levels/{id}` | Offenes Level ohne Musterlösungen |
| `POST /api/levels/{id}/tasks/{task}/submit` | Antwort bewerten und Fortschritt speichern |
| `POST /api/levels/{id}/tasks/{task}/restart` | Boss-Versuch neu beginnen |
| `GET /api/progress` | XP, Sterne, Ränge, Streak und Abzeichen |
| `POST /api/progress/reset` | Lokalen Spielstand löschen |
| `GET /api/corpus` | Quellen inklusive Versionsmetadaten |
| `POST /api/rag/run` | Pipeline ausführen |
| `GET /api/agents/stream` | Live-Ereignisse als Server-Sent Events |
