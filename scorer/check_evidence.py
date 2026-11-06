#!/usr/bin/env python3
"""
check_evidence.py — можно ли верить тексту CV: числа, должности и подача буллетов.

Жёсткие проверки (pass):
  numbers — каждое число в CV есть в базе (base-cv.md + карточки) в том же виде: 38%, 4x, $100K, 15K.
            Строки карточек с пометками NDA / предположение / оценка в базу не идут (tailor-cv, правило 2).
            Числа словами («three») и смысл числа не проверяются: только сам факт, что такое число есть в базе.
  roles   — компании, должности, даты и порядок ролей как в базе, строка Languages без изменений.
            Нужен --base или --roles-from. Без них (проверка самого Master CV) пропускается.
            --roles-from сверяет только роли и не добавляет файл к базе чисел: так профили Master сверяются между собой (C18).

Мягкие проверки (style_ok, только предупреждение):
  duties  — больше одного буллета-обязанности на роль: без числа и начинается с глагола обязанности.
  claims  — пустые характеристики вместо фактов.
  voice   — местоимения первого лица.
  metric_share — доля буллетов Experience с числом (справочно).

Usage:
  check_evidence.py --cv output/<...>/CV.md --base knowledge-base/base-cv.md [--cards knowledge-base/cards] [--json]
"""
import argparse, json, re
from pathlib import Path

FLAGGED = re.compile(r"⚠️|\bNDA\b|предположени|не использовать|не писать|не называть|оценк", re.I)
NUM = re.compile(
    r"(?<![\w.,/-])(?P<cur>[$€£])?\s?(?P<val>\d{1,3}(?:[, ]\d{3})+|\d+(?:\.\d+)?)"
    r"(?P<mag>\s?(?:[KkMm]\b|тыс\w*\.?|тысяч\w*|млн))?(?P<unit>\s?(?:%|[xXхХ×]\b|раза?\b))?")
YEAR = re.compile(r"^(19|20)\d\d$")
DUTY = re.compile(r"^(?:owned|supported|facilitated|responsible for|worked (?:on|with)|helped|assisted|participated|"
                  r"managed|coordinated|collaborated|handled|involved in|in charge of)\b", re.I)
CLAIMS = re.compile(
    r"\b(?:ownership mindset|results?[- ](?:driven|oriented)|passionate|proven track record|team player|detail[- ]oriented|"
    r"self[- ]starter|hard[- ]working|go[- ]getter|strategic thinker|fast learner|excellent communication|"
    r"strong (?:communication|leadership|analytical)|dynamic (?:leader|professional)|most effective in|"
    r"comfortable saying no)\b", re.I)
VOICE = re.compile(r"\b(?:I|my|me|mine|myself)\b")


def number_tokens(text):
    """Числа строки в нормальном виде: класс (% / x / $ / plain) + значение."""
    out = []
    for m in NUM.finditer(re.sub(r"\b\d+-to-\d+\b", " ", text)):  # 0-to-1 — термин, а не число
        raw = m.group("val")
        val = float(re.sub(r"[, ]", "", raw))
        mag = (m.group("mag") or "").strip().lower()
        if mag == "k" or mag.startswith("тыс"):
            val *= 1_000
        elif mag == "m" or mag == "млн":
            val *= 1_000_000
        unit = (m.group("unit") or "").strip().lower()
        if m.group("cur"):
            cls = "$"
        elif unit == "%":
            cls = "%"
        elif unit:
            cls = "x"
        else:
            cls = ""
        if not cls and not mag and YEAR.match(raw):
            continue
        shown = m.group(0).strip()
        out.append((f"{cls}{val:g}", shown))
    return out


def corpus(paths):
    seen = set()
    for p in paths:
        for line in Path(p).read_text().splitlines():
            if FLAGGED.search(line):
                continue
            seen.update(t for t, _ in number_tokens(line))
    return seen


def parse(md):
    """Разбор CV.md: tagline, текст для чисел, роли, буллеты по ролям, Languages."""
    lines = [l.strip() for l in md.splitlines()]
    res = {"tagline": "", "body": [], "roles": [], "bullets": [], "languages": "", "profile": ""}
    section, role, meta_next, header_seen = "Header", None, False, False
    for l in lines:
        if not l:
            continue
        if l.startswith("# "):
            continue
        if section == "Header" and not l.startswith("## "):
            if not header_seen:
                res["tagline"], header_seen = l, True
                res["body"].append(l)
            continue
        if l.startswith("## "):
            section, role, meta_next = l[3:].strip(), None, False
            continue
        if l.startswith("### "):
            role = {"head": l[4:].strip(), "dates": "", "bullets": []}
            res["roles"].append(role)
            meta_next = True
            continue
        if meta_next:
            role["dates"] = l.split("·")[0].strip()
            meta_next = False
            continue
        if section.lower() == "languages":
            res["languages"] += " " + l
            continue
        if section.lower() == "skills":
            continue
        if section.lower() == "career profile":
            res["profile"] += " " + l
        res["body"].append(l)
        if role is not None and l.startswith("- "):
            role["bullets"].append(l[2:])
    return res


def clean(s):
    s = re.sub(r"[*_`]+", "", s).replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s).strip().lower()


def role_key(r):
    return f"{clean(r['head'])} | {clean(r['dates'])}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cv", required=True)
    ap.add_argument("--base", help="базовое CV: без него роли не сверяются, а числа — только по карточкам")
    ap.add_argument("--roles-from", help="с чем сверять роли, если не с --base")
    ap.add_argument("--cards", default="knowledge-base/cards")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    cv = parse(Path(a.cv).read_text())
    cards = sorted(Path(a.cards).glob("*.md")) if Path(a.cards).is_dir() else []
    known = corpus(cards + ([Path(a.base)] if a.base else []))

    unknown = []
    for line in cv["body"]:
        for token, shown in number_tokens(re.sub(r"[*_`]+", "", line)):
            if token not in known and shown not in unknown:
                unknown.append(shown)

    roles = None
    if a.roles_from or a.base:
        base = parse(Path(a.roles_from or a.base).read_text())
        want, got = [role_key(r) for r in base["roles"]], [role_key(r) for r in cv["roles"]]
        missing = [k for k in want if k not in got]
        extra = [k for k in got if k not in want]
        order_ok = not missing and not extra and want == got
        lang_ok = clean(base["languages"]) == clean(cv["languages"])
        roles = {"pass": order_ok and lang_ok, "missing": missing, "extra": extra,
                 "order_ok": order_ok, "languages_ok": lang_ok}

    duties = []
    total = with_num = 0
    for r in cv["roles"]:
        found = []
        for b in r["bullets"]:
            total += 1
            has_num = bool(number_tokens(b))
            with_num += has_num
            if not has_num and DUTY.match(clean(b)):
                found.append(b)
        if len(found) > 1:
            duties.append({"role": r["head"], "bullets": found})

    text = " ".join(cv["body"])
    claims = sorted({m.group(0).lower() for m in CLAIMS.finditer(text)})
    voice = sorted(set(VOICE.findall(text)))
    res = {
        "pass": not unknown and (roles is None or roles["pass"]),
        "numbers": {"pass": not unknown, "unknown": unknown},
        "roles": roles,
        "style_ok": not duties and not claims and not voice,
        "duties": duties,
        "claims": claims,
        "voice": voice,
        "metric_share": round(with_num / total, 2) if total else None,
    }
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(f"evidence: {'PASS' if res['pass'] else 'FAIL'}  ·  подача: {'OK' if res['style_ok'] else 'WARN'}  ·  буллеты с числом: {res['metric_share']}")
        if unknown:
            print("  чисел нет в базе:", ", ".join(unknown))
        if roles and not roles["pass"]:
            print("  роли не как в базе:", json.dumps({k: v for k, v in roles.items() if k != "pass"}, ensure_ascii=False))
        for d in duties:
            print(f"  обязанности ({d['role']}): {len(d['bullets'])}")
        if claims:
            print("  пустые характеристики:", ", ".join(claims))
        if voice:
            print("  местоимения:", ", ".join(voice))


if __name__ == "__main__":
    main()
