"""API-Tests über FastAPIs TestClient (mit Test-Korpus und temporärer DB)."""
import json

from app import content_loader


def _submit(client, level, task, answer):
    r = client.post(f"/api/levels/{level}/tasks/{task}/submit", json={"answer": answer})
    assert r.status_code == 200, r.text
    return r.json()


def test_status(client):
    r = client.get("/api/status").json()
    assert r == {"llm_enabled": False, "model": None, "version": "1.0", "gpu_enabled": False, "gpu_models": {}}


def test_index_served(client):
    assert client.get("/").status_code == 200


def test_levels_list_and_lock(client):
    levels = client.get("/api/levels").json()
    assert [lv["id"] for lv in levels] == [1, 2]  # kaputte level_99.json wird ignoriert
    assert levels[0]["unlocked"] is True and levels[1]["unlocked"] is False
    assert levels[0]["task_count"] == 10
    r = client.get("/api/levels/2")
    assert r.status_code == 403 and r.json() == {"detail": "Level gesperrt"}
    assert client.get("/api/levels/42").status_code == 404


def test_level_has_no_solutions(client):
    level = client.get("/api/levels/1").json()
    assert "solution" not in json.dumps(level)
    boss = next(t for t in level["tasks"] if t["type"] == "boss")
    assert len(boss["steps"]) == 2 and all("solution" not in s for s in boss["steps"])


def test_submit_quiz_and_xp(client):
    res = _submit(client, 1, "l01t01", {"selected": ["b"]})
    assert res["correct"] is False and res["score"] == 0 and res["xp_awarded"] == 0
    res = _submit(client, 1, "l01t01", {"selected": ["a"]})
    assert res["correct"] is True and res["xp_awarded"] == 10
    assert res["details"]["correct"] == ["a"]
    assert res["progress"]["player"]["xp"] == 10
    assert res["progress"]["levels"]["1"]["best_scores"]["l01t01"] == 1.0
    assert any(b["id"] == "first_steps" for b in res["progress"]["player"]["badges"])
    # Wiederholen bringt keine XP
    assert _submit(client, 1, "l01t01", {"selected": ["a"]})["xp_awarded"] == 0


def test_submit_partial_scores(client):
    multi = _submit(client, 1, "l01t02", {"selected": ["a", "c"]})
    assert abs(multi["score"] - 1 / 3) < 1e-3 and multi["xp_awarded"] == round(20 / 3)
    order = _submit(client, 1, "l01t04", {"order": ["x", "z", "y"]})
    assert abs(order["score"] - 1 / 3) < 1e-3
    spot = _submit(client, 1, "l01t05", {"selected": ["s1", "s2"]})
    assert abs(spot["score"] - 2 / 3) < 1e-3
    code = _submit(client, 1, "l01t08", {"blanks": {"1": "a@b", "2": "5"}})
    assert code["score"] == 0.5 and code["details"]["per_blank"] == {"1": True, "2": False}


def test_submit_tune(client):
    low = _submit(client, 1, "l01t06", {"params": {"retrieval.k": 1}})
    assert "metric_value" in low["details"] and "run" in low["details"]
    high = _submit(client, 1, "l01t06", {"params": {"retrieval.k": 4}})
    assert high["correct"] is True and high["details"]["metrics"]["recall_at_k"] == 1.0


def test_submit_explain(client):
    bad = _submit(client, 1, "l01t09", {"text": "Keine Ahnung."})
    assert bad["correct"] is False and bad["details"]["graded_by"] == "rubric"
    good = _submit(client, 1, "l01t09", {"text": "Sie raten das wahrscheinlichste nächste Token und kennen nur "
                                                  "ihre Trainingsdaten."})
    assert good["correct"] is True and good["score"] == 1.0
    assert set(good["details"]["hits"]) == {"Wahrscheinlichkeit", "Kein Wissen"}


def test_boss_lives_and_win(client):
    r = _submit(client, 1, "l01t10", {"step": 0, "answer": {"selected": ["a"]}})
    d = r["details"]
    assert d["step_correct"] is False and d["lives_left"] == 2 and d["finished"] is False
    r = _submit(client, 1, "l01t10", {"step": 0, "answer": {"selected": ["b"]}})
    assert r["details"]["step_correct"] is True and r["score"] == 0.5 and r["xp_awarded"] == 30
    r = _submit(client, 1, "l01t10", {"step": 1, "answer": {"choice": "x"}})
    assert r["details"]["finished"] is True and r["correct"] is True and r["score"] == 1.0
    assert any(b["id"] == "boss_slayer" for b in r["progress"]["player"]["badges"])


def test_boss_game_over_resets(client):
    for _ in range(3):
        r = _submit(client, 1, "l01t10", {"step": 1, "answer": {"choice": "y"}})
    assert r["details"]["lives_left"] == 0 and r["details"]["finished"] is True
    r = _submit(client, 1, "l01t10", {"step": 1, "answer": {"choice": "y"}})
    assert r["details"]["lives_left"] == 2  # neuer Versuch


def test_invalid_answers(client):
    assert client.post("/api/levels/1/tasks/l01t01/submit", json={}).status_code == 422
    assert client.post("/api/levels/1/tasks/nope/submit", json={"answer": {}}).status_code == 404
    assert client.post("/api/levels/1/tasks/l01t10/submit", json={"answer": {"step": 9}}).status_code == 422


def test_unlock_progress_and_reset(client):
    answers = {
        "l01t01": {"selected": ["a"]}, "l01t02": {"selected": ["a", "b"]}, "l01t03": {"choice": "a"},
        "l01t04": {"order": ["x", "y", "z"]}, "l01t05": {"selected": ["s2"]},
        "l01t06": {"params": {"retrieval.k": 4}}, "l01t07": {"choice": "o2"},
        "l01t08": {"blanks": {"1": "np.dot(a,b)", "2": "4"}},
    }
    for tid, ans in answers.items():
        assert _submit(client, 1, tid, ans)["correct"], tid
    prog = client.get("/api/progress").json()
    lv1 = prog["levels"]["1"]
    assert abs(lv1["score_pct"] - 0.8) < 1e-6 and lv1["stars"] == 1
    assert prog["levels"]["2"]["unlocked"] is True
    assert client.get("/api/levels/2").status_code == 200
    player = prog["player"]
    assert player["xp"] == 190 and player["rank"] == "Chunk-Schmied" and player["next_rank_xp"] == 400
    assert player["streak_days"] == 1
    badge_ids = {b["id"] for b in player["badges"]}
    assert {"first_steps", "hallucination_hunter", "time_traveler", "code_cracker", "tuner"} <= badge_ids
    for b in player["badges"]:
        assert set(b) == {"id", "name", "icon", "description"}
    reset = client.post("/api/progress/reset").json()
    assert reset["player"]["xp"] == 0 and reset["levels"]["2"]["unlocked"] is False


def test_corpus(client):
    c = client.get("/api/corpus").json()
    assert c["id"] == "default" and len(c["documents"]) == 8 and "_fingerprint" not in c
    assert client.get("/api/corpus?id=nope").status_code == 404


def test_rag_run(client):
    r = client.post("/api/rag/run", json={"query": "Wie viel kostet der Pro-Plan?",
                                          "retrieval": {"method": "bm25", "k": 3}})
    assert r.status_code == 200
    body = r.json()
    assert body["config"]["retrieval"]["method"] == "bm25" and len(body["chunks"]) == 3
    assert client.post("/api/rag/run", json={}).status_code == 200
    assert client.post("/api/rag/run", json={"corpus": "nope"}).status_code == 404


def test_agents_stream(client):
    with client.stream("GET", "/api/agents/stream",
                       params={"query": "Wie viele Anfragen pro Minute erlaubt die API?",
                               "force_fail_first": "true"}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        raw = "".join(r.iter_text())
    events = [json.loads(block[len("data: "):]) for block in raw.split("\n\n") if block.startswith("data: ")]
    assert events[0]["agent"] == "orchestrator" and events[-1]["type"] == "final"
    assert any(e.get("status") == "retry" for e in events)


def test_loader_robust_without_dirs(monkeypatch, tmp_path):
    monkeypatch.setattr(content_loader, "LEVELS_DIR", tmp_path / "missing")
    monkeypatch.setattr(content_loader, "CORPUS_DIR", tmp_path / "missing2")
    content_loader.clear_cache()
    assert content_loader.load_levels() == {} and content_loader.load_corpora() == {}
