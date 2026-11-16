"""FastAPI-App: statische Dateien, Startseite und alle API-Router unter /api."""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.api import agents, corpus, gpu, levels, playground, progress, status

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(title="RAG Academy", version=config.VERSION)

for module in (status, levels, progress, corpus, playground, agents, gpu):
    app.include_router(module.router, prefix="/api")

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR), check_dir=False), name="static")


@app.get("/", include_in_schema=False)
def index():
    page = config.STATIC_DIR / "index.html"
    if page.is_file():
        return FileResponse(str(page))
    return HTMLResponse("<h1>RAG Academy</h1><p>static/index.html fehlt noch.</p>", status_code=200)
