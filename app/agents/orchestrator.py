"""Agentisches RAG: Planner → Retriever → Generator → Verifier mit Retry-Schleife.

`run_agents(...)` ist ein Generator, der Events gemäß CONTRACTS.md liefert:
  {"type":"step","agent":...,"iteration":n,"status":"start|done|fail|retry","message":...,"payload":{...}}
  {"type":"final","answer":ANSWER,"abstained":bool,"iterations":n,"chunks":[CHUNK]}
Vollständig deterministisch (offline); Claude wird nur bei use_llm=True und gesetztem Key genutzt.
"""
from __future__ import annotations

import re
from typing import Iterator

from app import config as app_config
from app import content_loader
from app.rag import freshness, generate, pipeline
from app.rag.text import STOPWORDS, content_tokens, raw_tokens, stem

# Kleine Domänen-Synonymliste (Schlüssel und Werte als Rohwörter; Abgleich über Wortstämme)
SYNONYMS: list[list[str]] = [
    ["preis", "kosten", "kostet", "tarif", "euro", "gebühr"],
    ["plan", "tarif", "paket", "abo"],
    ["limit", "grenze", "kontingent", "rate", "drosselung"],
    ["anfragen", "requests", "aufrufe"],
    ["api", "schnittstelle", "endpunkt"],
    ["support", "hilfe", "kundendienst", "ticket", "reaktionszeit"],
    ["sicherheit", "verschlüsselung", "verschlüsselt", "schutz"],
    ["version", "release", "changelog", "veraltet"],
    ["datenschutz", "dsgvo", "personenbezogen"],
    ["backup", "sicherung", "wiederherstellung"],
    ["speicher", "storage", "speicherplatz"],
    ["kündigung", "kündigen", "vertrag", "laufzeit"],
]
_SYN_INDEX: dict[str, list[str]] = {}
for group in SYNONYMS:
    for w in group:
        _SYN_INDEX.setdefault(stem(w), [])
        _SYN_INDEX[stem(w)] += [x for x in group if stem(x) != stem(w) and x not in _SYN_INDEX[stem(w)]]


def keywords(query: str) -> list[str]:
    return list(dict.fromkeys(t for t in raw_tokens(query) if t not in STOPWORDS and (len(t) > 1 or t.isdigit())))


def expand(words: list[str], per_word: int = 2) -> list[str]:
    extra: list[str] = []
    for w in words:
        for syn in _SYN_INDEX.get(stem(w), [])[:per_word]:
            if syn not in words and syn not in extra:
                extra.append(syn)
    return extra


def decompose(query: str) -> list[str]:
    """Zerlegt eine Frage in Teilfragen (an 'und', 'sowie', Kommas, Fragezeichen)."""
    parts = re.split(r"\s+(?:und|sowie|oder)\s+|[,;?]\s*", query, flags=re.IGNORECASE)
    parts = [p.strip() for p in parts if p and len(content_tokens(p)) >= 1]
    return parts if len(parts) > 1 else []


def plan(query: str, iteration: int) -> dict:
    """Planner: Query-Rewrite. Jede Iteration nutzt eine andere Strategie."""
    kw = keywords(query)
    if iteration == 1:
        exp = expand(kw, 1)
        return {"strategy": "keyword_rewrite", "rewritten_query": " ".join(kw + exp), "sub_queries": [],
                "expansions": exp, "k": 4, "rerank": False, "mmr": False}
    if iteration == 2:
        subs = decompose(query)
        exp = expand(kw, 2)
        queries = subs + [" ".join(kw + exp)] if subs else [query, " ".join(kw + exp), " ".join(exp) or query]
        return {"strategy": "multi_query", "rewritten_query": " ".join(kw + exp),
                "sub_queries": list(dict.fromkeys(q for q in queries if q.strip())), "expansions": exp,
                "k": 5, "rerank": True, "mmr": False}
    exp = expand(kw, 4)
    return {"strategy": "broad_rerank", "rewritten_query": " ".join(kw + exp), "sub_queries": [],
            "expansions": exp, "k": 6, "rerank": True, "mmr": True}


def _retrieve(bundle, plan_: dict, drop_superseded: bool, as_of: str) -> tuple[list[dict], dict]:
    cfg = app_config.normalize_pipeline_config({
        "query": plan_["rewritten_query"],
        "retrieval": {"method": "hybrid", "k": plan_["k"], "rerank": plan_["rerank"], "mmr": plan_["mmr"]},
        "freshness": {"enabled": True, "half_life_days": 365, "drop_superseded": drop_superseded, "as_of": as_of},
    })
    queries = plan_["sub_queries"] or [plan_["rewritten_query"]]
    fused: dict[str, dict] = {}
    for q in queries:
        chunks, _, _ = pipeline.retrieve_chunks(bundle, q, cfg)
        for c in chunks:
            if c["id"] not in fused or c["score"] > fused[c["id"]]["score"]:
                fused[c["id"]] = c
    ranked = sorted(fused.values(), key=lambda c: (-c["score"], c["id"]))[: plan_["k"]]
    for r, c in enumerate(ranked, start=1):
        c["rank"] = r
    return ranked, cfg


def _step(agent: str, iteration: int, status: str, message: str, payload: dict | None = None) -> dict:
    return {"type": "step", "agent": agent, "iteration": iteration, "status": status,
            "message": message, "payload": payload or {}}


def run_agents(query: str, max_iterations: int = 3, force_fail_first: bool = False,
               use_llm: bool = False, corpus_id: str = "default") -> Iterator[dict]:
    query = (query or "").strip()
    max_iterations = max(1, min(int(max_iterations or 3), 5))
    corpus = content_loader.get_corpus(corpus_id)
    yield _step("orchestrator", 1, "start",
                f"Ich koordiniere vier Agenten für die Frage „{query}“: Planner, Retriever, Generator und "
                f"Verifier. Wenn der Verifier die Antwort ablehnt, starte ich eine neue Runde mit anderer "
                f"Strategie (maximal {max_iterations} Runden).",
                {"query": query, "max_iterations": max_iterations, "force_fail_first": force_fail_first,
                 "use_llm": use_llm})
    if corpus is None or not query:
        reason = "Es ist kein Korpus geladen." if corpus is None else "Die Frage ist leer."
        yield _step("orchestrator", 1, "fail", f"{reason} Ich kann nichts nachschlagen und enthalte mich.")
        yield {"type": "final", "answer": generate.abstain_answer(), "abstained": True, "iterations": 0,
               "chunks": []}
        return

    bundle, _ = pipeline.get_bundle(corpus, "recursive", 400, 60)
    as_of = str(corpus.get("as_of") or app_config.DEFAULT_PIPELINE_CONFIG["freshness"]["as_of"])
    llm_on = bool(use_llm and app_config.llm_enabled())
    drop_superseded = False
    answer, chunks = generate.abstain_answer(), []
    iteration = 0

    for iteration in range(1, max_iterations + 1):
        # --- Planner ---------------------------------------------------------------
        yield _step("planner", iteration, "start",
                    "Ich formuliere die Frage für die Suche um. Suchmaschinen mögen keine Füllwörter – "
                    "Schlüsselbegriffe und Synonyme erhöhen die Trefferchance."
                    if iteration == 1 else
                    "Die letzte Runde ist durchgefallen, also wähle ich bewusst eine andere Suchstrategie, "
                    "statt dasselbe noch einmal zu versuchen.")
        p = plan(query, iteration)
        if p["strategy"] == "keyword_rewrite":
            pmsg = (f"Stoppwörter entfernt und um Synonyme ergänzt → „{p['rewritten_query']}“. "
                    "So findet auch ein Dokument, das 'Tarif' statt 'Plan' sagt, den Weg in den Kontext.")
        elif p["strategy"] == "multi_query":
            pmsg = (f"Multi-Query/Zerlegung: Ich stelle {len(p['sub_queries'])} Teil- bzw. Varianten-Fragen "
                    "und führe die Treffer zusammen. Das deckt Aspekte ab, die eine einzelne Suche übersieht. "
                    "Zusätzlich wird Reranking aktiviert.")
        else:
            pmsg = (f"Breite Suche: viele Synonyme, mehr Chunks (k={p['k']}), Reranking und MMR für Vielfalt – "
                    "letzter Versuch, belastbare Belege zu finden.")
        yield _step("planner", iteration, "done", pmsg, p)

        # --- Retriever -----------------------------------------------------------------
        yield _step("retriever", iteration, "start",
                    "Ich durchsuche den Korpus hybrid (TF-IDF für Bedeutungsnähe über Wortgewichte + BM25 für "
                    "exakte Begriffe) und gewichte neuere Dokumente höher (Recency-Decay)."
                    + (" Ersetzte Dokumente filtere ich diesmal komplett heraus." if drop_superseded else ""))
        chunks, rcfg = _retrieve(bundle, p, drop_superseded, as_of)
        stale_n = sum(1 for c in chunks if c["stale"])
        conflicts = freshness.detect_conflicts(chunks)
        rmsg = (f"{len(chunks)} Chunks gefunden: {', '.join(c['id'] for c in chunks)}. "
                f"Bester Score {chunks[0]['score']:.2f}." if chunks else "Keine Chunks gefunden.")
        if stale_n:
            rmsg += f" {stale_n} davon stammen aus veralteten (ersetzten) Dokumenten – Vorsicht!"
        if conflicts:
            rmsg += f" {len(conflicts)} möglicher Widerspruch zwischen Quellen erkannt."
        yield _step("retriever", iteration, "done", rmsg, {
            "chunks": [{"id": c["id"], "title": c["title"], "score": c["score"], "stale": c["stale"],
                        "date": c["date"]} for c in chunks],
            "method": "hybrid", "k": p["k"], "drop_superseded": drop_superseded, "conflicts": conflicts})

        # --- Generator -----------------------------------------------------------------
        gen_cfg = dict(rcfg["generation"], mode="llm" if llm_on else "extractive")
        yield _step("generator", iteration, "start",
                    "Ich formuliere eine Antwort NUR aus den gefundenen Chunks und hänge an jeden Satz die "
                    "Quelle an. Ist die Evidenz zu schwach, enthalte ich mich lieber, statt zu raten."
                    + (" (Claude formuliert, Zitate sind Pflicht.)" if llm_on else " (Offline: extraktiv.)"))
        answer, ginfo = generate.generate_answer(query, chunks, gen_cfg, bundle.index.term_idf)
        if answer["abstained"]:
            gmsg = (f"Ich enthalte mich: bester Relevanz-Score {ginfo.get('best_score', 0):.2f} "
                    f"< Schwelle {gen_cfg['abstain_threshold']:.2f} oder kein passender Satz im Kontext.")
        else:
            gmsg = f"Entwurf mit {len(answer['sentences'])} Satz/Sätzen erstellt: {answer['text'][:220]}"
        if ginfo.get("blocked_injection"):
            gmsg += f" Eingeschleuste Anweisungen in {', '.join(ginfo['blocked_injection'])} ignoriert."
        if ginfo.get("fallback"):
            gmsg += " " + ginfo["fallback"]
        yield _step("generator", iteration, "done", gmsg,
                    {"answer": answer, "abstained": answer["abstained"], "llm_used": bool(ginfo.get("llm_used"))})

        # --- Verifier ------------------------------------------------------------------
        yield _step("verifier", iteration, "start",
                    "Ich prüfe drei Dinge: (1) Grounding – steht jeder Satz wirklich im zitierten Chunk? "
                    "(2) Zitate – verweist jede Quelle auf einen Chunk im Kontext? "
                    "(3) Aktualität – stützt sich die Antwort auf veraltete Dokumente?")
        checked, report = pipeline.finalize_answer(
            {**answer, "sentences": [dict(s) for s in answer["sentences"]]}, chunks,
            {"generation": gen_cfg, "verify": False})
        reasons: list[str] = []
        if answer["abstained"]:
            reasons.append("Keine belastbare Antwort: der Generator hat sich enthalten.")
        if report["unsupported"]:
            reasons.append(f"{len(report['unsupported'])} Satz/Sätze sind nicht durch den zitierten Chunk gedeckt "
                           "(Halluzinationsgefahr).")
        if not answer["abstained"] and not report["citations_ok"]:
            reasons.append("Zitate fehlen oder verweisen auf Chunks außerhalb des Kontexts.")
        if report["stale_cited"]:
            reasons.append(f"Die Antwort zitiert veraltete Quellen ({', '.join(report['stale_cited'])}), "
                           "obwohl neuere Versionen existieren.")
            drop_superseded = True
        if force_fail_first and iteration == 1 and not reasons:
            reasons.append("Strenger Demo-Modus: In Runde 1 verlange ich eine Gegenprüfung mit einer zweiten, "
                           "unabhängigen Suchstrategie, bevor ich eine Antwort freigebe.")
        payload = {"faithfulness": report["faithfulness"], "citations_ok": report["citations_ok"],
                   "stale_cited": report["stale_cited"], "reasons": reasons,
                   "sentences": [{"text": s["text"], "grounding": s["grounding"], "supported": s["supported"],
                                  "citations": s["citations"]} for s in checked["sentences"]]}
        if not reasons:
            answer = checked
            yield _step("verifier", iteration, "done",
                        f"Alles geprüft: {report['supported_sentences']}/{report['total_sentences']} Sätze sind "
                        "belegt, Zitate stimmen, keine veralteten Quellen. Antwort freigegeben.", payload)
            yield _step("orchestrator", iteration, "done",
                        f"Fertig nach {iteration} Runde(n). Die Antwort ist geerdet und zitiert ihre Quellen.")
            yield {"type": "final", "answer": answer, "abstained": False, "iterations": iteration,
                   "chunks": chunks}
            return
        yield _step("verifier", iteration, "fail", "Abgelehnt: " + " ".join(reasons), payload)
        if iteration < max_iterations:
            yield _step("orchestrator", iteration, "retry",
                        f"Der Verifier hat Runde {iteration} abgelehnt. Ich starte Runde {iteration + 1} mit "
                        "einer anderen Strategie – Feedback-Schleifen sind der Kern agentischer RAG-Systeme.",
                        {"next_iteration": iteration + 1, "reasons": reasons})

    yield _step("orchestrator", iteration, "fail",
                f"Auch nach {iteration} Runden gibt es keine verifizierte Antwort. Ehrliches „Weiß ich nicht“ "
                "ist besser als eine Halluzination – ich enthalte mich.")
    yield {"type": "final", "answer": generate.abstain_answer(), "abstained": True, "iterations": iteration,
           "chunks": chunks}
