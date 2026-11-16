"""Evaluationsmetriken für RAG (Retrieval- und Antwortqualität)."""
from __future__ import annotations

from app.rag.text import content_tokens


def _unique(seq):
    return list(dict.fromkeys(seq))


def recall_at_k(retrieved_doc_ids: list[str], relevant: list[str]) -> float:
    """Anteil der relevanten Dokumente, die unter den Top-k auftauchen."""
    rel = set(relevant or [])
    if not rel:
        return 1.0
    return len(rel & set(retrieved_doc_ids)) / len(rel)


def precision_at_k(retrieved_doc_ids: list[str], relevant: list[str]) -> float:
    """Anteil der abgerufenen Chunks, die aus einem relevanten Dokument stammen."""
    if not retrieved_doc_ids:
        return 0.0
    rel = set(relevant or [])
    return sum(1 for d in retrieved_doc_ids if d in rel) / len(retrieved_doc_ids)


def mrr(retrieved_doc_ids: list[str], relevant: list[str]) -> float:
    """Reziproker Rang des ersten relevanten Treffers."""
    rel = set(relevant or [])
    for i, d in enumerate(retrieved_doc_ids, start=1):
        if d in rel:
            return 1.0 / i
    return 0.0


def faithfulness(answer: dict) -> float:
    """Anteil gestützter Sätze (Abstain/keine Aussagen → 1.0: nichts Falsches behauptet)."""
    sents = answer.get("sentences") or []
    if not sents:
        return 1.0
    return sum(1 for s in sents if s.get("supported")) / len(sents)


def _chunk_is_relevant(chunk: dict, query_terms: list[str], relevant: list[str] | None) -> bool:
    if relevant is not None:
        return chunk["doc_id"] in set(relevant)
    if not query_terms:
        return False
    toks = set(content_tokens(f"{chunk['title']} {chunk['text']}"))
    return sum(1 for t in query_terms if t in toks) / len(query_terms) >= 0.5


def context_precision(chunks: list[dict], query: str, relevant: list[str] | None = None) -> float:
    """Rang-gewichtete Präzision (wie RAGAS): Mittel von precision@i über alle relevanten Positionen i.

    Ohne Relevanzlabels gilt ein Chunk als relevant, wenn er ≥50 % der Query-Terme enthält.
    """
    q_terms = _unique(content_tokens(query))
    hits, acc = 0, 0.0
    for i, ch in enumerate(chunks, start=1):
        if _chunk_is_relevant(ch, q_terms, relevant):
            hits += 1
            acc += hits / i
    return acc / hits if hits else 0.0


def answer_relevance(answer: dict, query: str) -> float:
    """Anteil der Query-Begriffe, die in der Antwort aufgegriffen werden (Abstain → 0)."""
    if answer.get("abstained"):
        return 0.0
    q_terms = _unique(content_tokens(query))
    if not q_terms:
        return 0.0
    a = set(content_tokens(" ".join(s["text"] for s in answer.get("sentences") or [])))
    return sum(1 for t in q_terms if t in a) / len(q_terms)


def freshness_score(chunks: list[dict]) -> float:
    """1 − Anteil veralteter (ersetzter) Chunks im Kontext."""
    if not chunks:
        return 1.0
    return 1.0 - sum(1 for c in chunks if c.get("stale")) / len(chunks)


def compute_metrics(chunks: list[dict], answer: dict, query: str,
                    relevant_doc_ids: list[str] | None = None) -> dict:
    m = {
        "faithfulness": faithfulness(answer),
        "context_precision": context_precision(chunks, query, relevant_doc_ids),
        "answer_relevance": answer_relevance(answer, query),
        "freshness_score": freshness_score(chunks),
        "stale_in_context": sum(1 for c in chunks if c.get("stale")),
    }
    if relevant_doc_ids is not None:
        docs = [c["doc_id"] for c in chunks]
        m["recall_at_k"] = recall_at_k(docs, relevant_doc_ids)
        m["precision_at_k"] = precision_at_k(docs, relevant_doc_ids)
        m["mrr"] = mrr(docs, relevant_doc_ids)
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}
