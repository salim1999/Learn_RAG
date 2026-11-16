"""POST /api/rag/run – Pipeline-Spielwiese."""
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from app.config import PipelineConfigError
from app.rag.pipeline import CorpusNotFound, run_pipeline

router = APIRouter(tags=["rag"])


@router.post("/rag/run")
def rag_run(config: dict[str, Any] = Body(default_factory=dict)) -> dict:
    cfg = dict(config or {})
    # optionale Erweiterung: relevant_doc_ids → zusätzliche Retrieval-Metriken
    relevant = cfg.pop("relevant_doc_ids", None)
    if relevant is not None and not isinstance(relevant, list):
        relevant = None
    try:
        return run_pipeline(cfg, relevant_doc_ids=relevant)
    except CorpusNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PipelineConfigError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
