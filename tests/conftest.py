"""Gemeinsame Fixtures: temporäre DB, Test-Korpus/Level (unabhängig von app/content), kein API-Key."""
from pathlib import Path

import pytest

from app import content_loader
from app.rag import pipeline, remote

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    monkeypatch.setenv("RAG_ACADEMY_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RAG_ACADEMY_AGENT_DELAY", "0")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # GPU-Modus aus (.env wird beim Import geladen) und harte Sperre gegen echte Netzwerkaufrufe
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.delenv("RUNPOD_EMBED_ENDPOINT_ID", raising=False)
    monkeypatch.setenv("RAG_ACADEMY_EMB_CACHE", str(tmp_path / "emb_cache"))

    def _no_network():
        raise AssertionError("Echter Netzwerkaufruf in Tests verboten – remote._client mocken!")

    monkeypatch.setattr(remote, "_client", _no_network)
    monkeypatch.setattr(content_loader, "LEVELS_DIR", FIXTURES / "levels")
    monkeypatch.setattr(content_loader, "CORPUS_DIR", FIXTURES / "corpus")
    content_loader.clear_cache()
    pipeline.clear_cache()
    yield
    content_loader.clear_cache()
    pipeline.clear_cache()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)
