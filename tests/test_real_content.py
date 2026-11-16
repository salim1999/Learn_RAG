"""Prüft die echten Inhalte von Agent B (falls vorhanden):
jede Aufgabe muss mit ihrer Musterlösung Score 1.0 erreichen, und keine Lösung darf ausgeliefert werden.
"""
import json

import pytest

from app import config, content_loader
from app.grading import grade_task
from app.rag import pipeline

REAL_LEVELS = config.CONTENT_DIR / "levels"
REAL_CORPUS = config.CONTENT_DIR / "corpus"


@pytest.fixture
def real_content(monkeypatch):
    monkeypatch.setattr(content_loader, "LEVELS_DIR", REAL_LEVELS)
    monkeypatch.setattr(content_loader, "CORPUS_DIR", REAL_CORPUS)
    content_loader.clear_cache()
    pipeline.clear_cache()
    levels = content_loader.load_levels()
    if not levels:
        pytest.skip("Noch keine Level-Dateien von Agent B vorhanden")
    return levels


def solution_answer(task: dict) -> dict:
    """Leitet aus der Musterlösung eine Antwort im Client-Format ab."""
    sol = task.get("solution") or {}
    t = task["type"]
    if t == "quiz":
        return {"selected": list(sol.get("correct", []))}
    if t in ("better", "freshness"):
        return {"choice": sol.get("correct"), "reason": ""}
    if t == "order":
        return {"order": list(sol.get("order", []))}
    if t == "spot":
        return {"selected": list(sol.get("hallucinated", []))}
    if t == "tune":
        return {"params": dict(sol.get("example_params", {}))}
    if t == "code":
        return {"blanks": {k: (v[0] if isinstance(v, list) else v) for k, v in sol.get("blanks", {}).items()}}
    if t == "explain":
        return {"text": sol.get("model_answer", "")}
    raise AssertionError(f"unbekannter Typ {t}")


def _all_gradable(levels):
    for lid, level in sorted(levels.items()):
        for task in level["tasks"]:
            if task["type"] == "boss":
                for i, step in enumerate(task.get("steps", [])):
                    yield f"L{lid}/{task['id']}/step{i}", step
            else:
                yield f"L{lid}/{task['id']}", task


def test_every_task_solvable_with_solution(real_content):
    if "tune" in {t["type"] for _, t in _all_gradable(real_content)} and not content_loader.load_corpora():
        pytest.fail("tune-Aufgaben vorhanden, aber kein Korpus geladen")
    failures = []
    for name, task in _all_gradable(real_content):
        try:
            score, feedback, details = grade_task(task, solution_answer(task))
        except Exception as exc:  # noqa: BLE001 – Sammeln statt Abbrechen
            failures.append(f"{name}: Exception {exc!r}")
            continue
        if score < 1.0:
            extra = ""
            if task["type"] == "tune":
                extra = f" metrics={details.get('metrics')}"
            if task["type"] == "explain":
                extra = f" misses={details.get('misses')}"
            failures.append(f"{name} ({task['type']}): score={score:.3f}{extra}")
    assert not failures, "Aufgaben nicht mit Musterlösung lösbar:\n" + "\n".join(failures)


def test_real_levels_hide_solutions(real_content):
    for lid, level in real_content.items():
        assert "\"solution\"" not in json.dumps(content_loader.strip_solutions(level))


def test_real_task_ids_unique(real_content):
    ids = [t["id"] for lv in real_content.values() for t in lv["tasks"]]
    assert len(ids) == len(set(ids)), "doppelte Task-IDs"
