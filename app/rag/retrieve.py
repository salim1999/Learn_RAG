"""Retrieval-Bausteine: Top-k, MMR (Diversität) und heuristisches Reranking."""
from __future__ import annotations

import numpy as np

from app.rag.embed import Index
from app.rag.text import content_tokens


def top_k(scores: np.ndarray, k: int, allowed: np.ndarray | None = None) -> list[int]:
    """Indizes der k besten Scores (stabil: bei Gleichstand gewinnt der kleinere Index)."""
    idx = np.arange(len(scores))
    if allowed is not None:
        idx = idx[allowed]
    order = sorted(idx.tolist(), key=lambda i: (-float(scores[i]), i))
    return order[:k]


def mmr(index: Index, candidates: list[int], scores: np.ndarray, k: int, lam: float) -> list[int]:
    """Maximal Marginal Relevance: λ·Relevanz − (1−λ)·max. Ähnlichkeit zu bereits gewählten Chunks."""
    selected: list[int] = []
    pool = list(candidates)
    if index.matrix is None:
        return pool[:k]
    sims = (index.matrix[pool] @ index.matrix[pool].T).toarray()
    pos = {c: p for p, c in enumerate(pool)}
    while pool and len(selected) < k:
        best, best_val = None, -1e9
        for c in pool:
            red = max((sims[pos[c], pos[s]] for s in selected), default=0.0)
            val = lam * float(scores[c]) - (1 - lam) * red
            if val > best_val + 1e-12:
                best, best_val = c, val
        selected.append(best)
        pool.remove(best)
    return selected


def term_coverage(query_terms: list[str], token_set: set[str]) -> float:
    if not query_terms:
        return 0.0
    return sum(1 for t in query_terms if t in token_set) / len(query_terms)


def rerank_scores(index: Index, query: str, candidates: list[int], scores: np.ndarray) -> dict[int, float]:
    """Heuristischer "Cross-Encoder"-Ersatz: Score + Termüberdeckung + Titel-Treffer."""
    q_terms = list(dict.fromkeys(content_tokens(query)))
    out = {}
    for c in candidates:
        cov = term_coverage(q_terms, index.chunk_token_sets[c] | index.title_token_sets[c])
        title = term_coverage(q_terms, index.title_token_sets[c])
        out[c] = 0.6 * float(scores[c]) + 0.3 * cov + 0.1 * title
    return out
