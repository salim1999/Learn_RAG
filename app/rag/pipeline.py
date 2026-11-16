"""End-to-End-RAG-Pipeline: run_pipeline(config) → RUN_RESPONSE (siehe CONTRACTS.md)."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
from sklearn.decomposition import PCA
from threadpoolctl import threadpool_limits

from app import config as app_config
from app import content_loader
from app.rag import chunking, eval as rag_eval, freshness, generate, remote, retrieve, verify
from app.rag.embed import Index
from app.rag.text import content_tokens

MAX_POINTS = 400
_CACHE_SIZE = 32


class CorpusNotFound(LookupError):
    pass


@dataclass
class Bundle:
    """Gecachter Index pro (Korpus, Chunking-Parametern) inkl. 3D-Projektion."""
    chunks: list[dict]
    index: Index
    pca: PCA | None
    scale: np.ndarray
    coords: dict[int, tuple[float, float, float]] = field(default_factory=dict)
    sample: list[int] = field(default_factory=list)
    build_ms: float = 0.0
    key: tuple = ()


_cache: "OrderedDict[tuple, Bundle]" = OrderedDict()
_lock = threading.Lock()


def _build_projection(index: Index, n: int) -> tuple[PCA | None, np.ndarray, dict, list[int]]:
    if n > MAX_POINTS:
        sample = sorted(set(np.linspace(0, n - 1, MAX_POINTS).round().astype(int).tolist()))
    else:
        sample = list(range(n))
    if index.matrix is None or n == 0:
        return None, np.ones(3), {i: (0.0, 0.0, 0.0) for i in range(n)}, sample
    dense = index.matrix.toarray()
    n_comp = min(3, dense.shape[0], dense.shape[1])
    if n_comp < 1 or dense.shape[0] < 2:
        return None, np.ones(3), {i: (0.0, 0.0, 0.0) for i in range(n)}, sample
    # Nur drei Anschauungsachsen: eine volle SVD des gesamten Wortschatzes
    # blockierte auf kleinen Rechnern minutenlang. Randomisierte PCA berechnet
    # nur diese Achsen, mit festem Seed reproduzierbar. Ein BLAS-Thread vermeidet
    # Überbelegung beim parallelen API-/Testbetrieb.
    pca = PCA(n_components=n_comp, svd_solver="randomized", random_state=0)
    with threadpool_limits(limits=1, user_api="blas"):
        pca.fit(dense[sample])
        proj = pca.transform(dense)
    if n_comp < 3:
        proj = np.hstack([proj, np.zeros((proj.shape[0], 3 - n_comp))])
    scale = np.abs(proj[sample]).max(axis=0)
    scale[scale == 0] = 1.0
    proj = (proj / scale).clip(-1, 1)
    coords = {i: tuple(round(float(v), 4) for v in proj[i]) for i in range(n)}
    return pca, scale, coords, sample


def get_bundle(corpus: dict, strategy: str, size: int, overlap: int) -> tuple[Bundle, bool]:
    """Index aus dem Cache holen oder bauen. Rückgabe: (bundle, war_gecacht)."""
    key = (corpus["id"], corpus.get("_fingerprint"), strategy, int(size), int(overlap))
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key], True
    t0 = time.perf_counter()
    chunks = chunking.chunk_corpus(corpus, strategy, size, overlap)
    index = Index(chunks)
    pca, scale, coords, sample = _build_projection(index, len(chunks))
    bundle = Bundle(chunks, index, pca, scale, coords, sample, (time.perf_counter() - t0) * 1000, key)
    with _lock:
        _cache[key] = bundle
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return bundle, False


def clear_cache() -> None:
    with _lock:
        _cache.clear()
    remote.clear_cache()


GPU_FALLBACK_MSG = "GPU nicht erreichbar → TF-IDF-Fallback"
RERANK_FALLBACK_MSG = "GPU nicht erreichbar → heuristisches Rerank"


def dense_scores(bundle: Bundle, query: str) -> np.ndarray:
    """Kalibrierte e5-Kosinus-Scores (wirft remote.RemoteError bei Problemen)."""
    passages = [f"{c['title']}. {c['text']}" for c in bundle.chunks]
    matrix, _ = remote.corpus_embeddings("|".join(map(str, bundle.key)), passages)
    q = remote.query_embedding(query)
    return remote.calibrate(matrix @ q)


def compute_scores(bundle: Bundle, query: str, method: str) -> tuple[np.ndarray, str, dict]:
    """Scores je Methode; dense/hybrid_dense mit Fallback. Rückgabe: (scores, genutzte_methode, gpu_info)."""
    idx = bundle.index
    if method not in ("dense", "hybrid_dense"):
        return idx.scores(query, method), method, {}
    info = {"gpu_used": False, "requested": method}
    if not app_config.gpu_enabled():
        info["fallback"] = "GPU-Modus nicht konfiguriert → TF-IDF-Fallback"
    else:
        try:
            dense = dense_scores(bundle, query)
            info["gpu_used"] = True
            info["model"] = remote.EMBED_MODEL
            if method == "dense":
                return dense, method, info
            return 0.5 * idx.bm25_scores(query) + 0.5 * dense, method, info
        except remote.RemoteError as exc:
            info["fallback"] = GPU_FALLBACK_MSG
            info["error"] = str(exc)
    fb = "tfidf" if method == "dense" else "hybrid"
    return idx.scores(query, fb), fb, info


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 2)


def _chunk_out(bundle: Bundle, i: int, score: float, relevance: float, rank: int,
               factor: float | None = None, age: int | None = None) -> dict:
    c = bundle.chunks[i]
    out = {"id": c["id"], "doc_id": c["doc_id"], "title": c["title"], "text": c["text"],
           "score": round(float(score), 4), "date": c["date"], "stale": c["stale"],
           "superseded_by": c["superseded_by"], "rank": rank,
           # Zusatzfelder (nicht im Vertrag, aber nützlich für UI/Erklärungen)
           "relevance": round(float(relevance), 4), "version": c.get("version"),
           "source": c.get("source"), "tags": c.get("tags", [])}
    if factor is not None:
        out["recency"] = round(float(factor), 4)
        out["age_days"] = age
    return out


def retrieve_chunks(bundle: Bundle, query: str, cfg: dict) -> tuple[list[dict], list[dict], list[int]]:
    """Retrieval + Freshness + Rerank/MMR. Rückgabe: (chunks, trace_einträge, chunk_indizes)."""
    idx = bundle.index
    r, f = cfg["retrieval"], cfg["freshness"]
    k, method = r["k"], r["method"]
    trace = []
    n = len(bundle.chunks)

    # 1) Ähnlichkeitssuche
    t0 = time.perf_counter()
    if n:
        raw, used, gpu_info = compute_scores(bundle, query, method)
    else:
        raw, used, gpu_info = np.zeros(0), method, {}
    top_raw = retrieve.top_k(raw, 8)
    method_label = {"tfidf": "TF-IDF-Kosinus", "bm25": "BM25", "hybrid": "Hybrid (TF-IDF + BM25)",
                    "dense": "Dense-Embeddings (e5, GPU)", "hybrid_dense": "Hybrid (BM25 + Dense, GPU)"}[used]
    note = f"{gpu_info['fallback']}. " if gpu_info.get("fallback") else ""
    trace.append({
        "stage": "retrieval", "title": f"Suche: {method_label}",
        "message": (note + f"Alle {n} Chunks werden mit der Frage verglichen ({method_label}). "
                    f"Bester Treffer: {bundle.chunks[top_raw[0]]['id'] if top_raw else '–'} "
                    f"mit Score {float(raw[top_raw[0]]) if top_raw else 0:.2f}. "
                    "Ein hoher Score heißt nur 'ähnliche Wörter' – nicht automatisch 'richtige Antwort'."),
        "ms": _ms(t0),
        "data": {"method": used, "requested_method": method, "k": k, **({"gpu": gpu_info} if gpu_info else {}),
                 "candidates": [{"id": bundle.chunks[i]["id"], "score": round(float(raw[i]), 4)} for i in top_raw]},
    })

    # 2) Aktualität
    t0 = time.perf_counter()
    as_of = f["as_of"]
    factors = np.ones(n)
    ages: list[int | None] = [None] * n
    if f["enabled"]:
        for i, c in enumerate(bundle.chunks):
            factors[i], ages[i] = freshness.recency_factor(c["date"], as_of, f["half_life_days"])
    adjusted = raw * factors
    allowed = np.array([not c["stale"] for c in bundle.chunks], dtype=bool) if f["drop_superseded"] else None
    dropped = [c["id"] for c in bundle.chunks if c["stale"]] if f["drop_superseded"] else []
    pool_size = max(k * 5, 20)
    pool = retrieve.top_k(adjusted, pool_size, allowed)
    if f["enabled"] or f["drop_superseded"]:
        parts = []
        if f["enabled"]:
            parts.append(f"Recency-Decay mit Halbwertszeit {f['half_life_days']} Tage (Stichtag {as_of}): "
                         "ältere Chunks verlieren Score, behalten aber mindestens 30 %.")
        if f["drop_superseded"]:
            parts.append(f"{len(set(c.split('#')[0] for c in dropped))} ersetzte Dokumente "
                         "(superseded_by gesetzt) werden komplett ausgefiltert.")
        msg = " ".join(parts)
    else:
        msg = ("Aktualitätsfilter aus: veraltete Dokumente konkurrieren gleichberechtigt mit neuen – "
               "Gefahr veralteter Antworten.")
    trace.append({
        "stage": "freshness", "title": "Aktualität", "message": msg, "ms": _ms(t0),
        "data": {"enabled": f["enabled"], "half_life_days": f["half_life_days"], "as_of": as_of,
                 "drop_superseded": f["drop_superseded"], "dropped": dropped,
                 "adjusted": [{"id": bundle.chunks[i]["id"], "before": round(float(raw[i]), 4),
                               "after": round(float(adjusted[i]), 4), "age_days": ages[i]}
                              for i in pool[:8]] if f["enabled"] else []},
    })

    # 3) Rerank / MMR
    t0 = time.perf_counter()
    final = adjusted.copy()
    rerank_used, rerank_note = "heuristic", ""
    if r["rerank"] and pool:
        new_scores = None
        if r.get("rerank_mode") == "cross_encoder":
            if not app_config.gpu_enabled():
                rerank_note = "GPU-Modus nicht konfiguriert → heuristisches Rerank. "
            else:
                cands = pool[:20]  # Kosten begrenzen: nur die besten 20 Kandidaten
                try:
                    ce = remote.rerank(query, [bundle.chunks[i]["text"] for i in cands])
                    new_scores = dict(zip(cands, ce))
                    pool = cands
                    rerank_used = "cross_encoder"
                except remote.RemoteError:
                    rerank_note = RERANK_FALLBACK_MSG + ". "
        if new_scores is None:
            new_scores = retrieve.rerank_scores(idx, query, pool, adjusted)
        for i, s in new_scores.items():
            final[i] = s
        pool = sorted(pool, key=lambda i: (-float(final[i]), i))
    if r["mmr"] and pool:
        selected = retrieve.mmr(idx, pool, final, k, r["mmr_lambda"])
    else:
        selected = sorted(pool, key=lambda i: (-float(final[i]), i))[:k]
    if r["rerank"] or r["mmr"]:
        parts = []
        if r["rerank"] and rerank_used == "cross_encoder":
            parts.append(f"Cross-Encoder-Reranking ({remote.RERANK_MODEL}, GPU): Frage und Chunk werden "
                         "gemeinsam bewertet – genauer als reine Vektorähnlichkeit.")
        elif r["rerank"]:
            parts.append(rerank_note + "Reranking: Score neu berechnet aus 60 % Ähnlichkeit, 30 % Abdeckung der Frage-Begriffe "
                         "und 10 % Titel-Treffer.")
        if r["mmr"]:
            parts.append(f"MMR (λ={r['mmr_lambda']:.2f}) wählt diverse Chunks, damit nicht k fast gleiche "
                         "Textstücke den Kontext füllen.")
        msg = " ".join(parts)
    else:
        msg = f"Kein Reranking/MMR: die Top-{k} nach Score werden direkt übernommen."
    trace.append({
        "stage": "rerank", "title": "Rerank & Auswahl", "message": msg, "ms": _ms(t0),
        "data": {"enabled": r["rerank"], "rerank_mode": rerank_used if r["rerank"] else None,
                 "requested_rerank_mode": r.get("rerank_mode"), "mmr": r["mmr"], "mmr_lambda": r["mmr_lambda"],
                 "order": [bundle.chunks[i]["id"] for i in selected]},
    })

    chunks = [_chunk_out(bundle, i, final[i], raw[i], rank,
                         factors[i] if f["enabled"] else None, ages[i])
              for rank, i in enumerate(selected, start=1)]
    return chunks, trace, selected


def project_query(bundle: Bundle, query: str) -> dict:
    if bundle.pca is None:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    qv = bundle.index.query_vector(query)
    p = bundle.pca.transform(qv.toarray())[0]
    if len(p) < 3:
        p = np.concatenate([p, np.zeros(3 - len(p))])
    p = (p / bundle.scale).clip(-1, 1)
    return {"x": round(float(p[0]), 4), "y": round(float(p[1]), 4), "z": round(float(p[2]), 4)}


def build_points(bundle: Bundle, selected: list[int]) -> list[dict]:
    rank_of = {i: r for r, i in enumerate(selected, start=1)}
    ids = list(bundle.sample)
    extra = [i for i in selected if i not in set(ids)]
    if extra:  # abgerufene Chunks immer zeigen, Limit einhalten
        keep = set(selected)
        ids = [i for i in ids if i not in keep][: MAX_POINTS - len(selected)] + list(selected)
        ids.sort()
    pts = []
    for i in ids:
        c = bundle.chunks[i]
        x, y, z = bundle.coords.get(i, (0.0, 0.0, 0.0))
        pts.append({"id": c["id"], "doc_id": c["doc_id"], "x": x, "y": y, "z": z,
                    "retrieved": i in rank_of, "stale": c["stale"], "rank": rank_of.get(i)})
    return pts


def finalize_answer(answer: dict, chunks: list[dict], cfg: dict) -> tuple[dict, dict]:
    """Verifikation: Grounding setzen; bei verify=true ungestützte Sätze entfernen."""
    gen = cfg["generation"]
    report = verify.verify_answer(answer, chunks, gen["require_citations"])
    removed = []
    if cfg["verify"] and not answer.get("abstained") and report["unsupported"]:
        removed = [answer["sentences"][i]["text"] for i in report["unsupported"]]
        kept = [s for i, s in enumerate(answer["sentences"]) if i not in set(report["unsupported"])]
        answer = ({"text": generate.render_text(kept), "abstained": False, "sentences": kept}
                  if kept else generate.abstain_answer())
        report = verify.verify_answer(answer, chunks, gen["require_citations"])
    report["removed"] = removed
    return answer, report


def run_pipeline(config: dict | None, relevant_doc_ids: list[str] | None = None) -> dict:
    """Führt die komplette Pipeline aus und liefert RUN_RESPONSE (inkl. Trace mit ms-Zeiten)."""
    raw_cfg = config or {}
    cfg = app_config.normalize_pipeline_config(raw_cfg)
    corpus = content_loader.get_corpus(cfg["corpus"])
    if corpus is None:
        raise CorpusNotFound(f"Korpus '{cfg['corpus']}' nicht gefunden")
    if not (raw_cfg.get("freshness") or {}).get("as_of") and corpus.get("as_of"):
        cfg["freshness"]["as_of"] = str(corpus["as_of"])
    query = cfg["query"]
    ch, gen = cfg["chunking"], cfg["generation"]
    trace: list[dict] = []

    # Chunking (gecacht)
    t0 = time.perf_counter()
    bundle, cached = get_bundle(corpus, ch["strategy"], ch["size"], ch["overlap"])
    n = len(bundle.chunks)
    avg = round(sum(len(c["text"]) for c in bundle.chunks) / n, 1) if n else 0
    strat_label = {"fixed": "feste Zeichenfenster", "sentence": "ganze Sätze",
                   "recursive": "rekursiv (Absatz → Satz → Wort)"}[ch["strategy"]]
    trace.append({
        "stage": "chunking", "title": "Chunking",
        "message": (f"{len(corpus['documents'])} Dokumente wurden in {n} Chunks zerlegt ({strat_label}, "
                    f"max. {ch['size']} Zeichen, {ch['overlap']} Zeichen Überlappung, Ø {avg} Zeichen). "
                    + ("Index kam aus dem Cache." if cached else "Index wurde neu gebaut.")),
        "ms": _ms(t0) if cached else round(bundle.build_ms, 2),
        "data": {"strategy": ch["strategy"], "size": ch["size"], "overlap": ch["overlap"],
                 "num_chunks": n, "num_docs": len(corpus["documents"]), "avg_len": avg, "cached": cached},
    })

    # Embedding der Frage
    t0 = time.perf_counter()
    q_terms = list(dict.fromkeys(content_tokens(query)))
    known = [t for t in q_terms if t in bundle.index.idf]
    trace.append({
        "stage": "embedding", "title": "Frage einbetten",
        "message": (f"Die Frage wird in Begriffe zerlegt (Stoppwörter entfernt, Wortstämme gebildet): "
                    f"{', '.join(q_terms) or '–'}. {len(known)} davon kommen im Korpus-Vokabular "
                    f"({bundle.index.vocab_size} Begriffe) vor."),
        "ms": _ms(t0),
        "data": {"method": cfg["retrieval"]["method"], "vocab_size": bundle.index.vocab_size,
                 "query_terms": q_terms, "known_terms": known},
    })

    chunks, r_trace, selected = retrieve_chunks(bundle, query, cfg)
    trace.extend(r_trace)
    conflicts = freshness.detect_conflicts(chunks)
    for t in trace:
        if t["stage"] == "freshness":
            t["data"]["conflicts"] = conflicts
            if conflicts:
                t["message"] += f" Achtung: {len(conflicts)} möglicher Widerspruch im Kontext erkannt."

    # Generierung
    t0 = time.perf_counter()
    answer, info = generate.generate_answer(query, chunks, gen, bundle.index.term_idf)
    if answer["abstained"]:
        gmsg = (f"Bester Relevanz-Score {info.get('best_score', 0):.2f} liegt unter der Schwelle "
                f"{gen['abstain_threshold']:.2f} – statt zu raten, verweigert das System die Antwort (Abstain)."
                if info.get("reason") == "best_score_below_threshold"
                else "Kein Satz im Kontext beantwortet die Frage – Abstain statt Halluzination.")
    elif info.get("llm_used"):
        gmsg = "Claude formuliert die Antwort ausschließlich aus dem Kontext und zitiert die Chunk-IDs."
    else:
        gmsg = (f"Extraktive Antwort: die {len(answer['sentences'])} relevantesten Sätze aus den Top-Chunks "
                "wurden wörtlich übernommen" + (" und mit Quellen-IDs versehen." if gen["require_citations"]
                                                 else " (ohne Quellenangaben!)."))
        if not gen["strict_grounding"]:
            gmsg += (" strict_grounding ist aus: das System ergänzt eigenes 'Modellwissen' und antwortet "
                     "auch bei schwacher Evidenz – genau so entstehen Halluzinationen.")
    if info.get("fallback"):
        gmsg += " " + info["fallback"]
    if info.get("blocked_injection"):
        gmsg += (f" Verdächtige Anweisungen im Dokument ({', '.join(info['blocked_injection'])}) wurden "
                 "als Prompt-Injection ignoriert.")
    trace.append({
        "stage": "generation", "title": "Antwort erzeugen", "message": gmsg, "ms": _ms(t0),
        "data": {"mode": gen["mode"], "llm_used": bool(info.get("llm_used")), "abstained": answer["abstained"],
                 "best_score": info.get("best_score"), "threshold": gen["abstain_threshold"],
                 "blocked_injection": info.get("blocked_injection", [])},
    })

    # Verifikation
    t0 = time.perf_counter()
    answer, report = finalize_answer(answer, chunks, cfg)
    if not cfg["verify"]:
        vmsg = ("Verifikation ist aus – ungestützte Sätze bleiben in der Antwort. "
                "(Grounding-Werte werden nur für die Auswertung berechnet.)")
    elif answer["abstained"]:
        vmsg = ("Nichts zu prüfen: das System hat sich enthalten." if not report["removed"]
                else "Kein Satz war ausreichend belegt – die Antwort wurde durch eine Enthaltung ersetzt.")
    else:
        vmsg = (f"Jeder Satz wird gegen seinen zitierten Chunk geprüft (Wortüberdeckung ≥ 50 %): "
                f"{report['supported_sentences']}/{report['total_sentences']} gestützt.")
        if report["removed"]:
            vmsg += f" {len(report['removed'])} ungestützte(r) Satz/Sätze wurde(n) entfernt."
        if not report["citations_ok"]:
            vmsg += " Zitat-Check: Es fehlen Quellenangaben oder sie verweisen auf Chunks außerhalb des Kontexts."
        if report["stale_cited"]:
            vmsg += f" Warnung: zitiert veraltete Quellen ({', '.join(report['stale_cited'])})."
    trace.append({"stage": "verification", "title": "Verifikation", "message": vmsg, "ms": _ms(t0),
                  "data": {"enabled": cfg["verify"], **report}})

    metrics = rag_eval.compute_metrics(chunks, answer, query, relevant_doc_ids)
    return {
        "config": cfg,
        "trace": trace,
        "chunks": chunks,
        "answer": answer,
        "metrics": metrics,
        "points3d": build_points(bundle, selected),
        "query3d": project_query(bundle, query),
    }
