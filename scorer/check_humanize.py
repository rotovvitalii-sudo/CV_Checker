#!/usr/bin/env python3
"""
check_humanize.py — flags machine-sounding patterns in English text (CV bullets, cover letters).

Not an "AI detector" — it is a checklist of tells that make writing read as generated:
LLM-favourite vocabulary, cover-letter boilerplate, punctuation habits, and low burstiness
(all sentences the same length, which is the strongest structural tell).

Usage:
  check_humanize.py --file "output/<...>/Cover Letter.md" [--max-score 3] [--json]

Exit code is always 0; read the score.
"""
import argparse, json, re, statistics, sys
from pathlib import Path

# (label, regex, weight, hint)
PATTERNS = [
    ("llm-vocabulary", r"\b(delve|leverage|robust|seamless|tapestry|realm|testament|underscore[sd]?|"
                       r"pivotal|meticulous|holistic|synergy|myriad|plethora|paramount|nuanced|"
                       r"unlock(?:ing)?|elevat(?:e|ing)|empower(?:ing)?|foster(?:ing)?|harness(?:ing)?|"
                       r"spearhead(?:ed|ing)?|navigat(?:e|ing) the|embark)\b", 2,
         "заменить на обычное слово"),
    ("connector-stack", r"(?im)^\s*(moreover|furthermore|additionally|notably|indeed|ultimately|"
                        r"overall|in conclusion|that said)\b", 2,
         "убрать связку в начале предложения"),
    ("cover-letter-boilerplate", r"(?i)\b(i am writing to|i am excited to|i'm excited to|thrilled to|"
                                 r"passionate about|proven track record|results-driven|"
                                 r"i believe i would be a (great|perfect) fit|"
                                 r"commitment to excellence|perfectly aligns?|strong fit for)\b", 3,
         "шаблон сопроводительного письма — выбросить"),
    ("not-just-but", r"(?i)\bnot (just|only) [^.;]{3,40}\b but\b", 2, "конструкция «not just X but Y»"),
    ("whether-its", r"(?i)\bwhether it'?s\b", 2, "конструкция «whether it's … or …»"),
    ("worth-noting", r"(?i)\b(it'?s worth noting|it is important to note|plays? a (crucial|key|vital) role)\b", 3,
         "вводная пустышка"),
    ("buzz-adjective", r"(?i)\b(cutting-edge|state-of-the-art|game-?chang(er|ing)|ever-evolving|"
                       r"fast-paced world|in today'?s [a-z-]+ (world|landscape|market))\b", 3,
         "штамп"),
    ("journey-resonate", r"(?i)\b(journey|resonate[sd]?|dive deep|deep dive|align(?:s|ed)? with my (values|passion))\b", 2,
         "лексика мотивационных текстов"),
    ("em-dash-heavy", r"—", 0, "тире: считается отдельно, см. em_dashes"),
]

TRICOLON = re.compile(r"\b\w+, \w+,? and \w+\b")


def sentences(text: str):
    text = re.sub(r"\s+", " ", text)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--max-score", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    raw = Path(a.file).read_text()
    body = "\n".join(l for l in raw.splitlines() if not l.lower().startswith("subject:"))
    sents = sentences(body)
    words = body.split()

    hits, score = [], 0
    for label, pat, weight, hint in PATTERNS:
        for m in re.finditer(pat, body):
            if weight == 0:
                continue
            hits.append({"type": label, "match": m.group(0).strip(), "hint": hint, "weight": weight})
            score += weight

    # punctuation habits
    em = body.count("—")
    em_per_100w = em / max(len(words), 1) * 100
    if em_per_100w > 1.5:
        hits.append({"type": "em-dash-heavy", "match": f"{em} em dashes ({em_per_100w:.1f}/100 words)",
                     "hint": "оставить 1, остальные → запятая, двоеточие или точка", "weight": 2})
        score += 2

    tri = len(TRICOLON.findall(body))
    if tri >= 3:
        hits.append({"type": "tricolon", "match": f"{tri} перечислений «X, Y and Z»",
                     "hint": "разбить или сократить одно из них", "weight": 2})
        score += 2

    # burstiness: human writing mixes short and long sentences
    lens = [len(s.split()) for s in sents]
    stdev = statistics.pstdev(lens) if len(lens) > 1 else 0
    mean = statistics.mean(lens) if lens else 0
    low_burstiness = len(lens) >= 4 and stdev < 5
    if low_burstiness:
        hits.append({"type": "low-burstiness", "match": f"длины предложений {lens} (σ={stdev:.1f})",
                     "hint": "добавить одно короткое предложение (3–6 слов)", "weight": 2})
        score += 2

    res = {"file": a.file, "sentences": len(sents), "words": len(words),
           "sentence_lengths": lens, "mean_len": round(mean, 1), "stdev_len": round(stdev, 1),
           "em_dashes": em, "score": score, "max_score": a.max_score,
           "pass": score <= a.max_score, "hits": hits}

    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(f"score={score} (max {a.max_score}) → {'PASS' if res['pass'] else 'FAIL'} · "
              f"{len(sents)} sentences, σ={stdev:.1f}, em-dashes={em}")
        for h in hits:
            print(f"  [{h['type']}] {h['match']}  → {h['hint']}")
    sys.exit(0)


if __name__ == "__main__":
    main()
