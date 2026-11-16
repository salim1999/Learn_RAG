"""Tests für den optionalen RunPod-GPU-Modus – ausschließlich mit gemocktem HTTP (httpx.MockTransport)."""
import hashlib
import json

import httpx
import numpy as np
import pytest

from app.rag import pipeline, remote
from app.rag.pipeline import run_pipeline
from app.rag.text import content_tokens

KEY = "rp_SECRET_TEST_KEY"
ENDPOINT = "ep123"


def fake_vector(text: str, dim: int = 64) -> list[float]:
    """Deterministisches Pseudo-Embedding: Wort-Hashing + konstante Komponente (Kosinus im e5-Bereich)."""
    u = np.zeros(dim)
    for t in content_tokens(text.split(": ", 1)[-1]):
        u[1 + int(hashlib.md5(t.encode()).hexdigest(), 16) % (dim - 1)] += 1.0
    norm = np.linalg.norm(u)
    u = u / norm if norm else u
    u[0] = 2.0  # Kosinus landet so in ~[0.8, 1.0] – wie bei echten e5-Embeddings
    return u.tolist()


class FakeRunPod:
    def __init__(self, fail=False, pending_polls=0, rerank_format="scores"):
        self.fail, self.pending_polls, self.rerank_format = fail, pending_polls, rerank_format
        self.calls: list[tuple[str, dict]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {KEY}"
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        self.calls.append((path, body))
        if self.fail:
            return httpx.Response(500, json={"error": "boom"})
        if path.endswith("/runsync") or path.endswith("/run"):
            if self.pending_polls:
                self._pending_body = body
                return httpx.Response(200, json={"id": "job1", "status": "IN_QUEUE"})
            return httpx.Response(200, json={"id": "job1", "status": "COMPLETED", "output": self._output(body)})
        if "/status/" in path:
            self.pending_polls -= 1
            if self.pending_polls > 0:
                return httpx.Response(200, json={"id": "job1", "status": "IN_PROGRESS"})
            return httpx.Response(200, json={"id": "job1", "status": "COMPLETED",
                                             "output": self._output(self._pending_body)})
        if path.endswith("/health"):
            return httpx.Response(200, json={"workers": {"idle": 1, "running": 0}})
        return httpx.Response(404)

    def _output(self, body):
        inp = body["input"]
        if inp["model"] == remote.EMBED_MODEL:
            return {"object": "list", "model": inp["model"],
                    "data": [{"object": "embedding", "embedding": fake_vector(t), "index": i}
                             for i, t in enumerate(inp["input"])]}
        q = set(content_tokens(inp["query"]))
        scores = [len(q & set(content_tokens(d))) / (len(q) or 1) for d in inp["docs"]]
        if self.rerank_format == "results":
            return {"results": [{"index": i, "relevance_score": s} for i, s in enumerate(scores)]}
        return {"scores": scores}

    def n_embed_inputs(self, prefix):
        return sum(1 for p, b in self.calls if b.get("input", {}).get("model") == remote.EMBED_MODEL
                   for t in b["input"]["input"] if t.startswith(prefix))


@pytest.fixture
def gpu(monkeypatch):
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    monkeypatch.setenv("RUNPOD_EMBED_ENDPOINT_ID", ENDPOINT)
    monkeypatch.setattr(remote, "POLL_INTERVAL", 0.0)
    fake = FakeRunPod()
    monkeypatch.setattr(remote, "_client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
    return fake


Q = "Wie viele Anfragen pro Minute erlaubt die API?"


def test_dense_retrieval_and_disk_cache(gpu, tmp_path):
    r = run_pipeline({"query": Q, "retrieval": {"method": "dense"}})
    retrieval = next(t for t in r["trace"] if t["stage"] == "retrieval")
    assert retrieval["data"]["method"] == "dense" and retrieval["data"]["gpu"]["gpu_used"] is True
    assert r["chunks"][0]["doc_id"] == "t03"
    assert all(0 <= c["relevance"] <= 1 for c in r["chunks"])
    assert list((tmp_path / "emb_cache").glob("*.npy"))
    passages = gpu.n_embed_inputs("passage: ")
    assert passages > 0 and gpu.n_embed_inputs("query: ") == 1
    # Speicher-Cache leeren → Korpus-Embeddings kommen von der Platte (nicht erneut bezahlt)
    pipeline.clear_cache()
    run_pipeline({"query": "Was kostet der Pro-Plan?", "retrieval": {"method": "hybrid_dense"}})
    assert gpu.n_embed_inputs("passage: ") == passages


def test_cold_start_polling(gpu):
    gpu.pending_polls = 2
    r = run_pipeline({"query": Q, "retrieval": {"method": "dense"}})
    assert next(t for t in r["trace"] if t["stage"] == "retrieval")["data"]["gpu"]["gpu_used"]
    assert any("/status/job1" in p for p, _ in gpu.calls)


def test_gpu_error_falls_back_to_tfidf(gpu):
    gpu.fail = True
    r = run_pipeline({"query": Q, "retrieval": {"method": "dense", "rerank": True, "rerank_mode": "cross_encoder"}})
    retrieval = next(t for t in r["trace"] if t["stage"] == "retrieval")
    assert retrieval["data"]["method"] == "tfidf"
    assert "GPU nicht erreichbar → TF-IDF-Fallback" in retrieval["message"]
    rerank = next(t for t in r["trace"] if t["stage"] == "rerank")
    assert rerank["data"]["rerank_mode"] == "heuristic" and "heuristisches Rerank" in rerank["message"]
    assert r["chunks"][0]["doc_id"] == "t03"
    assert KEY not in json.dumps(r, ensure_ascii=False)


def test_without_key_no_network_and_fallback():
    # conftest entfernt den Key und sperrt remote._client
    r = run_pipeline({"query": Q, "retrieval": {"method": "hybrid_dense"}})
    retrieval = next(t for t in r["trace"] if t["stage"] == "retrieval")
    assert retrieval["data"]["method"] == "hybrid" and "TF-IDF-Fallback" in retrieval["message"]


@pytest.mark.parametrize("fmt", ["scores", "results"])
def test_cross_encoder_rerank(gpu, fmt):
    gpu.rerank_format = fmt
    r = run_pipeline({"query": Q, "retrieval": {"method": "tfidf", "rerank": True, "rerank_mode": "cross_encoder"}})
    rerank = next(t for t in r["trace"] if t["stage"] == "rerank")
    assert rerank["data"]["rerank_mode"] == "cross_encoder"
    assert r["chunks"][0]["doc_id"] == "t03"


def test_parsers_are_robust():
    assert remote.parse_scores([0.1, 0.9], 2) == [0.1, 0.9]
    assert remote.parse_scores({"data": [{"index": 1, "score": 0.2}, {"index": 0, "score": 0.7}]}, 2) == [0.7, 0.2]
    assert remote.parse_embeddings({"embeddings": [[1.0, 0.0]]}) == [[1.0, 0.0]]
    with pytest.raises(remote.RemoteError):
        remote.parse_scores({"scores": [0.1]}, 2)


def test_status_and_warmup(gpu, client):
    s = client.get("/api/status").json()
    assert s["gpu_enabled"] is True and s["gpu_models"]["embedding"] == remote.EMBED_MODEL
    w = client.get("/api/gpu/warmup").json()
    assert w["status"] == "ready" and w["job_id"] == "job1"
    assert KEY not in json.dumps(s) + json.dumps(w)


def test_warmup_disabled(client):
    assert client.get("/api/gpu/warmup").json()["status"] == "disabled"
