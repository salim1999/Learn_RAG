"""Zentrale Konfiguration: Pfade, Modell, Pipeline-Defaults."""
from __future__ import annotations

import copy
import datetime
import math
import os
from pathlib import Path
from typing import Any

VERSION = "1.0"

BASE_DIR = Path(__file__).resolve().parent.parent

# .env laden (RUNPOD_API_KEY, RUNPOD_EMBED_ENDPOINT_ID, ...); bestehende Umgebung hat Vorrang.
try:
    from dotenv import load_dotenv

    load_dotenv(BASE_DIR / ".env", override=False)
except ImportError:  # pragma: no cover - python-dotenv ist optional
    pass
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5"
APP_DIR = BASE_DIR / "app"
STATIC_DIR = BASE_DIR / "static"
CONTENT_DIR = APP_DIR / "content"

# Default-PipelineConfig laut CONTRACTS.md
DEFAULT_PIPELINE_CONFIG: dict[str, Any] = {
    "query": "Wie viel kostet der Pro-Plan?",
    "corpus": "default",
    "chunking": {"strategy": "fixed", "size": 300, "overlap": 50},
    "retrieval": {"method": "tfidf", "k": 4, "mmr": False, "mmr_lambda": 0.7, "rerank": False,
                  "rerank_mode": "heuristic"},
    "freshness": {"enabled": False, "half_life_days": 365, "drop_superseded": False, "as_of": "2026-11-16"},
    "generation": {"mode": "extractive", "strict_grounding": True, "abstain_threshold": 0.2,
                   "require_citations": True},
    "verify": True,
}


def api_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return key or None


def llm_enabled() -> bool:
    """True, wenn ein API-Key gesetzt ist (Claude-Funktionen verfügbar)."""
    return api_key() is not None


def runpod_api_key() -> str | None:
    """RunPod-Key (nie loggen, nie an den Client ausliefern)."""
    return os.environ.get("RUNPOD_API_KEY", "").strip() or None


def runpod_endpoint_id() -> str | None:
    # RUNPOD_ENDPOINT_ID ist veraltet und wird bewusst ignoriert.
    return os.environ.get("RUNPOD_EMBED_ENDPOINT_ID", "").strip() or None


def gpu_enabled() -> bool:
    """True, wenn der optionale RunPod-GPU-Modus konfiguriert ist (sagt nichts über Erreichbarkeit)."""
    return runpod_api_key() is not None and runpod_endpoint_id() is not None


def gpu_timeout() -> float:
    """Gesamtbudget (Sekunden) für einen GPU-Aufruf inkl. Polling bei Kaltstart."""
    try:
        return float(os.environ.get("RUNPOD_TIMEOUT", "30"))
    except ValueError:
        return 30.0


def emb_cache_dir() -> Path:
    override = os.environ.get("RAG_ACADEMY_EMB_CACHE")
    return Path(override) if override else BASE_DIR / "data" / "emb_cache"


def db_path() -> Path:
    """SQLite-Pfad; per Env-Var RAG_ACADEMY_DB überschreibbar (Tests)."""
    override = os.environ.get("RAG_ACADEMY_DB")
    return Path(override) if override else BASE_DIR / "data" / "progress.db"


def agent_delay() -> float:
    """Pause zwischen Agenten-Events (Sekunden), per Env-Var überschreibbar."""
    try:
        return float(os.environ.get("RAG_ACADEMY_AGENT_DELAY", "0.35"))
    except ValueError:
        return 0.35


def deep_merge(base: dict, override: dict | None) -> dict:
    """Rekursives Mergen (override gewinnt), ohne die Eingaben zu verändern."""
    out = copy.deepcopy(base)
    for key, val in (override or {}).items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], val)
        else:
            out[key] = copy.deepcopy(val)
    return out


def _num(val: Any, default: float, lo: float, hi: float, as_int: bool = False) -> float | int:
    try:
        v = float(val)
    except (TypeError, ValueError, OverflowError):
        v = float(default)
    if not math.isfinite(v):
        v = float(default)
    v = max(lo, min(hi, v))
    return int(round(v)) if as_int else v


def _bool(val: Any) -> bool:
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "ja", "on")
    return bool(val)


class PipelineConfigError(ValueError):
    """Ungültige Eingaben sind Clientfehler, keine Serverfehler."""


def normalize_pipeline_config(cfg: dict | None) -> dict:
    """Defaults einsetzen und Werte in sinnvolle Bereiche bringen."""
    if cfg is not None and not isinstance(cfg, dict):
        raise PipelineConfigError("Pipeline-Konfiguration muss ein Objekt sein")
    for section in ("chunking", "retrieval", "freshness", "generation"):
        if section in (cfg or {}) and not isinstance(cfg[section], dict):
            raise PipelineConfigError(f"'{section}' muss ein Objekt sein")
    for name in ("query", "corpus"):
        if name in (cfg or {}) and not isinstance(cfg[name], str):
            raise PipelineConfigError(f"'{name}' muss ein Text sein")
    c = deep_merge(DEFAULT_PIPELINE_CONFIG, cfg or {})
    d = DEFAULT_PIPELINE_CONFIG
    c["query"] = str(c.get("query") or "").strip()
    if len(c["query"]) > 4000:
        raise PipelineConfigError("Frage darf höchstens 4000 Zeichen lang sein")
    c["corpus"] = str(c.get("corpus") or "default")

    ch = c["chunking"]
    if ch.get("strategy") not in ("fixed", "sentence", "recursive"):
        ch["strategy"] = d["chunking"]["strategy"]
    ch["size"] = _num(ch.get("size"), 300, 50, 4000, as_int=True)
    ch["overlap"] = _num(ch.get("overlap"), 50, 0, ch["size"] // 2, as_int=True)

    r = c["retrieval"]
    if r.get("method") not in ("tfidf", "bm25", "hybrid", "dense", "hybrid_dense"):
        r["method"] = d["retrieval"]["method"]
    r["k"] = _num(r.get("k"), 4, 1, 20, as_int=True)
    r["mmr"] = _bool(r.get("mmr"))
    r["mmr_lambda"] = _num(r.get("mmr_lambda"), 0.7, 0.0, 1.0)
    r["rerank"] = _bool(r.get("rerank"))
    if r.get("rerank_mode") not in ("heuristic", "cross_encoder"):
        r["rerank_mode"] = "heuristic"

    f = c["freshness"]
    f["enabled"] = _bool(f.get("enabled"))
    f["half_life_days"] = _num(f.get("half_life_days"), 365, 1, 100000, as_int=True)
    f["drop_superseded"] = _bool(f.get("drop_superseded"))
    f["as_of"] = str(f.get("as_of") or d["freshness"]["as_of"])
    try:
        datetime.date.fromisoformat(f["as_of"])
    except ValueError as exc:
        raise PipelineConfigError("'freshness.as_of' muss ein gültiges Datum (JJJJ-MM-TT) sein") from exc

    g = c["generation"]
    if g.get("mode") not in ("extractive", "llm"):
        g["mode"] = "extractive"
    g["strict_grounding"] = _bool(g.get("strict_grounding"))
    g["abstain_threshold"] = _num(g.get("abstain_threshold"), 0.2, 0.0, 1.0)
    g["require_citations"] = _bool(g.get("require_citations"))

    c["verify"] = _bool(c.get("verify"))
    return c
