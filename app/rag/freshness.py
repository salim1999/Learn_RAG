"""Aktualität: Recency-Decay, Entfernen ersetzter Dokumente, Stale-Markierung, Konflikterkennung."""
from __future__ import annotations

import datetime as _dt
import re

# Anteil des Scores, der unabhängig vom Alter erhalten bleibt (alte, aber gültige Infos
# sollen nicht komplett verschwinden): final = relevanz * (FLOOR + (1-FLOOR) * decay)
DECAY_FLOOR = 0.3


def parse_date(value) -> _dt.date | None:
    if not value:
        return None
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            return _dt.datetime.strptime(s[: len(fmt) + 2], fmt).date()
        except ValueError:
            continue
    try:
        return _dt.date.fromisoformat(s[:10])
    except ValueError:
        return None


def age_days(date_value, as_of: str) -> int | None:
    d, ref = parse_date(date_value), parse_date(as_of)
    if d is None or ref is None:
        return None
    return max(0, (ref - d).days)


def decay(age: int | None, half_life_days: float) -> float:
    """Exponentieller Zerfall: nach einer Halbwertszeit zählt ein Dokument nur noch halb."""
    if age is None:
        return 1.0
    return 0.5 ** (age / max(1.0, float(half_life_days)))


def recency_factor(date_value, as_of: str, half_life_days: float) -> tuple[float, int | None]:
    a = age_days(date_value, as_of)
    d = decay(a, half_life_days)
    return DECAY_FLOOR + (1 - DECAY_FLOOR) * d, a


def is_stale(chunk: dict) -> bool:
    return chunk.get("superseded_by") is not None


_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")


def detect_conflicts(chunks: list[dict]) -> list[dict]:
    """Findet widersprüchliche Chunks im Kontext.

    1) Ersetzungsbeziehung: Dokument A wird (direkt) durch Dokument B ersetzt.
    2) Gleiches Thema (gemeinsamer Tag) aus verschiedenen Dokumenten mit unterschiedlichen Zahlen.
    """
    conflicts: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for i, a in enumerate(chunks):
        for b in chunks[i + 1:]:
            if a["doc_id"] == b["doc_id"]:
                continue
            key = tuple(sorted((a["doc_id"], b["doc_id"])))
            if key in seen:
                continue
            reason = None
            if a.get("superseded_by") == b["doc_id"]:
                reason = f"{a['doc_id']} wurde durch {b['doc_id']} ersetzt"
            elif b.get("superseded_by") == a["doc_id"]:
                reason = f"{b['doc_id']} wurde durch {a['doc_id']} ersetzt"
            else:
                shared = set(a.get("tags") or []) & set(b.get("tags") or [])
                shared.discard("injection")
                if shared:
                    na = set(_NUM_RE.findall(a["text"]))
                    nb = set(_NUM_RE.findall(b["text"]))
                    if na and nb and na != nb and (a.get("date") != b.get("date")):
                        reason = (f"Gleiches Thema ({', '.join(sorted(shared))}), aber unterschiedliche "
                                  f"Zahlenangaben ({a.get('date')} vs. {b.get('date')})")
            if reason:
                seen.add(key)
                conflicts.append({"a": a["id"], "b": b["id"], "reason": reason})
    return conflicts
