#!/usr/bin/env python3
"""
cv_compare.py — что изменилось между двумя версиями CV.md (C15): по разделам, строка за строкой.

Оформление не считается правкой: markdown, маркеры списков, пробелы, типографские кавычки и тире нормализуются.
У изменённой строки — разметка по словам (marks: [[слово(а), "=" | "+" | "-"], …]). Новое без шапки (edits) — для поиска фактов.

Usage:
  cv_compare.py --old CV.md --new draft/CV.md [--pdf source.pdf] --json
"""
import argparse, difflib, json, re
from pathlib import Path

PAIR_MIN = 0.5  # строки похожи настолько, что это правка одной, а не удаление и вставка


def clean(s: str) -> str:
    s = re.sub(r"^\s*(#+|[-•*·])\s+", "", s)
    s = re.sub(r"[*_`]+", "", s)
    s = s.replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"').replace(" ", " ")
    s = s.replace("—", "-").replace("–", "-")
    return re.sub(r"\s+", " ", s).strip()


def parse(md: str):
    """[(раздел, строка)] без пустых строк; всё до первого ## — шапка."""
    out, sec = [], "Шапка"
    for raw in md.splitlines():
        if raw.startswith("## "):
            sec = clean(raw)
            out.append((sec, sec))
        elif clean(raw):
            out.append((sec, clean(raw)))
    return out


def marks(a: str, b: str):
    x, y = a.split(), b.split()
    res = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, x, y, autojunk=False).get_opcodes():
        if op == "equal":
            res.append([" ".join(x[i1:i2]), "="])
            continue
        if i2 > i1:
            res.append([" ".join(x[i1:i2]), "-"])
        if j2 > j1:
            res.append([" ".join(y[j1:j2]), "+"])
    return res


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.split(), b.split(), autojunk=False).ratio()


def compare(old_md: str, new_md: str):
    old, new = parse(old_md), parse(new_md)
    a, b = [x[1] for x in old], [x[1] for x in new]
    sections, order = {}, []

    def bucket(name):
        if name not in sections:
            sections[name] = {"title": name, "added": [], "removed": [], "changed": []}
            order.append(name)
        return sections[name]

    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        rem, add = list(range(i1, i2)), list(range(j1, j2))
        for i in list(rem):  # к удалённой строке ищем самую похожую новую
            best = max(add, key=lambda j: ratio(a[i], b[j]), default=None)
            if best is not None and ratio(a[i], b[best]) >= PAIR_MIN:
                bucket(new[best][0])["changed"].append({"from": a[i], "to": b[best], "marks": marks(a[i], b[best])})
                rem.remove(i)
                add.remove(best)
        for i in rem:
            bucket(old[i][0])["removed"].append(a[i])
        for j in add:
            bucket(new[j][0])["added"].append(b[j])

    secs = [sections[n] for n in order]
    edits = []
    for s in secs:
        if s["title"] == "Шапка":
            continue
        edits += s["added"] + [c["to"] for c in s["changed"]]
    old_words, new_words = " ".join(a).split(), " ".join(b).split()
    return {
        "same": not secs,
        "similarity": round(difflib.SequenceMatcher(None, old_words, new_words, autojunk=False).ratio(), 3),
        "sections": secs,
        "edits": edits,
        "was": [c["from"] for s in secs if s["title"] != "Шапка" for c in s["changed"]],
        "counts": {k: sum(len(s[k]) for s in secs) for k in ("added", "removed", "changed")},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--pdf")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    res = compare(Path(a.old).read_text(encoding="utf-8"), Path(a.new).read_text(encoding="utf-8"))
    if a.pdf:
        from pypdf import PdfReader
        res["pdf_pages"] = len(PdfReader(a.pdf).pages)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
