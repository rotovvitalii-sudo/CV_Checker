#!/usr/bin/env python3
"""
pick_master.py — какой профиль Master CV лучше подходит вакансии (C18).

Одна логика для приложения и чата. Покрытие считается как в check_master.py: must ×2, nice ×1.

Правило выбора:
  1. Лучшее покрытие.
  2. Если другие профили отстают не больше чем на 2 п.п., побеждает тот, чьи terms есть в названии роли.
  3. Ничья остаётся: больше закрытых must, затем основной профиль.
  4. Ключей нет: только название роли, иначе основной профиль (без матча).

Usage:
  pick_master.py [--only NAME ...] [--root .] [--json]
"""
import argparse, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_master import md_text, score  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
NEAR = 0.02


def norm(s):
    return re.sub(r"[^a-z0-9+]+", " ", str(s).lower()).strip()


def title_hit(role, terms):
    """Длина самого точного совпадения terms с названием роли: 0 — совпадений нет."""
    text = f" {norm(role)} "
    return max((len(norm(t)) for t in terms if norm(t) and f" {norm(t)} " in text), default=0)


def role_of(path):
    """Поле role: из фронтматтера вакансии."""
    if not path.exists():
        return ""
    m = re.search(r"^role:\s*(.+)$", path.read_text(errors="ignore"), re.M)
    return m.group(1).strip().strip("\"'") if m else ""


def pct(x):
    return f"{round(x * 100)}%"


def choose(ranking, profiles, default, role):
    """ranking отсортирован по покрытию; пустой — ключей ещё нет."""
    if not ranking:
        hits = sorted(((title_hit(role, p.get("terms") or [p["title"]]), p) for p in profiles), key=lambda x: -x[0])
        if hits and hits[0][0]:
            p = hits[0][1]
            return p["id"], "title", f"ключей ещё нет, название роли совпало с {p['title']}"
        title = next((p["title"] for p in profiles if p["id"] == default), default)
        return default, "default", f"ключей ещё нет, взят основной профиль {title}"

    top = ranking[0]
    near = [r for r in ranking if top["score"] - r["score"] <= NEAR + 1e-9]
    others = [r for r in ranking if r is not top]
    if len(near) == 1:
        tail = f" против {pct(others[0]['score'])} у {others[0]['title']}" if others else ""
        return top["profile"], "coverage", f"покрытие {pct(top['score'])}{tail}"

    terms = {p["id"]: p.get("terms") or [p["title"]] for p in profiles}
    hits = sorted(((title_hit(role, terms[r["profile"]]), r) for r in near), key=lambda x: -x[0])
    if hits[0][0] and (len(hits) == 1 or hits[0][0] > hits[1][0]):
        r = hits[0][1]
        return r["profile"], "title", f"покрытие почти равное, название роли совпало с {r['title']}"

    best_must = max(r["must_hit"] for r in near)
    tied = [r for r in near if r["must_hit"] == best_must]
    if len(tied) == 1:
        r = tied[0]
        return r["profile"], "must", f"покрытие почти равное, больше закрытых must: {r['must']}"
    r = next((x for x in tied if x["profile"] == default), tied[0])
    return r["profile"], "default", f"покрытие почти равное, взят {r['title']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    root = Path(a.root)
    master = root / "knowledge-base" / "master-cv"
    reg = json.loads((master / "active.json").read_text())
    profiles = [p for p in reg.get("profiles", []) if p.get("version") and not p.get("archived")]
    default = reg.get("default")
    texts = {}
    for p in profiles:
        f = master / "versions" / f"v{p['version']:03d}" / "base-cv.md"
        texts[p["id"]] = md_text(f.read_text())

    vac = {f.stem: f for f in (root / "vacancies").glob("*.md")}
    keys = {f.parent.name: f for f in (root / "output").glob("*/01-keywords.json")}
    res = {}
    for name in sorted(set(vac) | set(keys)):
        if a.only and name not in a.only:
            continue
        role = role_of(vac.get(name, Path("/nonexistent"))) or name.split(" - ")[0]
        ranking, provisional = [], False
        if name in keys and profiles:
            try:
                kw = json.loads(keys[name].read_text())
            except ValueError:
                kw = {}
            provisional = kw.get("source") == "quick"
            if kw.get("must") or kw.get("nice"):
                for p in profiles:
                    s = score(texts[p["id"]], kw)
                    hit, miss = s["must"]["hit"], s["must"]["miss"]
                    ranking.append({"profile": p["id"], "title": p["title"], "version": p["version"], "score": s["score"],
                                    "must": f"{len(hit)}/{len(hit) + len(miss)}", "must_hit": len(hit),
                                    "mustHit": hit, "mustMiss": miss})
                ranking.sort(key=lambda r: -r["score"])
        pick, by, reason = choose(ranking, profiles, default, role)
        res[name] = {"role": role, "pick": pick, "by": by, "reason": reason, "scored": bool(ranking),
                     "provisional": provisional, "ranking": ranking}

    if a.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        for name, r in res.items():
            print(f"{name}: {r['pick']} ({r['reason']})")


if __name__ == "__main__":
    main()
