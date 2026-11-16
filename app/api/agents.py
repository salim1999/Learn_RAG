"""GET /api/agents/stream – Server-Sent Events des Agenten-Orchestrators."""
import asyncio
import json

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app import config
from app.agents.orchestrator import run_agents

router = APIRouter(tags=["agents"])


@router.get("/agents/stream")
async def agents_stream(
    query: str = Query(..., min_length=1, max_length=4000, description="Frage an das Agenten-System"),
    max_iterations: int = Query(3, ge=1, le=3),
    force_fail_first: bool = Query(False),
    use_llm: bool = Query(False),
):
    delay = config.agent_delay()

    async def events():
        first = True
        # Indexbau und SDK-Aufrufe blockieren nie den ASGI-Event-Loop.
        gen = run_agents(query, max_iterations, force_fail_first, use_llm)
        while True:
            evt = await asyncio.to_thread(next, gen, None)
            if evt is None:
                break
            if not first and delay > 0:
                await asyncio.sleep(delay)
            first = False
            yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
