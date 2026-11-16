"""Regressions for observed integration failures and the course's safety claims."""
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import config, db
from app.agents.orchestrator import run_agents
from app.code_checks import UnsafeExpression, check_blank, evaluate_expression
from app.grading import grade_code
from app.rag.pipeline import finalize_answer


def test_xp_atomic_and_bounded_across_parallel_submissions():
    with ThreadPoolExecutor(max_workers=8) as pool:
        awards = list(pool.map(lambda _: db.record_score("parallel", 1, 1, 20), range(20)))
    assert sum(awards) == db.total_xp() == 20
    assert db.get_best_score("parallel") == 1


def test_partial_score_rounding_does_not_farm_xp():
    for score in (.05, .15, .25, .35, .45, .55, .65, .75, .85, .95, 1):
        db.record_score("partial", 1, score, 10)
    assert db.total_xp() == 10
    assert db.record_score("partial", 1, 1, 10) == 0


def test_boss_must_follow_steps_and_restart_keeps_best(client):
    path = "/api/levels/1/tasks/l01t10"
    assert client.post(path + "/submit", json={"answer": {"step": 1, "answer": {"choice": "x"}}}).status_code == 422
    first = client.post(path + "/submit", json={"answer": {"step": 0, "answer": {"selected": ["b"]}}}).json()
    assert first["score"] == .5 and first["xp_awarded"] == 30
    reset = client.post(path + "/restart").json()
    assert reset == {"lives_left": 3, "solved_steps": [], "finished": False, "step": 0}
    assert client.get("/api/progress").json()["player"]["xp"] == 30
    again = client.post(path + "/submit", json={"answer": {"step": 0, "answer": {"selected": ["b"]}}}).json()
    assert again["xp_awarded"] == 0 and again["score"] == .5
    assert client.post("/api/levels/1/tasks/l01t01/restart").status_code == 422
    assert client.post("/api/levels/2/tasks/l02t01/restart").status_code == 403


@pytest.mark.parametrize("bad", [{"retrieval": None}, {"chunking": []}, {"generation": "llm"},
                                  {"freshness": False}, {"query": []}, {"freshness": {"as_of": "tomorrow"}}])
def test_bad_pipeline_shapes_are_422(client, bad):
    assert client.post("/api/rag/run", json=bad).status_code == 422


def test_nonfinite_slider_values_use_defaults():
    cfg = config.normalize_pipeline_config({"retrieval": {"k": float("nan")},
                                            "chunking": {"size": float("inf")}})
    assert cfg["retrieval"]["k"] == 4 and cfg["chunking"]["size"] == 300


@pytest.mark.parametrize("answer", [{"selected": {}}, {"selected": [None]}, {"reason": []}])
def test_malformed_task_fields_are_422(client, answer):
    assert client.post("/api/levels/1/tasks/l01t01/submit", json={"answer": answer}).status_code == 422


def test_agent_loop_hard_cap_and_http_bound(client):
    final = list(run_agents("Wer gewann die Fußball-Weltmeisterschaft?", max_iterations=99))[-1]
    assert final["iterations"] == 3 and final["abstained"]
    assert client.get("/api/agents/stream", params={"query": "Pro?", "max_iterations": 4}).status_code == 422


@pytest.mark.parametrize("source", ["__import__('os').system('touch /tmp/rag-unsafe')", "open('secret')",
                                     "(1).__class__", "(lambda: 1)()", "[x for x in range(1000000)]",
                                     "'x' * 1000000", "2 ** 1000000", "(1000000 ** 32) ** 32",
                                     "np.sqrt([1, 4], out=data)"])
def test_expression_interpreter_rejects_unapproved_operations(source):
    with pytest.raises((UnsafeExpression, TypeError, ValueError)):
        evaluate_expression(source, {})


def test_code_testcases_accept_equivalent_and_reject_boundary_bug():
    task = {"template": "def pack(chunks, budget, count_tokens):\n    if {{1}}: pass"}
    assert check_blank(task, "budget >= t + used", ["used + t <= budget"]) == (True, 4)
    assert check_blank(task, "used + t < budget", ["used + t <= budget"]) == (False, 4)
    assert check_blank({"template": "def mmr_score(): pass"}, ".7", ["lam"])[0] is False


def test_ast_preserves_whitespace_inside_string_constants():
    task = {"blanks": [{"id": "1"}], "solution": {"blanks": {"1": ["'select'"]}}}
    assert grade_code(task, {"blanks": {"1": "'sel ect'"}})[0] == 0


@pytest.mark.parametrize("text,citations", [("Der Pro-Plan kostet 999 Euro.", ["d1#0"]),
                                           ("Der Pro-Plan kostet 49 Euro.", ["invented#0"]),
                                           ("Der Pro-Plan kostet 49 Euro.", [])])
def test_verifier_removes_numeric_hallucinations_and_invalid_citations(text, citations):
    chunks = [{"id": "d1#0", "text": "Der Pro-Plan kostet 49 Euro im Monat."}]
    answer = {"text": text, "abstained": False, "sentences": [{"text": text, "citations": citations}]}
    checked, report = finalize_answer(answer, chunks, {"generation": {"require_citations": True}, "verify": True})
    assert checked["abstained"] and report["removed"] == [text]
