"""Tests für den Agenten-Orchestrator."""
from app.agents.orchestrator import run_agents


def _collect(**kw):
    return list(run_agents(**kw))


def test_orchestrator_terminates_with_final():
    events = _collect(query="Wie viele Anfragen pro Minute erlaubt die API?", max_iterations=3)
    assert events[-1]["type"] == "final"
    assert all(e["type"] == "step" for e in events[:-1])
    final = events[-1]
    assert final["abstained"] is False and final["iterations"] == 1
    assert final["answer"]["sentences"] and final["chunks"]
    agents = {e["agent"] for e in events[:-1]}
    assert agents == {"planner", "retriever", "generator", "verifier", "orchestrator"}
    for e in events[:-1]:
        assert e["status"] in ("start", "done", "fail", "retry") and e["message"]


def test_force_fail_first_triggers_retry():
    events = _collect(query="Wie viele Anfragen pro Minute erlaubt die API?", max_iterations=3,
                      force_fail_first=True)
    fails = [e for e in events if e.get("agent") == "verifier" and e.get("status") == "fail"]
    retries = [e for e in events if e.get("status") == "retry"]
    assert fails and fails[0]["iteration"] == 1
    assert retries and retries[0]["agent"] == "orchestrator"
    final = events[-1]
    assert final["type"] == "final" and final["iterations"] == 2 and not final["abstained"]
    planners = [e for e in events if e.get("agent") == "planner" and e["status"] == "done"]
    assert planners[0]["payload"]["strategy"] != planners[1]["payload"]["strategy"]


def test_off_topic_abstains_after_max_iterations():
    events = _collect(query="Wer gewann die Fußball-Weltmeisterschaft?", max_iterations=2)
    final = events[-1]
    assert final["type"] == "final" and final["abstained"] is True and final["iterations"] == 2


def test_final_answer_never_cites_stale_chunks():
    events = _collect(query="Wie viel kostet der Pro-Plan?", max_iterations=3)
    final = events[-1]
    assert final["type"] == "final"
    by_id = {c["id"]: c for c in final["chunks"]}
    cited = {cid for s in final["answer"]["sentences"] for cid in s["citations"]}
    assert all(not by_id[c]["stale"] for c in cited if c in by_id)
