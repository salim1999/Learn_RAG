"""Acceptance tests on the shipped course, using real API submission/progress paths."""
import json

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from app import config, content_loader
from app.agents.orchestrator import run_agents
from app.grading import grade_task
from app.rag import pipeline
from tests.test_real_content import solution_answer

SCHEMAS = config.BASE_DIR / "schemas"


@pytest.fixture
def curriculum(monkeypatch):
    monkeypatch.setattr(content_loader, "LEVELS_DIR", config.CONTENT_DIR / "levels")
    monkeypatch.setattr(content_loader, "CORPUS_DIR", config.CONTENT_DIR / "corpus")
    content_loader.clear_cache()
    pipeline.clear_cache()
    return content_loader.load_levels()


def validate(schema_name, value):
    schema = json.loads((SCHEMAS / f"{schema_name}.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)


def exercises(levels):
    for level in levels.values():
        for task in level["tasks"]:
            yield task
            yield from task.get("steps", [])


def test_curriculum_schema_and_completeness(curriculum):
    assert sorted(curriculum) == list(range(1, 15))
    all_ids = []
    total_xp = 0
    for level in curriculum.values():
        validate("level", level)
        validate("level", content_loader.strip_solutions(level))
        assert 4 <= len(level["tasks"]) <= 6
        assert level["tasks"][-1]["type"] == "boss"
        assert level["tasks"][-1]["lives"] == 3
        assert sum(t["type"] == "boss" for t in level["tasks"]) == 1
        total_xp += sum(task["xp"] for task in level["tasks"])
    for task in exercises(curriculum):
        all_ids.append(task["id"])
        assert 10 <= task["xp"] <= 60, task["id"]
        if task["type"] == "quiz":
            assert {o["id"] for o in task["options"]} <= set(task["solution"]["option_explanations"])
    assert len(set(all_ids)) == len(all_ids)
    assert {t["type"] for t in exercises(curriculum)} == {
        "quiz", "better", "order", "spot", "tune", "freshness", "code", "explain", "boss"
    }
    assert total_xp >= 3000, "The highest rank must be reachable without repeat farming"


def test_corpus_schema_versions_and_injection(curriculum):
    corpus = content_loader.public_corpus(content_loader.get_corpus())
    validate("corpus", corpus)
    docs = {d["id"]: d for d in corpus["documents"]}
    assert 25 <= len(docs) <= 35
    assert len(docs) == len(corpus["documents"])
    assert any("injection" in d["tags"] for d in docs.values())
    for doc in docs.values():
        assert 80 <= len(doc["text"].split()) <= 300, doc["id"]
        seen = {doc["id"]}
        current = doc
        while current.get("superseded_by"):
            next_id = current["superseded_by"]
            assert next_id in docs and next_id not in seen, (doc["id"], next_id)
            assert docs[next_id]["date"] > current["date"]
            seen.add(next_id)
            current = docs[next_id]


def test_every_tuning_target_requires_a_change(curriculum):
    for task in exercises(curriculum):
        if task["type"] != "tune":
            continue
        defaults = {p["name"]: p["default"] for p in task["params"]}
        initial, _, _ = grade_task(task, {"params": defaults})
        final, _, _ = grade_task(task, solution_answer(task))
        assert initial < 1, f"{task['id']} already passes before tuning"
        assert final == 1, f"{task['id']} has an unreachable target"


def test_full_course_through_api_unlocks_and_awards_xp_once(curriculum, client):
    assert client.get("/api/levels/2").status_code == 403
    expected_xp = 0
    for level_id, level in sorted(curriculum.items()):
        response = client.get(f"/api/levels/{level_id}")
        assert response.status_code == 200
        assert '"solution"' not in json.dumps(response.json())
        for task in level["tasks"]:
            url = f"/api/levels/{level_id}/tasks/{task['id']}/submit"
            if task["type"] == "boss":
                for index, step in enumerate(task["steps"]):
                    response = client.post(url, json={"answer": {"step": index, "answer": solution_answer(step)}})
                    assert response.status_code == 200, (task["id"], response.text)
                    assert response.json()["details"]["step_correct"], task["id"]
                assert response.json()["details"]["won"]
                assert response.json()["details"]["lives_left"] == 3
            else:
                response = client.post(url, json={"answer": solution_answer(task)})
                assert response.status_code == 200, (task["id"], response.text)
                repeated = client.post(url, json={"answer": solution_answer(task)})
                assert repeated.json()["xp_awarded"] == 0, task["id"]
            assert response.json()["score"] == 1, (task["id"], response.text)
            expected_xp += task["xp"]
        progress = client.get("/api/progress").json()
        stats = progress["levels"][str(level_id)]
        assert stats["score_pct"] == 1 and stats["stars"] == 3
        assert progress["player"]["xp"] == expected_xp
        if level_id < 14:
            assert progress["levels"][str(level_id + 1)]["unlocked"]
    assert progress["player"]["rank"] == "Halluzinations-Bezwinger"
    assert "graduate" in {b["id"] for b in progress["player"]["badges"]}
    reset = client.post("/api/progress/reset")
    assert reset.status_code == 200
    cleared = client.get("/api/progress").json()
    assert cleared["player"]["xp"] == 0
    assert all(v["unlocked"] == (k == "1") for k, v in cleared["levels"].items())


def test_real_sse_event_schema_and_retry(curriculum):
    events = list(run_agents(query="Wie viel kostet der Pro-Plan?", force_fail_first=True))
    for event in events:
        validate("trace-event", event)
    assert events[-1]["type"] == "final"
    assert any(e.get("status") == "retry" for e in events)
    assert 1 < events[-1]["iterations"] <= 3
    assert not events[-1]["abstained"]
