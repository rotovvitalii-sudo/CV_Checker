#!/usr/bin/env python3
"""
feed.py — лента вакансий для веб-приложения (S1, docs/specs/03-job-feed.md).

Берёт всё сырьё, которое скачал fetch.py (job-search/raw/<source>-<дата>.json), прогоняет через
тот же словарь classify.py и раскладывает по двум разделам:
  fit      — поток A или B (строгий отбор, как в fetch.py);
  product  — продуктовая роль, но задачи обучения в тексте нет («почти подходят»).
Остальное в ленту не попадает: вакансии «задача обучения без продуктовой роли» — шум
(замер 2026-10-13: DevOps, контент-райтеры, солюшн-инженеры).

Исключает то, что уже есть в заявках (vacancies/, корпус, входящие веб-приложения) и пропущенное
(web/data/feed-skipped.json). Модель не вызывается — это чистая сортировка.

Использование:
  feed.py --json            вся лента
  feed.py --get KEY         одна вакансия целиком (с полным описанием) — для «Сохранить»
"""
import argparse, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from classify import classify, us_only  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "job-search" / "raw"
CORPUS = ROOT / "job-search" / "corpus" / "jobs.jsonl"
VACANCIES = ROOT / "vacancies"
APPS = ROOT / "web" / "data" / "applications.json"
SKIPPED = ROOT / "web" / "data" / "feed-skipped.json"
EXCERPT = 400
SECTORS = ("edtech", "fintech")  # порядок = приоритет при дублях
PROFILE = ROOT / "knowledge-base" / "profile.json"


def exclude_us_only():
    """Профиль поиска → exclude_us_only (по умолчанию да): вакансии только для США в ленту не попадают."""
    try:
        return json.loads(PROFILE.read_text()).get("exclude_us_only", True) is not False
    except (OSError, json.JSONDecodeError):
        return True


def key_of(j):
    """Тот же ключ, что в fetch.py: url без query, иначе компания::роль."""
    return (j.get("url") or f"{j.get('company', '')}::{j.get('title', '')}").split("?")[0].rstrip("/")


def norm_url(u):
    return (u or "").split("?")[0].rstrip("/")


def posted_iso(v):
    s = str(v or "").strip()
    if re.fullmatch(r"\d{9,11}", s):  # Himalayas: unix-время строкой
        return datetime.fromtimestamp(int(s), timezone.utc).strftime("%Y-%m-%d")
    m = re.match(r"\d{4}-\d{2}-\d{2}", s)
    return m.group(0) if m else ""


def load_raw():
    """Все файлы сырья; при дублях остаётся копия из самого свежего файла.
    EdTech (S6) — полный снимок вакансий компаний, поэтому берётся только последний файл:
    закрытые вакансии должны пропадать из ленты."""
    jobs, sources = {}, []
    files = sorted(RAW.glob("*-*.json"))  # имена <source>-<YYYY-MM-DD>.json сортируются по дате
    # отраслевые разделы (S6 EdTech, S7 FinTech) — полный снимок, берём только последний файл каждой отрасли
    snap = lambda f: next((s for s in SECTORS if f.name.startswith(f"{s}-")), None)
    files = [f for f in files if not snap(f)] + [fs[-1] for s in SECTORS if (fs := [f for f in files if snap(f) == s])]
    for f in files:
        m = re.match(r"(.+)-(\d{4}-\d{2}-\d{2})\.json$", f.name)
        if not m:
            continue
        try:
            data = json.loads(f.read_text())
        except json.JSONDecodeError:
            continue
        sources.append({"source": m.group(1), "file": f.name, "date": m.group(2), "count": len(data)})
        for j in data:
            jobs[key_of(j)] = j
    return jobs, sources


def saved_urls():
    """URL вакансий, которые уже есть в приложении: файлы вакансий, корпус, входящие."""
    urls = set()
    if VACANCIES.exists():
        for f in VACANCIES.glob("*.md"):
            m = re.search(r"^url:\s*(\S+)", f.read_text(), re.M)
            if m:
                urls.add(norm_url(m.group(1)))
    if CORPUS.exists():
        for line in CORPUS.read_text().splitlines():
            try:
                urls.add(norm_url(json.loads(line).get("url")))
            except json.JSONDecodeError:
                pass
    if APPS.exists():
        try:
            for it in json.loads(APPS.read_text()).get("inbox", {}).values():
                urls.add(norm_url(it.get("url")))
        except json.JSONDecodeError:
            pass
    urls.discard("")
    return urls


def skipped():
    try:
        return json.loads(SKIPPED.read_text()) if SKIPPED.exists() else {}
    except json.JSONDecodeError:
        return {}


def card(key, j, c, section):
    desc = j.get("description", "")
    return {
        "key": key, "section": section,
        "title": j.get("title", ""), "company": j.get("company", ""), "url": j.get("url", ""),
        "source": j.get("source", ""), "location": j.get("location", ""),
        "posted": posted_iso(j.get("date_posted")), "salary": j.get("salary", "") or "",
        "seniority": j.get("seniority", "") or "",
        "domains": c["domains"], "hits": (c["edu_task"] or c["role_builder"] or c["role_product"])[:6],
        "stream": c["bucket"], "score": c["score"],
        "segment": j.get("segment", ""), "country": j.get("country", ""), "role_group": j.get("role_group", ""),
        "excerpt": desc[:EXCERPT] + ("…" if len(desc) > EXCERPT else ""),
    }


def academy_signals(jobs):
    """S7 P1 · поток B из базы FinTech: компания открыла роль «обучение клиентов» (группа edu), но продуктовой роли
    в последнем снимке у неё нет — «строит академию без продакта». Считается по всем ролям снимка, включая пропущенные."""
    groups = {}
    for j in jobs.values():
        if j.get("source") == "fintech":
            groups.setdefault(j.get("company", ""), set()).add(j.get("role_group") or "")
    return {c for c, g in groups.items() if "edu" in g and "product" not in g}


def write_signals(jobs, companies):
    """Строка в job-search/signals.md на каждую edu-роль таких компаний; дубли по ссылке пропускаются (fetch.append_signals)."""
    if not companies:
        return
    import contextlib
    from fetch import append_signals
    rows = [{"company": j["company"], "title": j.get("title", ""), "url": j.get("url", ""),
             "fit_hits": ["обучение клиентов", "FinTech без продакта"]}
            for j in jobs.values() if j.get("source") == "fintech" and j.get("company") in companies and j.get("role_group") == "edu"]
    with contextlib.redirect_stdout(sys.stderr):  # stdout занят JSON ленты
        append_signals(rows, datetime.now().strftime("%Y-%m-%d"))


def build():
    jobs, sources = load_raw()
    signal_cos = academy_signals(jobs)
    write_signals(jobs, signal_cos)
    saved, skip = saved_urls(), skipped()
    items = []
    hide_us = exclude_us_only()
    hidden_us = []
    for key, j in jobs.items():
        if key in skip or norm_url(j.get("url")) in saved:
            continue
        c = classify(j)
        if j.get("source") in SECTORS:
            section = j["source"]  # роль уже отобрана edtech.py по заголовку
        elif c["bucket"] in ("A", "B"):
            section = "fit"
        elif c["role_product"] and not c["role_teaching"]:
            section = "product"
        else:
            continue
        # Только США (переезд или резидентство) — не показываем; считаем, чтобы лента сказала, сколько скрыто
        why_us = us_only(j) if hide_us else None
        if why_us:
            hidden_us.append({"title": j.get("title", ""), "company": j.get("company", ""), "location": j.get("location", ""),
                              "section": section, "why": why_us})
            continue
        items.append(card(key, j, c, section))
        if section == "fintech" and j.get("company") in signal_cos and j.get("role_group") == "edu":
            items[-1]["academy_signal"] = True
    pair = lambda x: (re.sub(r"[^a-z0-9]+", "", x["company"].lower()), re.sub(r"[^a-z0-9]+", "", x["title"].lower()))
    # Одна вакансия в нескольких разделах — оставляем одну копию по приоритету EdTech → FinTech → доски
    rank = {s: i for i, s in enumerate(SECTORS)}
    best = {}
    for x in items:
        k = pair(x)
        if k not in best or rank.get(x["section"], 99) < rank.get(best[k]["section"], 99):
            best[k] = x
    items = [x for x in items if best[pair(x)] is x]
    items.sort(key=lambda x: (-x["score"], x["posted"] and -int(x["posted"].replace("-", "")) or 0))
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": sources,
        "total": len(jobs),
        "items": items,
        "hidden_us": hidden_us,
        "skipped": [{"key": k, **v} for k, v in sorted(skip.items(), key=lambda kv: kv[1].get("at", ""), reverse=True)],
    }


def get_one(key):
    jobs, _ = load_raw()
    j = jobs.get(key)
    if not j:
        return None
    c = classify(j)
    section = j["source"] if j.get("source") in SECTORS else "fit" if c["bucket"] else "product"
    return {**card(key, j, c, section), "description": j.get("description", "")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--get")
    a = ap.parse_args()
    if a.get:
        print(json.dumps(get_one(a.get), ensure_ascii=False))
        return
    feed = build()
    if a.json:
        print(json.dumps(feed, ensure_ascii=False))
    else:
        by = {}
        for it in feed["items"]:
            by[it["section"]] = by.get(it["section"], 0) + 1
        print(f"сырья: {feed['total']} · подходят: {by.get('fit', 0)} · продуктовые: {by.get('product', 0)} · EdTech: {by.get('edtech', 0)} · FinTech: {by.get('fintech', 0)} · пропущено: {len(feed['skipped'])}")
        for it in feed["items"][:15]:
            print(f"  {it['section']:<7} {it['score']:>2}  {it['title'][:55]:<55} — {it['company'][:25]}  {it['posted']}")


if __name__ == "__main__":
    main()
