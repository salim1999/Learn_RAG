"""Claude integration uses the official SDK, with no network/billed calls in tests."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import anthropic
import httpx
import pytest

from app.agents import llm
from app.grading import grade_explain
from app.rag import generate


def response(text, stop="end_turn"):
    return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="text", text=text)])


def fake_client(monkeypatch, side_effect):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-sent")
    create = Mock(side_effect=side_effect)
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)), close=Mock())
    monkeypatch.setattr(llm, "_client", lambda: client)
    return client, create


def test_without_key_never_constructs_client(monkeypatch):
    monkeypatch.setattr(llm, "_client", lambda: pytest.fail("No key must mean zero API calls"))
    assert llm._call_json("system", "user", {}) is None


def test_sdk_request_and_success(monkeypatch):
    client, create = fake_client(monkeypatch, [response('{"score": 1}')])
    assert llm._call_json("system", "user", llm.GRADE_SCHEMA) == {"score": 1}
    kwargs = create.call_args.kwargs
    assert kwargs["model"] == "claude-opus-5-5"
    assert kwargs["thinking"] == {"type": "adaptive"}
    assert kwargs["output_config"]["effort"] == "low" and kwargs["fallbacks"] == "default"
    assert kwargs["betas"] == ["server-side-fallback-2026-07-01"]
    client.close.assert_called_once()


@pytest.mark.parametrize("status,kind", [(429, anthropic.RateLimitError), (500, anthropic.APIStatusError)])
def test_api_errors_fall_back(monkeypatch, status, kind):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    error = kind("test", response=httpx.Response(status, request=req), body={})
    client, _ = fake_client(monkeypatch, error)
    assert llm._call_json("system", "user", {}) is None
    client.close.assert_called_once()


def test_connection_error_falls_back(monkeypatch):
    error = anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))
    fake_client(monkeypatch, error)
    assert llm._call_json("system", "user", {}) is None


@pytest.mark.parametrize("reply", [response('{}', "refusal"), response('{"score":', "max_tokens"),
                                   response('not json'), response(42), SimpleNamespace(content=None)])
def test_refusal_truncation_and_malformed_responses_fall_back(monkeypatch, reply):
    fake_client(monkeypatch, [reply])
    assert llm._call_json("system", "user", {}) is None


def test_structured_output_rejected_retries_plain_json(monkeypatch):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    error = anthropic.BadRequestError("format", response=httpx.Response(400, request=req), body={})
    _, create = fake_client(monkeypatch, [error, response('{"ok": true}')])
    assert llm._call_json("system", "user", {}) == {"ok": True}
    assert create.call_count == 2
    assert "format" not in create.call_args.kwargs["output_config"]


def test_sdk_signature_mismatch_uses_offline_fallback(monkeypatch):
    fake_client(monkeypatch, TypeError("unexpected keyword argument 'fallbacks'"))
    assert llm._call_json("system", "user", {}) is None


def test_invalid_online_generation_uses_extractive_fallback(monkeypatch):
    fake_client(monkeypatch, [response(json.dumps({"abstained": False, "sentences": [{"text": "Pro kostet 49 Euro.",
                                                                                             "citations": "not-a-list"}]}))])
    answer, info = generate.generate_answer("Pro kostet Euro", [{"id": "d1#0", "text": "Pro kostet 49 Euro im Monat.",
                                                                  "title": "Pro", "date": "2026-01-01", "score": 1}],
                                           {"mode": "llm", "strict_grounding": True, "abstain_threshold": .2,
                                            "require_citations": True})
    assert not answer["abstained"] and not info["llm_used"] and info["fallback"]


def test_failed_online_grading_uses_keyword_rubric(monkeypatch):
    fake_client(monkeypatch, [response("not-json")])
    task = {"question": "Was ist Grounding?", "solution": {"rubric": [{"concept": "Kontext", "keywords": ["Kontext"]}],
                                                           "pass_ratio": .6, "model_answer": "Belege im Kontext"}}
    score, _, details = grade_explain(task, {"text": "Mit Kontext belegen."})
    assert score == 1 and details["graded_by"] == "rubric"
