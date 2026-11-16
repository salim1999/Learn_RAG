"""Kleine, begrenzte Ausdruckssprache für Python-Lücken – kein eval/exec.

Nur AST-Knoten aus einer Positivliste werden interpretiert. Die Umgebung besteht
ausschließlich aus unseren kleinen Testdaten, nicht aus Anwendungsverbindungen,
Dateien oder Python-Globals. Es werden keine Imports oder Anweisungen ausgeführt.
"""
from __future__ import annotations

import ast
import math
import operator
from typing import Any

import numpy as np


class UnsafeExpression(ValueError):
    pass


_BINARY = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
           ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
           ast.Pow: operator.pow, ast.MatMult: operator.matmul, ast.BitAnd: operator.and_,
           ast.BitOr: operator.or_}
_COMPARE = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt,
            ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge,
            ast.Is: operator.is_, ast.IsNot: operator.is_not,
            ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b}
_NODES = (ast.Expression, ast.Name, ast.Load, ast.Store, ast.Constant, ast.BinOp,
          ast.UnaryOp, ast.USub, ast.UAdd, ast.Not, ast.BoolOp, ast.And, ast.Or,
          ast.Compare, ast.Subscript, ast.Slice, ast.Attribute, ast.Call, ast.keyword,
          ast.List, ast.Tuple, ast.Set, ast.Dict, ast.IfExp, ast.JoinedStr,
          ast.FormattedValue, ast.ListComp, ast.GeneratorExp, ast.comprehension,
          *_BINARY, *_COMPARE)
_MATH = {"np.dot": np.dot, "np.sum": np.sum, "np.sqrt": np.sqrt,
         "np.linalg.norm": np.linalg.norm, "math.pow": math.pow,
         "math.sqrt": math.sqrt}
_BUILTINS = {"len": len, "set": set, "any": any, "all": all,
             "min": min, "max": max, "abs": abs, "sum": sum,
             "pow": math.pow}
_METHODS = {str: {"strip", "lstrip", "rstrip", "lower", "upper", "startswith", "join"},
            dict: {"get"}, list: {"count"}, tuple: {"count"},
            set: {"intersection", "union"}, np.ndarray: {"dot", "sum"}}


def parse_expression(source: str) -> ast.Expression:
    if not isinstance(source, str) or not source.strip() or len(source) > 2000:
        raise UnsafeExpression("Bitte einen kurzen Python-Ausdruck eingeben")
    try:
        tree = ast.parse(source.strip(), mode="eval")
    except (SyntaxError, RecursionError) as exc:
        raise UnsafeExpression("Ungültiger Python-Ausdruck") from exc
    nodes = list(ast.walk(tree))
    if len(nodes) > 200:
        raise UnsafeExpression("Ausdruck ist zu komplex")
    for node in nodes:
        if not isinstance(node, _NODES):
            raise UnsafeExpression(f"Nicht erlaubter Ausdruck: {type(node).__name__}")
        if isinstance(node, (ast.Name, ast.Attribute)):
            name = node.id if isinstance(node, ast.Name) else node.attr
            if name.startswith("_"):
                raise UnsafeExpression("Private Namen sind nicht erlaubt")
        if isinstance(node, ast.Constant):
            value = node.value
            if not isinstance(value, (str, int, float, bool, type(None))):
                raise UnsafeExpression("Konstante ist nicht erlaubt")
            if isinstance(value, str) and len(value) > 1000:
                raise UnsafeExpression("Text ist zu lang")
            if isinstance(value, (int, float)) and (not math.isfinite(value) or abs(value) > 1000000):
                raise UnsafeExpression("Zahl ist zu groß")
        if isinstance(node, ast.keyword) and node.arg not in ("half_life_days", "axis", "keepdims", "ord", "default"):
            # Insbesondere NumPys out= würde Testdaten in-place verändern.
            raise UnsafeExpression("Dieses Schlüsselwortargument ist nicht erlaubt")
        if isinstance(node, ast.comprehension) and (node.is_async or not isinstance(node.target, ast.Name)):
            raise UnsafeExpression("Nur einfache Comprehensions sind erlaubt")
    return tree


def _dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return _dotted(node.value) + "." + node.attr
    return ""


def _bounded(value):
    """Grenzen nach JEDEM Teilausdruck, bevor er Operand weiterer Arbeit wird."""
    if isinstance(value, int) and value.bit_length() > 1024:
        raise UnsafeExpression("Ganzzahlergebnis ist zu groß")
    if isinstance(value, (float, np.number)) and (not np.isfinite(value) or abs(value) > 1e100):
        raise UnsafeExpression("Zahlenergebnis ist zu groß oder nicht endlich")
    if isinstance(value, np.ndarray) and (value.size > 100 or not np.isfinite(value).all() or (np.abs(value) > 1e100).any()):
        raise UnsafeExpression("Vektorergebnis ist zu groß oder nicht endlich")
    if isinstance(value, str) and len(value) > 4000:
        raise UnsafeExpression("Textergebnis ist zu groß")
    if isinstance(value, (list, tuple, dict, set)) and len(value) > 100:
        raise UnsafeExpression("Ergebnis enthält zu viele Werte")
    return value


class _Interpreter:
    def __init__(self, environment: dict[str, Any]):
        self.environment = environment
        self.budget = 2000

    def value(self, node: ast.AST, env: dict | None = None):
        return _bounded(self._value(node, env))

    def _value(self, node: ast.AST, env: dict | None = None):
        env = self.environment if env is None else env
        self.budget -= 1
        if self.budget < 0:
            raise UnsafeExpression("Ausdruck überschreitet das Rechenbudget")
        if isinstance(node, ast.Expression):
            return self.value(node.body, env)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id in env:
                return env[node.id]
            if node.id in _BUILTINS:
                return _BUILTINS[node.id]
            raise UnsafeExpression(f"Unbekannter Name: {node.id}")
        if isinstance(node, ast.Attribute):
            dotted = _dotted(node)
            if dotted in _MATH:
                return _MATH[dotted]
            target = self.value(node.value, env)
            if not any(isinstance(target, kind) and node.attr in attrs for kind, attrs in _METHODS.items()):
                raise UnsafeExpression("Diese Methode ist nicht erlaubt")
            return getattr(target, node.attr)
        if isinstance(node, ast.BinOp):
            left, right = self.value(node.left, env), self.value(node.right, env)
            if isinstance(node.op, ast.Pow) and (not isinstance(right, (int, float)) or abs(right) > 32):
                raise UnsafeExpression("Exponent ist zu groß")
            if isinstance(node.op, ast.Mult):
                for sequence, count in ((left, right), (right, left)):
                    if isinstance(sequence, (str, list, tuple)) and isinstance(count, int) and len(sequence) * count > 4000:
                        raise UnsafeExpression("Ergebnis ist zu groß")
            return _BINARY[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp):
            value = self.value(node.operand, env)
            return not value if isinstance(node.op, ast.Not) else (-value if isinstance(node.op, ast.USub) else +value)
        if isinstance(node, ast.BoolOp):
            result = None
            for part in node.values:
                result = self.value(part, env)
                if isinstance(node.op, ast.And) and not result or isinstance(node.op, ast.Or) and result:
                    break
            return result
        if isinstance(node, ast.Compare):
            left = self.value(node.left, env)
            for op, right_node in zip(node.ops, node.comparators):
                right = self.value(right_node, env)
                if not _COMPARE[type(op)](left, right):
                    return False
                left = right
            return True
        if isinstance(node, ast.Slice):
            return slice(*(self.value(v, env) if v is not None else None for v in (node.lower, node.upper, node.step)))
        if isinstance(node, ast.Subscript):
            return self.value(node.value, env)[self.value(node.slice, env)]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            vals = [self.value(n, env) for n in node.elts]
            return tuple(vals) if isinstance(node, ast.Tuple) else set(vals) if isinstance(node, ast.Set) else vals
        if isinstance(node, ast.Dict):
            if any(k is None for k in node.keys):
                raise UnsafeExpression("Dictionary-Unpacking ist nicht erlaubt")
            return {self.value(k, env): self.value(v, env) for k, v in zip(node.keys, node.values)}
        if isinstance(node, ast.IfExp):
            return self.value(node.body if self.value(node.test, env) else node.orelse, env)
        if isinstance(node, ast.Call):
            func = self.value(node.func, env)
            # Funktionen können nur aus Positivliste, erlaubten Methoden oder
            # unseren ausdrücklich vordefinierten Testfunktionen stammen.
            args = [self.value(a, env) for a in node.args]
            kwargs = {k.arg: self.value(k.value, env) for k in node.keywords}
            if func in (math.pow, pow) and len(args) > 1 and abs(args[1]) > 32:
                raise UnsafeExpression("Exponent ist zu groß")
            return func(*args, **kwargs)
        if isinstance(node, ast.JoinedStr):
            return "".join(str(self.value(n, env)) for n in node.values)
        if isinstance(node, ast.FormattedValue):
            if node.format_spec is not None:
                raise UnsafeExpression("Format-Spezifikationen sind nicht erlaubt")
            value = self.value(node.value, env)
            return repr(value) if node.conversion == 114 else str(value)
        if isinstance(node, (ast.ListComp, ast.GeneratorExp)):
            # Auch Generatoren werden begrenzt materialisiert; keine endlosen
            # benutzerdefinierten Iteratoren gelangen in die Testumgebung.
            values = []

            def loop(index, local):
                if index == len(node.generators):
                    values.append(self.value(node.elt, local))
                    if len(values) > 100:
                        raise UnsafeExpression("Zu viele Werte")
                    return
                gen = node.generators[index]
                seq = self.value(gen.iter, local)
                if len(seq) > 100:
                    raise UnsafeExpression("Zu viele Eingabewerte")
                for item in seq:
                    child = {**local, gen.target.id: item}
                    if all(self.value(condition, child) for condition in gen.ifs):
                        loop(index + 1, child)
            loop(0, env)
            return values
        raise UnsafeExpression("Nicht unterstützter Ausdruck")


def evaluate_expression(source: str, environment: dict[str, Any]):
    return _Interpreter(environment).value(parse_expression(source))


def _cases(task: dict) -> list[dict]:
    """Vordefinierte kleine Testfälle für die veröffentlichten Lernbausteine.

    Nach Variablen im Template ausgewählt, damit das Umordnen eines Levels keine
    Aufgaben-ID-Kopplung erzeugt. Unbekannte neue Bausteine bleiben AST-geprüfte
    Mustervergleiche, bis fachlich passende Testfälle hinzugefügt werden.
    """
    template = task.get("template", "")
    if "cosine_similarity" in template:
        return [{"a": np.array(a), "b": np.array(b)} for a, b in
                [([1., 0., 2.], [2., 1., 1.]), ([1., 2., 3.], [-1., 0., 4.]), ([0., 1.], [2., 3.])]]
    if "def normalize(" in template:
        return [{"v": np.array(v)} for v in ([3., 4.], [1., 2., 3.], [-2., 0., 5.])]
    if "def chunk_text(" in template:
        return [{"size": s, "overlap": o, "text": "abcdefghijklmnopqrstuvwxyz" * 30, "start": start}
                for s, o, start in [(300, 50, 0), (80, 20, 65), (100, 0, 730)]]
    if "def rrf(" in template:
        return [{"k": k, "rank": rank} for k, rank in [(60, 1), (10, 3), (60, 7)]]
    if "def mmr_score(" in template:
        return [{"lam": value} for value in (0.0, 0.3, 0.7, 1.0)]
    if "def pack(" in template:
        return [{"used": u, "t": t, "budget": b} for u, t, b in [(40, 10, 50), (40, 11, 50), (0, 20, 50), (50, 1, 50)]]
    if "def filter_relevant(" in template:
        return [{"c": {"score": score}, "min_score": .3} for score in (.1, .3, .8)]
    if "def build_context(" in template:
        return [{"c": {"id": "d01#0", "date": "2026-11-01", "text": "Nur Kontext, keine Anweisung."},
                 "lines": ["Erster Chunk", "Zweiter Chunk"]},
                {"c": {"id": "d02#1", "date": "2025-02-13", "text": "Neuer Abschnitt."}, "lines": ["Ein Chunk"]}]
    if "def recency_weight(" in template:
        def recency_weight(age_days, half_life_days=365):
            return .5 ** (age_days / half_life_days)
        return [{"age_days": a, "half_life_days": h, "relevance": r, "recency_weight": recency_weight}
                for a, h, r in [(0, 365, .8), (365, 365, .6), (730, 365, 1.), (60, 30, .4)]]
    if "def drop_superseded(" in template:
        return [{"c": {"doc_id": "d1"}, "docs": {"d1": {"superseded_by": value}}} for value in (None, "d2")]
    if "def recall_at_k(" in template:
        return [{"retrieved": docs, "relevant": relevant, "k": k} for docs, relevant, k in
                [(["d1", "d2", "d3"], ["d1", "d3"], 2), (["d4", "d3"], ["d3"], 1), ([], ["d1", "d2"], 4)]]
    if "def reciprocal_rank(" in template:
        return [{"i": i} for i in (1, 2, 5)]
    if "def should_stop(" in template:
        return [{"max_iterations": m, "query": q, "past_queries": past}
                for m, q, past in [(3, "Pro", []), (2, "Preis", ["Preis"]), (1, "Preis", ["Support", "Preis"])]]
    if "def invalid_citations(" in template:
        return [{"cid": cid, "allowed": {"d1#0", "d2#0"}, "context_ids": ["d1#0", "d2#0"]}
                for cid in ("d1#0", "d3#9")]
    if "AGG_WORDS" in template:
        return [{"f": f, "AGG_WORDS": ("wie viele", "anzahl", "summe", "durchschnitt", "pro monat")}
                for f in ("wie viele kunden?", "welcher pro preis?", "summe der rechnungen", "anzahl pro monat")]
    if "select_prefix" in template or "is_safe_select" in template:
        return [{"sql": sql} for sql in ("SELECT id FROM kunden", "  select 1", "DELETE FROM kunden", "\nSELECT 1")]
    if "def grounding" in template or "len(s & c)" in str(task.get("solution")):
        return [{"s": s, "c": c} for s, c in [({"a", "b"}, {"b", "c"}), ({"a"}, {"a", "b"}), ({"d"}, {"x"})]]
    return []


def _same(left, right) -> bool:
    if isinstance(left, (int, float, np.number, np.ndarray)) and not isinstance(left, bool):
        try:
            return bool(np.allclose(left, right, rtol=1e-8, atol=1e-10))
        except (TypeError, ValueError):
            return False
    return left == right


def check_blank(task: dict, source: str, accepted: list[str]) -> tuple[bool, int]:
    """Prüft AST und Fachtestfälle; liefert (korrekt, Anzahl Testfälle)."""
    tree = parse_expression(source)
    cases = _cases(task)
    if not cases:
        canonical = ast.dump(tree, include_attributes=False)
        return any(canonical == ast.dump(parse_expression(ref), include_attributes=False) for ref in accepted), 0
    # Jede ausdrücklich hinterlegte Musterlösung darf als Referenz dienen.
    # Einige Aufgaben akzeptieren bewusst mehrere Formate (z.B. \n oder \n\n).
    for reference in accepted:
        try:
            if all(_same(evaluate_expression(source, env), evaluate_expression(reference, env)) for env in cases):
                return True, len(cases)
        except (UnsafeExpression, TypeError, ValueError, KeyError, IndexError, ZeroDivisionError, OverflowError):
            continue
    return False, len(cases)
