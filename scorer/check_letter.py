#!/usr/bin/env python3
"""
check_letter.py — enforces the "80% my own words" rule for cover letters.

Input: a trace file where every sentence of the final English letter is on its own line,
prefixed with a tag:
    [D] ...   sentence translated/condensed from the candidate's dictation (their thought, their phrasing)
    [A] ...   sentence added by the skill (fact from CV / knowledge base, connective sentence)
Lines without a tag (headings, blank, comments starting with #) are ignored.

Usage:
  check_letter.py --trace 04-cover-letter-trace.md [--min 0.8] [--json]

Prints share of dictated words and PASS/FAIL.
"""
import argparse, json, re, sys
from pathlib import Path

TAG = re.compile(r"^\[(D|A)\]\s*(.*)$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trace", required=True)
    ap.add_argument("--min", type=float, default=0.8)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    d_words = a_words = 0
    d_sent = a_sent = 0
    for line in Path(a.trace).read_text().splitlines():
        m = TAG.match(line.strip())
        if not m:
            continue
        n = len(m.group(2).split())
        if m.group(1) == "D":
            d_words += n; d_sent += 1
        else:
            a_words += n; a_sent += 1

    total = d_words + a_words
    share = d_words / total if total else 0.0
    ok = share >= a.min and total > 0
    res = {"dictated_words": d_words, "added_words": a_words, "total_words": total,
           "dictated_sentences": d_sent, "added_sentences": a_sent,
           "dictated_share": round(share, 3), "min": a.min, "pass": ok}
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(f"dictated={d_words}w ({d_sent} sent) added={a_words}w ({a_sent} sent) "
              f"share={share*100:.0f}% min={a.min*100:.0f}% → {'PASS' if ok else 'FAIL'}")
    sys.exit(0)


if __name__ == "__main__":
    main()
