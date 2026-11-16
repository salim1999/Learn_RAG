"""Verifikation: Grounding pro Satz (Token-Containment im zitierten Chunk) und Zitat-Check."""
from __future__ import annotations

import re

from app.rag.text import content_tokens

SUPPORT_THRESHOLD = 0.5
_NUMBERS = re.compile(r"(?<!\w)\d+(?:[.,]\d+)?")


def _numbers(text: str) -> set[str]:
    return {value.replace(",", ".") for value in _NUMBERS.findall(text)}


def containment(sentence: str, chunk_text: str) -> float:
    """Anteil der Inhaltswörter des Satzes, die im Chunk vorkommen (0..1)."""
    s = set(content_tokens(sentence))
    if not s:
        return 1.0
    c = set(content_tokens(chunk_text))
    return len(s & c) / len(s)


def verify_answer(answer: dict, chunks: list[dict], require_citations: bool = True) -> dict:
    """Setzt grounding/supported je Satz (in-place) und liefert einen Prüfbericht."""
    by_id = {c["id"]: c for c in chunks}
    sentences = answer.get("sentences") or []
    invalid: list[str] = []
    uncited: list[int] = []
    unsupported: list[int] = []
    stale_cited: list[str] = []
    numeric_mismatches: list[int] = []
    for i, s in enumerate(sentences):
        cites = list(s.get("citations") or [])
        valid = [c for c in cites if c in by_id]
        invalid_here = [c for c in cites if c not in by_id]
        invalid.extend(c for c in cites if c not in by_id)
        if valid:
            g = max(containment(s["text"], by_id[c]["text"]) for c in valid)
            stale_cited.extend(c for c in valid if by_id[c].get("stale"))
        else:
            uncited.append(i)
            # ohne Zitat: bestmögliche Stütze im gesamten Kontext (aber Zitat-Check schlägt fehl)
            g = max((containment(s["text"], c["text"]) for c in chunks), default=0.0)
        source_text = " ".join(by_id[c]["text"] for c in valid) if valid else " ".join(c["text"] for c in chunks)
        numbers_ok = _numbers(s["text"]) <= _numbers(source_text)
        if not numbers_ok:
            numeric_mismatches.append(i)
        s["grounding"] = round(float(g), 3)
        s["supported"] = bool(g >= SUPPORT_THRESHOLD and numbers_ok and not invalid_here
                              and (valid or not require_citations))
        if not s["supported"]:
            unsupported.append(i)
    total = len(sentences)
    faithfulness = 1.0 if total == 0 else (total - len(unsupported)) / total
    citations_ok = not invalid and (not require_citations or not uncited)
    return {
        "faithfulness": round(faithfulness, 4),
        "total_sentences": total,
        "supported_sentences": total - len(unsupported),
        "unsupported": unsupported,
        "uncited": uncited,
        "invalid_citations": sorted(set(invalid)),
        "numeric_mismatches": numeric_mismatches,
        "citations_ok": citations_ok,
        "stale_cited": sorted(set(stale_cited)),
    }
