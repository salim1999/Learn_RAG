"""GET /api/progress, POST /api/progress/reset"""
from fastapi import APIRouter

from app import db
from app import progress as prog

router = APIRouter(tags=["progress"])


@router.get("/progress")
def get_progress() -> dict:
    return prog.get_progress()


@router.post("/progress/reset")
def reset_progress() -> dict:
    db.reset_all()
    return prog.get_progress()
