#!/usr/bin/env python3
"""
calibrate_dict.py — проверка словаря classify.py на фикстурах.

Фикстуры (job-search/fixtures/fixtures.json) — короткие вакансии, собранные по реальным кейсам:
три эталонные вакансии кандидата (должны попадать в поток A), два сигнала «не-EdTech строит обучение»
(поток B) и типовой шум (должен отсеиваться). Правило то же, что у эталонов скоринга:
если фикстура не проходит — правится словарь, а не фикстура.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from classify import classify, edtech_role, fintech_role, us_only

rows = json.loads((Path(__file__).parent / "fixtures" / "fixtures.json").read_text())
ok = True
print(f"{'фикстура':<46} {'ждём':<6} {'итог':<6} {'score':<6} результат")
for r in rows:
    c = classify(r)
    got = c["bucket"]
    good = got == r["expect"]
    ok &= good
    name = f"{r['title']} — {r['company']}"[:44]
    print(f"{name:<46} {str(r['expect']):<6} {str(got):<6} {c['score']:<6} {'PASS' if good else 'FAIL'}")
    if not good:
        print(f"    {r['note']}")
        print(f"    домены={c['domains']} задача={c['edu_task'][:4]} роль_p={c['role_product'][:2]} "
              f"роль_b={c['role_builder'][:2]} внеш={c['external'][:2]} внутр={c['internal'][:2]}")
# Раздел «EdTech» (S6): роли отбираются только по заголовку
print(f"\n{'роль для раздела EdTech':<46} {'ждём':<9} {'итог':<9} результат")
for r in json.loads((Path(__file__).parent / "fixtures" / "edtech_roles.json").read_text()):
    got = edtech_role(r["title"])
    good = got == r["expect"]
    ok &= good
    print(f"{r['title'][:44]:<46} {str(r['expect']):<9} {str(got):<9} {'PASS' if good else 'FAIL'}")

# Раздел «FinTech» (S7): плюс группа «обучение клиентов» (edu)
print(f"\n{'роль для раздела FinTech':<46} {'ждём':<9} {'итог':<9} результат")
for r in json.loads((Path(__file__).parent / "fixtures" / "fintech_roles.json").read_text()):
    got = fintech_role(r["title"])
    good = got == r["expect"]
    ok &= good
    print(f"{r['title'][:44]:<46} {str(r['expect']):<9} {str(got):<9} {'PASS' if good else 'FAIL'}")

# Только США (2026-10-26): такие вакансии в ленту не попадают
print(f"\n{'только США (локация / текст)':<46} {'ждём':<9} {'итог':<9} результат")
for r in json.loads((Path(__file__).parent / "fixtures" / "us_only.json").read_text()):
    got = bool(us_only(r))
    good = got == r["expect"]
    ok &= good
    print(f"{(r['location'] + ' ' + r['description'])[:44]:<46} {str(r['expect']):<9} {str(got):<9} {'PASS' if good else 'FAIL'}")

print("\nВСЕ ФИКСТУРЫ ПРОХОДЯТ" if ok else "ЕСТЬ ОТКЛОНЕНИЯ — правь словарь в classify.py")
