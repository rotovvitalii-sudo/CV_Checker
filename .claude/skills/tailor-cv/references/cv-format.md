# Формат CV.md

Единственный источник правды для CV. `build_docx.js` парсит ровно эти конструкции — ничего другого
не используй (нет таблиц, картинок, HTML, вложенных списков).

```markdown
# ALEX MORGAN
Product Lead | Founder Experience | 0→1 | EdTech SaaS | Education-Led Acquisition
Country | Open to Hybrid & Remote | +00 000 000 000 | alex.morgan@example.com | linkedin.com/in/example

## Career Profile
Три–четыре предложения одним абзацем. Первым — то, что ищет вакансия.

## Career Highlights
- Buллет с цифрой
- Буллет с цифрой
- Буллет с цифрой

## Experience
### Northwind Learning (EU) — Product Lead
January 2023 – Present · Full Time, Remote
_Subscription-based EdTech platform for finance education_
- Буллет; поддерживается **жирный** внутри
- Буллет

### Brightpath (UAE) — Senior Product Marketing Manager
April 2022 – December 2022 · Full Time, Remote
- Буллет

## Founder Experience
- **Studio One (2017–2021)** — текст
- **VR Labs (2019–2021)** — текст

## Education
- State University — Master's in Management, 2010
- Startup Accelerator Program, 2022

## Skills
Product strategy · Subscription monetization · Pricing & packaging · ...

## Languages
English (C1), Spanish (Native)
```

Правила парсера:
- `# ` — имя, ровно одно, первой строкой.
- Строки между именем и первым `## ` — шапка (tagline, контакты), рендерятся мелким шрифтом.
- `## ` — заголовок секции (Heading 1). Используй стандартные названия: Career Profile,
  Career Highlights, Experience, Founder Experience, Education, Skills, Languages.
- `### ` — заголовок места работы. **Следующая непустая строка** — мета (даты · формат), курсив.
- `_..._` — курсивный абзац (описание компании), опционально.
- `- ` — буллет. `**...**` — жирный фрагмент внутри буллета или абзаца.
- Пустые строки игнорируются, но оставляй их для читаемости.

Длина: одна страница A4 по факту рендера в PDF (`check_cv.py` → LibreOffice), с запасом ≥ 12 мм снизу.
Ориентир — 560–600 слов (мастер-CV — 560, Arial 10pt). Избегай буллетов, переносящих 1–2 слова на
новую строку: при ширине текста ~7.2" в строку Arial 10pt помещается ~100 символов.
Не используй символ `→` в шапке — в некоторых рендерах он подменяется; пиши `0-to-1`.
