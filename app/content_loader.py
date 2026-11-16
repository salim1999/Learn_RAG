"""Lädt Level- und Korpus-JSON robust (fehlende/fehlerhafte Dateien → Warnung, kein Crash).

Ergebnisse werden gecacht und automatisch neu geladen, sobald sich Dateien
(Name, Größe oder mtime) ändern – praktisch, während Inhalte parallel entstehen.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from app import config

log = logging.getLogger("rag_academy.content")

# In Tests per monkeypatch auf temporäre Ordner umbiegbar.
LEVELS_DIR: Path = config.CONTENT_DIR / "levels"
CORPUS_DIR: Path = config.CONTENT_DIR / "corpus"

_cache: dict[str, tuple[tuple, Any]] = {}


def _signature(directory: Path, pattern: str) -> tuple:
    if not directory.is_dir():
        return (str(directory),)
    files = sorted(directory.glob(pattern))
    sig = [str(directory)]
    for f in files:
        try:
            st = f.stat()
            sig.append((f.name, st.st_size, st.st_mtime_ns))
        except OSError:
            continue
    return tuple(sig)


def _read_json(path: Path) -> Any | None:
    try:
        with path.open("r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        log.warning("Inhaltsdatei %s konnte nicht geladen werden: %s", path.name, exc)
        return None


def _load_levels_uncached(directory: Path) -> dict[int, dict]:
    levels: dict[int, dict] = {}
    if not directory.is_dir():
        log.warning("Level-Ordner %s fehlt", directory)
        return levels
    for path in sorted(directory.glob("level_*.json")):
        data = _read_json(path)
        if not isinstance(data, dict):
            if data is not None:
                log.warning("%s: Level muss ein JSON-Objekt sein", path.name)
            continue
        lid = data.get("id")
        if lid is None:  # Fallback: Nummer aus dem Dateinamen
            m = re.search(r"(\d+)", path.stem)
            lid = int(m.group(1)) if m else None
        try:
            lid = int(lid)
        except (TypeError, ValueError):
            log.warning("%s: ungültige Level-ID %r", path.name, lid)
            continue
        data["id"] = lid
        tasks = data.get("tasks")
        if not isinstance(tasks, list):
            log.warning("%s: 'tasks' fehlt oder ist keine Liste", path.name)
            data["tasks"] = []
        else:
            data["tasks"] = [t for t in tasks if isinstance(t, dict) and t.get("id") and t.get("type")]
        data.setdefault("theory", [])
        if lid in levels:
            log.warning("Doppelte Level-ID %s (%s) – überschreibe", lid, path.name)
        levels[lid] = data
    return levels


def _load_corpora_uncached(directory: Path) -> dict[str, dict]:
    corpora: dict[str, dict] = {}
    if not directory.is_dir():
        log.warning("Korpus-Ordner %s fehlt", directory)
        return corpora
    for path in sorted(directory.glob("*.json")):
        data = _read_json(path)
        if not isinstance(data, dict):
            continue
        docs = data.get("documents")
        if not isinstance(docs, list):
            log.warning("%s: 'documents' fehlt", path.name)
            continue
        clean = []
        for d in docs:
            if not isinstance(d, dict) or not d.get("id") or not isinstance(d.get("text"), str):
                log.warning("%s: Dokument ohne id/text übersprungen", path.name)
                continue
            d.setdefault("title", d["id"])
            d.setdefault("source", "")
            d.setdefault("date", None)
            d.setdefault("version", None)
            d.setdefault("superseded_by", None)
            d.setdefault("tags", [])
            clean.append(d)
        data["documents"] = clean
        cid = str(data.get("id") or path.stem)
        data["id"] = cid
        data.setdefault("title", cid)
        data.setdefault("as_of", config.DEFAULT_PIPELINE_CONFIG["freshness"]["as_of"])
        data["_fingerprint"] = hashlib.sha1(
            json.dumps(clean, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        corpora[cid] = data
    return corpora


def load_levels() -> dict[int, dict]:
    sig = _signature(LEVELS_DIR, "level_*.json")
    hit = _cache.get("levels")
    if hit and hit[0] == sig:
        return hit[1]
    levels = _load_levels_uncached(LEVELS_DIR)
    _cache["levels"] = (sig, levels)
    return levels


def load_corpora() -> dict[str, dict]:
    sig = _signature(CORPUS_DIR, "*.json")
    hit = _cache.get("corpora")
    if hit and hit[0] == sig:
        return hit[1]
    corpora = _load_corpora_uncached(CORPUS_DIR)
    _cache["corpora"] = (sig, corpora)
    return corpora


def clear_cache() -> None:
    _cache.clear()


def get_level(level_id: int) -> dict | None:
    return load_levels().get(int(level_id))


def get_task(level_id: int, task_id: str) -> dict | None:
    level = get_level(level_id)
    if not level:
        return None
    for t in level.get("tasks", []):
        if t.get("id") == task_id:
            return t
    return None


def get_corpus(corpus_id: str = "default") -> dict | None:
    return load_corpora().get(corpus_id)


def public_corpus(corpus: dict) -> dict:
    """Korpus ohne interne Felder (z.B. _fingerprint)."""
    return {k: v for k, v in corpus.items() if not k.startswith("_")}


def strip_solutions(obj: Any) -> Any:
    """Entfernt rekursiv alle 'solution'-Schlüssel (auch in boss-steps). Gibt eine Kopie zurück."""
    if isinstance(obj, dict):
        return {k: strip_solutions(v) for k, v in obj.items() if k != "solution"}
    if isinstance(obj, list):
        return [strip_solutions(v) for v in obj]
    return copy.deepcopy(obj)
