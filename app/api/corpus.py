"""GET /api/corpus"""
from fastapi import APIRouter, HTTPException, Query

from app import content_loader

router = APIRouter(tags=["corpus"])


@router.get("/corpus")
def get_corpus(id: str = Query("default", description="Korpus-ID")) -> dict:
    corpus = content_loader.get_corpus(id)
    if corpus is None:
        raise HTTPException(status_code=404, detail="Korpus nicht gefunden")
    return content_loader.public_corpus(corpus)
