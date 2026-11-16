"""Chunking-Strategien: fixed, sentence, recursive (Größe und Overlap in Zeichen)."""
from __future__ import annotations

from app.rag.text import split_sentences


def _snap_end(text: str, end: int, start: int) -> int:
    """Schiebt ein Chunk-Ende auf die letzte Wortgrenze zurück (max. 20 % des Fensters)."""
    if end >= len(text):
        return len(text)
    limit = start + int((end - start) * 0.8)
    pos = text.rfind(" ", limit, end)
    return pos if pos > start else end


def _snap_start(text: str, start: int) -> int:
    """Schiebt einen Chunk-Anfang auf den nächsten Wortanfang (damit Overlap keine Wortfetzen erzeugt)."""
    if start <= 0 or text[start - 1].isspace():
        return max(0, start)
    nxt = text.find(" ", start, start + 30)
    return nxt + 1 if nxt != -1 else start


def chunk_fixed(text: str, size: int, overlap: int) -> list[str]:
    """Festes Zeichenfenster mit Overlap; Enden werden auf Wortgrenzen geschnappt."""
    text = " ".join(text.split())
    if not text:
        return []
    chunks, start = [], 0
    step_min = max(1, size - overlap)
    while start < len(text):
        end = _snap_end(text, start + size, start)
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= len(text):
            break
        nxt = max(start + step_min // 2, end - overlap)
        start = _snap_start(text, nxt)
    return chunks


def _merge_units(units: list[str], size: int, overlap: int, joiner: str = " ") -> list[str]:
    """Packt Einheiten (Sätze/Teile) gierig bis `size`; Overlap = Einheiten vom Ende des Vorgängers."""
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for u in units:
        u = u.strip()
        if not u:
            continue
        add = len(u) + (len(joiner) if cur else 0)
        if cur and cur_len + add > size:
            chunks.append(joiner.join(cur))
            # Overlap: so viele End-Einheiten übernehmen, wie in `overlap` Zeichen passen
            carry: list[str] = []
            carry_len = 0
            for prev in reversed(cur):
                if carry_len + len(prev) > overlap:
                    break
                carry.insert(0, prev)
                carry_len += len(prev) + len(joiner)
            cur, cur_len = carry, max(0, carry_len - len(joiner)) if carry else 0
            add = len(u) + (len(joiner) if cur else 0)
        cur.append(u)
        cur_len += add
    if cur:
        chunks.append(joiner.join(cur))
    return chunks


def chunk_sentence(text: str, size: int, overlap: int) -> list[str]:
    """Satzbasiert: ganze Sätze bis `size` Zeichen, Overlap in ganzen Sätzen. Überlange Sätze → fixed."""
    units: list[str] = []
    for s in split_sentences(text):
        s = " ".join(s.split())
        units.extend(chunk_fixed(s, size, overlap) if len(s) > size else [s])
    return _merge_units(units, size, overlap)


_SEPARATORS = ["\n\n", "\n", ". ", "; ", ", ", " "]


def _split_recursive(text: str, size: int, seps: list[str]) -> list[str]:
    if len(text) <= size:
        return [text]
    for i, sep in enumerate(seps):
        if sep in text:
            parts = text.split(sep)
            # Trenner (außer Leerraum) am Teilende erhalten, z.B. den Punkt
            keep = sep.strip()
            pieces = [p + keep if (keep and j < len(parts) - 1) else p for j, p in enumerate(parts)]
            out: list[str] = []
            for p in pieces:
                if len(p) > size:
                    out.extend(_split_recursive(p, size, seps[i + 1:]))
                elif p.strip():
                    out.append(p)
            return out
    return chunk_fixed(text, size, 0)


def chunk_recursive(text: str, size: int, overlap: int) -> list[str]:
    """Rekursiv: erst Absätze, dann Zeilen, Sätze, Teilsätze, Wörter – danach wieder bis `size` zusammenfügen."""
    pieces = [" ".join(p.split()) for p in _split_recursive(text.strip(), size, _SEPARATORS)]
    return _merge_units([p for p in pieces if p], size, overlap)


STRATEGIES = {"fixed": chunk_fixed, "sentence": chunk_sentence, "recursive": chunk_recursive}


def chunk_text(text: str, strategy: str = "fixed", size: int = 300, overlap: int = 50) -> list[str]:
    size = max(20, int(size))
    overlap = max(0, min(int(overlap), size // 2))
    fn = STRATEGIES.get(strategy, chunk_fixed)
    return [c for c in fn(text or "", size, overlap) if c.strip()]


def chunk_corpus(corpus: dict, strategy: str, size: int, overlap: int) -> list[dict]:
    """Zerlegt alle Dokumente in Chunk-Dicts (id = '<doc_id>#<n>')."""
    chunks: list[dict] = []
    for doc in corpus.get("documents", []):
        for i, piece in enumerate(chunk_text(doc.get("text", ""), strategy, size, overlap)):
            chunks.append({
                "id": f"{doc['id']}#{i}",
                "doc_id": doc["id"],
                "title": doc.get("title", doc["id"]),
                "text": piece,
                "date": doc.get("date"),
                "version": doc.get("version"),
                "source": doc.get("source", ""),
                "tags": list(doc.get("tags") or []),
                "superseded_by": doc.get("superseded_by"),
                "stale": doc.get("superseded_by") is not None,
            })
    return chunks
