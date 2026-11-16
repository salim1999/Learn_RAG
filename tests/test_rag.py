"""Tests für Chunking, Retrieval, Freshness, Generierung, Verifikation und Pipeline."""
import time

from app.rag import chunking, freshness
from app.rag.embed import Index
from app.rag.generate import ABSTAIN_TEXT
from app.rag.pipeline import run_pipeline
from app.rag.text import split_sentences, stem
from app.rag.verify import containment

TEXT = ("RAG verbindet Suche mit Generierung. Zuerst wird der Korpus in Chunks zerlegt. "
        "Dann werden die Chunks eingebettet, z. B. mit TF-IDF. Bei einer Frage werden die ähnlichsten Chunks "
        "abgerufen.\n\nDas Sprachmodell formuliert daraus eine Antwort mit Quellen. Ohne Quellen drohen "
        "Halluzinationen, also erfundene Fakten.")


def test_split_sentences_protects_abbreviations():
    s = split_sentences(TEXT)
    assert any("z. B. mit TF-IDF" in x for x in s)
    assert len(s) == 6


def test_stemming_consistent():
    assert stem("Preise") == stem("Preis")
    assert stem("kostet") == stem("kosten")
    assert stem("Verschlüsselung") == stem("verschlüsselt")


def test_chunk_fixed_size_and_overlap():
    chunks = chunking.chunk_text(TEXT, "fixed", 80, 20)
    assert len(chunks) > 3
    assert all(len(c) <= 80 for c in chunks)
    # Overlap: Ende eines Chunks taucht am Anfang des nächsten wieder auf
    assert chunks[0].split()[-1] in chunks[1]


def test_chunk_sentence_keeps_sentences_whole():
    chunks = chunking.chunk_text(TEXT, "sentence", 120, 0)
    for c in chunks:
        assert c.endswith((".", "!", "?"))
        assert len(c) <= 120


def test_chunk_recursive_respects_size():
    chunks = chunking.chunk_text(TEXT, "recursive", 100, 30)
    assert all(len(c) <= 100 for c in chunks)
    joined = " ".join(chunks)
    assert "Halluzinationen" in joined and "Korpus" in joined


def test_chunk_corpus_ids_and_stale():
    corpus = {"documents": [{"id": "a", "title": "A", "text": TEXT, "date": "2024-01-01", "superseded_by": "b"},
                            {"id": "b", "title": "B", "text": "Kurz.", "date": "2025-01-01", "superseded_by": None}]}
    chunks = chunking.chunk_corpus(corpus, "fixed", 100, 10)
    assert chunks[0]["id"] == "a#0" and chunks[0]["stale"] is True
    assert chunks[-1]["id"] == "b#0" and chunks[-1]["stale"] is False


def _index():
    chunks = [{"id": f"d{i}#0", "doc_id": f"d{i}", "title": t, "text": x}
              for i, (t, x) in enumerate([
                  ("Preise", "Der Pro-Plan kostet 49 Euro im Monat."),
                  ("Limits", "Die API erlaubt 1000 Anfragen pro Minute."),
                  ("Support", "Der Support antwortet werktags."),
              ])]
    return Index(chunks)


def test_retrieval_methods_rank_relevant_first():
    idx = _index()
    for method in ("tfidf", "bm25", "hybrid"):
        scores = idx.scores("Was kostet der Pro-Plan?", method)
        assert int(scores.argmax()) == 0, method
        assert 0.0 <= scores.min() and scores.max() <= 1.0


def test_freshness_decay_and_conflicts():
    f_new, _ = freshness.recency_factor("2026-11-01", "2026-11-16", 365)
    f_old, age = freshness.recency_factor("2022-11-16", "2026-11-16", 365)
    assert f_new > f_old and age == 1461
    assert abs(freshness.decay(365, 365) - 0.5) < 1e-9
    a = {"id": "t01#0", "doc_id": "t01", "superseded_by": "t02", "tags": ["pricing"], "text": "39", "date": "2023"}
    b = {"id": "t02#0", "doc_id": "t02", "superseded_by": None, "tags": ["pricing"], "text": "49", "date": "2026"}
    conf = freshness.detect_conflicts([a, b])
    assert conf and "ersetzt" in conf[0]["reason"]


def test_containment():
    assert containment("Der Pro-Plan kostet 49 Euro.", "Der Pro-Plan kostet 49 Euro im Monat.") == 1.0
    assert containment("Alles ist gratis für immer.", "Der Pro-Plan kostet 49 Euro.") < 0.5


def test_pipeline_response_shape_and_speed():
    run_pipeline({"query": "warmup"})
    t0 = time.perf_counter()
    r = run_pipeline({"query": "Wie viel kostet der Pro-Plan?", "retrieval": {"method": "hybrid", "k": 4}})
    assert (time.perf_counter() - t0) < 0.3
    assert set(r) == {"config", "trace", "chunks", "answer", "metrics", "points3d", "query3d"}
    stages = [t["stage"] for t in r["trace"]]
    assert stages == ["chunking", "embedding", "retrieval", "freshness", "rerank", "generation", "verification"]
    assert all(isinstance(t["ms"], float) for t in r["trace"])
    assert len(r["chunks"]) == 4 and r["chunks"][0]["rank"] == 1
    for key in ("id", "doc_id", "title", "text", "score", "date", "stale", "superseded_by", "rank"):
        assert key in r["chunks"][0]
    ans = r["answer"]
    assert not ans["abstained"] and ans["sentences"]
    assert all(s["citations"] and s["supported"] for s in ans["sentences"])
    for key in ("faithfulness", "context_precision", "answer_relevance", "freshness_score", "stale_in_context"):
        assert key in r["metrics"]
    assert r["points3d"] and all(-1 <= p[a] <= 1 for p in r["points3d"] for a in "xyz")
    assert sum(p["retrieved"] for p in r["points3d"]) == 4
    assert set(r["query3d"]) == {"x", "y", "z"}


def test_abstain_on_off_topic_question():
    r = run_pipeline({"query": "Wer gewann die Fußball-Weltmeisterschaft?"})
    assert r["answer"]["abstained"] is True
    assert r["answer"]["text"] == ABSTAIN_TEXT


def test_freshness_drop_superseded_removes_stale():
    q = {"query": "Wie viel kostet der Pro-Plan?", "retrieval": {"method": "hybrid"}}
    base = run_pipeline(q)
    assert base["metrics"]["stale_in_context"] >= 1
    fresh = run_pipeline({**q, "freshness": {"enabled": True, "drop_superseded": True}})
    assert fresh["metrics"]["stale_in_context"] == 0
    assert fresh["metrics"]["freshness_score"] == 1.0
    assert "49" in fresh["answer"]["text"]


def test_recency_prefers_newer_version():
    r = run_pipeline({"query": "Wie viel kostet der Pro-Plan?", "retrieval": {"method": "hybrid"},
                      "freshness": {"enabled": True, "half_life_days": 180}})
    assert r["chunks"][0]["doc_id"] == "t02"


def test_injection_sentence_blocked():
    r = run_pipeline({"query": "Wie lange werden Backups aufbewahrt?", "retrieval": {"method": "hybrid"}})
    assert "Ignoriere" not in r["answer"]["text"]
    assert "Backups" in r["answer"]["text"]


def test_non_strict_grounding_hallucinates_and_verify_removes():
    q = {"query": "Wie viel kostet der Pro-Plan?", "generation": {"strict_grounding": False}}
    unverified = run_pipeline({**q, "verify": False})
    assert unverified["metrics"]["faithfulness"] < 1.0
    verified = run_pipeline({**q, "verify": True})
    assert verified["metrics"]["faithfulness"] == 1.0


def test_retrieval_metrics_with_relevant_ids():
    r = run_pipeline({"query": "Wie viele Anfragen pro Minute erlaubt die API?", "retrieval": {"k": 3}},
                     relevant_doc_ids=["t03"])
    assert r["metrics"]["recall_at_k"] == 1.0 and r["metrics"]["mrr"] == 1.0
    assert abs(r["metrics"]["precision_at_k"] - 1 / 3) < 1e-3


def test_mmr_and_rerank_run():
    r = run_pipeline({"query": "Pro-Plan Preis", "retrieval": {"mmr": True, "rerank": True, "k": 3}})
    assert len(r["chunks"]) == 3
    assert len({c["id"] for c in r["chunks"]}) == 3
