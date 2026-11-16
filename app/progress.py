"""Fortschrittslogik: XP, Ränge, Sterne, Freischaltung, Badges → PROGRESS-Objekt."""
from __future__ import annotations

from app import content_loader, db

RANKS: list[tuple[int, str]] = [
    (0, "Token-Lehrling"), (150, "Chunk-Schmied"), (400, "Vektor-Navigator"), (800, "Retrieval-Ritter"),
    (1300, "Grounding-Wächter"), (2000, "RAG-Architekt"), (3000, "Halluzinations-Bezwinger"),
]

BADGES: list[dict] = [
    {"id": "first_steps", "name": "Erste Schritte", "icon": "👣",
     "description": "Deine erste Aufgabe vollständig richtig gelöst."},
    {"id": "hallucination_hunter", "name": "Halluzinationsjäger", "icon": "🕵️",
     "description": "Alle Halluzinations-Suchaufgaben (spot) perfekt gelöst."},
    {"id": "time_traveler", "name": "Zeitreisender", "icon": "⏳",
     "description": "Alle Aktualitäts-Aufgaben (freshness) perfekt gelöst."},
    {"id": "boss_slayer", "name": "Boss-Bezwinger", "icon": "🐉",
     "description": "Einen Boss-Kampf vollständig gewonnen."},
    {"id": "perfectionist", "name": "Perfektionist", "icon": "💎",
     "description": "3 Sterne in einem Level erreicht."},
    {"id": "streak_3", "name": "Streak 3", "icon": "🔥",
     "description": "An 3 Tagen hintereinander gelernt."},
    {"id": "tuner", "name": "Feinmechaniker", "icon": "🎛️",
     "description": "Drei Tuning-Aufgaben gemeistert (oder alle, falls es weniger gibt)."},
    {"id": "code_cracker", "name": "Code-Knacker", "icon": "💻",
     "description": "Alle Code-Lückentexte perfekt ausgefüllt."},
    {"id": "graduate", "name": "Absolvent", "icon": "🎓",
     "description": "Jedes Level mit mindestens 70 % abgeschlossen."},
]
BADGE_BY_ID = {b["id"]: b for b in BADGES}

UNLOCK_PCT = 0.7


def rank_for(xp: int) -> tuple[str, int | None]:
    name, nxt = RANKS[0][1], None
    for i, (threshold, rank) in enumerate(RANKS):
        if xp >= threshold:
            name = rank
            nxt = RANKS[i + 1][0] if i + 1 < len(RANKS) else None
    return name, nxt


def stars_for(pct: float) -> int:
    if pct >= 0.9999:
        return 3
    if pct >= 0.85:
        return 2
    if pct >= UNLOCK_PCT:
        return 1
    return 0


def level_stats(level: dict, best: dict[str, float]) -> tuple[float, dict[str, float]]:
    tasks = level.get("tasks") or []
    scores = {t["id"]: round(best[t["id"]], 4) for t in tasks if t["id"] in best}
    pct = sum(best.get(t["id"], 0.0) for t in tasks) / len(tasks) if tasks else 0.0
    return round(pct, 4), scores


def levels_progress(best: dict[str, float] | None = None) -> dict[str, dict]:
    """{level_id: {unlocked, score_pct, stars, best_scores}} – Level 1 (bzw. das erste) ist immer offen."""
    levels = content_loader.load_levels()
    best = db.get_best_scores() if best is None else best
    out: dict[str, dict] = {}
    prev_pct = None
    for i, lid in enumerate(sorted(levels)):
        pct, scores = level_stats(levels[lid], best)
        unlocked = i == 0 or lid == 1 or (prev_pct is not None and prev_pct >= UNLOCK_PCT)
        out[str(lid)] = {"unlocked": unlocked, "score_pct": pct, "stars": stars_for(pct), "best_scores": scores}
        prev_pct = pct
    return out


def is_unlocked(level_id: int) -> bool:
    return levels_progress().get(str(level_id), {}).get("unlocked", False)


def _all_perfect(task_type: str, levels: dict, best: dict) -> bool:
    tasks = [t for lv in levels.values() for t in lv.get("tasks", []) if t.get("type") == task_type]
    return bool(tasks) and all(best.get(t["id"], 0.0) >= 0.999 for t in tasks)


def evaluate_badges() -> list[str]:
    """Prüft alle Badge-Bedingungen, vergibt neue und gibt deren IDs zurück."""
    levels = content_loader.load_levels()
    best = db.get_best_scores()
    lp = levels_progress(best)
    earned: list[str] = []

    def check(badge_id: str, cond: bool):
        if cond and db.award_badge(badge_id):
            earned.append(badge_id)

    all_tasks = [t for lv in levels.values() for t in lv.get("tasks", [])]
    check("first_steps", any(v >= 0.999 for v in best.values()))
    check("hallucination_hunter", _all_perfect("spot", levels, best))
    check("time_traveler", _all_perfect("freshness", levels, best))
    check("boss_slayer", any(t.get("type") == "boss" and best.get(t["id"], 0) >= 0.999 for t in all_tasks))
    check("perfectionist", any(v["stars"] == 3 for v in lp.values()))
    check("streak_3", db.streak_days() >= 3)
    tune = [t for t in all_tasks if t.get("type") == "tune"]
    solved_tune = sum(1 for t in tune if best.get(t["id"], 0) >= 0.999)
    check("tuner", bool(tune) and solved_tune >= min(3, len(tune)))
    check("code_cracker", _all_perfect("code", levels, best))
    check("graduate", bool(lp) and all(v["score_pct"] >= UNLOCK_PCT for v in lp.values()))
    return earned


def get_progress() -> dict:
    xp = db.total_xp()
    rank, nxt = rank_for(xp)
    badges = [BADGE_BY_ID[b] for b in db.get_badges() if b in BADGE_BY_ID]
    return {
        "player": {"xp": xp, "rank": rank, "next_rank_xp": nxt, "streak_days": db.streak_days(),
                   "badges": badges},
        "levels": levels_progress(),
    }
