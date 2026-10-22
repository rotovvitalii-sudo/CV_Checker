#!/usr/bin/env python3
"""
check_diff.py — how far a tailored CV drifted from the base (master) CV.

Rule: a tailored CV may change at most 30% of the master CV's text (raised from 20% on 2026-10-16).
Adaptation is targeted (tagline, profile, highlights, several bullets, Skills), not a rewrite.

--title "<role from the vacancy>": the tagline (first line under the name) must START with the exact
vacancy title. Gender markers like "(all genders)", "(m/f/d)" are dropped; "→" becomes "0-to-1"-style
"-to-" because the header renderer can't show arrows. Reported as tagline_ok / expected_title.

Metric: word-level edit distance via difflib on normalized tokens (markdown stripped, lowercased).
  changed = 1 - SequenceMatcher(base_tokens, cv_tokens).ratio()
Also prints per-section change so you can see where the drift is.

Usage:
  check_diff.py --base knowledge-base/base-cv.md --cv output/<...>/CV.md [--max 0.3] [--title "<role>"] [--json]
"""
import argparse, difflib, json, re
from pathlib import Path

MD_STRIP = re.compile(r"[*_#`>]+")


def tokens(text: str):
    text = MD_STRIP.sub(" ", text)
    return [t for t in re.split(r"[^\w$%+&/'.-]+", text.lower()) if t]


def sections(md: str):
    """Split CV.md into {section_name: text} by '## ' headings; header block → 'Header'."""
    out, name, buf = {}, "Header", []
    for line in md.splitlines():
        if line.startswith("## "):
            out[name] = "\n".join(buf); name, buf = line[3:].strip(), []
        else:
            buf.append(line)
    out[name] = "\n".join(buf)
    return out


def change(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta and not tb:
        return 0.0
    return round(1 - difflib.SequenceMatcher(a=ta, b=tb, autojunk=False).ratio(), 3)


GENDER = re.compile(r"\s*\((?:all genders|m/f/d|f/m/d|m/w/d|w/m/d|f/m/x|m/f/x|m/f|f/m|h/f|k/m|m/k|f/m/div)\)", re.I)


def expected_title(role):
    """Title as written in the vacancy, minus gender markers; arrows are not renderable in the header."""
    t = GENDER.sub("", role).strip()
    t = re.sub(r"\s*→\s*", "-to-", t)
    return re.sub(r"\s+", " ", t)


def norm_title(s):
    return re.sub(r"[\s\u2013\u2014-]+", " ", s.lower()).strip()


def tagline(md):
    """First non-empty line after the '# NAME' heading."""
    lines = md.splitlines()
    for i, l in enumerate(lines):
        if l.startswith("# "):
            return next((x.strip() for x in lines[i + 1:] if x.strip()), "")
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--cv", required=True)
    ap.add_argument("--max", type=float, default=0.3)
    ap.add_argument("--title", default="", help="vacancy role: the tagline must start with it")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    base, cv = Path(a.base).read_text(), Path(a.cv).read_text()
    total = change(base, cv)
    bs, cs = sections(base), sections(cv)
    per = {}
    for name in list(bs) + [n for n in cs if n not in bs]:
        per[name] = {"change": change(bs.get(name, ""), cs.get(name, "")),
                     "base_words": len(tokens(bs.get(name, ""))),
                     "cv_words": len(tokens(cs.get(name, "")))}
    res = {"change": total, "max": a.max, "pass": total <= a.max, "sections": per}
    if a.title:
        want = expected_title(a.title)
        line = tagline(cv)
        res.update({"expected_title": want, "tagline": line,
                    "tagline_ok": norm_title(line).startswith(norm_title(want))})
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(f"change={total*100:.0f}% max={a.max*100:.0f}% → {'PASS' if res['pass'] else 'FAIL'}")
        if a.title:
            print(f"tagline: {'OK' if res['tagline_ok'] else 'FAIL'} — должна начинаться с «{res['expected_title']}»; сейчас: «{res['tagline']}»")
        for n, s in per.items():
            print(f"  {n:<20} {s['change']*100:5.0f}%   ({s['base_words']}→{s['cv_words']} words)")


if __name__ == "__main__":
    main()
