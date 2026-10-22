#!/usr/bin/env node
/**
 * build_docx.js — renders CV.md (constrained markdown) into an ATS-friendly one-column .docx.
 *
 * Usage: node build_docx.js <CV.md> <CV.docx>
 *
 * CV.md format:
 *   # NAME                         → name (first line)
 *   <line>                         → header lines before first "## " (tagline, contacts)
 *   ## Section                     → standard section heading (Career Profile, Experience, ...)
 *   ### Company — Title            → job header (bold)
 *   <line right after ###>         → meta line (dates · location), rendered italic
 *   _text_                         → italic paragraph (company one-liner)
 *   - bullet                       → bullet; supports **bold** inline
 *   plain line                     → paragraph; supports **bold** inline
 *
 * No tables, no images, no text boxes, no columns — by design (ATS).
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  LevelFormat, BorderStyle, convertInchesToTwip,
} = require("docx");

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node build_docx.js <CV.md> <CV.docx>");
  process.exit(1);
}

const FONT = "Arial";
const SIZE = 20;        // half-points → 10pt
const SIZE_SMALL = 18;  // 9pt
const SIZE_NAME = 32;   // 16pt
const SIZE_H = 22;      // 11pt

// "**bold** normal" → TextRuns
function runs(text, base = {}) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) => {
    const bold = p.startsWith("**") && p.endsWith("**");
    return new TextRun({ text: bold ? p.slice(2, -2) : p, bold: bold || base.bold, italics: base.italics, font: FONT, size: base.size || SIZE, color: base.color });
  });
}

const lines = fs.readFileSync(inPath, "utf8").split(/\r?\n/);
const children = [];
let seenSection = false;
let prevWasJobHeader = false;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const line = raw.trim();
  if (!line) { prevWasJobHeader = false; continue; }

  if (line.startsWith("# ")) {
    children.push(new Paragraph({
      children: [new TextRun({ text: line.slice(2), bold: true, font: FONT, size: SIZE_NAME })],
      spacing: { after: 40 },
    }));
    continue;
  }

  if (line.startsWith("## ")) {
    seenSection = true;
    prevWasJobHeader = false;
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: line.slice(3), bold: true, font: FONT, size: SIZE_H, color: "000000" })],
      spacing: { before: 120, after: 40 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } },
    }));
    continue;
  }

  if (line.startsWith("### ")) {
    prevWasJobHeader = true;
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: line.slice(4), bold: true, font: FONT, size: SIZE, color: "000000" })],
      spacing: { before: 100, after: 0 },
    }));
    continue;
  }

  if (line.startsWith("- ")) {
    prevWasJobHeader = false;
    children.push(new Paragraph({
      children: runs(line.slice(2)),
      numbering: { reference: "bullets", level: 0 },
      spacing: { after: 10 },
    }));
    continue;
  }

  if (prevWasJobHeader) {
    // meta line: dates · location
    prevWasJobHeader = false;
    children.push(new Paragraph({
      children: runs(line, { italics: true, size: SIZE_SMALL, color: "444444" }),
      spacing: { after: 20 },
    }));
    continue;
  }

  if (line.startsWith("_") && line.endsWith("_")) {
    children.push(new Paragraph({
      children: runs(line.slice(1, -1), { italics: true, size: SIZE_SMALL, color: "444444" }),
      spacing: { after: 20 },
    }));
    continue;
  }

  // header lines (before first section) vs body paragraphs
  if (!seenSection) {
    children.push(new Paragraph({
      children: runs(line, { size: SIZE_SMALL }),
      spacing: { after: 20 },
    }));
  } else {
    children.push(new Paragraph({ children: runs(line), spacing: { after: 40 } }));
  }
}

const doc = new Document({
  creator: "CV Checker",
  styles: {
    default: { document: { run: { font: FONT, size: SIZE } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: SIZE_H, bold: true, color: "000000" } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: SIZE, bold: true, color: "000000" } },
    ],
  },
  numbering: {
    config: [{
      reference: "bullets",
      levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: convertInchesToTwip(0.2), hanging: convertInchesToTwip(0.15) } } } }],
    }],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: convertInchesToTwip(0.5), bottom: convertInchesToTwip(0.5), left: convertInchesToTwip(0.55), right: convertInchesToTwip(0.55) },
      },
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  console.log(`written ${outPath} (${buf.length} bytes, ${children.length} paragraphs)`);
});
