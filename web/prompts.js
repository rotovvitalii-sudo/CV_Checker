// Промпты для фоновых запусков агента. Вся логика — в скилах проекта; здесь только входы и выходы.
const BACKGROUND = `Ты запущен в фоне из веб-приложения CV Checker. Кандидата рядом нет: вопросы не задавай,
AskUserQuestion недоступен. Если чего-то не хватает — действуй консервативно и запиши вопрос туда,
куда сказано ниже. Не выдумывай фактов. Ответ в чат в конце — одна-две строки по-русски.`;

function fit({ id, text, url, existing }) {
  const src = existing
    ? `Текст вакансии: файл \`vacancies/${existing}.md\`.`
    : text
      ? `Текст вакансии: файл \`web/data/inbox/${id}.txt\`.`
      : `Ссылка на вакансию: ${url}
Открой её через WebFetch. Если страница требует логина, недоступна или полного текста вакансии на ней
нет — запиши в \`web/data/inbox/${id}.result.json\` ровно {"status":"needs_text","reason":"<коротко почему>"}
и закончи работу.`;
  const save = existing
    ? `.venv/bin/python scorer/score_job.py add --no-save --result web/data/inbox/${id}.result.json web/data/inbox/${id}.job.json
(Файл вакансии уже есть — новый в vacancies/ не создавай.)`
    : `.venv/bin/python scorer/score_job.py add --save-always --result web/data/inbox/${id}.result.json web/data/inbox/${id}.job.json
Это ручная загрузка: вакансия сохраняется в vacancies/ при любом балле.`;
  const vacName = existing ? existing : '<имя файла вакансии из поля vacancy_file в result.json, без .md>';
  return `${BACKGROUND}

Задача: оценить фит одной вакансии по скилу job-scout (\`.claude/skills/job-scout/SKILL.md\`, режим A).
Перед скорингом прочитай \`job-fit-search-brief.md\` и профиль поиска \`knowledge-base/profile.json\`
(офисные локации, релокация, форматы, языки, минимальная зарплата) — по нему ставь балл «логистика».
Сверься с базой кейсов (\`knowledge-base/cards/INDEX.md\` и подходящие карточки): \`anchor_card\` — id карточки,
\`gaps\` — требования, которых нет в карточках.

${src}

Извлечение по схеме вместе с баллами сохрани в \`web/data/inbox/${id}.job.json\` (полный текст
вакансии — в поле raw_text${url ? `, ссылку — в url` : ''}). Для карточки «коротко» обязательно заполни:
- \`what_you_do\` — 3–5 главных обязанностей из текста вакансии, короткими фразами на языке вакансии,
  без пересказа требований к кандидату;
- \`date_posted\` — дата публикации в формате YYYY-MM-DD, только если она есть в тексте или на странице; иначе "".
Затем запусти:
${save}

${KEYWORDS_STEP(vacName, true)}`;
}

// Шаг 1 tailor-cv отдельно: требования и ключевые слова нужны для матча вакансии с Master CV
function KEYWORDS_STEP(name, skipIfExists) {
  return `Последний шаг — шаг 1 скила tailor-cv (\`.claude/skills/tailor-cv/SKILL.md\`, раздел «Шаг 1»)
для этой вакансии: создай \`output/${name}/01-requirements.md\` и \`output/${name}/01-keywords.json\`.
Только шаг 1 — CV не собирай, карточки не подбирай.${skipIfExists ? ' Если оба файла уже существуют — пропусти.' : ''}`;
}

function keywords({ name }) {
  return `${BACKGROUND}

Вакансия: \`vacancies/${name}.md\`.
${KEYWORDS_STEP(name, false)}`;
}

function tailor({ name }) {
  return `${BACKGROUND}

Задача: выполни скил tailor-cv (\`.claude/skills/tailor-cv/SKILL.md\`) целиком для \`vacancies/${name}.md\`.
Если \`output/${name}/01-requirements.md\` и \`01-keywords.json\` уже существуют — шаг 1 не переделывай,
используй их (по этим ключам считается матч вакансии с Master CV, он не должен скакать).
Папка результата — строго \`output/${name}/\` (имя совпадает с именем файла вакансии без .md).
Шапка CV — правило 3b скила: точное название роли из поля role: вакансии, проверка \`check_diff.py --title\`.
Пробелы, риски и вопросы к кандидату — в report.md, не в чат.

В самом конце запиши \`output/${name}/summary.json\`:
{"recruiter_score": <1-5>, "verdict": "yes|no|maybe", "main_reason": "одна главная причина по-русски (пусто, если yes)",
 "reason_tag": "domain|seniority|missing-skill:<навык>|top-third|location|language|role-type|other", "top_gaps": ["до 5 главных пробелов по-русски"], "iterations": <N>,
 "ready": <true, если все условия готовности выполнены>, "cards_used": ["<id карточек knowledge-base/cards/, на которых стоят буллеты CV>"],
 "note": "одна фраза по-русски"}`;
}

function letter({ name }) {
  return `${BACKGROUND}

Задача: выполни скил cover-letter (\`.claude/skills/cover-letter/SKILL.md\`) для «${name}».
- Вакансия: \`vacancies/${name}.md\`
- CV: \`output/${name}/CV.md\`, отчёт: \`output/${name}/report.md\`
- Надиктовка: \`output/${name}/00-dictation.md\` (на шаге 1 сохрани её копию в knowledge-base/raw/ как требует скил)

Если есть \`output/${name}/04-letter-outline.json\` — это структура, по которой кандидат надиктовывал: используй её
только как подсказку о порядке блоков. Слова письма — из надиктовки; подсказки и факты структуры словами
кандидата не считаются (в трассировке это \`[A]\`, как любой текст не из надиктовки).

Шаг 3 (вопросы) пропусти: неясные места переводи максимально близко к тексту. Вопросы и список
сокращённого запиши в конец \`04-cover-letter-trace.md\` в раздел «Вопросы к кандидату».
Humanizer (шаг 5b) обязателен. Итоговое письмо — строго \`output/${name}/Cover Letter.md\`.

В самом конце запиши \`output/${name}/letter-summary.json\`:
{"questions": ["вопросы к кандидату"], "removed": ["что сократил из надиктовки"], "cards_used": ["<id карточек>"],
 "card_suggestions": [шаг 6b скила: факты из надиктовки, которых нет в базе], "note": "одна фраза по-русски"}`;
}

// C8: письмо без надиктовки — факты только из базы со ссылками, голос по прошлым надиктовкам
// C8 P1 · голосовой профиль: один прогон по всем надиктовкам → knowledge-base/voice.md
function voiceProfile({ files }) {
  return `${BACKGROUND}

Задача: скил voice-profile (\`.claude/skills/voice-profile/SKILL.md\`). Прочитай все надиктовки (${files.length}):
${files.map((f) => `- \`knowledge-base/raw/${f}\``).join('\n')}
Результат — строго \`knowledge-base/voice.md\` по формату скила; в \`sources\` перечисли все эти файлы.
Фактов об опыте (компании, цифры) в профиле нет — только манера. Вопросы не задавай.`;
}

function letterGenerate({ name, hasOutline, hasVoice }) {
  return `${BACKGROUND}

Задача: выполни скил cover-letter-generate (\`.claude/skills/cover-letter-generate/SKILL.md\`) для «${name}».
- Вакансия: \`vacancies/${name}.md\`
- CV: \`output/${name}/CV.md\`, отчёты: \`output/${name}/02-match-report.md\`, \`report.md\`
- Структура: ${hasOutline ? `\`output/${name}/04-letter-outline.json\`` : `её ещё нет — сначала выполни скил letter-outline и сохрани \`output/${name}/04-letter-outline.json\``}

${hasVoice ? 'Голос — по профилю `knowledge-base/voice.md` (правило 3 скила): надиктовки из `knowledge-base/raw/` ради голоса не читай.\n' : ''}Надиктовки к этому письму нет и не будет — вопросы не задавай; что стоит проверить глазами, запиши в
\`letter-summary.json\` → questions. Humanizer обязателен. Итоговое письмо — строго \`output/${name}/Cover Letter.md\`,
трассировка — \`output/${name}/04-generated-trace.json\`; \`scorer/check_generated.py --name "${name}"\` должен дать pass: true.
В \`letter-summary.json\` обязательно "mode": "generated".`;
}

// W5: подготовка к собеседованию и тренажёр
function interviewPrep({ name, hasCV }) {
  return `${BACKGROUND}

Задача: скил interview-prep (\`.claude/skills/interview-prep/SKILL.md\`), режим «подготовка», для «${name}».
- Вакансия: \`vacancies/${name}.md\`; CV: ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md`'}
- Пробелы: \`output/${name}/02-match-report.md\`, \`report.md\`, \`summary.json\` / \`03-verdict.json\` (вердикт), если есть
- Карточки: \`knowledge-base/cards/INDEX.md\` и нужные карточки
- Банк историй: \`knowledge-base/stories.json\`, если есть — бери оттуда подходящие истории (ту же карточку и тему), уточняя «fits» под эту вакансию
Результат — строго \`output/${name}/07-interview.json\` по схеме скила.`;
}

// Тренажёр: маленький контекст (без чтения базы) — дёшево на каждую попытку
function practice({ name, question, answer, out }) {
  return `${BACKGROUND}

Задача: скил interview-prep (\`.claude/skills/interview-prep/SKILL.md\`), режим «тренажёр». Базу знаний не читай.
Вакансия (для контекста роли): \`vacancies/${name}.md\` — только первые 60 строк.
Вопрос интервьюера: ${JSON.stringify(question)}
Ответ кандидата: ${JSON.stringify(answer)}
Результат — строго \`${out}\`: один JSON-объект по схеме режима «тренажёр». Не хвали, не переписывай ответ.`;
}

// W4: первое сообщение контакту в целевой компании
function outreach({ company, why, contact, vacancy, out }) {
  return `${BACKGROUND}

Задача: скил outreach (\`.claude/skills/outreach/SKILL.md\`) — первое сообщение.
- Компания: ${company}${why ? ` (чем интересна кандидату: ${why})` : ''}
- Контакт: ${contact.name}${contact.role ? `, ${contact.role}` : ''}; круг: ${{ close: 'знакомы близко', known: 'помнит кандидата, давно не общались', stranger: 'пока не знакомы' }[contact.circle] || contact.circle}; язык: ${contact.language || 'en'}
${contact.note ? `- Заметка кандидата о контакте: ${contact.note}\n` : ''}- Вакансия в компании: ${vacancy || 'нет открытой — сообщение про команду и продукт'}

Результат — строго \`${out}\`. Ничего не отправляй.`;
}

// W3: вердикт первого отбора для CV, собранного до W3, или по Master CV, если адаптации нет
function verdict({ name, hasCV }) {
  return `${BACKGROUND}

Задача: вердикт рекрутера на первом отборе — раздел «Вердикт первого отбора (W3)» шага 6 скила tailor-cv
(\`.claude/skills/tailor-cv/SKILL.md\`). CV не меняй и не пересобирай.
- Вакансия: \`vacancies/${name}.md\`
- CV: ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md` (адаптированного CV нет — оцени Master CV)'}

Результат — строго \`output/${name}/03-verdict.json\`:
{"verdict": "yes|no|maybe", "main_reason": "…", "reason_tag": "…", "matches": ["…"], "missing": ["…"], "hidden": ["…"], "extra": ["…"], "cv": "${hasCV ? 'tailored' : 'master'}"}`;
}

// C11: ответы на поля формы заявки на сайте (то, что приложение не подставило само)
function formFill({ name, hasCV, hasLetter }) {
  return `${BACKGROUND}

Задача: скил form-answers (\`.claude/skills/form-answers/SKILL.md\`), раздел «Режим формы на сайте», для «${name}».
- Поля формы: \`output/${name}/06-form.json\`; уже подставлено: \`output/${name}/06-form-pre.json\` (эти ключи не трогай)
- Вакансия: \`vacancies/${name}.md\`; CV: ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md`'}${hasLetter ? `; письмо: \`output/${name}/Cover Letter.md\`` : ''}
- Стандартные ответы: \`knowledge-base/profile-answers.md\`; профиль: \`knowledge-base/profile.json\`; карточки: \`knowledge-base/cards/\`

Результат — строго \`output/${name}/06-form-agent.json\` по схеме раздела. Нет ответа в базе — status "ask", не выдумывай.
Форму не открывай и ничего не отправляй — заполнение делает приложение.`;
}

// C9: база кейсов — фоновый режим скила case-interview (раунды через файлы черновика)
function caseRound1({ id, target }) {
  return `${BACKGROUND}

Задача: скил case-interview (\`.claude/skills/case-interview/SKILL.md\`), раздел «Режим приложения», **раунд 1**.
Черновик: \`web/data/case-drafts/${id}/\`, надиктовка — \`dictation.txt\`.
${target ? `Это дополнение к карточке \`knowledge-base/cards/${target}.md\` (duplicate_of = "${target}").` : 'Это новый кейс — проверь дубли по INDEX.md.'}
Результат — \`questions.json\` и \`draft.md\` в папке черновика, надиктовка дословно в knowledge-base/raw/.
В knowledge-base/cards/ ничего не пиши.`;
}

function caseRound2({ id, target }) {
  return `${BACKGROUND}

Задача: скил case-interview (\`.claude/skills/case-interview/SKILL.md\`), раздел «Режим приложения», **раунд 2**.
Черновик: \`web/data/case-drafts/${id}/\` (dictation.txt, questions.json, draft.md, answers.json).
${target ? `Дополни существующую карточку \`knowledge-base/cards/${target}.md\` — не создавай новую.` : 'Создай новую карточку (id — card_id из questions.json, если он не занят).'}
Пустые ответы — «не знаю»: [НЕТ ДАННЫХ] и раздел «Пробелы». Обнови INDEX.md и запиши result.json.`;
}

function caseScan({ files, out }) {
  return `${BACKGROUND}

Задача: скил case-interview (\`.claude/skills/case-interview/SKILL.md\`), раздел «Поиск новых фактов в надиктовках писем».
Надиктовки: ${files.map((f) => `\`knowledge-base/raw/${f}\``).join(', ')}.
Результат — строго \`${out}\`. Карточки не меняй.`;
}

// C7: структура для надиктовки письма — подсказки и факты, не текст письма
function outline({ name, hasCV }) {
  return `${BACKGROUND}

Задача: выполни скил letter-outline (\`.claude/skills/letter-outline/SKILL.md\`) для «${name}».
- Вакансия: \`vacancies/${name}.md\`
- ${hasCV ? `Адаптированное CV: \`output/${name}/CV.md\` (факты сверяй с ним), отчёты \`output/${name}/02-match-report.md\`, \`report.md\`` : 'Адаптированного CV ещё нет — опирайся на `knowledge-base/master-cv.md` и карточки'}

Результат — строго \`output/${name}/04-letter-outline.json\` и \`04-letter-outline.md\` по схеме скила.
Проверка \`scorer/check_outline.py\` должна пройти (pass: true). Больше ничего в output/ не меняй.`;
}

function masterImport({ id, fileName }) {
  return `${BACKGROUND}

Задача: перенести новую версию Master CV кандидата из загруженного файла в формат конвейера.
- Исходный файл: \`web/data/master-draft/${id}/${fileName}\` (его можно прочитать напрямую — Read умеет PDF).
- Извлечённый текст: \`web/data/master-draft/${id}/text.txt\`.
- Формат результата: \`.claude/skills/tailor-cv/references/cv-format.md\` — строго.
- Образец оформления: текущая версия \`knowledge-base/base-cv.md\` (тот же порядок секций, та же строка мета
  под местом работы «даты · формат», курсив для описания компании, «0-to-1» вместо стрелки).

Правила:
1. **Формулировки дословно.** Ты раскладываешь текст по секциям, а не редактируешь его: не сокращай, не
   улучшай, не добавляй ничего из карточек базы знаний. Исправляй только артефакты извлечения из PDF
   (переносы строк внутри буллета, слипшиеся слова, лишние пробелы).
2. Если чего-то нет в файле (например, секции Skills) — не добавляй.
3. Ничего не меняй в knowledge-base/ и output/. Пиши только в \`web/data/master-draft/${id}/\`.

Результат:
- \`web/data/master-draft/${id}/draft.md\` — CV в формате CV.md.
- \`web/data/master-draft/${id}/notes.json\`:
  {"issues": ["что не удалось разложить или в чём сомневаешься — по-русски"],
   "changes": ["чем новая версия по смыслу отличается от текущего base-cv.md — коротко, по-русски"],
   "conflicts": ["факты, которые расходятся с knowledge-base/master-cv.md или карточками (даты, цифры, роли)"]}
  Для conflicts сверься с \`knowledge-base/master-cv.md\` и \`knowledge-base/cards/INDEX.md\`.`;
}

function answers({ name, hasCV }) {
  return `${BACKGROUND}

Задача: выполни скил form-answers (\`.claude/skills/form-answers/SKILL.md\`) для «${name}».
- Вопросы формы: \`output/${name}/05-questions.json\`
- Вакансия: \`vacancies/${name}.md\`
- CV: ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md` (адаптированного CV ещё нет)'}
- Стандартные ответы: \`knowledge-base/profile-answers.md\`
- Надиктовка и письмо, если есть: \`output/${name}/00-dictation.md\`, \`output/${name}/Cover Letter.md\`

Результат — строго \`output/${name}/05-answers.json\` и \`output/${name}/05-answers.md\` по схеме скила.
Humanizer (шаг 3) обязателен.`;
}

function edtechCompanies({ limit, sector = 'edtech' }) {
  const label = sector === 'fintech' ? 'FinTech' : 'EdTech';
  return `${BACKGROUND}

Задача: выполни скил edtech-companies (\`.claude/skills/edtech-companies/SKILL.md\`) для отрасли **${label}**
(\`--sector ${sector}\` во всех командах edtech.py) — расширь базу ${label}-компаний. Лимит этого запуска —
${limit} компаний: сначала компании без автосбора (шаг A), оставшийся лимит — новые компании (шаг B).
В базу пиши только через \`.venv/bin/python job-search/edtech.py --sector ${sector} add\`.`;
}

// S4 P1 · один ответ формы заново по комментарию кандидата
function answerRedo({ name, item, comment, out, hasCV }) {
  return `${BACKGROUND}

Задача: скил form-answers (\`.claude/skills/form-answers/SKILL.md\`) — **переделай один ответ** для «${name}».
Вопрос: «${item.q}»${item.limit ? ` (лимит ${item.limit} символов)` : ''}.
Текущие варианты:
${(item.variants || []).map((v) => `- ${v.label}: ${v.text}`).join('\n')}
Что поменять (комментарий кандидата): «${comment}».
Факты — только из базы: вакансия \`vacancies/${name}.md\`, CV ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md`'},
карточки \`knowledge-base/cards/\`, стандартные ответы \`knowledge-base/profile-answers.md\`. Humanizer обязателен.
Результат — строго \`${out}\`: {"status", "note", "variants": [{"label": "short"|"long", "text"}], "sources": [...]} по схеме скила
для одного вопроса. Другие файлы не трогай.`;
}

// S6 P1 · одна компания, которую скрипт не смог подключить: найти страницу карьеры и систему найма
function sectorCompany({ sector, name, careersUrl }) {
  const label = sector === 'fintech' ? 'FinTech' : 'EdTech';
  return `${BACKGROUND}

Задача: скил edtech-companies (\`.claude/skills/edtech-companies/SKILL.md\`), шаг A, но **только для одной компании**:
«${name}»${careersUrl ? ` (страница карьеры, которую дал кандидат: ${careersUrl})` : ''}, отрасль ${label} (\`--sector ${sector}\`).
Найди её настоящую страницу вакансий и систему найма с токеном и запиши через
\`.venv/bin/python job-search/edtech.py --sector ${sector} add --name "${name}" --slugs <токен> --careers-url <ссылка>\`.
Если открытого API нет (Workday, свой сайт) — всё равно запиши компанию с её страницей карьеры (будет «без API»).
Другие компании не трогай.`;
}

module.exports = { fit, tailor, letter, letterGenerate, voiceProfile, outline, caseRound1, caseRound2, caseScan, formFill, verdict, outreach, interviewPrep, practice, keywords, masterImport, answers, answerRedo, edtechCompanies, sectorCompany };
