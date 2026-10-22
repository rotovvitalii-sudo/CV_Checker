#!/usr/bin/env python3
"""
fetch.py — шаг 1 конвейера Job Fit Search: тянет вакансии с публичных API удалённых досок
и отбирает кандидатов на скоринг.

Дешёвая механическая часть. Суждение «фит / не фит» делает модель на шаге 2 (скил job-scout),
и чтобы ей не носить сотни вакансий, здесь работает двухступенчатый отсев:
  1) роль похожа на продуктовую/бизнесовую (ROLE_TERMS в заголовке);
  2) в описании есть фит-термины (FIT_TERMS: academy, LMS, learning platform, customer education…).
Вакансия проходит, если выполнены оба условия, ЛИБО если фит-терминов в описании много
(сильный сигнал задачи даже при непонятном заголовке).

Источники (публичные JSON API, без ключей). Замеры 2026-10-02:
  himalayas   https://himalayas.app/jobs/api    — 101K вакансий, курсорная пагинация по 20 → основной
  remoteok    https://remoteok.com/api          — ~100 последних; по их ToS при публикации ссылаться
  remotive    https://remotive.com/api/remote-jobs — отдаёт только 16 вакансий, оставлен для полноты

Использование:
  fetch.py                         все источники
  fetch.py --source himalayas      один источник
  fetch.py --pages 60              глубже по Himalayas (страница = 20 вакансий)
  fetch.py --all-roles             не фильтровать по заголовку (только по фит-терминам)

Выход:
  job-search/raw/<source>-<дата>.json   всё, что отдал источник (сырьё, для повторного прогона)
  job-search/candidates/<дата>.json     кандидаты на скоринг, с полем fit_hits
"""
import argparse, html, json, os, re, sys, time, urllib.request, urllib.error
from pathlib import Path as _P
sys.path.insert(0, str(_P(__file__).parent))
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "job-search" / "raw"
CAND = ROOT / "job-search" / "candidates"
# Контакт в User-Agent — по правилам вежливого сбора; задаётся переменной окружения CVC_CONTACT
UA = {"User-Agent": f"cv-checker-jobfit/0.1 (personal job search{'; contact ' + os.environ['CVC_CONTACT'] if os.environ.get('CVC_CONTACT') else ''})"}

from classify import classify   # словарь и правила отбора — там


def clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def get(url: str):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)


def norm(source, title, company, url, description, location="", date="", extra=None):
    return {"source": source, "title": clean(title), "company": clean(company), "url": url,
            "location": clean(location), "date_posted": str(date)[:10],
            "description": clean(description)[:6000], **(extra or {})}


def from_remoteok():
    data = get("https://remoteok.com/api")
    out = []
    for j in data[1:]:  # [0] — объект с текстом лицензии
        out.append(norm("remoteok", j.get("position", ""), j.get("company", ""),
                        j.get("url") or j.get("apply_url", ""), j.get("description", ""),
                        j.get("location", ""), j.get("date", ""),
                        {"tags": j.get("tags", [])}))
    return out


def from_remotive():
    data = get("https://remotive.com/api/remote-jobs")
    return [norm("remotive", j.get("title", ""), j.get("company_name", ""), j.get("url", ""),
                 j.get("description", ""), j.get("candidate_required_location", ""),
                 j.get("publication_date", ""),
                 {"tags": j.get("tags", []), "salary": j.get("salary", "")})
            for j in data.get("jobs", [])]


CURSOR_FILE = ROOT / "job-search" / "cursor.json"


def from_himalayas(pages=40, fresh=False, seen=None):
    """
    fresh=True (кнопка «Обновить ленту» в веб-приложении): начать с самой новой страницы, не трогая
    сохранённый курсор глубокого обхода, и остановиться на первой странице без новых вакансий.

    API отдаёт максимум 20 вакансий на запрос, страницы — курсором, и ограничивает частоту (429).
    Поэтому: пауза между страницами, мягкая остановка на лимите и сохранение курсора,
    чтобы следующий запуск продолжил с того же места, а не ходил по одним и тем же вакансиям.
    """
    out = []
    saved_cursor = json.loads(CURSOR_FILE.read_text()).get("himalayas") if CURSOR_FILE.exists() else None
    cursor = None if fresh else saved_cursor
    for i in range(pages):
        url = "https://himalayas.app/jobs/api?limit=20" + (f"&cursor={cursor}" if cursor else "")
        try:
            data = get(url)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(f"  himalayas: лимит запросов на странице {i}, останавливаюсь "
                      f"(собрано {len(out)}, курсор сохранён)", file=sys.stderr)
                break
            raise
        time.sleep(1.2)  # вежливый темп к чужому API
        page_new = 0
        for j in data.get("jobs", []):
            out.append(norm("himalayas", j.get("title", ""), j.get("companyName", ""),
                            j.get("applicationLink", ""),
                            j.get("description") or j.get("excerpt", ""),
                            ", ".join(j.get("locationRestrictions") or []),
                            j.get("pubDate", ""),
                            {"seniority": j.get("seniority", ""),
                             "categories": j.get("categories", [])}))
            if seen is not None and key_of(out[-1]) not in seen:
                page_new += 1
        print(f"  himalayas: страница {i + 1}, новых {page_new}", file=sys.stderr, flush=True)
        if fresh and seen is not None and page_new == 0:
            break  # дальше только то, что уже видели
        nxt = data.get("nextCursor")
        if not nxt:
            cursor = None  # дошли до конца ленты — следующий запуск начнёт сначала
            break
        cursor = nxt
    if not fresh:
        CURSOR_FILE.write_text(json.dumps({"himalayas": cursor}))
    return out


def key_of(j):
    return (j["url"] or f"{j['company']}::{j['title']}").split("?")[0].rstrip("/")


SOURCES = {"remoteok": from_remoteok, "remotive": from_remotive, "himalayas": from_himalayas}


SIGNALS_MD = ROOT / "job-search" / "signals.md"
SIGNALS_HEAD = """# Поток B — компании, которые строят обучение

Каждая строка: компания наняла человека, который **строит или ведёт обучение**
(instructional designer, customer education, LMS, enablement). Значит, она строит академию —
а владельца продукта у неё может не быть. Это повод написать напрямую Head of Product / CMO / CEO
по схеме «вижу, вы строите X; я делал это трижды; вот кейс».

Сообщения пишет и отправляет кандидат сам. Статусы: `new` → `researched` → `contacted` → `replied` → `dropped`.

| Компания | Сигнал (вакансия) | Термины | Ссылка | Дата | Кому писать | Статус |
|---|---|---|---|---|---|---|
"""


def append_signals(signals, today):
    """Дописывает новые сигналы в таблицу потока B, не трогая уже проставленные статусы."""
    SIGNALS_MD.parent.mkdir(parents=True, exist_ok=True)
    existing = SIGNALS_MD.read_text() if SIGNALS_MD.exists() else SIGNALS_HEAD
    added = 0
    rows = []
    for j in signals:
        if j["url"] and j["url"] in existing:
            continue
        if f"| {j['company']} | {j['title']}" in existing:
            continue
        link = f"[вакансия]({j['url']})" if j["url"] else "—"
        rows.append(f"| {j['company']} | {j['title'][:60]} | {', '.join(j['fit_hits'][:4])} | "
                    f"{link} | {today} | — | new |")
        added += 1
    if rows:
        SIGNALS_MD.write_text(existing.rstrip() + "\n" + "\n".join(rows) + "\n")
    print(f"поток B: добавлено в signals.md {added}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=list(SOURCES), action="append")
    ap.add_argument("--pages", type=int, default=40, help="страниц Himalayas по 20 вакансий")
    ap.add_argument("--fresh", action="store_true",
                    help="Himalayas с самой новой страницы до первой страницы без новых; курсор не трогать")
    a = ap.parse_args()

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    RAW.mkdir(parents=True, exist_ok=True); CAND.mkdir(parents=True, exist_ok=True)
    chosen = a.source or list(SOURCES)
    seen_path = ROOT / "job-search" / "seen.json"
    seen_all = set(json.loads(seen_path.read_text())) if seen_path.exists() else set()
    total, stream_a, stream_b, fresh = 0, [], [], 0

    for name in chosen:
        try:
            jobs = from_himalayas(a.pages, a.fresh, seen_all) if name == "himalayas" else SOURCES[name]()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"{name}: не отвечает — {e}", file=sys.stderr)
            continue
        (RAW / f"{name}-{today}.json").write_text(json.dumps(jobs, ensure_ascii=False, indent=1))
        na = nb = 0
        for j in jobs:
            key = key_of(j)
            if key in seen_all:
                continue
            seen_all.add(key); fresh += 1
            c = classify(j)
            if not c["bucket"]:
                continue
            bucket = c["bucket"]
            j["fit_hits"] = c["edu_task"] or c["role_builder"]
            j["classify"] = c
            (stream_a if bucket == "A" else stream_b).append(j)
            na, nb = na + (bucket == "A"), nb + (bucket == "B")
        total += len(jobs)
        print(f"{name:<10} получено {len(jobs):>5} → поток A: {na}, поток B: {nb}")

    seen_path.write_text(json.dumps(sorted(seen_all)))
    (CAND / f"{today}.json").write_text(json.dumps(stream_a, ensure_ascii=False, indent=1))
    (CAND / f"{today}-signals.json").write_text(json.dumps(stream_b, ensure_ascii=False, indent=1))

    if stream_b:
        append_signals(stream_b, today)

    print(f"\nвсего {total} вакансий, новых с прошлого запуска {fresh}")
    print(f"поток A (кандидаты на скоринг): {len(stream_a)} → {(CAND / f'{today}.json').relative_to(ROOT)}")
    print(f"поток B (сигналы компаний):     {len(stream_b)} → {(CAND / f'{today}-signals.json').relative_to(ROOT)}\n")

    for label, group in (("ПОТОК A — на скоринг", stream_a), ("ПОТОК B — сигналы", stream_b)):
        if not group:
            continue
        print(f"--- {label}")
        for j in sorted(group, key=lambda x: -len(x["fit_hits"]))[:20]:
            print(f"  [{len(j['fit_hits'])}] {j['title'][:62]} — {j['company'][:30]} ({j['source']})")
            print(f"       {', '.join(j['fit_hits'][:6])}")


if __name__ == "__main__":
    main()
