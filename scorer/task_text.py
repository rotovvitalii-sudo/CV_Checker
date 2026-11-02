#!/usr/bin/env python3
"""
task_text.py — текст файлов тестового задания для плана (C14), без интерпретации.

PDF и DOCX — текстом (как cv_text.py), CSV — заголовок и первые строки, XLSX — листы, заголовки и первые строки
(читается прямо из XML внутри файла, openpyxl не нужен), MD / TXT — как есть. Каждый файл обрезается до --max символов.

Usage:
  task_text.py --dir test-tasks/<slug>/brief [--max 6000] --json
"""
import argparse, csv, json, re, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from cv_text import pdf_text, docx_text

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def csv_text(p: Path, rows=6) -> str:
    with p.open(newline="", encoding="utf-8", errors="replace") as f:
        out = [" | ".join(r) for _, r in zip(range(rows), csv.reader(f))]
    n = sum(1 for _ in p.open(encoding="utf-8", errors="replace"))
    return "\n".join(out) + f"\n… строк всего: {n}"


def xlsx_text(p: Path, rows=6) -> str:
    z = zipfile.ZipFile(p)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    out = []
    for sh in wb.findall("m:sheets/m:sheet", NS):
        t = target.get(sh.get(RNS), "")
        name = "xl/" + t.lstrip("/").removeprefix("xl/")
        if name not in z.namelist():
            continue
        data = ET.fromstring(z.read(name)).findall("m:sheetData/m:row", NS)
        lines = []
        for row in data[:rows]:
            cells = []
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                val = v.text if v is not None else "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                if c.get("t") == "s" and val is not None and val.isdigit():
                    val = shared[int(val)] if int(val) < len(shared) else val
                cells.append(val or "")
            lines.append(" | ".join(cells))
        out.append(f"## Лист «{sh.get('name')}» · строк {len(data)}\n" + "\n".join(lines))
    return "\n\n".join(out)


def one(p: Path) -> str:
    ext = p.suffix.lower()
    if ext == ".pdf":
        return pdf_text(p)
    if ext == ".docx":
        return docx_text(p)
    if ext in (".csv", ".tsv"):
        return csv_text(p)
    if ext in (".xlsx", ".xlsm"):
        return xlsx_text(p)
    if ext in (".md", ".txt", ".json"):
        return p.read_text(encoding="utf-8", errors="replace")
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--max", type=int, default=6000)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    files = []
    for p in sorted(Path(a.dir).glob("*")):
        if not p.is_file() or p.name.startswith((".", "_")):
            continue
        try:
            t = re.sub(r"\n{3,}", "\n\n", one(p)).strip()
            files.append({"name": p.name, "chars": len(t), "text": t[: a.max], "truncated": len(t) > a.max})
        except Exception as e:  # битый файл не ломает план — просто без текста
            files.append({"name": p.name, "chars": 0, "text": "", "error": str(e)[:200]})
    print(json.dumps({"ok": True, "files": files}, ensure_ascii=False))


if __name__ == "__main__":
    main()
