"""Text-Hilfen: Tokenisierung, Stoppwörter, leichtes deutsches Stemming, Satztrennung."""
from __future__ import annotations

import re
from functools import lru_cache

STOPWORDS = frozenset("""
a ab aber alle allem allen aller alles als also am an ander andere anderen auch auf aus bei beim bin bis bist
bitte da dabei dadurch dafür dagegen daher damit dann dar daran darauf darf darum das dass daß dazu dein deine
dem den denen denn der deren des dessen dich die dies diese diesem diesen dieser dieses dir doch dort du durch
ein eine einem einen einer eines einige einigen einiger einiges er es etwa etwas euch euer eure für gab gibt
gilt hab habe haben hat hatte hatten hier hin hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer ihres im in
ins ist ja je jede jedem jeden jeder jedes jetzt kann kannst können könnte machen man manche mehr mein meine
mich mir mit muss musst müssen nach nachdem nein nun nur ob oder ohne sehr sein seine seinem seinen seiner
sich sie sind so solche soll sollen sollte sondern sonst über um und uns unser unsere unter viel viele vom von
vor wann war waren warum was weil welche welchem welchen welcher welches wenn wer werde werden wie wieviel
wieso will wir wird wirst wo woher wohin wurde wurden zu zum zur zwar zwischen bzw ca ggf usw etc inkl sowie
gibt's genau eigentlich bereits noch schon immer wirklich derzeit aktuell aktuelle aktuellen
the a an and or of to in on for is are was were be by with at from as it this that what how which who why when
""".split())

_TOKEN_RE = re.compile(r"[0-9a-zäöüß]+", re.IGNORECASE)
_SUFFIXES_A = ("ungen", "heiten", "keiten", "ung", "heit", "keit", "ern", "en", "er", "es", "em", "e", "n", "s")
_S_ENDING = set("bdfghklmnrt")  # "s" nur nach diesen Buchstaben abschneiden (wie Snowball)
_CONSONANTS = set("bcdfghjklmnpqrsvwxz")


@lru_cache(maxsize=50000)
def stem(word: str) -> str:
    """Sehr leichtes deutsches Stemming in zwei Schritten (Endungen, dann -t/-et) – deterministisch."""
    w = word.lower().replace("ß", "ss").replace("ä", "a").replace("ö", "o").replace("ü", "u")
    if w.isdigit() or len(w) <= 4:
        return w
    for suf in _SUFFIXES_A:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            if suf == "s" and w[-2] not in _S_ENDING:
                continue
            w = w[: -len(suf)]
            break
    if len(w) > 4:
        if w.endswith("et") and len(w) - 2 >= 3:
            w = w[:-2]
        elif w.endswith("t") and w[-2] in _CONSONANTS:
            w = w[:-1]
    return w


def raw_tokens(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


def content_tokens(text: str) -> list[str]:
    """Kleinschreibung, Stoppwörter raus, gestemmt. Basis für TF-IDF, BM25 und Grounding."""
    return [stem(t) for t in raw_tokens(text) if t not in STOPWORDS and (len(t) > 1 or t.isdigit())]


# Abkürzungen, an denen kein Satzende ist
_ABBREV = ["z. B.", "z.B.", "d. h.", "d.h.", "u. a.", "u.a.", "bzw.", "ca.", "Nr.", "inkl.", "evtl.", "ggf.",
           "usw.", "etc.", "max.", "min.", "Std.", "Tsd.", "Mio.", "vgl.", "sog.", "zzgl.", "e.g.", "i.e."]
_SENT_SPLIT = re.compile(r"(?<=[.!?])(?<!\d\.)\s+(?=[\"„»(\[]?[A-ZÄÖÜ0-9])|\n{2,}|\n(?=\s*[-*•] )")


def split_sentences(text: str) -> list[str]:
    """Satztrennung mit Schutz gängiger Abkürzungen."""
    if not text:
        return []
    protected = text
    for i, ab in enumerate(_ABBREV):
        protected = protected.replace(ab, ab.replace(".", f"\u0000{i}\u0000"))
    parts = _SENT_SPLIT.split(protected)
    out = []
    for p in parts:
        if p is None:
            continue
        for i, ab in enumerate(_ABBREV):
            p = p.replace(ab.replace(".", f"\u0000{i}\u0000"), ab)
        p = p.strip()
        if p:
            out.append(p)
    return out
