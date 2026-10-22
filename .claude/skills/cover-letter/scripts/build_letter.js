#!/usr/bin/env node
/**
 * build_letter.js — renders Cover Letter.md into a one-page .docx in the same style as the CV (C10).
 *
 * Usage: node build_letter.js <Cover Letter.md> <CV.md|base-cv.md> <out.docx> ["16 October 2026"]
 *
 * Header = name ("# NAME") and the contacts line (the header line with an e-mail) from the CV —
 * the tagline is not repeated. Then the date, then the letter: paragraphs separated by blank lines,
 * single line breaks kept (sign-off "Best regards,\nAlex Morgan"). A leading "Subject: …" line is
 * for e-mail only and is dropped. Arial, A4, no tables or images.
 */
const fs = require("fs");
const { Document, Packer, Paragraph, TextRun, BorderStyle, convertInchesToTwip } = require("docx");

const [, , letterPath, headerPath, outPath, dateArg] = process.argv;
if (!letterPath || !headerPath || !outPath) {
  console.error('Usage: node build_letter.js <Cover Letter.md> <CV.md> <out.docx> ["date"]');
  process.exit(1);
}

const FONT = "Arial";
const SIZE = 22;        // 11pt — письмо короткое, читается крупнее CV
const SIZE_SMALL = 18;  // 9pt — контакты, как в CV
const SIZE_NAME = 32;   // 16pt — имя, как в CV

const strip = (s) => s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");

// Шапка из CV: имя и строка контактов
const headerLines = fs.readFileSync(headerPath, "utf8").split(/\r?\n/);
const nameLine = headerLines.find((l) => l.startsWith("# ")) || "# ";
const firstSection = headerLines.findIndex((l) => l.startsWith("## "));
const head = headerLines.slice(0, firstSection === -1 ? headerLines.length : firstSection);
const contacts = head.find((l) => /@/.test(l)) || "";

// Письмо: без строки Subject и без markdown-заголовков
let text = fs.readFileSync(letterPath, "utf8").replace(/^﻿/, "");
text = text.replace(/^\s*subject:.*\n+/i, "").replace(/^#+\s.*\n+/gm, "").trim();
const paragraphs = text.split(/\n\s*\n/).map((p) => p.split("\n").map((l) => strip(l.trim())).filter(Boolean)).filter((p) => p.length);

const date = dateArg || new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const children = [
  new Paragraph({ children: [new TextRun({ text: nameLine.slice(2).trim(), bold: true, font: FONT, size: SIZE_NAME })], spacing: { after: 40 } }),
];
if (contacts) {
  children.push(new Paragraph({
    children: [new TextRun({ text: strip(contacts.trim()), font: FONT, size: SIZE_SMALL })],
    spacing: { after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 4 } },
  }));
}
children.push(new Paragraph({ children: [new TextRun({ text: date, font: FONT, size: SIZE_SMALL, color: "444444" })], spacing: { before: 200, after: 280 } }));

for (const p of paragraphs) {
  children.push(new Paragraph({
    children: p.flatMap((l, i) => [...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ text: l, font: FONT, size: SIZE })]),
    spacing: { after: 200, line: 288 },
  }));
}

const doc = new Document({
  creator: "CV Checker",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: convertInchesToTwip(0.7), bottom: convertInchesToTwip(0.7), left: convertInchesToTwip(0.85), right: convertInchesToTwip(0.85) },
      },
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outPath, buf);
  console.log(`ok: ${outPath} (${paragraphs.length} paragraphs)`);
});
