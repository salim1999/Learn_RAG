"""Sparse "Embeddings": TF-IDF (scikit-learn), BM25 (selbst implementiert) und Hybrid.

Alle Scores liegen in [0, 1] und sind absolut interpretierbar (wichtig für den Abstain-Schwellwert):
- tfidf : Kosinus-Ähnlichkeit Query↔Chunk
- bm25  : BM25-Score geteilt durch die Summe der IDF-Werte der Query-Terme
          (≈ "IDF-gewichteter Anteil der Query, der im Chunk vorkommt", gekappt auf 1)
- hybrid: 0.5 * tfidf + 0.5 * bm25 (normalisierte Summe)
"""
from __future__ import annotations

import math
from collections import Counter

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

from app.rag.text import content_tokens


class Index:
    def __init__(self, chunks: list[dict], k1: float = 1.5, b: float = 0.75):
        self.chunks = chunks
        # Titel mitindizieren – hilft bei kurzen Chunks ohne Schlüsselbegriff
        self.docs_tokens = [content_tokens(f"{c['title']} {c['text']}") for c in chunks]
        self.chunk_token_sets = [set(content_tokens(c["text"])) for c in chunks]
        self.title_token_sets = [set(content_tokens(c["title"])) for c in chunks]

        # --- TF-IDF -----------------------------------------------------------
        self.vectorizer = TfidfVectorizer(analyzer=lambda s: s, sublinear_tf=True, norm="l2")
        if chunks and any(self.docs_tokens):
            self.matrix = self.vectorizer.fit_transform(self.docs_tokens)
        else:
            self.matrix = None

        # --- BM25 -------------------------------------------------------------
        self.k1, self.b = k1, b
        self.tf = [Counter(toks) for toks in self.docs_tokens]
        self.doc_len = np.array([len(t) for t in self.docs_tokens], dtype=float)
        self.avgdl = float(self.doc_len.mean()) if len(self.doc_len) else 0.0
        df: Counter = Counter()
        for toks in self.docs_tokens:
            df.update(set(toks))
        n = len(chunks)
        # BM25+-artige IDF (immer positiv)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self.max_idf = math.log(1 + (n + 0.5) / 0.5) if n else 1.0

    @property
    def vocab_size(self) -> int:
        return len(self.idf)

    def query_vector(self, query: str):
        if self.matrix is None:
            return None
        return self.vectorizer.transform([content_tokens(query)])

    def tfidf_scores(self, query: str) -> np.ndarray:
        n = len(self.chunks)
        qv = self.query_vector(query)
        if qv is None or qv.nnz == 0:
            return np.zeros(n)
        return np.asarray((self.matrix @ qv.T).todense()).ravel().clip(0.0, 1.0)

    def term_idf(self, term: str) -> float:
        # unbekannte Terme bekommen die maximale IDF (sie sind "selten", nämlich nie da)
        return self.idf.get(term, self.max_idf)

    def bm25_scores(self, query: str) -> np.ndarray:
        n = len(self.chunks)
        q_terms = list(dict.fromkeys(content_tokens(query)))
        if not q_terms or n == 0:
            return np.zeros(n)
        scores = np.zeros(n)
        denom_norm = self.k1 * (1 - self.b + self.b * self.doc_len / (self.avgdl or 1.0))
        for t in q_terms:
            idf = self.idf.get(t)
            if idf is None:
                continue
            tf = np.array([c.get(t, 0) for c in self.tf], dtype=float)
            scores += idf * tf * (self.k1 + 1) / (tf + denom_norm)
        upper = sum(self.term_idf(t) for t in q_terms)
        return (scores / upper).clip(0.0, 1.0) if upper > 0 else scores

    def scores(self, query: str, method: str) -> np.ndarray:
        if method == "bm25":
            return self.bm25_scores(query)
        if method == "hybrid":
            return 0.5 * self.tfidf_scores(query) + 0.5 * self.bm25_scores(query)
        return self.tfidf_scores(query)

    def similarity(self, i: int, j: int) -> float:
        """Kosinus-Ähnlichkeit zweier Chunks (für MMR)."""
        if self.matrix is None:
            return 0.0
        return float((self.matrix[i] @ self.matrix[j].T).toarray()[0, 0])
