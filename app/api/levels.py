"""Level-Endpunkte inkl. Abgabe & Bewertung aller Aufgabentypen (boss mit Leben-Zustand)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException

from app import content_loader, db
from app import progress as prog
from app.grading import GradingError, grade_task, is_correct

router = APIRouter(tags=["levels"])


@router.get("/levels")
def list_levels() -> list[dict]:
    levels = content_loader.load_levels()
    lp = prog.levels_progress()
    out = []
    for lid in sorted(levels):
        lv = levels[lid]
        p = lp.get(str(lid), {})
        out.append({
            "id": lid, "title": lv.get("title", f"Level {lid}"), "subtitle": lv.get("subtitle", ""),
            "icon": lv.get("icon", "📘"), "color": lv.get("color", "#7c5cff"),
            "task_count": len(lv.get("tasks", [])), "unlocked": p.get("unlocked", False),
            "stars": p.get("stars", 0), "score_pct": p.get("score_pct", 0.0),
        })
    return out


def _require_level(level_id: int) -> dict:
    level = content_loader.get_level(level_id)
    if level is None:
        raise HTTPException(status_code=404, detail="Level nicht gefunden")
    if not prog.is_unlocked(level_id):
        raise HTTPException(status_code=403, detail="Level gesperrt")
    return level


@router.get("/levels/{level_id}")
def get_level(level_id: int) -> dict:
    return content_loader.strip_solutions(_require_level(level_id))


def _grade_boss(task: dict, answer: dict) -> tuple[float, str, str, dict]:
    """Ein Boss-Step. Leben gehen bei falschen Steps verloren; bei 0 Leben ist der Kampf vorbei."""
    steps = [s for s in task.get("steps") or [] if isinstance(s, dict)]
    if not steps:
        raise GradingError("Boss ohne Steps")
    try:
        step = int(answer.get("step"))
    except (TypeError, ValueError) as exc:
        raise GradingError("'step' muss eine Zahl sein") from exc
    if not 0 <= step < len(steps):
        raise GradingError(f"'step' außerhalb 0..{len(steps) - 1}")
    lives_max = int(task.get("lives", 3) or 3)
    state = db.get_boss_state(task["id"], lives_max)
    if state["finished"]:  # neuer Versuch nach Sieg oder Niederlage
        state = {"lives": lives_max, "solved": [], "finished": False}

    s_task = steps[step]
    s_score, s_fb, s_details = grade_task(s_task, answer.get("answer") or {})
    s_correct = is_correct(s_task.get("type", ""), s_score)
    solved = set(state["solved"])
    lives = state["lives"]
    if s_correct:
        solved.add(step)
    elif step not in solved:
        lives = max(0, lives - 1)
    won = len(solved) == len(steps)
    finished = won or lives == 0
    db.set_boss_state(task["id"], lives, sorted(solved), finished)

    score = len(solved) / len(steps)
    if won:
        status = "🏆 **Boss besiegt!** Alle Etappen gemeistert."
    elif lives == 0:
        status = (f"💀 **Keine Leben mehr.** Du hast {len(solved)}/{len(steps)} Etappen geschafft – "
                  "der nächste Versuch startet mit vollen Leben.")
    elif s_correct:
        status = f"✅ Etappe {step + 1} geschafft! Noch {len(steps) - len(solved)} Etappe(n). ❤️ × {lives}"
    else:
        status = f"❌ Etappe {step + 1} nicht geschafft – ein Leben verloren. ❤️ × {lives}"
    feedback = f"{status}\n\n{s_fb}"
    explanation = s_task.get("explanation", "")
    if finished and task.get("explanation"):
        explanation = (explanation + "\n\n---\n\n" if explanation else "") + task["explanation"]
    details = {"step": step, "step_correct": s_correct, "lives_left": lives, "finished": finished,
               "step_details": s_details, "step_score": round(s_score, 4), "solved_steps": sorted(solved),
               "won": won}
    return score, feedback, explanation, details


@router.post("/levels/{level_id}/tasks/{task_id}/submit")
def submit(level_id: int, task_id: str, body: dict[str, Any] = Body(...)) -> dict:
    _require_level(level_id)
    task = content_loader.get_task(level_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Aufgabe nicht gefunden")
    answer = body.get("answer") if isinstance(body, dict) else None
    if not isinstance(answer, dict):
        raise HTTPException(status_code=422, detail="Feld 'answer' (Objekt) fehlt")

    try:
        if task.get("type") == "boss":
            score, feedback, explanation, details = _grade_boss(task, answer)
        else:
            score, feedback, details = grade_task(task, answer)
            explanation = task.get("explanation", "")
    except GradingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    old_best = db.get_best_score(task_id)
    new_best = max(old_best, score)
    xp_awarded = int(round(int(task.get("xp", 0) or 0) * max(0.0, new_best - old_best)))
    if new_best > old_best:
        db.set_best_score(task_id, level_id, new_best)
    db.add_xp(task_id, xp_awarded)
    db.mark_activity()
    new_badges = prog.evaluate_badges()
    if new_badges:
        names = ", ".join(f"{prog.BADGE_BY_ID[b]['icon']} {prog.BADGE_BY_ID[b]['name']}" for b in new_badges)
        feedback += f"\n\n**Neues Abzeichen:** {names}"
        details = {**details, "new_badges": [prog.BADGE_BY_ID[b] for b in new_badges]}

    return {
        "correct": is_correct(task.get("type", ""), score) if task.get("type") != "boss" else score >= 0.999,
        "score": round(score, 4),
        "xp_awarded": xp_awarded,
        "feedback": feedback,
        "explanation": explanation,
        "details": details,
        "progress": prog.get_progress(),
    }
