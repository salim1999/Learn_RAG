"""Persistenz des Spielfortschritts (sqlite3 aus der Standardbibliothek).

Eine Verbindung pro Aufruf – einfach, threadsicher genug für einen lokalen Spieler.
Der Pfad wird bei jedem Verbindungsaufbau neu gelesen (RAG_ACADEMY_DB für Tests).
"""
from __future__ import annotations

import datetime as _dt
import json
import sqlite3
from contextlib import contextmanager
from typing import Iterator

from app import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS best_scores (
    task_id   TEXT PRIMARY KEY,
    level_id  INTEGER NOT NULL,
    score     REAL NOT NULL,
    updated   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xp_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id   TEXT NOT NULL,
    amount    INTEGER NOT NULL,
    ts        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS badges (
    badge_id  TEXT PRIMARY KEY,
    earned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_days (
    day       TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS boss_state (
    task_id   TEXT PRIMARY KEY,
    lives     INTEGER NOT NULL,
    solved    TEXT NOT NULL,      -- JSON-Liste gelöster Step-Indizes
    finished  INTEGER NOT NULL DEFAULT 0
);
"""


def today() -> _dt.date:
    """Heutiges Datum (in Tests monkeypatchbar)."""
    return _dt.date.today()


def _now() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    path = config.db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


# --- Best Scores -----------------------------------------------------------
def get_best_scores() -> dict[str, float]:
    with connect() as c:
        return {r[0]: float(r[1]) for r in c.execute("SELECT task_id, score FROM best_scores")}


def get_best_score(task_id: str) -> float:
    with connect() as c:
        row = c.execute("SELECT score FROM best_scores WHERE task_id=?", (task_id,)).fetchone()
        return float(row[0]) if row else 0.0


def set_best_score(task_id: str, level_id: int, score: float) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO best_scores(task_id, level_id, score, updated) VALUES(?,?,?,?) "
            "ON CONFLICT(task_id) DO UPDATE SET score=excluded.score, updated=excluded.updated",
            (task_id, int(level_id), float(score), _now()),
        )


def record_score(task_id: str, level_id: int, score: float, task_xp: int) -> int:
    """Bestwert und XP atomar speichern; Teilpunkte können keine zusätzlichen XP erzeugen.

    Das Rundungsziel ist der XP-Gesamtwert des Bestwerts. So bringen zehn kleine
    Verbesserungen genau so viele XP wie eine vollständig richtige Antwort.
    BEGIN IMMEDIATE verhindert doppelte XP bei parallelen Tabs/Abgaben.
    """
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT score FROM best_scores WHERE task_id=?", (task_id,)).fetchone()
        old = float(row[0]) if row else 0.0
        new = max(old, min(1.0, max(0.0, float(score))))
        if new > old:
            c.execute(
                "INSERT INTO best_scores(task_id, level_id, score, updated) VALUES(?,?,?,?) "
                "ON CONFLICT(task_id) DO UPDATE SET score=excluded.score, updated=excluded.updated",
                (task_id, int(level_id), new, _now()),
            )
        awarded = c.execute("SELECT COALESCE(SUM(amount),0) FROM xp_log WHERE task_id=?", (task_id,)).fetchone()[0]
        delta = max(0, int(round(int(task_xp) * new)) - int(awarded))
        if delta:
            c.execute("INSERT INTO xp_log(task_id, amount, ts) VALUES(?,?,?)", (task_id, delta, _now()))
        return delta


# --- XP ------------------------------------------------------------------------
def add_xp(task_id: str, amount: int) -> None:
    if amount <= 0:
        return
    with connect() as c:
        c.execute("INSERT INTO xp_log(task_id, amount, ts) VALUES(?,?,?)", (task_id, int(amount), _now()))


def total_xp() -> int:
    with connect() as c:
        row = c.execute("SELECT COALESCE(SUM(amount),0) FROM xp_log").fetchone()
        return int(row[0])


# --- Badges --------------------------------------------------------------------
def get_badges() -> list[str]:
    with connect() as c:
        return [r[0] for r in c.execute("SELECT badge_id FROM badges ORDER BY earned_at, rowid")]


def award_badge(badge_id: str) -> bool:
    """Vergibt ein Badge; True, wenn es neu ist."""
    with connect() as c:
        cur = c.execute("INSERT OR IGNORE INTO badges(badge_id, earned_at) VALUES(?,?)", (badge_id, _now()))
        return cur.rowcount > 0


# --- Aktivität / Streak ----------------------------------------------------------
def mark_activity(day: _dt.date | None = None) -> None:
    d = (day or today()).isoformat()
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO activity_days(day) VALUES(?)", (d,))


def streak_days() -> int:
    """Aufeinanderfolgende aktive Tage bis heute (oder bis gestern, falls heute noch nichts)."""
    with connect() as c:
        days = {r[0] for r in c.execute("SELECT day FROM activity_days")}
    cur = today()
    if cur.isoformat() not in days:
        cur -= _dt.timedelta(days=1)
    n = 0
    while cur.isoformat() in days:
        n += 1
        cur -= _dt.timedelta(days=1)
    return n


# --- Boss-Zustand ----------------------------------------------------------------
def get_boss_state(task_id: str, default_lives: int) -> dict:
    with connect() as c:
        row = c.execute("SELECT lives, solved, finished FROM boss_state WHERE task_id=?", (task_id,)).fetchone()
    if not row:
        return {"lives": int(default_lives), "solved": [], "finished": False}
    return {"lives": int(row[0]), "solved": json.loads(row[1]), "finished": bool(row[2])}


def set_boss_state(task_id: str, lives: int, solved: list[int], finished: bool) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO boss_state(task_id, lives, solved, finished) VALUES(?,?,?,?) "
            "ON CONFLICT(task_id) DO UPDATE SET lives=excluded.lives, solved=excluded.solved, "
            "finished=excluded.finished",
            (task_id, int(lives), json.dumps(sorted(set(solved))), int(bool(finished))),
        )


# --- Reset -------------------------------------------------------------------
def reset_all() -> None:
    with connect() as c:
        for table in ("best_scores", "xp_log", "badges", "activity_days", "boss_state"):
            c.execute(f"DELETE FROM {table}")
