#!/usr/bin/env python3
"""Проверка структуры для надиктовки письма (C7, скил letter-outline).

Структура — опора для надиктовки, а не текст письма. Проверяем то, что можно проверить кодом:
- 1–5 блоков, у каждого заголовок и подсказка;
- подсказка ≤ 200 символов и по-русски (защита от готовых английских фраз письма);
- у каждого факта есть источник — существующий файл в knowledge-base/ или output/;
- gaps — список строк.

    .venv/bin/python scorer/check_outline.py --outline "output/<…>/04-letter-outline.json" [--json]
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BLOCKS = 5
MAX_PROMPT = 200
MAX_FACT = 160
SOURCE_ROOTS = ("knowledge-base/", "output/")


def cyr_share(text):
    letters = re.findall(r"[A-Za-zА-Яа-яЁёІіЇїЄєҐґ]", text)
    if not letters:
        return 0.0
    return sum(bool(re.match(r"[А-Яа-яЁёІіЇїЄєҐґ]", c)) for c in letters) / len(letters)


def source_ok(src):
    p = str(src or "").split("#")[0].strip()
    if not p.startswith(SOURCE_ROOTS) or ".." in p:
        return False
    return (ROOT / p).is_file()


def check(data):
    issues = []
    blocks = data.get("blocks")
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= MAX_BLOCKS:
        issues.append(f"блоков должно быть 1–{MAX_BLOCKS}")
        blocks = blocks if isinstance(blocks, list) else []
    facts = 0
    for i, b in enumerate(blocks, 1):
        title, prompt = str(b.get("title", "")).strip(), str(b.get("prompt", "")).strip()
        if not title:
            issues.append(f"блок {i}: нет заголовка")
        if not prompt:
            issues.append(f"блок {i}: нет подсказки")
        elif len(prompt) > MAX_PROMPT:
            issues.append(f"блок {i}: подсказка {len(prompt)} символов (> {MAX_PROMPT}) — похоже на готовый текст")
        elif cyr_share(prompt) < 0.5:
            issues.append(f"блок {i}: подсказка не по-русски — похоже на фразу письма")
        for j, f in enumerate(b.get("facts") or [], 1):
            facts += 1
            text = str(f.get("text", "")).strip() if isinstance(f, dict) else ""
            if not text:
                issues.append(f"блок {i}, факт {j}: пустой")
            elif len(text) > MAX_FACT:
                issues.append(f"блок {i}, факт {j}: длиннее {MAX_FACT} символов")
            if not isinstance(f, dict) or not source_ok(f.get("source")):
                issues.append(f"блок {i}, факт {j}: источник «{f.get('source') if isinstance(f, dict) else ''}» — не файл базы")
    gaps = data.get("gaps", [])
    if not isinstance(gaps, list) or not all(isinstance(g, str) for g in gaps):
        issues.append("gaps должен быть списком строк")
    return {"pass": not issues, "issues": issues, "blocks": len(blocks), "facts": facts}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outline", required=True)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    try:
        data = json.loads(Path(a.outline).read_text(encoding="utf-8"))
        r = check(data)
    except (OSError, ValueError, AttributeError) as e:
        r = {"pass": False, "issues": [f"файл не читается: {e}"], "blocks": 0, "facts": 0}
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(f"блоков {r['blocks']} · фактов {r['facts']} · {'PASS' if r['pass'] else 'FAIL'}")
        for i in r["issues"]:
            print(" -", i)
    sys.exit(0 if r["pass"] else 1)


if __name__ == "__main__":
    main()
