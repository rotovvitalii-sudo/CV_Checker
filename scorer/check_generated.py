#!/usr/bin/env python3
"""Проверка письма, сгенерированного агентом (C8, скил cover-letter-generate).

Для надиктованных писем действует check_letter.py (≥ 80% слов из надиктовки). Здесь — другое правило:
каждый факт подтверждён файлом базы. Проверяем:
- трассировка 04-generated-trace.json совпадает с Cover Letter.md слово в слово (без строки Subject:);
- у каждого предложения fact есть источник — существующий файл в knowledge-base/ или output/<…>/;
- предложение link без фактов: в нём нет чисел (кроме тех, что есть в тексте вакансии, например K-12)
  и названий компаний из опыта кандидата;
- длина письма 120–320 слов.

    .venv/bin/python scorer/check_generated.py --name "<Роль - Компания>" [--json]
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_WORDS, MAX_WORDS = 120, 320


def words(text):
    return re.findall(r"[\w'’$€%.,+-]+", text.lower().replace("’", "'"))


def norm_words(text):
    return [w.strip(".,") for w in words(text) if w.strip(".,")]


def letter_body(text):
    lines = text.strip().splitlines()
    if lines and lines[0].lower().startswith("subject:"):
        lines = lines[1:]
    return "\n".join(lines)


def experience_names():
    """Компании из опыта кандидата: поле company карточек и заголовки опыта в master-cv / base-cv."""
    names = set()
    for card in (ROOT / "knowledge-base" / "cards").glob("*.md"):
        m = re.search(r"^company:\s*(.+)$", card.read_text(encoding="utf-8"), re.M)
        if m:
            names.add(m.group(1).strip())
    base = ROOT / "knowledge-base" / "base-cv.md"
    if base.exists():
        for m in re.finditer(r"^###\s+([^(—\n]+)", base.read_text(encoding="utf-8"), re.M):
            names.add(m.group(1).strip())
    return {n for n in names if len(n) >= 3}


def source_ok(src, name):
    p = str(src or "").split("#")[0].strip()
    if ".." in p or not (p.startswith("knowledge-base/") or p.startswith(f"output/{name}/")):
        return False
    return (ROOT / p).is_file()


NUM_RE = re.compile(r"\d[\d,.]*\d|\d")


def vacancy_numbers(name):
    v = ROOT / "vacancies" / f"{name}.md"
    return set(NUM_RE.findall(v.read_text(encoding="utf-8"))) if v.exists() else set()


def check(name):
    out = ROOT / "output" / name
    issues = []
    try:
        trace = json.loads((out / "04-generated-trace.json").read_text(encoding="utf-8"))
        sentences = trace["sentences"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        return {"pass": False, "issues": [f"трассировка не читается: {e}"], "facts": 0, "facts_ok": 0, "words": 0}
    try:
        letter = letter_body((out / "Cover Letter.md").read_text(encoding="utf-8"))
    except OSError:
        return {"pass": False, "issues": ["нет Cover Letter.md"], "facts": 0, "facts_ok": 0, "words": 0}

    traced = " ".join(str(s.get("text", "")) for s in sentences)
    if norm_words(traced) != norm_words(letter):
        issues.append("трассировка не совпадает с текстом письма — письмо правили мимо трассировки")

    names = experience_names()
    vac_nums = vacancy_numbers(name)
    facts = facts_ok = 0
    for i, s in enumerate(sentences, 1):
        text, tag = str(s.get("text", "")), s.get("tag")
        short = text[:60] + ("…" if len(text) > 60 else "")
        if tag == "fact":
            facts += 1
            srcs = s.get("sources") or []
            bad = [x for x in srcs if not source_ok(x, name)]
            if not srcs:
                issues.append(f"предложение {i} «{short}»: факт без источника")
            elif bad:
                issues.append(f"предложение {i}: источник «{bad[0]}» — не файл базы")
            else:
                facts_ok += 1
        elif tag == "link":
            nums = [x for x in NUM_RE.findall(text) if x not in vac_nums]
            hit = nums or next((n for n in names if re.search(rf"\b{re.escape(n)}\b", text)), None)
            if hit:
                issues.append(f"предложение {i} «{short}»: похоже на факт (цифра или компания), а помечено link")
        else:
            issues.append(f"предложение {i}: тег «{tag}» — нужен fact или link")

    n = len(norm_words(letter))
    if not MIN_WORDS <= n <= MAX_WORDS:
        issues.append(f"длина {n} слов — нужно {MIN_WORDS}–{MAX_WORDS}")
    return {"pass": not issues, "issues": issues, "facts": facts, "facts_ok": facts_ok, "words": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="папка output/<Роль - Компания>")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = check(a.name)
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(f"слов {r['words']} · факты с источником {r['facts_ok']}/{r['facts']} · {'PASS' if r['pass'] else 'FAIL'}")
        for i in r["issues"]:
            print(" -", i)
    sys.exit(0 if r["pass"] else 1)


if __name__ == "__main__":
    main()
