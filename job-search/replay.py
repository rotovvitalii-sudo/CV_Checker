#!/usr/bin/env python3
"""
replay.py — прогоняет уже скачанные вакансии из job-search/raw/ через текущий classify.py.
Нужен, чтобы крутить словарь без запросов к чужим API: поменял classify.py — сразу видишь,
что изменилось на тех же данных.

  replay.py            сводка и топ по потокам
  replay.py --show B   показать весь поток B с причинами
"""
import argparse, glob, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from classify import classify

ap = argparse.ArgumentParser()
ap.add_argument("--show", choices=["A", "B"], action="append")
ap.add_argument("--limit", type=int, default=25)
a = ap.parse_args()

jobs, seen = [], set()
for f in glob.glob(str(Path(__file__).parent / "raw" / "*.json")):
    for j in json.load(open(f)):
        k = (j.get("url") or "") + j.get("title", "")
        if k not in seen:
            seen.add(k); jobs.append(j)

res = []
for j in jobs:
    c = classify(j)
    if c["bucket"]:
        res.append((c, j))

A = sorted([r for r in res if r[0]["bucket"] == "A"], key=lambda r: -r[0]["score"])
B = sorted([r for r in res if r[0]["bucket"] == "B"], key=lambda r: -r[0]["score"])
print(f"кэш: {len(jobs)} вакансий → поток A: {len(A)}, поток B: {len(B)}\n")

for label, group in (("A", A), ("B", B)):
    if a.show and label not in a.show:
        continue
    print(f"=== ПОТОК {label}")
    for c, j in group[:a.limit]:
        dom = "/".join(c["domains"]) or "—"
        print(f"  [{c['score']}] {j['title'][:56]:<56} | {j['company'][:24]:<24} | {dom}")
        why = []
        if c["role_product"]: why.append("роль: " + ", ".join(c["role_product"][:2]))
        if c["role_builder"]: why.append("строит обучение: " + ", ".join(c["role_builder"][:2]))
        if c["role_teaching"]: why.append("преподавание: " + ", ".join(c["role_teaching"][:2]))
        if c.get("edu_task"): why.append("задача: " + ", ".join(c["edu_task"][:3]))
        if c["external"]: why.append("внешняя аудитория: " + ", ".join(c["external"][:2]))
        if c["internal"]: why.append("⚠ внутреннее обучение: " + ", ".join(c["internal"][:2]))
        print(f"        {' · '.join(why)}")
    print()
