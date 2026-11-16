"""Bewertung aller Aufgabentypen exakt nach CONTRACTS.md (reine Funktionen, ohne DB).

grade_task(task, answer) → (score, feedback_md, details)
Boss-Aufgaben haben Zustand (Leben) und werden in app/api/levels.py behandelt; deren Steps laufen hier durch.
"""
from __future__ import annotations

import copy
import re
from typing import Any

from app import config
from app.rag.pipeline import run_pipeline

INT_PARAMS = {"chunking.size", "chunking.overlap", "retrieval.k", "freshness.half_life_days"}
BOOL_SUFFIXES = (".mmr", ".rerank", ".enabled", ".drop_superseded", ".strict_grounding",
                 ".require_citations")


class GradingError(ValueError):
    """Ungültige Antwortstruktur → HTTP 422."""


def _sol(task: dict) -> dict:
    return task.get("solution") or {}


def _as_list(v) -> list:
    if v is None:
        return []
    return list(v) if isinstance(v, (list, tuple)) else [v]


def is_correct(task_type: str, score: float) -> bool:
    return score >= 1.0 if task_type in ("explain", "tune") else score >= 0.999


# --- quiz ----------------------------------------------------------------------------
def grade_quiz(task: dict, answer: dict):
    sol = _sol(task)
    correct = [str(c) for c in _as_list(sol.get("correct"))]
    selected = list(dict.fromkeys(str(s) for s in _as_list(answer.get("selected"))))
    cs, ss = set(correct), set(selected)
    if task.get("multi"):
        union = cs | ss
        score = len(cs & ss) / len(union) if union else 1.0
    else:
        score = 1.0 if ss and ss <= cs and len(ss) == 1 else 0.0
    expl = sol.get("option_explanations") or {}
    if score >= 0.999:
        fb = "**Richtig!**"
    elif score > 0:
        fb = f"**Teilweise richtig** ({len(cs & ss)} von {len(cs)} richtigen Optionen, {len(ss - cs)} falsch gewählt)."
    else:
        fb = "**Leider falsch.**"
    notes = [f"- **{o}**: {expl[o]}" for o in selected if o in expl]
    if notes:
        fb += "\n\n" + "\n".join(notes)
    return score, fb, {"correct": correct, "option_explanations": expl}


# --- better ------------------------------------------------------------------------
def grade_better(task: dict, answer: dict):
    sol = _sol(task)
    correct = str(sol.get("correct", ""))
    choice = str(answer.get("choice", ""))
    score = 1.0 if choice and choice == correct else 0.0
    label = (task.get(f"variant_{correct}") or {}).get("label", correct.upper())
    fb = (f"**Richtig!** Variante {label} ist besser." if score else f"**Nicht ganz.** Besser ist Variante {label}.")
    reason = str(answer.get("reason") or "").strip()
    if reason:
        fb += f"\n\n*Deine Begründung:* {reason}"
    return score, fb, {"correct": correct, "why": sol.get("why", "")}


# --- order -------------------------------------------------------------------------
def grade_order(task: dict, answer: dict):
    expected = [str(x) for x in _as_list(_sol(task).get("order"))]
    given = [str(x) for x in _as_list(answer.get("order"))]
    if not expected:
        return 1.0, "Keine Reihenfolge hinterlegt.", {"order": expected}
    if given == expected:
        score = 1.0
    else:
        hits = sum(1 for i, e in enumerate(expected) if i < len(given) and given[i] == e)
        score = min(hits / len(expected), 0.99)  # nur exakt = 1
    fb = ("**Perfekte Reihenfolge!**" if score >= 0.999 else
          f"**{round(score * len(expected))} von {len(expected)}** Positionen stimmen.")
    return score, fb, {"order": expected}


# --- spot --------------------------------------------------------------------------
def grade_spot(task: dict, answer: dict):
    sol = _sol(task)
    truth = {str(x) for x in _as_list(sol.get("hallucinated"))}
    sel = {str(x) for x in _as_list(answer.get("selected"))}
    if not truth and not sel:
        score = 1.0
    else:
        tp = len(truth & sel)
        prec = tp / len(sel) if sel else 0.0
        rec = tp / len(truth) if truth else 0.0
        score = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    missed, wrong = truth - sel, sel - truth
    if score >= 0.999:
        fb = "**Alle Halluzinationen entlarvt!**"
    else:
        fb = f"F1 = {score:.2f}."
        if missed:
            fb += f" Übersehen: {len(missed)}."
        if wrong:
            fb += f" Fälschlich markiert: {len(wrong)} (diese Sätze sind durch den Kontext gedeckt)."
    return score, fb, {"hallucinated": sorted(truth), "notes": sol.get("notes") or {}}


# --- tune ----------------------------------------------------------------------------
def _set_path(cfg: dict, path: str, value: Any) -> None:
    keys = path.split(".")
    cur = cfg
    for k in keys[:-1]:
        if not isinstance(cur.get(k), dict):
            cur[k] = {}
        cur = cur[k]
    cur[keys[-1]] = value


def _coerce_param(name: str, spec: dict | None, value: Any) -> Any:
    if isinstance(value, bool) or name.endswith(BOOL_SUFFIXES) or name == "verify":
        return value if isinstance(value, bool) else str(value).lower() in ("1", "true", "ja", "on")
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return value  # z.B. chunking.strategy / retrieval.method
    if isinstance(value, (int, float)) and spec:
        lo, hi = spec.get("min"), spec.get("max")
        if isinstance(lo, (int, float)):
            value = max(lo, value)
        if isinstance(hi, (int, float)):
            value = min(hi, value)
    if name in INT_PARAMS and isinstance(value, (int, float)):
        value = int(round(value))
    return value


def build_tune_config(task: dict, params: dict) -> dict:
    cfg = copy.deepcopy(task.get("base_config") or {})
    if task.get("query"):
        cfg["query"] = task["query"]
    specs = {p.get("name"): p for p in task.get("params") or [] if isinstance(p, dict)}
    # erst Defaults der Regler, dann die Werte des Spielers
    for name, spec in specs.items():
        if "default" in spec:
            _set_path(cfg, name, _coerce_param(name, spec, spec["default"]))
    for name, val in (params or {}).items():
        if specs and name not in specs:
            continue  # nur freigegebene Regler
        _set_path(cfg, name, _coerce_param(name, specs.get(name), val))
    return cfg


def grade_tune(task: dict, answer: dict):
    sol = _sol(task)
    target = task.get("target") or {}
    metric = target.get("metric", "recall_at_k")
    threshold = float(target.get("threshold", 1.0))
    params = answer.get("params")
    if params is not None and not isinstance(params, dict):
        raise GradingError("'params' muss ein Objekt sein")
    cfg = build_tune_config(task, params or {})
    run = run_pipeline(cfg, relevant_doc_ids=sol.get("relevant_doc_ids") or [])
    value = float(run["metrics"].get(metric, 0.0))
    score = 1.0 if value >= threshold else (value / threshold if threshold > 0 else 0.0)
    label = target.get("label") or metric
    fb = (f"**Ziel erreicht!** {label}: {value:.2f} (Ziel ≥ {threshold:.2f})" if score >= 1 else
          f"**Noch nicht.** {label}: {value:.2f} – Ziel ≥ {threshold:.2f}. Probier andere Einstellungen.")
    return score, fb, {"metric_value": round(value, 4), "metrics": run["metrics"], "run": run}


# --- freshness ---------------------------------------------------------------------
def grade_freshness(task: dict, answer: dict):
    sol = _sol(task)
    correct = str(sol.get("correct", ""))
    score = 1.0 if str(answer.get("choice", "")) == correct else 0.0
    fb = "**Richtig – du hast die aktuelle Quelle erkannt!**" if score else "**Leider falsch.** Achte auf Datum, Version und `superseded_by`."
    return score, fb, {"correct": correct, "why": sol.get("why", "")}


# --- code ----------------------------------------------------------------------------
def normalize_code(s: Any) -> str:
    """Whitespace-normalisiert: Leerraum entfernen, Anführungszeichen vereinheitlichen."""
    return re.sub(r"\s+", "", str(s or "")).replace('"', "'")


def grade_code(task: dict, answer: dict):
    sol_blanks = _sol(task).get("blanks") or {}
    given = answer.get("blanks") or {}
    if not isinstance(given, dict):
        raise GradingError("'blanks' muss ein Objekt sein")
    ids = [str(b.get("id")) for b in task.get("blanks") or [] if isinstance(b, dict)] or list(sol_blanks)
    per, expected = {}, {}
    for bid in ids:
        accepted = [normalize_code(a) for a in _as_list(sol_blanks.get(bid))]
        per[bid] = bool(accepted) and normalize_code(given.get(bid)) in accepted
        expected[bid] = (_as_list(sol_blanks.get(bid)) or [""])[0]
    score = sum(per.values()) / len(per) if per else 1.0
    fb = ("**Alle Lücken korrekt!**" if score >= 0.999 else
          f"**{sum(per.values())} von {len(per)}** Lücken korrekt.")
    return score, fb, {"per_blank": per, "expected": expected}


# --- explain -------------------------------------------------------------------------
def _norm_text(s: str) -> str:
    s = s.lower().replace("ß", "ss")
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue")):
        s = s.replace(a, b)
    s = re.sub(r"[-_/]", " ", s)
    return re.sub(r"\s+", " ", s)


def rubric_hits(rubric: list[dict], text: str) -> tuple[list[str], list[str]]:
    t = _norm_text(text)
    t_compact = t.replace(" ", "")
    hits, misses = [], []
    for r in rubric:
        kws = [_norm_text(k).strip() for k in _as_list(r.get("keywords")) if str(k).strip()]
        found = any(k in t or k.replace(" ", "") in t_compact for k in kws)
        (hits if found else misses).append(str(r.get("concept", "")))
    return hits, misses


def grade_explain(task: dict, answer: dict, allow_llm: bool = True):
    sol = _sol(task)
    rubric = [r for r in _as_list(sol.get("rubric")) if isinstance(r, dict)]
    pass_ratio = float(sol.get("pass_ratio", 0.6))
    text = str(answer.get("text") or "")
    model_answer = sol.get("model_answer", "")
    graded_by = "rubric"
    llm_feedback = None
    hits, misses = rubric_hits(rubric, text)
    ratio = len(hits) / len(rubric) if rubric else (1.0 if text.strip() else 0.0)
    if allow_llm and config.llm_enabled() and text.strip():
        from app.agents import llm

        res = llm.grade_explanation(task.get("question", task.get("prompt", "")), rubric, model_answer, text)
        if res is not None:
            graded_by = "claude"
            ratio, hits, misses, llm_feedback = res["score"], res["hits"], res["misses"], res["feedback"]
    score = 1.0 if ratio >= pass_ratio else ratio
    if llm_feedback:
        fb = llm_feedback
    elif score >= 1:
        fb = f"**Bestanden!** Du hast {len(hits)} von {len(rubric)} Kernkonzepten erklärt."
    else:
        fb = (f"**Noch nicht bestanden** ({len(hits)} von {len(rubric)} Konzepten, nötig: "
              f"{pass_ratio:.0%}). Es fehlen: {', '.join(misses) or '–'}.")
    return score, fb, {"hits": hits, "misses": misses, "model_answer": model_answer, "graded_by": graded_by}


GRADERS = {
    "quiz": grade_quiz, "better": grade_better, "order": grade_order, "spot": grade_spot,
    "tune": grade_tune, "freshness": grade_freshness, "code": grade_code, "explain": grade_explain,
}


def grade_task(task: dict, answer: Any) -> tuple[float, str, dict]:
    """Bewertet eine (Nicht-Boss-)Aufgabe. score in [0, 1]."""
    if not isinstance(answer, dict):
        raise GradingError("'answer' muss ein Objekt sein")
    fn = GRADERS.get(task.get("type"))
    if fn is None:
        raise GradingError(f"Unbekannter Aufgabentyp: {task.get('type')}")
    score, fb, details = fn(task, answer)
    return max(0.0, min(1.0, float(score))), fb, details
