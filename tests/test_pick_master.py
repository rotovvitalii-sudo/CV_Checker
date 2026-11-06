#!/usr/bin/env python3
"""Проверка автовыбора профиля на вымышленных данных: .venv/bin/python tests/test_pick_master.py"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILES = [
    {"id": "lead", "title": "Product Lead", "terms": ["product lead"], "version": 1},
    {"id": "growth", "title": "Growth Product Manager", "terms": ["growth product manager", "growth pm"], "version": 2},
    {"id": "empty", "title": "Product Owner", "terms": ["product owner"], "version": None},
    {"id": "old", "title": "Founder", "terms": ["founder"], "version": 3, "archived": True},
]
TEXT = {1: "roadmap strategy pricing", 2: "roadmap strategy retention experiments", 3: "roadmap strategy pricing retention experiments"}
fails = []


def run(vacancies):
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        m = d / "knowledge-base" / "master-cv"
        (d / "vacancies").mkdir()
        for v, t in TEXT.items():
            (m / "versions" / f"v{v:03d}").mkdir(parents=True)
            (m / "versions" / f"v{v:03d}" / "base-cv.md").write_text(t)
        (m / "active.json").write_text(json.dumps({"version": 1, "default": "lead", "profiles": PROFILES}))
        for name, (role, kw) in vacancies.items():
            (d / "vacancies" / f"{name}.md").write_text(f"---\nrole: {role}\n---\ntext")
            if kw is not None:
                (d / "output" / name).mkdir(parents=True)
                (d / "output" / name / "01-keywords.json").write_text(json.dumps(kw))
        out = subprocess.run([sys.executable, "scorer/pick_master.py", "--root", str(d), "--json"], cwd=ROOT, capture_output=True, text=True)
        return json.loads(out.stdout)


def check(name, cond):
    print(("ok  " if cond else "FAIL"), name)
    if not cond:
        fails.append(name)


r = run({
    "a": ("Senior Manager", {"must": ["retention", "experiments", "roadmap"]}),
    "b": ("Product Lead", {"must": ["retention", "experiments", "roadmap"]}),
    "c": ("Growth PM", {"must": ["roadmap", "strategy"]}),
    "d": ("Manager", {"must": ["roadmap", "strategy"]}),
    "e": ("Growth Product Manager", None),
    "f": ("Manager", None),
    "g": ("Manager", {"must": ["roadmap"], "source": "quick"}),
})
check("лучшее покрытие побеждает", r["a"]["pick"] == "growth" and r["a"]["by"] == "coverage")
check("причина с цифрами", "100%" in r["a"]["reason"] and "Product Lead" in r["a"]["reason"])
check("название не спорит с явным отрывом", r["b"]["pick"] == "growth")
check("почти равно: решает название", r["c"]["pick"] == "growth" and r["c"]["by"] == "title")
check("полная ничья: основной профиль", r["d"]["pick"] == "lead" and r["d"]["by"] == "default")
check("без ключей: название роли", r["e"]["pick"] == "growth" and not r["e"]["scored"])
check("без ключей и названия: основной", r["f"]["pick"] == "lead" and not r["f"]["ranking"])
check("быстрый фит помечен", r["g"]["provisional"])
check("пустой и архивный не участвуют", {x["profile"] for x in r["a"]["ranking"]} == {"lead", "growth"})
sys.exit(1 if fails else 0)
