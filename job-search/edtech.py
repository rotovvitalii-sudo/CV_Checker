#!/usr/bin/env python3
"""
edtech.py — отраслевые разделы ленты вакансий: «EdTech» (S6, docs/specs/14-edtech-careers.md)
и «FinTech» (S7, docs/specs/15-fintech-careers.md). Отрасль — параметр --sector (по умолчанию edtech).

Вакансии EdTech-компаний живут на их страницах карьеры. Большинство таких страниц — это витрина
стандартной системы найма (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio)
с открытым API для встраивания вакансий на сайт. Поэтому ежедневный сбор — это просто опрос этих API:
быстро, бесплатно и без агента. Агент нужен только чтобы находить новые компании (скил edtech-companies),
а добавляет их всё равно этот скрипт — после проверки, что API действительно отвечает.

База компаний: job-search/<sector>/companies.json, стартовый список — job-search/<sector>/seed.json
  {name, country, segment, careers_url, ats, token, status (ok|no_api|broken), checked_at, jobs_last, roles_last}

Команды (перед командой можно указать --sector edtech|fintech):
  seed FILE.json                 пробить список компаний [{name, country, segment, slugs?, careers_url?}]
  add --name N [--slugs a,b] [--country C] [--segment S] [--careers-url U]   добавить одну (для агента)
  fetch                          ежедневный сбор → job-search/raw/edtech-<дата>.json (только нужные роли)
  list [--json]                  база компаний и сводка
"""
import argparse, html, json, os, re, sys, threading, time, urllib.error, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from classify import edtech_role, fintech_role  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "job-search" / "edtech" / "companies.json"  # переопределяется в main() по --sector
RAW = ROOT / "job-search" / "raw"
UA = {"User-Agent": f"cv-checker-jobfit/0.1 (personal job search{'; contact ' + os.environ['CVC_CONTACT'] if os.environ.get('CVC_CONTACT') else ''})",  # контакт — CVC_CONTACT
      "Accept": "application/json"}
PAUSE = 0.3
WORKERS = 8


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean(text):
    text = re.sub(r"<[^>]+>", " ", html.unescape(text or ""))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


# Вежливость к одному хосту: потоки ждут друг друга. Workable режет частоту жёстче всех
# (замер 2026-10-13: два плотных прогона пробника → 429 на все запросы), поэтому ему — 1 запрос в 1,5 с.
HOST_GAP = {"apply.workable.com": 1.5}
_host_lock, _host_last = threading.Lock(), {}


class RateLimited(Exception):
    """Хост ответил 429 и после повторов — доска могла бы найтись, просто не сейчас."""


def _pace(url):
    host = urllib.parse.urlparse(url).hostname or ""
    gap = HOST_GAP.get(host, 0.15)
    with _host_lock:
        wait = _host_last.get(host, 0) + gap - time.time()
        _host_last[host] = time.time() + max(0, wait)
    if wait > 0:
        time.sleep(wait)


BLOCKED = set()  # хосты, которые в этом прогоне не сняли 429


def get(url, raw=False, timeout=20, retries=3):
    """GET с паузой на хост и повтором на 429; если 429 не проходит — RateLimited, а не «доски нет»."""
    host = urllib.parse.urlsplit(url).netloc
    if host in BLOCKED:  # хост уже отказал в этом прогоне — не продлеваем блокировку
        raise RateLimited(url)
    for attempt in range(retries + 1):
        _pace(url)
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                return body if raw else json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt == retries:
                BLOCKED.add(host)
                raise RateLimited(url)
            if e.code != 429:
                raise
            wait = e.headers.get("Retry-After")
            time.sleep(min(30, float(wait)) if wait and wait.replace(".", "").isdigit() else 3 * (attempt + 1))


def day(v):
    """Дата публикации → YYYY-MM-DD (ISO-строка или миллисекунды)."""
    if v in (None, ""):
        return ""
    if isinstance(v, (int, float)) or re.fullmatch(r"\d{12,13}", str(v)):
        return datetime.fromtimestamp(int(v) / 1000, timezone.utc).strftime("%Y-%m-%d")
    m = re.match(r"\d{4}-\d{2}-\d{2}", str(v))
    return m.group(0) if m else ""


# ─── адаптеры систем найма: token → [вакансии в общем формате] ────────────────
# Каждый бросает исключение, если токена нет (404 и т.п.).

def greenhouse(t):
    d = get(f"https://boards-api.greenhouse.io/v1/boards/{t}/jobs?content=true")
    return [{"title": j["title"], "url": j.get("absolute_url", ""), "location": (j.get("location") or {}).get("name", ""),
             "date_posted": day(j.get("first_published") or j.get("updated_at")), "description": clean(j.get("content"))}
            for j in d["jobs"]]


def lever(t):
    for host in ("api.lever.co", "api.eu.lever.co"):
        try:
            d = get(f"https://{host}/v0/postings/{t}?mode=json")
            break
        except urllib.error.HTTPError as e:
            if e.code != 404 or host == "api.eu.lever.co":
                raise
    if not isinstance(d, list):
        raise ValueError("не список")
    return [{"title": j["text"], "url": j.get("hostedUrl", ""), "location": (j.get("categories") or {}).get("location", ""),
             "date_posted": day(j.get("createdAt")),
             "description": clean((j.get("descriptionPlain") or "") + " " + " ".join(clean(x.get("content")) for x in j.get("lists", [])))}
            for j in d]


def ashby(t):
    d = get(f"https://api.ashbyhq.com/posting-api/job-board/{t}")
    return [{"title": j["title"], "url": j.get("jobUrl", ""),
             "location": ", ".join(filter(None, [j.get("location"), "Remote" if j.get("isRemote") else ""])),
             "date_posted": day(j.get("publishedAt")), "description": clean(j.get("descriptionPlain") or j.get("descriptionHtml"))}
            for j in d["jobs"]]


def workable(t):
    d = get(f"https://apply.workable.com/api/v1/widget/accounts/{t}")
    return [{"title": j["title"], "url": j.get("url") or j.get("shortlink", ""),
             "location": ", ".join(filter(None, [j.get("city"), j.get("country"), "Remote" if j.get("telecommuting") else ""])),
             "date_posted": day(j.get("published_on") or j.get("created_at")), "description": ""}
            for j in d["jobs"]]


def smartrecruiters(t):
    d = get(f"https://api.smartrecruiters.com/v1/companies/{t}/postings?limit=100")
    if not d.get("totalFound"):
        raise ValueError("нет вакансий — SmartRecruiters отвечает 200 и на несуществующие компании")
    return [{"title": j["name"], "url": f"https://jobs.smartrecruiters.com/{t}/{j['id']}",
             "location": ", ".join(filter(None, [(j.get("location") or {}).get("city"), (j.get("location") or {}).get("country"),
                                                  "Remote" if (j.get("location") or {}).get("remote") else ""])),
             "date_posted": day(j.get("releasedDate")), "description": ""}
            for j in d["content"]]


def recruitee(t):
    d = get(f"https://{t}.recruitee.com/api/offers/")
    return [{"title": j["title"], "url": j.get("careers_url", ""),
             "location": ", ".join(filter(None, [j.get("city"), j.get("country"), "Remote" if j.get("remote") else ""])),
             "date_posted": day(j.get("published_at")), "description": clean(j.get("description"))}
            for j in d["offers"]]


def personio(t):
    body = None
    for tld in ("de", "com"):
        try:
            body = get(f"https://{t}.jobs.personio.{tld}/xml", raw=True)
            break
        except urllib.error.HTTPError:
            if tld == "com":
                raise
    root = ET.fromstring(body)
    out = []
    for p in root.findall("position"):
        pid = (p.findtext("id") or "").strip()
        desc = " ".join(clean(v.findtext("value")) for v in p.findall("jobDescriptions/jobDescription"))
        out.append({"title": (p.findtext("name") or "").strip(), "url": f"https://{t}.jobs.personio.{tld}/job/{pid}",
                    "location": (p.findtext("office") or "").strip(), "date_posted": day(p.findtext("createdAt")), "description": desc})
    if not out and root.tag != "workzag-jobs":
        raise ValueError("не XML Personio")
    return out


ATS = {"greenhouse": greenhouse, "lever": lever, "ashby": ashby, "workable": workable,
       "recruitee": recruitee, "personio": personio, "smartrecruiters": smartrecruiters}


# ─── база компаний ────────────────────────────────────────────────────────────

def load():
    return json.loads(BASE.read_text()) if BASE.exists() else []


def save(companies):
    BASE.parent.mkdir(parents=True, exist_ok=True)
    companies.sort(key=lambda c: c["name"].lower())
    BASE.write_text(json.dumps(companies, ensure_ascii=False, indent=1) + "\n")


def slug_variants(name, extra=None):
    base = re.sub(r"\(.*?\)", "", name).strip()
    v = list(extra or [])
    words = re.sub(r"[^a-z0-9 ]+", "", base.lower()).split()
    v += ["".join(words), "-".join(words)]
    # «первое слово» не пробуем: «Khan Academy» → «khan» даёт ложные совпадения с чужими компаниями
    return [x for i, x in enumerate(v) if x and x not in v[:i]]


# ─── проверка, что доска принадлежит именно этой компании ────────────────────
# Замер 2026-10-13: Workable отвечает пустыми «мёртвыми» аккаунтами (chegg), Greenhouse «leap» —
# это AKQA Leap, Ashby «imprint» — платёжная компания. Поэтому одного ответа API мало.

# Строгие слова: «learn», «skills» встречаются в любом тексте («learn more», «machine learning»).
# Порог — частота: у Imprint (платежи) 2 случайных упоминания, у EdTech-компаний — десятки.
EDU_RE = re.compile(r"\b(education(?:al)?|edtech|e-?learning|students?|teachers?|teaching|classrooms?|curricul\w*|"
                    r"courses?|tutor\w*|learners?|language learning|schools?|upskill\w*|online learning|"
                    # немецкий, испанский, португальский — у европейских и LatAm-компаний описания не на английском
                    r"bildung\w*|lernplattform\w*|lernende\w*|schüler\w*|studierende\w*|lehrkr\w*|lehrer\w*|nachhilfe|"
                    r"educaci[oó]n|estudiantes|aprendizaje|cursos|educa[cç][aã]o|alunos|ensino)\b", re.I)
EDU_MIN_HITS = 5

# Тема FinTech (брокеры, трейдинг, крипто) для той же проверки принадлежности доски
# Только узкие термины трейдинга и крипто. «markets», «exchange», «investment», «options», «tokens» —
# в любой вакансии («stock options» в бенефитах): с ними прошли облачная Vantage, Circle.so, Ramp (карты).
FIN_RE = re.compile(r"\b(trading|traders?|brokers?|brokerage|cfds?|forex|stocks|etfs?|equities|crypto\w*|blockchain|"
                    r"bitcoin|ethereum|digital assets?|defi|web3|wallets?|derivatives|futures|stablecoins?|on-?chain|"
                    r"retail investors?|self-custody|copy trading|investing app|investment app|investing platform|"
                    r"share dealing|isas?|sipps?)\b", re.I)

SECTORS = {
    "edtech": {"label": "EdTech", "re": EDU_RE, "role": edtech_role},
    "fintech": {"label": "FinTech", "re": FIN_RE, "role": fintech_role},
}
SECTOR = {"name": "edtech", **SECTORS["edtech"]}


def norm_name(x):
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"\(.*?\)", "", str(x or "")).lower())


def board_name(ats, t):
    """Название доски, если система найма его отдаёт (Greenhouse, Workable)."""
    try:
        if ats == "greenhouse":
            return get(f"https://boards-api.greenhouse.io/v1/boards/{t}").get("name")
        if ats == "workable":
            return get(f"https://apply.workable.com/api/v1/widget/accounts/{t}").get("name")
    except Exception:
        return None
    return None


def verify(company, ats, t, jobs):
    """(подтверждено, причина). Нужны открытые вакансии и признак, что доска — этой компании."""
    if not jobs:
        return False, "0 открытых вакансий — не подтвердить"
    want = norm_name(company)
    bn = board_name(ats, t)
    if bn:
        got = norm_name(bn)
        if want and got and (want in got or got in want):
            return True, f"доска «{bn}»"
        return False, f"доска называется «{bn}»"
    descs = [j["description"] for j in jobs if j.get("description")]
    if not descs:
        return True, "вакансии есть, описаний нет"  # SmartRecruiters / Personio без описаний
    first = re.sub(r"\(.*?\)", "", company).split()[0].lower()
    text = " ".join(descs[:15])
    if first not in text.lower():
        return False, "в описаниях вакансий нет названия компании"
    hits = len(SECTOR["re"].findall(text))
    if hits < EDU_MIN_HITS:
        return False, f"тема отрасли ({SECTOR['label']}) почти не упоминается ({hits}) — похоже на другую компанию"
    return True, "название и тема обучения в описаниях"


def probe(name, slugs=None):
    """Первая пара (система найма, токен), где API отвечает и доска подтверждена как доска этой компании.
    Возвращает (ats, token, n_jobs, кандидат_с_причиной_отказа | None)."""
    rejected = None
    for t in slug_variants(name, slugs):
        for ats, fn in ATS.items():
            try:
                jobs = fn(t)
            except RateLimited:
                rejected = rejected or f"{ats}:{t} — система найма ограничила частоту, перепроверить позже"
                continue
            except Exception:
                continue
            ok, why = verify(name, ats, t, jobs)
            if ok:
                return ats, t, len(jobs), None
            rejected = rejected or f"{ats}:{t} — {why}"
    return None, None, 0, rejected


def probe_company(c):
    ats, token, n, rejected = probe(c["name"], c.get("slugs"))
    rec = {k: c.get(k, "") for k in ("name", "country", "segment", "careers_url")}
    status = "ok" if ats else ("retry" if rejected and "ограничила частоту" in rejected else "no_api")
    rec.update({"ats": ats or "none", "token": token or "", "status": status,
                "checked_at": now(), "jobs_last": n, "roles_last": None, "note": rejected or ""})
    return rec


def cmd_seed(a):
    seed = json.loads(Path(a.file).read_text())
    base = {c["name"].lower(): c for c in load()}
    todo = [c for c in seed if c["name"].lower() not in base or base[c["name"].lower()]["status"] != "ok"]
    print(f"пробиваю {len(todo)} компаний ({WORKERS} потоков)…", flush=True)
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, rec in enumerate(ex.map(probe_company, todo), 1):
            base[rec["name"].lower()] = {**base.get(rec["name"].lower(), {}), **rec}
            extra = f" · отклонено: {rec['note']}" if rec["note"] else ""
            print(f"[{i}/{len(todo)}] {rec['name']}: {rec['ats']} {rec['token']} ({rec['jobs_last']} вакансий){extra}", flush=True)
    save(list(base.values()))
    s = summary(list(base.values()))
    print(f"\nбаза: {s['total']} · автосбор {s['ok']} · без API {s['no_api']} · сломались {s['broken']} · перепроверить {s['retry']}")


def cmd_add(a):
    base = {c["name"].lower(): c for c in load()}
    rec = probe_company({"name": a.name, "country": a.country, "segment": a.segment, "careers_url": a.careers_url,
                         "slugs": [s.strip() for s in (a.slugs or "").split(",") if s.strip()]})
    old = base.get(a.name.lower())
    if old and old["status"] == "ok" and rec["status"] != "ok":
        print(json.dumps({"added": False, "reason": "уже в базе с рабочим API", "company": old}, ensure_ascii=False))
        return
    base[a.name.lower()] = {**(old or {}), **{k: v for k, v in rec.items() if v not in ("", None) or k in ("token",)}}
    save(list(base.values()))
    print(json.dumps({"added": True, "company": base[a.name.lower()]}, ensure_ascii=False))


def fetch_company(c):
    try:
        jobs = ATS[c["ats"]](c["token"])
    except Exception as e:  # сломалась одна компания — остальные собираем
        return c, None, f"{type(e).__name__}: {str(e)[:80]}"
    picked = []
    for j in jobs:
        group = SECTOR["role"](j["title"])
        if not group:
            continue
        picked.append({"source": SECTOR["name"], "title": clean(j["title"]), "company": c["name"], "url": j["url"],
                       "location": clean(j["location"]), "date_posted": j["date_posted"],
                       "description": j["description"][:6000], "segment": c.get("segment", ""),
                       "country": c.get("country", ""), "ats": c["ats"], "role_group": group})
    return c, (len(jobs), picked), None


def cmd_fetch(a):
    companies = load()
    active = [c for c in companies if c.get("status") in ("ok", "broken") and c.get("ats") in ATS]
    print(f"{SECTOR['label']}: опрашиваю {len(active)} компаний…", flush=True)
    found, errors, t0 = [], 0, time.time()
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, (c, res, err) in enumerate(ex.map(fetch_company, active), 1):
            c["checked_at"] = now()
            if err:
                if not err.startswith("RateLimited"):  # 429 — временно, компанию не ломаем
                    c["status"] = "broken"
                errors += 1
                print(f"[{i}/{len(active)}] {c['name']}: не отвечает ({err})", flush=True)
                continue
            total, picked = res
            c.update({"status": "ok", "jobs_last": total, "roles_last": len(picked)})
            found += picked
            if picked:
                print(f"[{i}/{len(active)}] {c['name']}: {len(picked)} из {total}", flush=True)
            time.sleep(PAUSE / WORKERS)
    save(companies)
    # Одна вакансия в нескольких городах приходит несколькими копиями — склеиваем, локации через «;»
    merged = {}
    for j in found:
        k = (j["company"].lower(), re.sub(r"\s+", " ", j["title"].lower()).strip())
        if k in merged:
            if j["location"] and j["location"] not in merged[k]["location"]:
                merged[k]["location"] = "; ".join(filter(None, [merged[k]["location"], j["location"]]))
        else:
            merged[k] = j
    found = list(merged.values())
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / f"{SECTOR['name']}-{today}.json").write_text(json.dumps(found, ensure_ascii=False, indent=1))
    print(f"\n{SECTOR['label']}: {len(found)} подходящих ролей у {len({j['company'] for j in found})} компаний · "
          f"не ответили {errors} · {time.time() - t0:.0f} с → job-search/raw/{SECTOR['name']}-{today}.json", flush=True)


def summary(companies):
    return {"total": len(companies), "ok": sum(c["status"] == "ok" for c in companies),
            "no_api": sum(c["status"] == "no_api" for c in companies), "broken": sum(c["status"] == "broken" for c in companies),
            "retry": sum(c["status"] == "retry" for c in companies)}


def cmd_list(a):
    companies = load()
    if a.json:
        print(json.dumps({"summary": summary(companies), "companies": companies}, ensure_ascii=False))
        return
    s = summary(companies)
    print(f"база: {s['total']} · автосбор {s['ok']} · без API {s['no_api']} · сломались {s['broken']}")
    for c in companies:
        print(f"  {c['status']:<7} {c['ats']:<16} {c['name']:<30} {c.get('country', '')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sector", choices=list(SECTORS), default="edtech")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("seed"); p.add_argument("file"); p.set_defaults(fn=cmd_seed)
    p = sub.add_parser("add"); p.add_argument("--name", required=True); p.add_argument("--slugs")
    p.add_argument("--country", default=""); p.add_argument("--segment", default=""); p.add_argument("--careers-url", default="")
    p.set_defaults(fn=cmd_add)
    p = sub.add_parser("fetch"); p.set_defaults(fn=cmd_fetch)
    p = sub.add_parser("list"); p.add_argument("--json", action="store_true"); p.set_defaults(fn=cmd_list)
    a = ap.parse_args()
    global BASE
    SECTOR.clear()
    SECTOR.update({"name": a.sector, **SECTORS[a.sector]})
    BASE = ROOT / "job-search" / a.sector / "companies.json"
    a.fn(a)


if __name__ == "__main__":
    main()
