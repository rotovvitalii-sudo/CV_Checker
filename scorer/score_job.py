#!/usr/bin/env python3
"""
score_job.py — детерминированная часть Job Fit Search (см. job-fit-search-brief.md).

Делит работу так: LLM (скил job-scout) извлекает вакансию по схеме и ставит баллы по рубрике,
скрипт проверяет схему, применяет жёсткие фильтры, считает арифметику, решает порог,
дедуплицирует и ведёт корпус. Чтобы «фит» не плыл от настроения модели.

Команды:
  add FILE.json [FILE2.json ...]   добавить вакансии в корпус
  digest [--days 1]                дайджест по корпусу
  calibrate                        прогнать эталоны из job-search/calibration/
  stats                            частоты для исследования рынка (раздел 9 брифа)

Схема одной вакансии — раздел 4 брифа, плюс блок scores:
  {"title","company","url","source","date_posted","location","work_format",
   "relocation_support","seniority","role_family","domain","business_model","platform",
   "company_stage","current_task","must_have_experience":[],"nice_to_have":[],
   "ai_requirement","languages_required":[],"salary",
   "scores":{"task_fit":0-4,"domain":0-2,"role_type":0-2,"logistics":0-2},
   "why":"2-3 предложения","anchor_card":"id карточки knowledge-base/cards/ или null",
   "anchor_case":"почему этот кейс в центр","gaps":[],
   "raw_text":"полный текст вакансии (опционально)"}
"""
import argparse, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "job-search" / "corpus" / "jobs.jsonl"
DIGESTS = ROOT / "job-search" / "digests"
CALIB = ROOT / "job-search" / "calibration"
VACANCIES = ROOT / "vacancies"

REQUIRED = ["title", "company", "current_task", "seniority", "role_family", "domain", "scores"]
SCORE_KEYS = {"task_fit": 4, "domain": 2, "role_type": 2, "logistics": 2}

SAVE_THRESHOLD = 7      # 7–10: сохранить в vacancies/ и показать в дайджесте
MAYBE_THRESHOLD = 5     # 5–6: только дайджест, как «возможно»

# Жёсткие фильтры (раздел 5 брифа): вакансия уходит в корпус без дайджеста.
# Значения — из профиля поиска knowledge-base/profile.json (C2, правится в приложении); если файла
# нет — прежние константы ниже.
PROFILE = ROOT / "knowledge-base" / "profile.json"
_DEFAULT = {
    "seniority_exclude": ["junior", "mid"],
    "languages": ["ukrainian", "uk", "russian", "ru", "english", "en", "polish", "pl"],
    "onsite_locations": ["warsaw", "warszawa", "tricity", "trójmiasto", "trojmiasto",
                         "gdansk", "gdańsk", "gdynia", "sopot", "poland", "polska"],
    "relocation": "with_support",   # no | with_support | any
    "work_formats": ["remote", "hybrid", "onsite"],
}


def _profile():
    try:
        p = json.loads(PROFILE.read_text()) if PROFILE.exists() else {}
    except json.JSONDecodeError:
        p = {}
    return {k: p.get(k, v) for k, v in _DEFAULT.items()}


_P = _profile()
JUNIOR_MID = {x.lower() for x in _P["seniority_exclude"]}
MY_LANGUAGES = {x.lower() for x in _P["languages"]}
TARGET_ONSITE = [x.lower() for x in _P["onsite_locations"]]
RELOCATION = _P["relocation"]
WORK_FORMATS = {x.lower() for x in _P["work_formats"]}


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def key_of(job: dict) -> str:
    """Ключ дедупликации: url, иначе компания+должность."""
    url = (job.get("url") or "").split("?")[0].rstrip("/")
    return url or f"{slug(job.get('company',''))}::{slug(job.get('title',''))}"


def validate(job: dict) -> list:
    errs = [f"нет поля «{f}»" for f in REQUIRED if not job.get(f)]
    sc = job.get("scores") or {}
    for k, mx in SCORE_KEYS.items():
        v = sc.get(k)
        if v is None:
            errs.append(f"нет балла «{k}»")
        elif not isinstance(v, int) or not (0 <= v <= mx):
            errs.append(f"балл «{k}»={v} вне диапазона 0–{mx}")
    return errs


def hard_filters(job: dict) -> list:
    """Возвращает список сработавших жёстких фильтров."""
    out = []
    sen = (job.get("seniority") or "").lower()
    if sen in JUNIOR_MID:
        out.append(f"seniority: {sen} — исключён в профиле")

    fmt = (job.get("work_format") or "").lower()
    loc = (job.get("location") or "").lower()
    reloc = (job.get("relocation_support") or "unknown").lower()
    if fmt in ("remote", "hybrid", "onsite") and fmt not in WORK_FORMATS:
        out.append(f"формат {fmt} исключён в профиле")
    elif fmt == "onsite" and not any(t in loc for t in TARGET_ONSITE):
        # no — офис только в целевых локациях; with_support — ещё и с поддержкой релокации; any — любой
        if RELOCATION == "no" or (RELOCATION == "with_support" and reloc != "yes"):
            out.append(f"онсайт вне целевых локаций без релокации ({job.get('location')})")

    for lang in job.get("languages_required") or []:
        base = re.split(r"[ (/]", lang.strip().lower())[0]
        if base and base not in MY_LANGUAGES:
            out.append(f"требуется язык: {lang}")
    return out


def flags(job: dict) -> list:
    out = []
    must = " ".join(job.get("must_have_experience") or []).lower()
    if re.search(r"\b(native mobile|ios|android|mobile app|мобильн)", must) or \
       (job.get("platform") or "").lower() == "mobile":
        out.append("mobile_gap")
    if (job.get("ai_requirement") or "").lower() == "builds_ai_features":
        out.append("ai_gap")
    return out


def enrich(job: dict) -> dict:
    sc = job["scores"]
    total = sum(sc[k] for k in SCORE_KEYS)
    hf = hard_filters(job)
    if hf:
        bucket = "corpus"
    elif total >= SAVE_THRESHOLD:
        bucket = "save"
    elif total >= MAYBE_THRESHOLD:
        bucket = "maybe"
    else:
        bucket = "corpus"
    job["total"] = total
    job["hard_filters"] = hf
    job["flags"] = flags(job)
    job["bucket"] = bucket
    job["key"] = key_of(job)
    # C9: главный кейс — существующая карточка базы; несуществующий id не роняет фит, а помечается
    card = (job.get("anchor_card") or "").strip().removesuffix(".md").split("/")[-1]
    if card:
        job["anchor_card"] = card
        if not (ROOT / "knowledge-base" / "cards" / f"{card}.md").exists():
            job["anchor_card_missing"] = True
    job.setdefault("added", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    return job


def load_corpus() -> list:
    if not CORPUS.exists():
        return []
    return [json.loads(l) for l in CORPUS.read_text().splitlines() if l.strip()]


def save_vacancy_md(job: dict) -> Path:
    """Сохраняет вакансию в vacancies/ в формате, который ждёт конвейер tailor-cv."""
    name = re.sub(r"[/:]", "-", f"{job['title']} - {job['company']}")[:120]
    path = VACANCIES / f"{name}.md"
    fm = {k: job.get(k, "") for k in
          ("company", "url", "source", "date_posted", "location", "work_format",
           "seniority", "role_family", "domain", "business_model", "salary")}
    lines = ["---", f"role: {job['title']}"]
    lines += [f"{k}: {v}" for k, v in fm.items() if v]
    lines += [f"job_fit_score: {job['total']}/10",
              f"anchor_card: {job.get('anchor_card') or ''}",
              f"anchor_case: {job.get('anchor_case','')}",
              f"added: {job['added']}", "---", "",
              f"# {job['title']} — {job['company']}", "",
              f"**Задача компании:** {job['current_task']}", "",
              f"**Почему фит ({job['total']}/10):** {job.get('why','')}", ""]
    if job.get("gaps"):
        lines += ["**Пробелы:**"] + [f"- {g}" for g in job["gaps"]] + [""]
    if job.get("raw_text"):
        lines += ["## Текст вакансии", "", job["raw_text"]]
    else:
        lines += ["## Текст вакансии", "",
                  "_Не сохранён. Для запуска `tailor-cv` вставь полный текст сюда._"]
    path.write_text("\n".join(lines) + "\n")
    return path


def cmd_add(a):
    corpus = load_corpus()
    seen = {j["key"] for j in corpus}
    added, skipped, saved, results = [], [], [], []
    CORPUS.parent.mkdir(parents=True, exist_ok=True)

    for f in a.files:
        data = json.loads(Path(f).read_text())
        for job in (data if isinstance(data, list) else [data]):
            errs = validate(job)
            if errs:
                print(f"SKIP {job.get('title','?')} — {'; '.join(errs)}")
                continue
            job = enrich(job)
            if job["key"] in seen:
                skipped.append(job)
                if a.save_always and not a.no_save:
                    job["vacancy_file"] = str(save_vacancy_md(job).relative_to(ROOT))
                results.append({**job, "duplicate": True})
                continue
            seen.add(job["key"])
            added.append(job)
            if (job["bucket"] == "save" or a.save_always) and not a.no_save:
                path = save_vacancy_md(job)
                saved.append(path)
                job["vacancy_file"] = str(path.relative_to(ROOT))
            results.append(job)

    with CORPUS.open("a") as fh:
        for job in added:
            fh.write(json.dumps(job, ensure_ascii=False) + "\n")

    print(f"добавлено {len(added)}, дублей пропущено {len(skipped)}, корпус {len(corpus)+len(added)}")
    for job in sorted(added, key=lambda j: -j["total"]):
        fl = (" [" + ", ".join(job["flags"]) + "]") if job["flags"] else ""
        hf = (" ⛔ " + "; ".join(job["hard_filters"])) if job["hard_filters"] else ""
        print(f"  {job['total']:>2}/10 {job['bucket']:<6} {job['title']} — {job['company']}{fl}{hf}")
    for p in saved:
        print(f"  → {p.relative_to(ROOT)}")
    if a.result:
        out = [{k: v for k, v in j.items() if k != "raw_text"} for j in results]
        Path(a.result).write_text(json.dumps(out if len(out) != 1 else out[0], ensure_ascii=False, indent=2))


def cmd_digest(a):
    corpus = load_corpus()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    recent = [j for j in corpus if j.get("added", "") >= a.since] if a.since else corpus
    save = sorted([j for j in recent if j["bucket"] == "save"], key=lambda j: -j["total"])
    maybe = sorted([j for j in recent if j["bucket"] == "maybe"], key=lambda j: -j["total"])

    md = [f"# Дайджест вакансий — {today}", "",
          f"Корпус: {len(corpus)} вакансий. В этом дайджесте: {len(save)} фитов, {len(maybe)} «возможно».", ""]
    for title, group in (("## Фит — подаваться", save[:10]), ("## Возможно", maybe[:10])):
        md.append(title)
        if not group:
            md.append("\n_пусто_\n")
            continue
        md.append("")
        for j in group:
            fl = (" `" + "` `".join(j["flags"]) + "`") if j["flags"] else ""
            link = f"[{j['title']}]({j['url']})" if j.get("url") else j["title"]
            md.append(f"### {j['total']}/10 — {link} — {j['company']}{fl}")
            md.append(f"- **Задача компании:** {j['current_task']}")
            md.append(f"- **Почему:** {j.get('why','')}")
            md.append(f"- **Кейс в центр:** {j.get('anchor_case','—')}")
            if j.get("gaps"):
                md.append(f"- **Пробелы:** {'; '.join(j['gaps'])}")
            sc = j["scores"]
            md.append(f"- Баллы: задача {sc['task_fit']}/4 · домен {sc['domain']}/2 · "
                      f"роль {sc['role_type']}/2 · логистика {sc['logistics']}/2")
            md.append("")
    DIGESTS.mkdir(parents=True, exist_ok=True)
    out = DIGESTS / f"{today}.md"
    out.write_text("\n".join(md) + "\n")
    print("\n".join(md))
    print(f"\n→ {out.relative_to(ROOT)}")


def cmd_calibrate(a):
    files = sorted(CALIB.glob("*.json"))
    if not files:
        sys.exit(f"нет эталонов в {CALIB}")
    ok = True
    print(f"{'эталон':<42} {'ожидали':<9} {'получили':<8} итог")
    for f in files:
        job = json.loads(f.read_text())
        lo, hi = job.get("expected_min", 0), job.get("expected_max", 10)
        job = enrich(job)
        t = job["total"]
        good = lo <= t <= hi
        ok &= good
        name = f"{job['title']} — {job['company']}"[:40]
        print(f"{name:<42} {lo}–{hi:<7} {t:<8} {'PASS' if good else 'FAIL'}")
        if not good:
            sc = job["scores"]
            print(f"    задача {sc['task_fit']}/4 домен {sc['domain']}/2 "
                  f"роль {sc['role_type']}/2 логистика {sc['logistics']}/2")
    print("\nЕсли эталон не попал в диапазон — правится рубрика, а не эталон (раздел 6 брифа).")
    print("ВСЕ ЭТАЛОНЫ В ДИАПАЗОНЕ" if ok else "ЕСТЬ ОТКЛОНЕНИЯ")


def cmd_impact(a):
    """Как текущий профиль (knowledge-base/profile.json) меняет решения по корпусу: ничего не пишет."""
    corpus = load_corpus()
    changed = []
    for j in corpus:
        if not j.get("scores"):
            continue
        new = enrich(dict(j))
        if new["bucket"] != j.get("bucket"):
            changed.append({"title": j.get("title"), "company": j.get("company"), "total": new["total"],
                            "old": j.get("bucket"), "new": new["bucket"], "hard_filters": new["hard_filters"]})
    res = {"corpus": len(corpus), "changed": changed,
           "dropped": sum(c["new"] == "corpus" for c in changed), "restored": sum(c["new"] != "corpus" for c in changed)}
    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print(f"корпус {res['corpus']}: изменится {len(changed)} (отсеются {res['dropped']}, вернутся {res['restored']})")
        for c in changed:
            print(f"  {c['old']} → {c['new']}  {c['title']} — {c['company']}  {'; '.join(c['hard_filters'])}")


def cmd_stats(a):
    corpus = load_corpus()
    if not corpus:
        sys.exit("корпус пуст")
    def freq(key, extract=lambda j, k: [j.get(k)]):
        c = {}
        for j in corpus:
            for v in extract(j, key) or []:
                if v:
                    c[str(v).lower()] = c.get(str(v).lower(), 0) + 1
        return sorted(c.items(), key=lambda x: -x[1])
    print(f"корпус: {len(corpus)} вакансий\n")
    for key in ("domain", "role_family", "seniority", "ai_requirement", "platform", "business_model"):
        print(f"--- {key}")
        for v, n in freq(key)[:12]:
            print(f"  {n:>3}  {v}")
    print("--- must_have_experience (топ-20)")
    for v, n in freq("must_have_experience", lambda j, k: j.get(k) or [])[:20]:
        print(f"  {n:>3}  {v}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add"); p.add_argument("files", nargs="+"); p.add_argument("--no-save", action="store_true")
    p.add_argument("--save-always", action="store_true", help="сохранять .md в vacancies/ при любом балле (ручная загрузка)")
    p.add_argument("--result", help="записать обогащённую запись (total, bucket, flags, vacancy_file) в JSON"); p.set_defaults(fn=cmd_add)
    p = sub.add_parser("digest"); p.add_argument("--since", default=""); p.set_defaults(fn=cmd_digest)
    p = sub.add_parser("calibrate"); p.set_defaults(fn=cmd_calibrate)
    p = sub.add_parser("stats"); p.set_defaults(fn=cmd_stats)
    p = sub.add_parser("impact"); p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_impact)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
