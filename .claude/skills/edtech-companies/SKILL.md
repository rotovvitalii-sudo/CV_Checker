---
name: edtech-companies
description: >-
  Расширяет базу компаний для отраслевых разделов ленты вакансий: «EdTech» (job-search/edtech/companies.json)
  и «FinTech» — брокеры, трейдинг, крипто (job-search/fintech/companies.json); отрасль — `--sector`.
  Для компаний без автосбора находит настоящую страницу карьеры и систему найма (Greenhouse, Lever,
  Ashby, Workable, SmartRecruiters, Recruitee, Personio) с токеном; находит новые EdTech-компании мира
  по сегментам и регионам. В базу пишет только через job-search/edtech.py add — скрипт проверяет, что
  API отвечает и доска принадлежит этой компании. Use when the candidate says «расширь базу EdTech»,
  «найди EdTech-компании», «добавь компанию в EdTech», «расширь базу FinTech», «добавь брокера / биржу»,
  or when the app runs «Найти новые компании».
argument-hint: "[сколько компаний] [сегмент или регион]"
allowed-tools: Read, Glob, Grep, WebFetch, WebSearch, Bash(.venv/bin/python:*)
---

# База компаний отраслевых разделов (EdTech, FinTech)

**Отрасль задаётся в задаче** (`edtech` или `fintech`) и передаётся во **все** команды скрипта:
`.venv/bin/python job-search/edtech.py --sector <отрасль> list|add …`. Без `--sector` скрипт работает с EdTech.

Зачем: раздел «EdTech» каждый день бесплатно опрашивает открытые API систем найма компаний из базы.
Чем больше компаний с рабочим API, тем полнее раздел. Ты не собираешь вакансии — ты находишь, **где**
компания публикует вакансии.

## Жёсткие правила

1. **Не редактируй `job-search/edtech/companies.json` руками.** Добавление и обновление — только
   `.venv/bin/python job-search/edtech.py add …`. Скрипт сам пробует токены, проверяет ответ API и
   то, что доска принадлежит этой компании (название доски или тема обучения в описаниях вакансий).
   Ответ `"added": true` со `status: "no_api"` — это нормально: компания в базе, но без автосбора.
2. **Только своя отрасль:**
   - **EdTech** — основной продукт — обучение: consumer-приложения, языки, K-12, higher-ed, платформы
     курсов и LMS, corporate learning, буткемпы, репетиторство, финансовое образование.
   - **FinTech** — сегменты «Брокеры и трейдинг» (CFD/forex, инвест-платформы, трейдинг-приложения) и
     «Крипто» (биржи, кошельки, Web3-инфраструктура). Необанки, платежи, кредиты, страхование — не берём.
3. **Без российских и китайских компаний** (санкции и недоступный рынок).
4. **Лимит за запуск** — столько компаний, сколько сказано в задаче (по умолчанию 30). Лучше 30
   проверенных, чем 100 угаданных.

## Процесс

### A. Компании без автосбора (`status: "no_api"`)
Список: `.venv/bin/python job-search/edtech.py --sector <отрасль> list --json` → компании со `status` ≠ `ok`.
Для каждой (в пределах лимита):
1. Найди страницу карьеры: `careers_url` из базы, иначе `WebSearch` «<компания> careers» и `WebFetch` сайта.
2. Найди на странице ссылки на систему найма — по ним видно систему и токен:
   - `boards.greenhouse.io/<token>`, `job-boards.greenhouse.io/<token>`, `?gh_jid=` → greenhouse
   - `jobs.lever.co/<token>` → lever · `jobs.ashbyhq.com/<token>` → ashby
   - `apply.workable.com/<token>` → workable · `jobs.smartrecruiters.com/<Token>` → smartrecruiters
   - `<token>.recruitee.com` → recruitee · `<token>.jobs.personio.de` / `.com` → personio
3. Запусти: `.venv/bin/python job-search/edtech.py --sector <отрасль> add --name "<как в базе>" --slugs <token> --careers-url <url>`
4. Workday (`myworkdayjobs.com`), iCIMS, Taleo, SuccessFactors, BambooHR, Teamtailor, свой сайт — API нет.
   Всё равно запусти `add --name … --careers-url <url>`, чтобы в базе осталась ссылка «проверь вручную».

### B. Новые компании
Если лимит не исчерпан — найди новые EdTech-компании, которых нет в базе (проверь по `list --json`).
Ищи по сегментам и регионам, где база тоньше: LatAm, Европа (DACH, Nordics, CEE, Iberia), Индия и
Юго-Восточная Азия, финансовое образование. Для каждой — шаги A.1–A.4 и
`add --name … --country <код> --segment <сегмент> --slugs … --careers-url …`.
Сегменты EdTech: `Consumer`, `Языки`, `K-12`, `Higher-ed`, `Курсы и LMS`, `Corporate learning`,
`Буткемпы`, `Репетиторство`, `Финобразование`. Сегменты FinTech: `Брокеры и трейдинг`, `Крипто`.
Для FinTech ищи там, где база тоньше: брокеры ЕС и CEE, LatAm-крипто, брокеры с образовательными
академиями (это сильнейший фит кандидата).

### C. Итог (по-русски, коротко)
Сколько компаний обработано, у скольких заработал автосбор, сколько на Workday или своих сайтах,
сколько новых добавлено. Итоговую сводку возьми из `edtech.py list`.
