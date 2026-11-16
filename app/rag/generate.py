"""Antwortgenerierung: extraktiv (offline, deterministisch) oder per Claude (mit Offline-Fallback)."""
from __future__ import annotations

import logging
import re
from typing import Callable

from app import config
from app.rag.text import content_tokens, split_sentences

log = logging.getLogger("rag_academy.generate")

ABSTAIN_TEXT = "Dazu habe ich in den Quellen keine verlässliche Information gefunden."

# Typische Prompt-Injection-Muster – solche Sätze übernimmt ein strikt geerdeter Generator nicht.
INJECTION_RE = re.compile(
    r"ignorier|ignore (all|any|previous|the)|vorherige[nr]? anweisung|systemprompt|system-prompt|system prompt"
    r"|du bist (jetzt|ab sofort)|you are now|vergiss (alle|deine|alles)|neue anweisung|antworte (immer|nur) mit",
    re.IGNORECASE,
)

# Simulierte "Modellwissen"-Ergänzung bei strict_grounding = false (bewusst ungestützt!)
HALLUCINATION_FILLER = "Erfahrungsgemäß gilt das übrigens auch rückwirkend für sämtliche Altverträge."

MAX_SENTENCES = 3
MAX_SOURCE_CHUNKS = 4
# strict: Der beste Satz muss mind. diesen IDF-gewichteten Anteil der Frage abdecken – sonst Abstain.
# (Verhindert Antworten, die nur auf häufigen Wörtern wie "NovaCloud" beruhen.)
MIN_COVERAGE = 0.3


def abstain_answer() -> dict:
    return {"text": ABSTAIN_TEXT, "abstained": True, "sentences": []}


def render_text(sentences: list[dict]) -> str:
    """Fließtext mit [chunk_id]-Zitaten hinter jedem Satz."""
    parts = []
    for s in sentences:
        cites = "".join(f" [{c}]" for c in s.get("citations") or [])
        parts.append(f"{s['text']}{cites}")
    return " ".join(parts)


def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def extractive_answer(query: str, chunks: list[dict], gen: dict,
                      idf: Callable[[str], float] | None = None) -> tuple[dict, dict]:
    """Wählt die (max. 3) relevantesten Sätze aus den Top-Chunks; abstain bei schwacher Evidenz."""
    strict = gen.get("strict_grounding", True)
    threshold = float(gen.get("abstain_threshold", 0.2))
    cite = gen.get("require_citations", True)
    best = max((float(c.get("relevance", c.get("score", 0.0))) for c in chunks), default=0.0)
    info = {"best_score": round(best, 4), "threshold": threshold, "blocked_injection": [], "reason": None}

    if strict and (not chunks or best < threshold):
        info["reason"] = "best_score_below_threshold" if chunks else "no_chunks"
        return abstain_answer(), info

    q_terms = list(dict.fromkeys(content_tokens(query)))
    w = {t: (idf(t) if idf else 1.0) for t in q_terms}
    w_sum = sum(w.values()) or 1.0

    cands = []
    for rank, ch in enumerate(chunks[:MAX_SOURCE_CHUNKS]):
        rel = float(ch.get("relevance", ch.get("score", 0.0)))
        for pos, sent in enumerate(split_sentences(ch["text"])):
            toks = set(content_tokens(sent))
            if len(toks) < 3 or sent.rstrip().endswith("?"):  # Fragen (FAQ-Überschriften) sind keine Antworten
                continue
            if strict and INJECTION_RE.search(sent):
                info["blocked_injection"].append(ch["id"])
                continue
            cov = sum(w[t] for t in q_terms if t in toks) / w_sum
            if cov <= 0:
                continue
            cands.append({"score": cov + 0.25 * rel - 0.02 * rank, "cov": cov, "rank": rank, "pos": pos,
                          "text": sent, "chunk": ch["id"], "toks": toks})

    cands.sort(key=lambda c: (-c["score"], c["rank"], c["pos"]))
    if strict:
        best_cov = max((c["cov"] for c in cands), default=0.0)
        info["best_coverage"] = round(best_cov, 4)
        if best_cov < MIN_COVERAGE:
            cands = []
    chosen: list[dict] = []
    for c in cands:
        if len(chosen) >= MAX_SENTENCES:
            break
        if chosen and c["score"] < 0.5 * chosen[0]["score"]:
            break
        if any(_jaccard(c["toks"], o["toks"]) > 0.7 for o in chosen):
            continue
        chosen.append(c)

    if not chosen:
        if strict or not chunks:
            info["reason"] = "no_matching_sentence"
            return abstain_answer(), info
        # nicht strikt: notfalls irgendeinen Satz aus dem Top-Chunk nehmen (Halluzinationsgefahr!)
        first = (split_sentences(chunks[0]["text"]) or [chunks[0]["text"]])[0]
        chosen = [{"rank": 0, "pos": 0, "text": first, "chunk": chunks[0]["id"]}]

    chosen.sort(key=lambda c: (c["rank"], c["pos"]))
    sentences = [{"text": c["text"], "citations": [c["chunk"]] if cite else [],
                  "grounding": None, "supported": None} for c in chosen]
    if not strict:
        sentences.append({"text": HALLUCINATION_FILLER, "citations": [], "grounding": None, "supported": None})
    info["blocked_injection"] = sorted(set(info["blocked_injection"]))
    return {"text": render_text(sentences), "abstained": False, "sentences": sentences}, info


def llm_answer(query: str, chunks: list[dict], gen: dict) -> dict | None:
    """Antwort per Claude; None bei Fehler/fehlendem Key (Aufrufer fällt auf extraktiv zurück)."""
    if not config.llm_enabled() or not chunks:
        return None
    from app.agents import llm  # lazy: anthropic nur bei Bedarf importieren

    res = llm.generate_grounded_answer(query, chunks)
    if not res:
        return None
    if res.get("abstained") or not res.get("sentences"):
        return abstain_answer()
    valid_ids = {c["id"] for c in chunks}
    sentences = []
    for s in res["sentences"]:
        text = str(s.get("text", "")).strip()
        if not text:
            continue
        cites = [c for c in (s.get("citations") or []) if c in valid_ids]
        sentences.append({"text": text, "citations": cites if gen.get("require_citations", True) else [],
                          "grounding": None, "supported": None})
    if not sentences:
        return abstain_answer()
    return {"text": render_text(sentences), "abstained": False, "sentences": sentences}


def generate_answer(query: str, chunks: list[dict], gen: dict,
                    idf: Callable[[str], float] | None = None) -> tuple[dict, dict]:
    """Dispatcher nach generation.mode. info enthält 'llm_used' und ggf. 'fallback'."""
    if gen.get("mode") == "llm":
        best = max((float(c.get("relevance", c.get("score", 0.0))) for c in chunks), default=0.0)
        threshold = float(gen.get("abstain_threshold", 0.2))
        if gen.get("strict_grounding", True) and best < threshold:
            return abstain_answer(), {"best_score": round(best, 4), "threshold": threshold, "llm_used": False,
                                      "reason": "best_score_below_threshold", "blocked_injection": []}
        ans = llm_answer(query, chunks, gen)
        if ans is not None:
            return ans, {"best_score": round(best, 4), "threshold": threshold, "llm_used": True,
                         "reason": None, "blocked_injection": []}
        answer, info = extractive_answer(query, chunks, gen, idf)
        info["llm_used"] = False
        info["fallback"] = "Kein API-Key oder Claude nicht erreichbar – extraktiver Offline-Modus."
        return answer, info
    answer, info = extractive_answer(query, chunks, gen, idf)
    info["llm_used"] = False
    return answer, info
