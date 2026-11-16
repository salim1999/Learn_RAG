"""GET /api/gpu/warmup – stößt einen Kaltstart des optionalen RunPod-Endpunkts an."""
from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from app.rag import remote

router = APIRouter(tags=["gpu"])


@router.get("/gpu/warmup")
async def gpu_warmup() -> dict:
    # blockierendes HTTP im Threadpool, damit der Event-Loop frei bleibt
    return await run_in_threadpool(remote.warmup)
