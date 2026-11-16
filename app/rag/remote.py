"""Optionaler GPU-Modus über RunPod Serverless (Infinity-Worker).

- Dense-Embeddings: intfloat/multilingual-e5-base (768 Dim., Präfixe "query: " / "passage: ")
- Cross-Encoder-Rerank: BAAI/bge-reranker-v2-m3
Jeder Fehler wird als RemoteError gemeldet; der Aufrufer fällt dann auf TF-IDF bzw. heuristisches
Rerank zurück. Der API-Key wird nie geloggt und taucht in keiner Fehlermeldung auf.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from app import config

log = logging.getLogger("rag_academy.remote")

EMBED_MODEL = "intfloat/multilingual-e5-base"
RERANK_MODEL = "BAAI/bge-reranker-v2-m3"
BASE_URL = "https://api.runpod.ai/v2"
BATCH_SIZE = 64
POLL_INTERVAL = 1.0
PENDING = {"IN_QUEUE", "IN_PROGRESS"}

# e5-Kosinuswerte liegen fast immer in ~[0.7, 0.95]. Für einen absolut interpretierbaren
# Score in [0,1] (Abstain-Schwelle!) wird linear kalibriert: 0.75 → 0, 0.92 → 1.
DENSE_LOW, DENSE_HIGH = 0.75, 0.92


class RemoteError(RuntimeError):
    pass


def models() -> dict:
    return {"embedding": EMBED_MODEL, "rerank": RERANK_MODEL}


def _client() -> httpx.Client:
    """HTTP-Client (in Tests per monkeypatch durch einen MockTransport ersetzt)."""
    return httpx.Client(timeout=httpx.Timeout(config.gpu_timeout(), connect=10.0))


def _sanitize(msg: str) -> str:
    key = config.runpod_api_key()
    return msg.replace(key, "***") if key else msg


def _credentials() -> tuple[str, str]:
    key, endpoint = config.runpod_api_key(), config.runpod_endpoint_id()
    if not key or not endpoint:
        raise RemoteError("GPU-Modus nicht konfiguriert (RUNPOD_API_KEY / RUNPOD_EMBED_ENDPOINT_ID fehlen)")
    return key, endpoint


def _unwrap_output(output: Any) -> Any:
    # Manche Worker liefern [output] statt output
    if isinstance(output, list) and len(output) == 1 and isinstance(output[0], (dict, list)):
        return output[0]
    return output


def _runsync(payload: dict, timeout: float | None = None) -> Any:
    """POST /runsync; bei IN_QUEUE/IN_PROGRESS (Kaltstart) /status/{id} pollen bis Timeout."""
    key, endpoint = _credentials()
    budget = timeout if timeout is not None else config.gpu_timeout()
    deadline = time.monotonic() + budget
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        with _client() as client:
            resp = client.post(f"{BASE_URL}/{endpoint}/runsync", json={"input": payload}, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            while data.get("status") in PENDING:
                if time.monotonic() >= deadline:
                    raise RemoteError(f"Timeout nach {budget:.0f}s (Status {data.get('status')}, Kaltstart?)")
                job_id = data.get("id")
                if not job_id:
                    raise RemoteError("Antwort ohne Job-ID")
                time.sleep(POLL_INTERVAL)
                resp = client.get(f"{BASE_URL}/{endpoint}/status/{job_id}", headers=headers)
                resp.raise_for_status()
                data = resp.json()
    except RemoteError:
        raise
    except httpx.HTTPStatusError as exc:
        raise RemoteError(f"HTTP {exc.response.status_code} vom GPU-Endpunkt") from None
    except (httpx.HTTPError, ValueError) as exc:
        raise RemoteError(_sanitize(f"GPU-Endpunkt nicht erreichbar: {type(exc).__name__}")) from None
    status = data.get("status")
    if status != "COMPLETED":
        raise RemoteError(f"GPU-Job fehlgeschlagen (Status {status})")
    if "output" not in data:
        raise RemoteError("GPU-Antwort ohne 'output'")
    return _unwrap_output(data["output"])


def parse_embeddings(output: Any) -> list[list[float]]:
    """Robust: {"data":[{"embedding",index}]}, {"embeddings":[...]}, oder direkt eine Liste."""
    items = output
    if isinstance(output, dict):
        items = output.get("data", output.get("embeddings"))
    if not isinstance(items, list) or not items:
        raise RemoteError("Unerwartetes Embedding-Format")
    if isinstance(items[0], dict):
        items = sorted(items, key=lambda d: d.get("index", 0))
        vecs = [d.get("embedding") for d in items]
    else:
        vecs = items
    if not all(isinstance(v, list) and v for v in vecs):
        raise RemoteError("Unerwartetes Embedding-Format")
    return vecs


def parse_scores(output: Any, n: int) -> list[float]:
    """Robust: {"scores":[...]}, {"results"/"data":[{"index","relevance_score"|"score"}]} oder Liste."""
    items = output
    if isinstance(output, dict):
        for key in ("scores", "results", "data"):
            if key in output:
                items = output[key]
                break
    if not isinstance(items, list) or len(items) != n:
        raise RemoteError("Unerwartetes Rerank-Format")
    if items and isinstance(items[0], dict):
        scores = [0.0] * n
        for pos, d in enumerate(items):
            idx = int(d.get("index", pos))
            val = d.get("relevance_score", d.get("score"))
            if val is None or not 0 <= idx < n:
                raise RemoteError("Unerwartetes Rerank-Format")
            scores[idx] = float(val)
        return scores
    return [float(x) for x in items]


def _normalize(m: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return m / norms


def embed(texts: list[str], kind: str = "passage", timeout: float | None = None) -> np.ndarray:
    """Embeddings (L2-normalisiert) für Texte; kind = 'passage' | 'query' (e5-Präfix)."""
    prefix = "query: " if kind == "query" else "passage: "
    vecs: list[list[float]] = []
    for start in range(0, len(texts), BATCH_SIZE):
        batch = [prefix + t for t in texts[start:start + BATCH_SIZE]]
        out = _runsync({"model": EMBED_MODEL, "input": batch}, timeout)
        got = parse_embeddings(out)
        if len(got) != len(batch):
            raise RemoteError("Anzahl der Embeddings passt nicht")
        vecs.extend(got)
    return _normalize(np.asarray(vecs, dtype=np.float32))


def rerank(query: str, docs: list[str], timeout: float | None = None) -> list[float]:
    if not docs:
        return []
    out = _runsync({"model": RERANK_MODEL, "query": query, "docs": docs, "return_docs": False}, timeout)
    return parse_scores(out, len(docs))


def calibrate(cos: np.ndarray) -> np.ndarray:
    return ((cos - DENSE_LOW) / (DENSE_HIGH - DENSE_LOW)).clip(0.0, 1.0)


# --- Caches -------------------------------------------------------------------------
_corpus_mem: dict[str, np.ndarray] = {}
_query_mem: "OrderedDict[str, np.ndarray]" = OrderedDict()
_lock = threading.Lock()


def _cache_file(cache_key: str) -> Path:
    digest = hashlib.sha1(f"{EMBED_MODEL}|{cache_key}".encode()).hexdigest()[:20]
    return config.emb_cache_dir() / f"{digest}.npy"


def corpus_embeddings(cache_key: str, passages: list[str]) -> tuple[np.ndarray, bool]:
    """Korpus-Embeddings aus Speicher-/Platten-Cache oder per GPU. Rückgabe: (matrix, aus_cache)."""
    with _lock:
        if cache_key in _corpus_mem and len(_corpus_mem[cache_key]) == len(passages):
            return _corpus_mem[cache_key], True
    path = _cache_file(cache_key)
    if path.is_file():
        try:
            m = np.load(path)
            if m.shape[0] == len(passages):
                with _lock:
                    _corpus_mem[cache_key] = m
                return m, True
        except (OSError, ValueError):
            log.warning("Embedding-Cache %s defekt – wird neu berechnet", path.name)
    m = embed(passages, "passage")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, m)
    except OSError as exc:
        log.warning("Embedding-Cache konnte nicht geschrieben werden: %s", exc)
    with _lock:
        _corpus_mem[cache_key] = m
    return m, False


def query_embedding(query: str) -> np.ndarray:
    with _lock:
        if query in _query_mem:
            _query_mem.move_to_end(query)
            return _query_mem[query]
    v = embed([query], "query")[0]
    with _lock:
        _query_mem[query] = v
        while len(_query_mem) > 256:
            _query_mem.popitem(last=False)
    return v


def clear_cache() -> None:
    with _lock:
        _corpus_mem.clear()
        _query_mem.clear()


def warmup(timeout: float = 10.0) -> dict:
    """Stößt einen Kaltstart an (asynchroner /run-Job) und liefert den Endpunkt-Status."""
    result: dict[str, Any] = {"gpu_enabled": config.gpu_enabled(), "models": models() if config.gpu_enabled() else {}}
    if not config.gpu_enabled():
        result.update(status="disabled", message="GPU-Modus nicht konfiguriert – alles läuft offline.")
        return result
    key, endpoint = _credentials()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        with _client() as client:
            r = client.post(f"{BASE_URL}/{endpoint}/run", headers=headers, timeout=timeout,
                            json={"input": {"model": EMBED_MODEL, "input": ["query: warmup"]}})
            r.raise_for_status()
            job = r.json()
            result["job_id"] = job.get("id")
            result["job_status"] = job.get("status")
            try:
                h = client.get(f"{BASE_URL}/{endpoint}/health", headers=headers, timeout=timeout)
                if h.status_code == 200:
                    result["health"] = h.json()
            except httpx.HTTPError:
                pass
    except httpx.HTTPStatusError as exc:
        result.update(status="error", message=f"HTTP {exc.response.status_code} vom GPU-Endpunkt")
        return result
    except (httpx.HTTPError, ValueError) as exc:
        result.update(status="error", message=_sanitize(f"GPU nicht erreichbar: {type(exc).__name__}"))
        return result
    workers = (result.get("health") or {}).get("workers") or {}
    ready = int(workers.get("idle", 0) or 0) + int(workers.get("running", 0) or 0)
    result["status"] = "ready" if ready > 0 or result.get("job_status") == "COMPLETED" else "warming"
    result["message"] = ("GPU-Worker bereit." if result["status"] == "ready"
                         else "Kaltstart angestoßen – der Worker fährt hoch (kann 30–90 s dauern).")
    return result
