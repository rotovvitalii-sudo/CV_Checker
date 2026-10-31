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
Плюс поля «что болит» и корзины требований:
${PAIN_SCHEMA}
Затем запусти:
${save}

${KEYWORDS_STEP(vacName, true)}`;
}

// Быстрый фит (2026-10-27): один ход без инструментов. Сервер сам кладёт в промпт рубрику и ядро кандидата
// (разделы 2, 4, 5 job-fit-search-brief.md), профиль поиска и реестр карточек; модель возвращает один JSON,
// дальше — score_job.py add и ключевые слова на сервере. Сверено с агентным фитом Sonnet на 22 вакансиях:
// средняя разница балла 0.6, решение «7+ / ниже» совпало в 21 из 22, ≈ $0.003 против ≈ $0.33.
// V2 (docs/specs/31-vacancy-pain.md): «что болит», тип ситуации и три корзины требований — в обоих фитах
const PAIN_SCHEMA = `"pain": "одна фраза ПО-РУССКИ: что болит и зачем открыли роль — по первым 3–4 обязанностям и требованиям и тому, что повторяется разными словами; не видно, зачем открыли роль — пустая строка",
"situation": одно значение — "build_from_scratch (с нуля, построить процесс) | fix_chaos (навести порядок, перестроить) | scale (масштабировать работающее) | maintain (поддерживать, развивать существующее) | unclear",
"buckets": {"minimum": [{"req": "коротко по-русски", "kw": "ключ на языке вакансии; синонимы через |"}], "desired": [то же], "wishlist": [то же]} —
minimum: 3–6 пунктов, без которых не возьмут (первые строки требований, повторы, «must/required»), «будет плюсом» сюда нельзя;
desired: «plus / nice to have / preferred»; wishlist: длинные перечни инструментов и доменов. kw — так, как это написал бы кандидат в CV.`;

const FIT_QUICK_SYSTEM = 'Ты оцениваешь фит вакансии для одного кандидата по заданной рубрике. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function fitQuick({ briefText, profile, cardsIndex, vacancy }) {
  const sec = (n) => (briefText.match(new RegExp(`## ${n}\\.[\\s\\S]*?(?=\\n## \\d+\\.|$)`)) || [''])[0].trim();
  const prof = { ...profile };
  delete prof.money; delete prof._note;
  return `${sec(2)}

${sec(4)}

${sec(5)}

Якоря (не завышай, сомневаешься между двумя — ставь меньший):
- Фит по задаче: 4 — компания прямо собирается запускать/строить академию, LMS, образовательный продукт для клиентов, customer education, education-led онбординг/активацию; 3 — обучающий продукт уже есть, роль его растит; 2 — рост через контент или онбординг, где обучение — не продукт; 1 — обучение упомянуто вскользь ИЛИ это внутреннее обучение сотрудников (L&D, онбординг персонала, корпоративная LMS для своих людей); 0 — нет связи. «Senior PM в хорошей компании» без задачи обучения — 0.
- Домен: 2 — компания сама EdTech / FinTech / брокер / крипто (продукт для внешних клиентов); 1 — смежный; 0 — прочее. Внутренняя LMS не делает компанию EdTech-продуктом.
- Тип роли: 2 — продуктовое лидерство с бизнесом (Product Lead, Head of Product, Senior PM с growth); 1 — PMM, Growth, Ops, GM, «builder»/универсальная роль; 0 — технический/платформенный PM, не продукт.
- Логистика: 2 — формат, локация и языки явно подходят профилю; 1 — частично или не указано; 0 — не подходят (онсайт вне локаций без релокации, нужен язык, которого нет).
Логистика — по профилю поиска: ${JSON.stringify(prof)}

Карточки кейсов кандидата (anchor_card — ровно id из первой колонки или null):
${cardsIndex}

Вакансия:
"""
${vacancy.slice(0, 14000)}
"""

Верни JSON: все поля схемы раздела 4, плюс
"scores": {"task_fit":0-4,"domain":0-2,"role_type":0-2,"logistics":0-2} — только эти четыре ключа, без total,
"why": "2–3 предложения ПО-РУССКИ (не на языке вакансии), почему такой фит",
"anchor_card": "id или null", "anchor_case": "одна фраза по-русски", "gaps": ["требования вакансии, которых нет в карточках — по-русски"],
"keywords": {"must": ["10–18 ключевых слов/фраз из вакансии на её языке; синонимы через |, например \\"customer education|client education\\""], "nice": ["6–12"]},
${PAIN_SCHEMA}
"languages_required" — только языки, без которых не возьмут (не «плюс», не «желательно»; английский не указывай, если он просто рабочий язык вакансии); языки-плюсы — в nice_to_have.
Дата публикации — только если есть в тексте (YYYY-MM-DD), иначе "". Ничего не выдумывай о вакансии.`;
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

// C12 · инсайты кандидата (docs/specs/34-insights-base.md): сервер сам подбирает до 5 близких к вакансии.
// Инсайт — взгляд и знание, не опыт: в достижения не превращается.
const INSIGHT_RULE = 'Инсайт — взгляд кандидата на профессию, а не его опыт: не превращай его в достижение; цифры из инсайта — только как внешние данные со ссылкой на источник («по данным доклада …»).';
function insightsBlock(list, use) {
  if (!list?.length) return '';
  return `\nИнсайты кандидата, близкие к вакансии (из \`knowledge-base/insights/\`):\n${list.map((i) => `- [insight:${i.id}] ${i.title} (${i.sourceLabel})\n  Суть: ${i.essence}${i.en ? `\n  EN: ${i.en}` : ''}`).join('\n')}\n${INSIGHT_RULE}\n${use}\n`;
}

// V2: боль и минимум из фита — в верхнюю треть CV, первую фразу письма и вопросы интервью
function painBlock(fit, use) {
  const min = (fit?.buckets?.minimum || []).map((b) => b.req).filter(Boolean);
  if (!fit?.pain && !min.length) return '';
  return `\nИз разбора вакансии (быстрый фит, проверь по тексту):${fit.pain ? `\n- Что болит: ${fit.pain}` : ''}${fit.situation && fit.situation !== 'unclear' ? ` (ситуация: ${fit.situation})` : ''}${min.length ? `\n- Минимум требований: ${min.join('; ')}` : ''}\n${use}\n`;
}

function tailor({ name, fit, insights }) {
  return `${BACKGROUND}
${painBlock(fit, 'Верхняя треть CV отвечает на эту боль, минимум — в первых строках (только фактами из базы).')}${insightsBlock(insights, 'В CV.md инсайты НЕ попадают. Только в report.md, раздел пробелов: если по пробелу есть инсайт — «по пробелу X есть инсайт insight:<id>: тему знаешь, кейса нет — надиктуй, если делал».')}
Задача: выполни скил tailor-cv (\`.claude/skills/tailor-cv/SKILL.md\`) целиком для \`vacancies/${name}.md\`.
Если \`output/${name}/01-keywords.json\` содержит \`"source": "quick"\` (черновик быстрого фита) — шаг 1 сделай заново.
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

function letterGenerate({ name, hasOutline, hasVoice, fit, insights }) {
  return `${BACKGROUND}
${painBlock(fit, 'Первая фраза письма — про эту боль и как ты её уже решал (только факты из базы).')}${insightsBlock(insights, 'Можно не больше одной фразы точки зрения кандидата из инсайта — в блоке «почему эта компания / этот подход»; в трассировке у неё tag "fact" и sources: ["knowledge-base/insights/<id>.md"].')}
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
function interviewPrep({ name, hasCV, fit, insights }) {
  return `${BACKGROUND}
${painBlock(fit, 'Используй боль в «почему мы», «что сделаете за 90 дней» и в вопросах к компании («почему открыли позицию?»).')}${insightsBlock(insights, 'Опирайся на инсайты в рискованных вопросах (в hint: «опора: insight <id> — …», для вопросов «что вы думаете о / как бы вы подошли») и в вопросах к компании. В 07-interview.json добавь "insights_used": ["<id>", …] — только реально использованные.')}
Задача: скил interview-prep (\`.claude/skills/interview-prep/SKILL.md\`), режим «подготовка», для «${name}».
- Вакансия: \`vacancies/${name}.md\`; CV: ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md`'}
- Пробелы: \`output/${name}/02-match-report.md\`, \`report.md\`, \`summary.json\` / \`03-verdict.json\` (вердикт), если есть
- Карточки: \`knowledge-base/cards/INDEX.md\` и нужные карточки
- Банк историй: \`knowledge-base/stories.json\`, если есть — бери оттуда подходящие истории (ту же карточку и тему), уточняя «fits» под эту вакансию
Результат — строго \`output/${name}/07-interview.json\` по схеме скила. Файл уже есть — подготовь заново и запиши его целиком инструментом Write
(не дописывай и не патчи скриптами: запуск скриптов в фоне недоступен).`;
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

function answers({ name, hasCV, insights }) {
  return `${BACKGROUND}
${insightsBlock(insights, 'Для вопросов о мнении, мотивации и трендах можно опираться на инсайт — в sources ответа пиши "insight:<id>". Для фактических вопросов и вопросов об опыте — нельзя.')}
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
function answerRedo({ name, item, comment, out, hasCV, insights }) {
  return `${BACKGROUND}
${insightsBlock(insights, 'Для вопроса о мнении, мотивации или трендах можно опираться на инсайт — в sources пиши "insight:<id>".')}
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

// V1 · сообщение к отклику (docs/specs/30-apply-message.md): один ход без инструментов, контекст кладёт сервер
const APPLY_MSG_SYSTEM = 'Ты пишешь короткое сообщение к отклику на вакансию от лица кандидата, по-английски. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function applyMessage({ vacancy, fit, cv, voice, limit, error, prev }) {
  const ctx = vacancy ? `Вакансия:\n\"\"\"\n${vacancy.slice(0, 9000)}\n\"\"\"`
    : `Вакансия (текста нет, только разбор): задача — ${fit.current_task || ''}; что делать — ${(fit.what_you_do || []).join('; ')}`;
  const pain = fit.pain ? `\nЧто болит у компании (разбор, проверь по тексту): ${fit.pain}` : '';
  return `${ctx}${pain}

CV кандидата — единственный источник фактов:
\"\"\"
${cv.slice(0, 9000)}
\"\"\"
${voice ? `\nКак кандидат говорит (голосовой профиль, только манера — факты из него не бери):\n${voice.slice(0, 3000)}\n` : ''}
Напиши сообщение для поля «message / cover message» формы отклика. Лимит — ${limit} символов вместе с пробелами (целься в 70–90% лимита).
Структура, 3 части: (1) на какую роль и почему именно эта вакансия — через её задачу, не через комплименты компании;
(2) один конкретный результат кандидата с цифрой, связанный с главной задачей вакансии; (3) готовность поговорить.
${limit < 300 ? 'Без приветствия и подписи.' : 'Приветствие — максимум «Hi,» или «Hello,», без подписи.'}
Правила: каждое число и факт — дословно из CV, ничего не придумывай; не пересказывай CV; без «I'm excited / thrilled / passionate / motivated»,
без «leverage, delve, robust, seamless, proven track record, I am writing to»; без длинных тире; предложения разной длины, одно короткое.
${error ? `\nПредыдущий вариант не прошёл проверку: ${error}. Исправь это.\nПредыдущий вариант: ${prev}\n` : prev ? `\nНужен другой вариант, не похожий на прошлый: ${prev}\n` : ''}
Верни JSON: {"message": "текст сообщения", "facts": [{"text": "факт из сообщения", "source": "CV"}]}`;
}

// ---------- C12 · разбор надиктовки инсайта: один ход, сервер кладёт текст и существующие теги ----------
const INSIGHT_SYSTEM = 'Ты бережно разбираешь надиктовку кандидата об инсайте. Ничего не добавляешь от себя. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function insightParse({ text, source, tags, topics }) {
  return `Надиктовка (голосовой ввод, возможны ошибки распознавания):
"""
${String(text).slice(0, 8000)}
"""
Источник: ${source.type}${source.title ? ` — ${source.title}` : ''}.

Существующие теги (используй их, если подходят): ${tags.join(', ') || '—'}
Темы подготовки к интервью (если инсайт про одну из них — добавь её slug в теги): ${topics.join(', ') || '—'}

Правила: исправь только ошибки распознавания; смысл и формулировки кандидата сохрани, ничего не дописывай и не обобщай сверх сказанного.
"essence" — 1–3 мысли ПО-РУССКИ словами кандидата, каждая с новой строки, начиная с «- ».
"en" — 1–2 предложения по-английски, как кандидат сказал бы это на интервью: просто, без LLM-штампов (leverage, delve, robust, seamless), без длинных тире.
"tags" — 3–6 тегов kebab-case по-английски (предметная область: user-activation, pricing, ai-in-education …).
"looks_like_case" — true, если в надиктовке есть собственный опыт кандидата с результатом («я сделал …, конверсия выросла на …»); "case_hint" — этот фрагмент.
"multiple" — true, если это несколько разных, не связанных мыслей; "parts" — их короткие заголовки.

Верни JSON: {"title": "≤ 8 слов по-русски", "slug": "kebab-case-по-английски", "essence": "- …", "en": "…", "tags": ["…"],
"looks_like_case": false, "case_hint": "", "multiple": false, "parts": []}`;
}

// ---------- W8 · углубиться в темы (docs/specs/33-interview-topics.md) ----------
const TOPICS_SYSTEM = 'Ты помогаешь кандидату подготовиться к собеседованию: выбираешь темы для освежения знаний. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function interviewTopics({ cv, fit, requirements, library }) {
  const b = fit?.buckets || {};
  const req = [...(b.minimum || []), ...(b.desired || [])].map((x) => `- ${x.req}${x.kw ? ` (${x.kw})` : ''}`).join('\n') || requirements.slice(0, 4000);
  return `Требования вакансии (минимум и желательное):
${req}
${fit?.current_task ? `\nГлавная задача роли: ${fit.current_task}` : ''}${(fit?.what_you_do || []).length ? `\nЧто делать: ${fit.what_you_do.join('; ')}` : ''}${fit?.pain ? `\nЧто болит: ${fit.pain}` : ''}

CV кандидата:
"""
${cv.slice(0, 8000)}
"""

Темы, которые уже есть в библиотеке кандидата (если тема по смыслу совпадает — верни ровно этот slug):
${library.map((t) => `- ${t.slug}: ${t.title_en}`).join('\n') || '(пусто)'}

Выбери 4–8 тем для освежения знаний перед интервью — там, где пункт CV пересекается с требованием вакансии
(например, CV: «increased activation by 38%» + вакансия: «own activation» → тема «User activation in SaaS»).
Тема — предметная область, о которой спросят на интервью (метрики, подходы, лексика), а не навык вообще («communication») и не компания.
Сначала главная задача роли и минимум требований. Не дроби одну область на несколько тем.

Верни JSON: {"topics": [{"slug": "kebab-case-по-английски", "title_en": "…", "title_ru": "…",
"why": {"cv_line": "строка или пункт CV, коротко", "requirement": "требование вакансии, коротко по-русски"}, "priority": "high|medium|low"}]}`;
}

function topicLesson({ slug, title_en, title_ru, vacancy, why }) {
  return `${BACKGROUND}

Задача: скил topic-lesson (\`.claude/skills/topic-lesson/SKILL.md\`), режим приложения.
Тема: slug \`${slug}\`, «${title_en}» / «${title_ru}».
Контекст (для акцентов, не для фактов о кандидате): вакансия «${vacancy}»${why?.requirement ? `, требование: ${why.requirement}` : ''}${why?.cv_line ? `, строка CV: ${why.cv_line}` : ''}.
Запиши \`knowledge-base/learning/${slug}/lesson.en.md\` и \`knowledge-base/learning/${slug}/meta.json\` по схеме скила.`;
}

function topicVideo({ slug, title_en, bad }) {
  return `${BACKGROUND}

Задача: скил topic-lesson (\`.claude/skills/topic-lesson/SKILL.md\`), режим «только видео», тема \`${slug}\` «${title_en}».
Видео из \`knowledge-base/learning/${slug}/meta.json\` не прошло проверку${bad ? ` (${bad})` : ''}. Найди другое, проверь через oEmbed
и обнови в meta.json только поле video (или null, если не нашлось); ссылки из \`video_rejected\` не предлагай. Урок не трогай.`;
}

const TEST_SYSTEM = 'Ты составляешь тест по учебному материалу для подготовки к собеседованию. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function topicTest({ lessonText, video, past, n, lang = 'en' }) {
  const L = lang === 'ru' ? 'на русском (термины — по-английски, как в уроке)' : 'на английском (English only)';
  // Материал видео: ключевые мысли агента, иначе главы и описание со страницы (если там есть содержание)
  const vmat = video?.key_points?.length ? video.key_points.map((k) => `- ${k}`).join('\n')
    : [(video?.chapters || []).length ? `Главы: ${video.chapters.join('; ')}` : '', (video?.description || '').length >= 200 ? `Описание:\n${video.description}` : '']
      .filter(Boolean).join('\n');
  const vq = vmat ? Math.max(1, Math.round(n * 0.2)) : 0;
  return `Урок:
"""
${lessonText.slice(0, 14000)}
"""
${vq ? `\nМатериал видео «${video.title}» (${video.key_points?.length ? 'ключевые мысли' : 'главы и описание со страницы'}):\n${vmat}\n` : ''}
Составь тест из ${n} вопросов ${L} — вопросы и варианты ответов целиком на этом языке: ${n - vq} — по уроку${vq ? `, ${vq} — по материалу видео (только то, что в нём написано; рекламу и ссылки не спрашивай)` : ''}.
Каждый вопрос — выбор из 4 вариантов, ровно один верный; неверные — правдоподобные, не абсурдные. Проверяй понимание
(метрика, формула, когда применять подход, что хотят услышать на интервью, термин), а не память на формулировки.
Ответ должен однозначно следовать из материала выше — ничего сверх него. Не пиши «по уроку» / «according to the lesson» — спрашивай о предмете.
${past.length ? `\nЭти вопросы уже были — не повторяй их и не перефразируй:\n${past.map((q) => `- ${q}`).join('\n')}\n` : ''}
Верни JSON: {"questions": [{"q": "…", "options": ["…", "…", "…", "…"], "answer": 0-3,
"explain": "почему верно — одна фраза по-русски", "section": "заголовок раздела урока (## …) или Video", "from": "lesson|video"}]}`;
}

const TRANSLATE_SYSTEM = 'Ты переводишь учебный текст с английского на русский. Возвращаешь только переведённый markdown, без пояснений.';

function topicTranslate({ lessonText }) {
  return `Переведи урок на русский язык — живо и просто, как объяснял бы коллега.
Правила: структура markdown и заголовки разделов сохраняются (заголовки переведи, а в скобках оставь английский оригинал, например
«## Ключевые метрики и формулы (Key metrics and formulas)»); профессиональные термины оставляй по-английски при первом упоминании
с русским пояснением в скобках; формулы не переводи; раздел Glossary — термины по-английски, объяснения по-русски;
вопросы из раздела «How interviewers ask about it» — по-английски (так их зададут), пояснения — по-русски.

"""
${lessonText}
"""`;
}

module.exports = { insightParse, INSIGHT_SYSTEM, interviewTopics, TOPICS_SYSTEM, topicLesson, topicVideo, topicTest, TEST_SYSTEM, topicTranslate, TRANSLATE_SYSTEM,
  applyMessage, APPLY_MSG_SYSTEM, fit, fitQuick, FIT_QUICK_SYSTEM, tailor, letter, letterGenerate, voiceProfile, outline, caseRound1, caseRound2, caseScan, formFill, verdict, outreach, interviewPrep, practice, keywords, masterImport, answers, answerRedo, edtechCompanies, sectorCompany };
