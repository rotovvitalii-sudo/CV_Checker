#!/usr/bin/env python3
"""
check_master.py — матч Master CV с вакансиями по ключевым словам.

Берёт текст CV в формате CV.md (обычно knowledge-base/base-cv.md или версия из
knowledge-base/master-cv/versions/vNNN/base-cv.md) и считает покрытие ключей каждой вакансии
из output/<Роль - Компания>/01-keywords.json. Логика совпадения и веса (must ×2, nice ×1) —
те же, что в check_cv.py, чтобы цифры были сравнимы с покрытием адаптированного CV.

Usage:
  check_master.py --cv knowledge-base/base-cv.md [--output output] [--only NAME ...] [--json]
"""
import argparse, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_cv import coverage, MUST_WEIGHT, NICE_WEIGHT  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def md_text(md: str) -> str:
    """CV.md → плоский текст: без разметки заголовков, буллетов и выделения."""
    t = re.sub(r"^#{1,3}\s+", "", md, flags=re.M)
    t = re.sub(r"^\s*-\s+", "", t, flags=re.M)
    return t.replace("**", "").replace("_", " ")


def score(text: str, kw: dict) -> dict:
    must, nice = kw.get("must", []), kw.get("nice", [])
    mh, mm = coverage(text, must)
    nh, nm = coverage(text, nice)
    total = MUST_WEIGHT * len(must) + NICE_WEIGHT * len(nice)
    s = (MUST_WEIGHT * len(mh) + NICE_WEIGHT * len(nh)) / total if total else 0
    return {"score": round(s, 3),
            "must": {"hit": mh, "miss": mm}, "nice": {"hit": nh, "miss": nm}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cv", required=True)
    ap.add_argument("--output", default=str(ROOT / "output"))
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    text = md_text(Path(a.cv).read_text())
    res = {}
    for kwf in sorted(Path(a.output).glob("*/01-keywords.json")):
        name = kwf.parent.name
        if a.only and name not in a.only:
            continue
        try:
            kw = json.loads(kwf.read_text())
        except json.JSONDecodeError:
            continue
        res[name] = score(text, kw)

    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        for name, r in sorted(res.items(), key=lambda x: -x[1]["score"]):
            m = r["must"]
            print(f"{r['score']*100:4.0f}%  must {len(m['hit'])}/{len(m['hit'])+len(m['miss'])}  {name}")


if __name__ == "__main__":
    main()
