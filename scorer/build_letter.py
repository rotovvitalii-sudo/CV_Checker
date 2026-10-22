#!/usr/bin/env python3
"""Файлы сопроводительного письма для отправки (C10): Cover Letter.md → .docx (стиль CV) → .pdf.

    .venv/bin/python scorer/build_letter.py --name "<Роль - Компания>" [--force] [--json]

Пересобирает, только если изменилось содержимое письма, шапки CV или сборщика (или --force). Шапка — из output/<…>/CV.md,
иначе knowledge-base/base-cv.md. PDF рендерит LibreOffice, страницы считает pypdf.
Результат: {"docx", "pdf", "pages", "rebuilt", "error"}.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / ".claude" / "skills" / "cover-letter" / "scripts" / "build_letter.js"


def pages_of(pdf):
    from pypdf import PdfReader
    return len(PdfReader(str(pdf)).pages)


def letter_file(out):
    """Как store.letterFile(): Cover Letter.md, иначе старое имя вроде «Message to Hiring Team.md»."""
    if (out / "Cover Letter.md").exists():
        return out / "Cover Letter.md"
    import re
    for f in sorted(out.glob("*.md")):
        if re.search(r"letter|message", f.name, re.I) and not re.search(r"trace|outline|summary", f.name, re.I):
            return f
    return None


def build(name, force=False):
    out = ROOT / "output" / name
    letter = letter_file(out)
    if not letter:
        return {"error": "письма нет — сначала собери его"}
    header = out / "CV.md" if (out / "CV.md").exists() else ROOT / "knowledge-base" / "base-cv.md"
    docx, pdf = out / "Cover Letter.docx", out / "Cover Letter.pdf"
    # Свежесть — по содержимому входов, а не по датам файлов (письмо могли вернуть из копии со старой датой)
    import hashlib
    src = hashlib.sha256(b"".join(f.read_bytes() for f in (letter, header, SCRIPT))).hexdigest()
    stamp = out / ".cover-letter.src"
    fresh = pdf.exists() and docx.exists() and stamp.exists() and stamp.read_text() == src
    if fresh and not force:
        return {"docx": str(docx.relative_to(ROOT)), "pdf": str(pdf.relative_to(ROOT)), "pages": pages_of(pdf), "rebuilt": False}
    r = subprocess.run(["node", str(SCRIPT), str(letter), str(header), str(docx)], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not docx.exists():
        return {"error": f"сборка docx не удалась: {(r.stderr or r.stdout).strip()[-300:]}"}
    soffice = shutil.which("soffice")
    if not soffice:
        return {"error": "LibreOffice (soffice) не найден — PDF не собрать", "docx": str(docx.relative_to(ROOT))}
    subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out), str(docx)], capture_output=True, text=True, timeout=180)
    if not pdf.exists() or pdf.stat().st_mtime < docx.stat().st_mtime:
        return {"error": "LibreOffice не создал PDF", "docx": str(docx.relative_to(ROOT))}
    stamp.write_text(src)
    return {"docx": str(docx.relative_to(ROOT)), "pdf": str(pdf.relative_to(ROOT)), "pages": pages_of(pdf), "rebuilt": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = build(a.name, a.force)
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(r.get("error") or f"{r['pdf']} · страниц {r['pages']}{' (пересобрано)' if r['rebuilt'] else ''}")
    sys.exit(1 if r.get("error") else 0)


if __name__ == "__main__":
    main()
