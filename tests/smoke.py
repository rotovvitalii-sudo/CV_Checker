#!/usr/bin/env python3
"""Проверка всего приложения без агента и без изменения данных заявок.

    .venv/bin/python tests/smoke.py [--base http://127.0.0.1:4317] [--quick]

1. Статика: node --check всех JS, конфликт имён верхнего уровня между файлами интерфейса, компиляция Python.
2. Калибровки: словарь ролей (calibrate_dict.py) и рубрика фита (score_job.py calibrate).
3. API на чтение: списки, лента, отрасли, сайты, Master CV, профиль, агент, уведомления, база кейсов,
   страница каждой заявки.
4. Файлы: CV (PDF, DOCX — скачать и открыть), письма (PDF, DOCX), Master CV — код ответа, тип и имя файла
   по правилам E1. Скачивание письма может собрать Cover Letter.pdf/.docx — это производные файлы (C10).
--quick — без калибровок и без файлов писем.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = str(ROOT / ".venv" / "bin" / "python")
fails, passes = [], 0


def ok(cond, what):
    global passes
    if cond:
        passes += 1
    else:
        fails.append(what)
    return cond


def get(base, url, timeout=240):
    try:
        with urllib.request.urlopen(base + url, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:  # сервер не отвечает
        return 0, {}, str(e).encode()


def q(s):
    return urllib.parse.quote(s, safe="")


def section(t):
    print(f"\n== {t}")


def static():
    section("Статика")
    js = sorted((ROOT / "web").glob("*.js")) + sorted((ROOT / "web" / "public").glob("*.js"))
    for f in js:
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        ok(r.returncode == 0, f"node --check {f.relative_to(ROOT)}: {r.stderr.strip()[:200]}")
    names = {}
    for f in ["app.js", "cases-view.js", "master-view.js"]:
        txt = (ROOT / "web" / "public" / f).read_text()
        names[f] = re.findall(r"^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)", txt, re.M)
    for f, ns in names.items():
        dup = {n for n in ns if ns.count(n) > 1}
        ok(not dup, f"повтор имён внутри {f}: {sorted(dup)}")
    # Серверные модули: повтор function внутри файла тихо перекрывает первую (так сломался фит входящих 2026-10-21)
    for f in sorted((ROOT / "web").glob("*.js")):
        ns = re.findall(r"^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)", f.read_text(), re.M)
        dup = {n for n in ns if ns.count(n) > 1}
        ok(not dup, f"повтор имён внутри web/{f.name}: {sorted(dup)}")
    files = list(names)
    for i, a in enumerate(files):
        for b in files[i + 1:]:
            clash = set(names[a]) & set(names[b])
            ok(not clash, f"одинаковые имена в {a} и {b}: {sorted(clash)}")
    pys = [str(p) for p in list((ROOT / "scorer").glob("*.py")) + list((ROOT / "job-search").glob("*.py"))]
    r = subprocess.run([PY, "-m", "py_compile", *pys], capture_output=True, text=True)
    ok(r.returncode == 0, f"py_compile: {r.stderr.strip()[:300]}")
    print(f"   JS {len(js)}, Python {len(pys)}")


def calibrations():
    section("Калибровки")
    r = subprocess.run([PY, "job-search/calibrate_dict.py"], cwd=ROOT, capture_output=True, text=True)
    ok("ВСЕ ФИКСТУРЫ ПРОХОДЯТ" in r.stdout, "calibrate_dict.py: есть упавшие фикстуры")
    r = subprocess.run([PY, "scorer/score_job.py", "calibrate"], cwd=ROOT, capture_output=True, text=True)
    ok("ВСЕ ЭТАЛОНЫ В ДИАПАЗОНЕ" in r.stdout, "score_job.py calibrate: эталон вне диапазона")
    print("   словарь ролей и рубрика фита")


def api(base):
    section("API")
    urls = ["/", "/api/vacancies", "/api/feed", "/api/feed/edtech/companies", "/api/feed/fintech/companies",
            "/api/job-sites", "/api/master", "/api/profile", "/api/profile-answers", "/api/events",
            "/api/agent/status", "/api/agent/usage", "/api/cases", "/api/agent/models",
            "/api/targets", "/api/stories", "/api/money", "/api/week", "/api/feed/keys", "/api/voice", "/api/answer-library"]
    for u in urls:
        code, _, body = get(base, u)
        if ok(code == 200, f"GET {u} → {code}") and u.startswith("/api/"):
            try:
                json.loads(body)
            except ValueError:
                ok(False, f"GET {u}: не JSON")
    code, _, body = get(base, "/api/cases")
    cases = json.loads(body) if code == 200 else {"cards": [], "letters": []}
    for c in cases["cards"]:
        code, _, _ = get(base, f"/api/cases/card/{q(c['id'])}")
        ok(code == 200, f"карточка {c['id']} → {code}")
    for l in cases["letters"]:
        code, _, _ = get(base, f"/api/cases/raw/{q(l['file'])}")
        ok(code == 200, f"надиктовка {l['file']} → {code}")
    code, _, _ = get(base, "/api/topics/..%2Fetc")
    ok(code in (400, 404), f"тема с плохим slug → {code}")
    items = json.loads(get(base, "/api/vacancies")[2])["items"]
    details = []
    for it in items:
        code, _, body = get(base, f"/api/vacancies/{q(it['name'])}")
        if ok(code == 200, f"заявка {it['name']} → {code}"):
            details.append(json.loads(body))
            d = details[-1]
            # V2: корзины требований в разборе; V1: сообщение к отклику — с проверкой
            ok("minimum" in it and "hasApplyMsg" in it, f"заявка {it['name']}: в списке нет minimum / hasApplyMsg")
            bk = (d.get("brief") or {}).get("buckets")
            if bk:
                ok(all(g["hit"] <= g["total"] for g in bk["groups"]), f"корзины {it['name']}: hit > total")
            m = d.get("applyMessage")
            if m:
                ok(bool(m.get("message")) and "check" in m, f"сообщение к отклику {it['name']}: нет текста или проверки")
            # W8: темы для интервью — статус каждой темы читается, правильные ответы теста наружу не уходят
            for t in ((d.get("topics") or {}).get("list") or []):
                code, _, body = get(base, f"/api/topics/{q(t['slug'])}")
                if ok(code == 200, f"тема {t['slug']} → {code}"):
                    tp = json.loads(body)
                    ok(not any("answer" in x for x in ((tp.get("test") or {}).get("questions") or [])), f"тема {t['slug']}: в тесте видны ответы")
        # C11: состояние формы на сайте — только чтение (разбор формы тест не запускает)
        code, _, body = get(base, f"/api/vacancies/{q(it['name'])}/form")
        if ok(code == 200, f"форма {it['name']} → {code}"):
            t = json.loads(body)["target"]
            ok(bool(t.get("url")) or bool(t.get("reason")), f"форма {it['name']}: нет ни ссылки, ни причины")
    print(f"   эндпоинтов {len(urls)}, карточек {len(cases['cards'])}, надиктовок {len(cases['letters'])}, заявок {len(details)}")
    return details


def disposition_name(headers):
    h = {k.lower(): v for k, v in headers.items()}.get("content-disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", h)
    if m:
        return urllib.parse.unquote(m.group(1))
    m = re.search(r'filename="?([^";]+)"?', h)
    return m.group(1) if m else ""


def check_file(base, url, want_name, kind, attach):
    code, headers, body = get(base, url)
    if not ok(code == 200, f"{url} → {code} {body[:120]!r}"):
        return
    disp = {k.lower(): v for k, v in headers.items()}.get("content-disposition", "")
    ok(disp.startswith("attachment" if attach else "inline"), f"{url}: Content-Disposition «{disp[:40]}»")
    ok(disposition_name(headers) == want_name, f"{url}: имя «{disposition_name(headers)}», ждали «{want_name}»")
    magic = {"pdf": b"%PDF", "docx": b"PK"}[kind]
    ok(body[:4].startswith(magic), f"{url}: не {kind}")


def files(base, details, quick):
    section("Файлы")
    n_cv = n_letter = 0
    for d in details:
        name, en = d["name"], d["exportNames"]
        if d["hasCV"]:
            n_cv += 1
            check_file(base, f"/files/{q(name)}/CV.docx?download=1", en["cvDocx"], "docx", True)
            if "CV.pdf" in d["files"]:
                check_file(base, f"/files/{q(name)}/CV.pdf?download=1", en["cvPdf"], "pdf", True)
                check_file(base, f"/files/{q(name)}/CV.pdf/{q(en['cvPdf'])}", en["cvPdf"], "pdf", False)
            else:
                ok(False, f"{name}: есть CV.docx, но нет CV.pdf — кнопки PDF не будет")
        if d.get("letterFile") and not quick:
            n_letter += 1
            check_file(base, f"/letter-file/{q(name)}/pdf?download=1", en["letterPdf"], "pdf", True)
            check_file(base, f"/letter-file/{q(name)}/docx?download=1", en["letterDocx"], "docx", True)
            check_file(base, f"/letter-file/{q(name)}/pdf/{q(en['letterPdf'])}", en["letterPdf"], "pdf", False)
    m = json.loads(get(base, "/api/master")[2])
    act = next((v for v in m.get("versions", []) if v.get("active")), None)
    if act:
        # Имя — из шапки base-cv.md, как web/store.js → personName()
        head = ((ROOT / "knowledge-base" / "base-cv.md").read_text().split("\n")[0] if (ROOT / "knowledge-base" / "base-cv.md").exists() else "")
        person = "_".join(w[:1].upper() + w[1:].lower() for w in head.lstrip("#").split()) or "CV"
        exp = f"CV_{person}_Master_v{act['version']:03d}"
        check_file(base, f"/master-files/{act['version']}/{q('Master CV.pdf')}?download=1", exp + ".pdf", "pdf", True)
        check_file(base, f"/master-files/{act['version']}/{q('Master CV.docx')}?download=1", exp + ".docx", "docx", True)
    print(f"   CV {n_cv}, письма {n_letter}{' (пропущены: --quick)' if quick else ''}, Master v{act['version'] if act else '—'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:4317")
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    static()
    if not a.quick:
        calibrations()
    details = api(a.base)
    files(a.base, details, a.quick)
    print(f"\nИтог: {passes} проверок прошло, {len(fails)} упало")
    for f in fails:
        print("  ✗", f)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
