#!/usr/bin/env python3
"""Проверка scorer/check_evidence.py на вымышленном кандидате: .venv/bin/python tests/test_check_evidence.py"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = """# ALEX MORGAN
Product Lead | 0-to-1 | EdTech
Poland | +00 000 000 000 | alex@example.com

## Career Profile
Product leader with 8+ years in EdTech. Led a team of 6.

## Experience
### Northwind Learning (EU) — Product Lead
January 2023 – October 2026 · Full Time, Remote
_Subscription platform_
- Owned product strategy and roadmap
- Increased conversion by 38% from a 2% baseline

## Education
- State University, 2010

## Languages
English (C1), Polish (B2)
"""
CARD = """# Карточка
Конверсия выросла на 38%, 15 000+ платных пользователей, курс в 4 раза быстрее, контракт $100K.
⚠️ NDA: выручка 90%.
Выборка — предположение: 20K.
"""
fails = []


def run(cv, base=True):
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "cards").mkdir()
        (d / "cards" / "c.md").write_text(CARD)
        (d / "base.md").write_text(BASE)
        (d / "cv.md").write_text(cv)
        args = [sys.executable, "scorer/check_evidence.py", "--cv", str(d / "cv.md"), "--cards", str(d / "cards"), "--json"]
        out = subprocess.run(args + (["--base", str(d / "base.md")] if base else []), cwd=ROOT, capture_output=True, text=True).stdout
        return json.loads(out)


def check(name, cond):
    print(("ok  " if cond else "FAIL"), name)
    if not cond:
        fails.append(name)


check("база совпадает сама с собой", run(BASE)["pass"])
add = "- Grew to 15K+ users, 4x faster, closed $100K deal\n\n## Education"
check("те же числа в другой записи", run(BASE.replace("\n## Education", add, 1))["numbers"]["pass"])
for bad in ("50%", "10x", "$200K", "90%", "20K"):
    r = run(BASE.replace("by 38%", f"by {bad}"))
    check(f"число {bad} поймано", bad in r["numbers"]["unknown"])
check("должность изменена", not run(BASE.replace("— Product Lead", "— Head of Product"))["pass"])
check("дата изменена", not run(BASE.replace("October 2026", "Present"))["pass"])
check("уровень языка изменён", not run(BASE.replace("English (C1)", "English (C2)"))["pass"])
check("формат работы менять можно", run(BASE.replace("Full Time, Remote", "Remote"))["pass"])
check("контакты и годы не считаются", run(BASE.replace("State University, 2010", "State University, 2011"))["numbers"]["pass"])
two = run(BASE.replace("- Increased", "- Supported sales teams\n- Increased"))
check("две обязанности в роли", len(two["duties"]) == 1 and not two["style_ok"] and two["pass"])
check("пустые слова", run(BASE.replace("Led a team", "Results-driven. Led a team"))["claims"] == ["results-driven"])
check("местоимения", run(BASE.replace("Led a team", "I led a team"))["voice"] == ["I"])
check("без --base только числа", run(BASE, base=False)["roles"] is None)
sys.exit(1 if fails else 0)
