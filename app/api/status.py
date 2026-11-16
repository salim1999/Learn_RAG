"""GET /api/status"""
from fastapi import APIRouter

from app import config
from app.rag import remote

router = APIRouter(tags=["status"])


@router.get("/status")
def status() -> dict:
    enabled = config.llm_enabled()
    gpu = config.gpu_enabled()
    return {"llm_enabled": enabled, "model": config.MODEL if enabled else None, "version": config.VERSION,
            "gpu_enabled": gpu, "gpu_models": remote.models() if gpu else {}}
