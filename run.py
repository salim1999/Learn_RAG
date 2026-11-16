"""Start the local Academy. Usage: python run.py [--port 8000] [--reload]."""
import argparse
import os

import uvicorn

# Load the project's .env before reading server options, too.
from app import config  # noqa: F401

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RAG Academy – lokaler Lernserver")
    parser.add_argument("--host", default=os.environ.get("RAG_ACADEMY_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("RAG_ACADEMY_PORT", "8000"))
    parser.add_argument("--reload", action="store_true", help="Entwicklungsmodus: bei Codeänderungen neu starten")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port muss zwischen 1 und 65535 liegen")
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload)
