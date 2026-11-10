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

// W9: культура компании — топ-3 ценности, их слова и что сказать; меняет акцент и слова, не факты
function cultureBlock(c, use) {
  if (!c?.top?.length) return '';
  return `\nКультура компании ${c.company} (разбор W9, публичные источники):\n${c.top.map((v) => `- ${v.name} — их слова: ${v.their_words.join(', ') || '—'}. ${v.meaning}${v.say?.card ? `\n  Твоя опора: карточка ${v.say.card}${v.say.angle ? ` — ${v.say.angle}` : ''}` : v.say?.gap ? `\n  Своего кейса нет (${v.say.gap}) — не придумывай` : ''}`).join('\n')}
Их словарь: ${c.vocabulary.join(', ') || '—'}${c.avoid.length ? `\nНе говорить: ${c.avoid.join('; ')}` : ''}
Культура меняет акцент и слова, но не факты: опыт — только из базы.
${use}\n`;
}

function tailor({ name, fit, insights, mine, base }) {
  return `${BACKGROUND}
${painBlock(fit, 'Верхняя треть CV отвечает на эту боль, минимум — в первых строках (только фактами из базы).')}${insightsBlock(insights, 'В CV.md инсайты НЕ попадают. Только в report.md, раздел пробелов: если по пробелу есть инсайт — «по пробелу X есть инсайт insight:<id>: тему знаешь, кейса нет — надиктуй, если делал».')}
${mine ? `Актуальное \`output/${name}/CV.md\` — версия кандидата, которую он правил сам. Основа новой адаптации — она, а не base-cv.md: сохрани его правки и формулировки,
факты из неё для этой вакансии считай разрешёнными, даже если их нет в базе: числа из его версии в \`check_evidence.py\` не считаются ошибкой, только перечисли их в report.md. Дрейф по-прежнему считается от Master CV.\n\n` : ''}Задача: выполни скил tailor-cv (\`.claude/skills/tailor-cv/SKILL.md\`) целиком для \`vacancies/${name}.md\`.
${base ? `Базовое CV этой адаптации — \`${base.file}\` (профиль Master CV «${base.title}»). Везде, где скил говорит о базовом CV, бери этот файл: копируй его в CV.md и передавай в \`--base\` проверок.\n` : ''}Если \`output/${name}/01-keywords.json\` содержит \`"source": "quick"\` (черновик быстрого фита) — шаг 1 сделай заново.
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

function letterGenerate({ name, hasOutline, hasVoice, fit, insights, culture }) {
  return `${BACKGROUND}
${painBlock(fit, 'Первая фраза письма — про эту боль и как ты её уже решал (только факты из базы).')}${cultureBlock(culture, 'В письме — одно-два слова или акцента компании там, где они естественно ложатся на твой факт; не перечисляй ценности. В letter-summary.json добавь "culture_used": ["<ценность>", …].')}${insightsBlock(insights, 'Можно не больше одной фразы точки зрения кандидата из инсайта — в блоке «почему эта компания / этот подход»; в трассировке у неё tag "fact" и sources: ["knowledge-base/insights/<id>.md"].')}
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
function interviewPrep({ name, hasCV, fit, insights, culture, whyUs }) {
  return `${BACKGROUND}
${whyUs?.short ? `\nОтвет кандидата «почему мы» (готов, проверен): ${whyUs.short}\nЧасть «о себе» → why не должна ему противоречить.\n` : ''}${painBlock(fit, 'Используй боль в «почему мы», «что сделаете за 90 дней» и в вопросах к компании («почему открыли позицию?»).')}${cultureBlock(culture, '«О себе» и fits историй — с акцентом и словами этих ценностей (факты те же). В 07-interview.json добавь "culture_used": ["<ценность>", …] — только реально использованные.')}${insightsBlock(insights, 'Опирайся на инсайты в рискованных вопросах (в hint: «опора: insight <id> — …», для вопросов «что вы думаете о / как бы вы подошли») и в вопросах к компании. В 07-interview.json добавь "insights_used": ["<id>", …] — только реально использованные.')}
Задача: скил interview-prep (\`.claude/skills/interview-prep/SKILL.md\`), режим «подготовка», для «${name}».
- Вакансия: \`vacancies/${name}.md\`; CV: ${hasCV ? `\`output/${name}/CV.md\`` : '`knowledge-base/base-cv.md`'}
- Пробелы: \`output/${name}/02-match-report.md\`, \`report.md\`, \`summary.json\` / \`03-verdict.json\` (вердикт), если есть
- Карточки: \`knowledge-base/cards/INDEX.md\` и нужные карточки
- Банк историй: \`knowledge-base/stories.json\`, если есть — бери оттуда подходящие истории (ту же карточку и тему), уточняя «fits» под эту вакансию
Результат — строго \`output/${name}/07-interview.json\` по схеме скила. Файл уже есть — подготовь заново и запиши его целиком инструментом Write
(не дописывай и не патчи скриптами: запуск скриптов в фоне недоступен).`;
}

// Тренажёр: маленький контекст (без чтения базы) — дёшево на каждую попытку
function practice({ name, question, answer, out, values, whyUs }) {
  return `${BACKGROUND}
${whyUs ? `\nЭто вопрос «почему мы». Добавь в JSON "why": {"company": true|false — назвал ли кандидат конкретику о компании (задача, продукт, новость, ценность), а не общие слова; "fact": true|false — привёл ли свой факт опыта с результатом}.\n` : ''}${values?.length ? `\nГлавные ценности компании (W9): ${values.join('; ')}. Добавь в JSON "culture": {"said": [ценности, которые прозвучали в ответе — словами или по смыслу], "missed": [остальные из этих, если к вопросу они подходили]}. На оценку score это не влияет.\n` : ''}
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
function outline({ name, hasCV, culture }) {
  return `${BACKGROUND}
${cultureBlock(culture, 'В подсказках блоков (по-русски) отметь, где упомянуть ценность компании своим фактом: «они ценят <ценность> — расскажи, как ты …». Фраз письма не пиши. В 04-letter-outline.json добавь "culture_used": ["<ценность>", …].')}
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

// W9a: готовый ответ «почему мы» — основа для вопросов формы о мотивации к компании
function whyUsBlock(w) {
  if (!w?.short) return '';
  return `\nГотовый ответ кандидата «почему мы» (проверен: факты из CV и разбора компании):\n- short: ${w.short}\n- long: ${w.long}
Для вопросов формы о мотивации к компании (why us / why join / what attracts you / why this company) строй варианты на его основе, подгоняя под лимит;
в sources ответа пиши "why-us". Для других вопросов не используй.\n`;
}

function answers({ name, hasCV, insights, whyUs }) {
  return `${BACKGROUND}
${whyUsBlock(whyUs)}${insightsBlock(insights, 'Для вопросов о мнении, мотивации и трендах можно опираться на инсайт — в sources ответа пиши "insight:<id>". Для фактических вопросов и вопросов об опыте — нельзя.')}
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
function answerRedo({ name, item, comment, out, hasCV, insights, whyUs }) {
  return `${BACKGROUND}
${whyUsBlock(whyUs)}${insightsBlock(insights, 'Для вопроса о мнении, мотивации или трендах можно опираться на инсайт — в sources пиши "insight:<id>".')}
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

function applyMessage({ vacancy, fit, cv, voice, limit, error, prev, culture }) {
  const ctx = vacancy ? `Вакансия:\n\"\"\"\n${vacancy.slice(0, 9000)}\n\"\"\"`
    : `Вакансия (текста нет, только разбор): задача — ${fit.current_task || ''}; что делать — ${(fit.what_you_do || []).join('; ')}`;
  const pain = (fit.pain ? `\nЧто болит у компании (разбор, проверь по тексту): ${fit.pain}` : '')
    + (culture?.top?.length ? `\nЧто компания ценит (их слова): ${culture.top.map((v) => `${v.name} — ${v.their_words.slice(0, 3).join(', ')}`).join('; ')}. Можно одно их слово там, где оно ложится на факт из CV.` : '');
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

// ---------- W10 · мои вопросы к интервьюеру (docs/specs/38-interviewer-questions.md) ----------
const HRQ_SYSTEM = 'Ты опытный карьерный коуч продуктовых лидеров. Готовишь кандидату вопросы, которые он задаст интервьюеру в конце звонка. Ничего не выдумываешь о компании сверх данных. Отвечай только одним JSON-объектом без пояснений и без markdown.';
const HRQ_STAGE = { recruiter: 'первый звонок с рекрутером / HR', hiring_manager: 'интервью с нанимающим менеджером', final: 'финальный этап (руководство, команда)' };

function interviewerQuestions({ stage, langName, vacancy, fit, research, whyUs, cv, risky, earlier, keep, count, replace, prev, error }) {
  const r = research;
  const b = fit?.buckets || {};
  const comp = r ? `Компания ${r.company}: ${r.snapshot.what} ${r.snapshot.product ? `Продукт: ${r.snapshot.product}.` : ''} ${r.snapshot.stage ? `Стадия: ${r.snapshot.stage}.` : ''}
Ценности (их слова): ${r.values.slice(0, 5).map((v) => `${v.name} (${v.their_words.join(', ')}) — ${v.meaning}`).join('; ')}
Новости (только эти ссылки можно ставить в basis.url):
${r.snapshot.news.filter((n) => n.url).map((n) => `- ${n.date || ''} ${n.title} — ${n.url}`).join('\n') || '—'}
Страницы разбора (тоже можно в basis.url): ${r.sources.map((x) => x.url).slice(0, 10).join(' ')}
Вопросы о культуре, на которые в источниках нет ответа: ${(r.ask || []).join(' | ') || '—'}
Чего не говорить: ${(r.avoid || []).map((a) => a.what).join('; ') || '—'}` : 'Разбора компании нет — опирайся на вакансию; basis.url оставляй пустым.';
  return `Этап: ${HRQ_STAGE[stage] || stage}. Вопросы — на ${langName} языке (язык вакансии); "goal" и "why" — по-русски.

Текст вакансии:
"""
${String(vacancy).slice(0, 9000)}
"""
${fit?.pain ? `Что болит у компании: ${fit.pain}\n` : ''}${fit?.situation ? `Ситуация: ${fit.situation}\n` : ''}${fit?.current_task ? `Главная задача роли: ${fit.current_task}\n` : ''}${(b.minimum || []).length ? `Минимум требований: ${b.minimum.map((x) => x.req).join('; ')}\n` : ''}
${comp}
${whyUs ? `\nПочему кандидату интересна компания (его ответ «почему мы»): ${whyUs}\n` : ''}
CV кандидата:
"""
${String(cv).slice(0, 6000)}
"""
${(risky || []).length ? `Где CV и вакансия расходятся (рискованные вопросы к нему): ${risky.join(' | ')}\n` : ''}${earlier.length ? `\nУже спрошено на прошлых этапах и что ответили (не повторяй; используй ответы, копай глубже):\n${earlier.map((x) => `- [${x.stage}] ${x.q} → ${x.answer || 'ответ не записан'}`).join('\n')}\n` : ''}
Каким должен быть вопрос:
- конкретный для этой компании и роли: опирается на «что болит», свежую новость, ценность, требование вакансии или пробел в CV кандидата;
- показывает, что кандидат понимает бизнес и уже думает о задаче; звучит естественно вслух, ≤ 30 слов;
- НЕ спрашивай то, на что уже есть ответ в тексте вакансии или в разборе компании;
- без зарплаты, бонусов, отпуска, удалёнки; без «what is your culture like», «typical day»;
- под этап: рекрутеру — роль и ожидания, почему роль открыта, команда, процесс и сроки; менеджеру — задача первых 90 дней, как меряют успех,
  главные трудности, решения и данные; финал — стратегия, приоритеты, как устроены решения;
- минимум один вопрос — о следующих шагах процесса (category "process"); минимум один — из «что болит» или новости (basis "pain" / "news").
Поля: "q" — вопрос; "goal" — что кандидат хочет узнать; "why" — аргументация: что этот вопрос показывает о кандидате и почему важен именно сейчас
(1–2 фразы, конкретно, обращаясь к нему на «ты»: «Показывает, что ты …»); "basis" — {"type": "pain|news|value|gap|role|process", "ref": "фраза-источник", "url": "ссылка из списка выше или пусто"};
"category" — "role|team|success|company|process"; "top" — true у 3 главных (если на вопросы останется 2 минуты); "followup" — уточнение, если ответ общий.
${replace ? `\nЗамени ОДИН вопрос — дай другой вопрос с другой целью, не похожий на этот: «${replace.q}» (цель: ${replace.goal}).
Остальные вопросы списка (не дублируй): ${keep.map((x) => x.q).join(' | ') || '—'}${error ? `\nПрошлая замена не прошла проверку: ${error}. Исправь. Прошлая замена: «${prev}»` : ''}
Верни JSON: {"item": {"q": "…", "goal": "…", "why": "…", "basis": {"type": "…", "ref": "…", "url": ""}, "category": "…", "top": ${replace.top}, "followup": "…"}}`
    : `${keep.length ? `\nЭти вопросы кандидат оставляет (не дублируй по смыслу): ${keep.map((x) => `${x.q}${x.top ? ' [главный]' : ''}`).join(' | ')}
Главных среди них: ${keep.filter((x) => x.top).length}; отметь "top" только у ${Math.max(0, 3 - keep.filter((x) => x.top).length)} новых.\n` : ''}
Сгенерируй ${count} вопросов.${error ? `\nПрошлый список не прошёл проверку: ${error}. Исправь.\nПрошлый список: ${prev}` : ''}
Верни JSON: {"items": [{"q": "…", "goal": "…", "why": "…", "basis": {"type": "…", "ref": "…", "url": ""}, "category": "…", "top": false, "followup": "…"}]}`}`;
}

// ---------- C13 · ответы → база кейсов (docs/specs/37-answers-to-cases.md) ----------
const ANSWER_FACTS_SYSTEM = 'Ты сверяешь ответ кандидата с его базой кейсов и выписываешь только то, что он сам сказал и чего в базе нет. Ничего не додумываешь. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function answerFacts({ question, answer, origin, index, cards, note }) {
  return `Где кандидат отвечал: ${origin}.
Вопрос: ${question}
${note ? `${note}\n` : ''}Ответ кандидата (дословно, возможны ошибки распознавания речи):
"""
${String(answer).slice(0, 6000)}
"""

Реестр карточек базы кейсов:
${String(index || '').slice(0, 6000)}

Ближайшие карточки целиком (что уже есть в базе):
${cards.map((c) => `=== ${c.id} ===\n${c.text}`).join('\n\n') || '—'}

Задача:
1. "facts" — конкретные факты опыта кандидата из ответа, которых НЕТ в карточках: цифра, эксперимент и его итог, решение, масштаб, срок, инструмент.
   Каждый факт — одна фраза по-русски. "quote" — фрагмент ответа ДОСЛОВНО, без правок (можно несколько кусков через «…»).
   Каждое число факта должно стоять в "quote" и записано так же, как в ответе (в ответе «one dollar» — в факте «один доллар», не «$1»). "card" — id карточки, к которой факт относится, или null.
   Если факт уже есть в карточке — не выписывай. Если противоречит карточке (другая цифра, другой срок) — выпиши и заполни
   "conflict": что именно расходится («в карточке 12%, в ответе 15%»), иначе null.
   Не факты: мнения, общие слова («я всегда опираюсь на данные»), планы, оценки себя. Ничего не обобщай сверх сказанного. 0 фактов — нормально.
2. "story" — если в ответе целая история (ситуация → что сделал → результат), которой нет ни в одной карточке:
   {"is_new": true, "title": "≤ 8 слов по-русски", "why": "почему это отдельный кейс", "card": null}.
   Если история уже есть в карточке — {"is_new": false, "title": "…", "why": "…", "card": "<id>"}. Если истории нет — null.
3. "insight" — true, если ответ в основном про мнение или взгляд кандидата, а не про его опыт.

Верни JSON: {"facts": [{"fact": "…", "quote": "…", "card": null, "conflict": null}], "story": null, "insight": false}`;
}

// ---------- C20 · требование → кейс (docs/specs/45-requirement-cases.md) ----------
const REQ_MATCH_SYSTEM = 'Ты строгий нанимающий менеджер. Оцениваешь, насколько история кандидата подтверждает одно требование вакансии. Не хвалишь и не переписываешь текст за кандидата. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function reqMatch({ req, text, vacancy, title }) {
  return `Вакансия: ${title}
Текст вакансии (для контекста):
"""
${String(vacancy || '').slice(0, 4000)}
"""

Требование, которое проверяем: «${req}»

Кейс кандидата (возможны ошибки распознавания речи, язык любой):
"""
${String(text).slice(0, 5000)}
"""

Оцени по четырём частям (целые числа):
- "relevance" 0–40 — это опыт именно того, что требуют (не смежного). Опыт другого рода — не выше 14.
- "evidence" 0–25 — есть ли результат и цифры: что изменилось, на сколько, за какой срок.
- "ownership" 0–20 — видно, что сделал сам кандидат (решения, действия), а не «мы» или команда.
- "scale" 0–15 — масштаб и контекст: пользователи, деньги, команда, рынок, сложность — сопоставимо с этой ролью.
"hit" — 1–4 коротких пункта по-русски: что в кейсе попадает в требование.
"missing" — 1–4 пункта по-русски, ВОПРОСАМИ к кандидату о том, чего не хватает («Сколько было учеников?», «Что ты решил сам?»). Не предлагай готовых фраз и не додумывай факты.
"verdict" — одна фраза по-русски: главное, что держит оценку.

Верни JSON: {"parts": {"relevance": 0, "evidence": 0, "ownership": 0, "scale": 0}, "hit": ["…"], "missing": ["…"], "verdict": "…"}`;
}

const REQ_SUGGEST_SYSTEM = 'Ты подбираешь кандидату историю из его базы кейсов под требование вакансии. Пользуешься только фактами из карточек, ничего не додумываешь и не округляешь. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function reqSuggest({ req, title, langName, index, cards, pain }) {
  return `Вакансия: ${title}${pain ? `\nЧто болит у компании: ${pain}` : ''}
Требование: «${req}»

Реестр карточек базы кейсов:
${String(index || '').slice(0, 6000)}

Карточки целиком (единственный источник фактов):
${cards.map((c) => `=== ${c.id} ===\n${c.text}`).join('\n\n') || '—'}

Задача: выбери до 2 карточек из тех, что даны целиком, которые лучше всего подтверждают требование. Для каждой:
- "card" — id карточки;
- "why" — по-русски, одной-двумя фразами: что именно в карточке матчится с требованием;
- "covers" — по-русски: какая часть требования закрыта;
- "not_covers" — по-русски: что из требования карточка не закрывает (пусто, если закрывает всё);
- "draft" — история на ${langName} от первого лица, 60–120 слов: ситуация → что сделал сам → результат. Только факты этой карточки;
  каждое число — ровно как в карточке (не пересчитывай, не округляй, не переводи цифры в слова). Нет фактов под требование — пустая строка.
Если ни одна карточка не подтверждает требование по существу — "options": [] и "hint" по-русски: о чём надиктовать новый кейс.

Верни JSON: {"options": [{"card": "…", "why": "…", "covers": "…", "not_covers": "…", "draft": "…"}], "hint": ""}`;
}

// ---------- W8 · углубиться в темы (docs/specs/33-interview-topics.md) ----------
const TOPICS_SYSTEM = 'Ты помогаешь кандидату подготовиться к собеседованию: выбираешь темы для освежения знаний. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function interviewTopics({ cv, fit, requirements, vacancy, answers, formQuestions }) {
  const b = fit?.buckets || {};
  const req = [...(b.minimum || []), ...(b.desired || [])].map((x) => `- ${x.req}${x.kw ? ` (${x.kw})` : ''}`).join('\n') || requirements.slice(0, 4000);
  return `Текст вакансии:
"""
${String(vacancy || '').slice(0, 7000)}
"""

Требования (минимум и желательное):
${req}
${fit?.current_task ? `\nГлавная задача роли: ${fit.current_task}` : ''}${(fit?.what_you_do || []).length ? `\nЧто делать: ${fit.what_you_do.join('; ')}` : ''}${fit?.pain ? `\nЧто болит: ${fit.pain}` : ''}
${answers.length ? `\nНа что кандидат отвечал при подаче (компания уже спрашивала об этом, значит спросит и на интервью):\n${answers.map((x) => `- ${x.q}${x.a ? `\n  Ответ: ${String(x.a).slice(0, 500)}` : ''}`).join('\n')}\n` : ''}${formQuestions ? `\nВопросы формы заявки:\n${String(formQuestions).slice(0, 2000)}\n` : ''}
CV кандидата:
"""
${cv.slice(0, 8000)}
"""

Выбери 4–8 тем для освежения знаний именно к этому интервью: о чём спросят на этой роли в этой компании и этой отрасли.
- Тема — предметная область (метрики, подходы, лексика), а не навык вообще («communication») и не компания.
- Называй тему в терминах этой вакансии и её продукта и рынка: если роль про трейдинг и первый депозит, то и тема про них, а не про подписку.
- Опирайся на текст вакансии и вопросы при подаче. Сначала главная задача роли и минимум требований. Не дроби одну область на несколько тем.
- Где пункт CV пересекается с требованием, укажи его в "cv_line". Требование, которого в CV нет, тоже может быть темой: тогда "cv_line" пустой.

Верни JSON: {"topics": [{"slug": "kebab-case-по-английски", "title_en": "…", "title_ru": "…",
"why": {"cv_line": "строка или пункт CV, коротко", "requirement": "требование вакансии, коротко по-русски"}, "priority": "high|medium|low"}]}`;
}

// Темы вакансии собираются без оглядки на библиотеку; сопоставление — отдельным ходом: сданное не надо учить заново
const TOPICS_MATCH_SYSTEM = 'Ты сверяешь темы подготовки к интервью с библиотекой уже готовых уроков. Тема совпадает, только если готовый урок покрывает её по существу. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function topicsMatch({ topics, library }) {
  return `Темы для новой вакансии:
${topics.map((t) => `- ${t.slug}: ${t.title_en} (${t.why.requirement})`).join('\n')}

Библиотека готовых уроков:
${library.map((t) => `- ${t.slug}: ${t.title_en}${t.outline ? `\n  Разделы: ${t.outline}` : ''}`).join('\n')}

Для каждой темы укажи урок из библиотеки, если он покрывает эту тему в этой же предметной области и подходит для подготовки без нового урока.
Если совпадает только общая идея, а рынок, продукт или метрики другие (подписка и трейдинг, онбординг в SaaS и онбординг брокера), — null. Один урок — не больше чем на одну тему.

Верни JSON: {"matches": [{"slug": "<тема>", "library_slug": "<урок>" или null}]}`;
}

// Фильтр видео из профиля — агенту, чтобы искал сразу подходящие; проверяет всё равно сервер
const videoRulesLine = (r) => (r ? `\nВидео: не длиннее ${r.max_minutes} мин, опубликовано не раньше чем ${r.max_years} г. назад, от ${r.min_views} просмотров, на английском.
Предложи основное видео и до 4 запасных в \`video_candidates\` — сервер возьмёт первое, что пройдёт фильтр.` : '');

function topicLesson({ slug, title_en, title_ru, vacancy, why, rules, course }) {
  const ctx = course ? `Курс «${course.title}» (${course.kind === 'domain' ? 'доменный — нужен раздел Worked examples' : course.kind}), уровень: ${course.level}. Цель курса: ${course.goal}
Модуль «${course.module}», урок ${course.n} из ${course.total}. Цель урока: ${course.lesson.goal || '—'}${(course.lesson.covers || []).length ? `; что войдёт: ${course.lesson.covers.join(', ')}` : ''}.
Уже пройдены (не повторяй): ${course.prev.join('; ') || '—'}
Будут дальше (не забегай вперёд): ${course.next.join('; ') || '—'}
${course.glossary.length ? `Глоссарий курса: ${course.glossary.join(', ')}\n` : ''}${course.materials.length ? `Материалы кандидата (прочитай и опирайся):\n${course.materials.map((m) => `- ${m}`).join('\n')}\n` : ''}Раздел «Урок курса» скила обязателен.`
    : `Контекст (для акцентов, не для фактов о кандидате): вакансия «${vacancy}»${why?.requirement ? `, требование: ${why.requirement}` : ''}${why?.cv_line ? `, строка CV: ${why.cv_line}` : ''}.`;
  return `${BACKGROUND}

Задача: скил topic-lesson (\`.claude/skills/topic-lesson/SKILL.md\`), режим приложения.
Тема: slug \`${slug}\`, «${title_en}» / «${title_ru}».
${ctx}
Запиши \`knowledge-base/learning/${slug}/lesson.en.md\` и \`knowledge-base/learning/${slug}/meta.json\` по схеме скила.${videoRulesLine(rules)}`;
}

function topicVideo({ slug, title_en, bad, rules, rejected = [] }) {
  return `${BACKGROUND}

Задача: подобрать видео на YouTube к уроку по теме \`${slug}\` «${title_en}» (скил topic-lesson, раздел «Видео»).
${bad ? `Прошлое видео не подошло: ${bad}.\n` : ''}${rejected.length ? `Не предлагай эти ссылки: ${rejected.map((x) => x.url).join(', ')}.\n` : ''}${videoRulesLine(rules)}
Ищи WebSearch'ем (по возможности с годом в запросе — нужны свежие). oEmbed, длительность, просмотры и язык проверит сервер — сам не проверяй.
Файлов не пиши и скриптов не запускай. Ответь только одним JSON:
{"candidates": [{"url": "https://www.youtube.com/watch?v=…", "title": "…", "channel": "…"}]} — до 5 штук, лучшее первым; не нашлось — пустой список.`;
}

const TEST_SYSTEM = 'Ты составляешь тест по учебному материалу для подготовки к собеседованию. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function topicTest({ lessonText, video, past, n, lang = 'en', numeric = false }) {
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
${numeric ? 'Доменный курс: не меньше 2 вопросов — задачи с числами по разделу Worked examples (посчитать маржу, своп, стоимость пункта и т.п.), варианты — числа.\n' : ''}Каждый вопрос — выбор из 4 вариантов, ровно один верный; неверные — правдоподобные, не абсурдные. Проверяй понимание
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

// ---------- W9 · разбор компании (docs/specs/35-company-research.md) ----------
function companyResearch({ company, domain, slug, vacancy, url }) {
  return `${BACKGROUND}

Задача: скил company-research (\`.claude/skills/company-research/SKILL.md\`), режим приложения.
Компания: ${company}${domain ? `, сайт ${domain}` : ''}${url ? `; ссылка вакансии: ${url}` : ''}.
Вакансия: \`vacancies/${vacancy}.md\` — её формулировки тоже сигнал.
Результат — строго \`knowledge-base/companies/${slug}.json\` (slug "${slug}"), одним Write. Больше ничего не пиши.`;
}

const COMPANY_SAY_SYSTEM = 'Ты сводишь ценности компании с реальным опытом кандидата для подготовки к интервью. Ничего не придумываешь. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function companySay({ research, cv, cards, stories }) {
  const vals = research.values.map((v) => `- ${v.name} [${v.strength}] — их слова: ${v.their_words.join(', ')}. ${v.meaning}`).join('\n');
  return `Ценности компании ${research.company} (из публичных источников):
${vals}

CV кандидата — единственный источник цифр:
\"\"\"
${cv.slice(0, 9000)}
\"\"\"

Карточки опыта (реестр, id — первая колонка):
${cards.slice(0, 6000)}
${stories.length ? `\nБанк историй (STAR): ${stories.map((x) => `${x.card}: ${x.title}`).join('; ')}\n` : ''}
Для каждой ценности со strength high или medium: какая карточка (id из реестра) лучше всего это подтверждает, как это подать
(angle, по-русски, 1 фраза) и одна фраза по-английски для интервью словами компании (phrase_en: только факты и цифры из CV,
просто, без leverage / delve / robust / seamless, без длинных тире). Нет подходящей карточки — card: null и gap: «надиктуй кейс про …» (по-русски).
Не натягивай: слабое совпадение хуже честного пробела.
"why_company" — 1–2 фразы по-русски от первого лица кандидата («мне близко…», «я строил…»): почему ему эта компания (через их задачу и его опыт), опора для «почему мы».

Верни JSON: {"say": [{"value": "<name ценности дословно>", "card": "<id>|null", "story": "название истории или пусто", "angle": "…", "phrase_en": "…", "gap": ""}],
"why_company": "…"}`;
}

// ---------- W9a · «почему мы» (docs/specs/36-why-us.md): один ход, контекст кладёт сервер ----------
const WHY_SYSTEM = 'Ты готовишь ответ кандидата на вопрос интервью «Why do you want to work here?» — по-английски, от его лица. Факты — только из данного. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function whyUs({ research, say, pain, cv, cards, voice, insights, dictation, prev, error }) {
  const r = research;
  const facts = [
    ...r.values.filter((v) => !v.unverified).slice(0, 5).map((v) => `- ценность «${v.name}» (их слова: ${v.their_words.join(', ')}): ${v.meaning} — ${v.evidence.map((e) => e.url).join(' ')}`),
    ...r.snapshot.news.filter((n) => n.url).map((n) => `- новость ${n.date || ''}: ${n.title} — ${n.url}`),
  ].join('\n');
  const src = r.sources.map((x) => x.url).slice(0, 10).join(' ');
  return `Компания ${r.company}: ${r.snapshot.what} ${r.snapshot.product ? `Продукт: ${r.snapshot.product}.` : ''} ${r.snapshot.stage ? `Стадия: ${r.snapshot.stage}.` : ''}
Источники общей справки: ${src}
Конкретика о компании (с ссылками — только их можно указывать в trace):
${facts}
${pain ? `\nЧто болит у компании (разбор вакансии): ${pain}\n` : ''}
Что сказать из опыта (подобрано раньше): ${say.say.filter((x) => x.card).map((x) => `${x.value} → карточка ${x.card}: ${x.angle}`).join('; ') || '—'}

CV кандидата — единственный источник цифр о нём:
\"\"\"
${cv.slice(0, 8000)}
\"\"\"
Реестр карточек (id — первая колонка):
${cards.slice(0, 4000)}
${voice ? `\nКак кандидат говорит (только манера, не факты):\n${voice.slice(0, 2500)}\n` : ''}${insights?.length ? `\nВзгляды кандидата (инсайты — не опыт, можно как «I believe …»):\n${insights.map((x) => `- [insight:${x.id}] ${x.essence}`).join('\n')}\n` : ''}
${dictation ? `Почему кандидату интересна компания — его надиктовка (основа части 1, держись близко к ней; деньги, удалёнку и уход с работы в ответ НЕ бери):\n\"\"\"\n${dictation.slice(0, 2000)}\n\"\"\"` : 'Надиктовки мотивации нет: строй часть 1 на совпадении их задачи с опытом кандидата, без выдуманных чувств и «давно пользуюсь продуктом».'}

Напиши два варианта ответа: "short" — 50–80 слов (~25 секунд вслух), "long" — 110–160 слов (~55 секунд).
Три части: (1) что именно в компании — их задача, продукт, новость или ценность, конкретно; (2) почему это моё — один факт опыта с цифрой из CV;
(3) что я сделаю у них или чему хочу научиться — без обещаний результата.
Правила: разговорно, предложения разной длины; без passionate, dream company, always admired, excited to, thrilled, perfect fit, leverage, delve,
robust, seamless, proven track record; без длинных тире; ни слова про деньги, удалёнку и прошлую работу как причину.
"theses_ru" — 3 тезиса по-русски, по одному на часть, чтобы сказать своими словами.
"trace" — каждое предложение обоих вариантов: {"variant": "short|long", "text": "предложение", "tag": "company|fact|motivation|link",
"url": "ссылка из списка выше (для company)", "card": "id карточки или cv (для fact)"}.
${error ? `\nПрошлый вариант не прошёл проверку: ${error}. Исправь.\nПрошлый вариант: ${prev}\n` : prev ? `\nНужен другой вариант, не похожий на прошлый: ${prev}\n` : ''}
Верни JSON: {"short": "…", "long": "…", "theses_ru": ["…", "…", "…"], "trace": [...]}`;
}

// C19: структура курса — агент с поиском по скилу course-outline
function courseOutline({ course, materials, library, out }) {
  return `${BACKGROUND}

Задача: скил course-outline (\`.claude/skills/course-outline/SKILL.md\`), режим приложения.
Курс «${course.title}» · тип: ${course.kind} · тема: ${course.topic} · уровень: ${course.level}
Цель: ${course.goal}
Время: ${course.hours_per_week} ч в неделю${course.weeks ? `, ${course.weeks} недель` : ', срок не задан'}.
${course.refs ? `На что опираться (от кандидата): ${course.refs}\n` : ''}${materials.length ? `Материалы кандидата:\n${materials.map((m) => `- ${m}`).join('\n')}\n` : ''}
Готовые уроки в библиотеке (не дублируй по смыслу; если урок нужен курсу — используй тот же slug):
${library.map((t) => `- ${t.slug}: ${t.title_en}`).join('\n') || '—'}

Результат — строго \`${out}\` по схеме скила.`;
}

// C19: пробный экзамен по всем урокам курса — один ход
const EXAM_SYSTEM = 'Ты составляешь пробный экзамен по учебному курсу в стиле сертификационного. Только по материалу уроков. Отвечай только одним JSON-объектом без пояснений и без markdown.';
function courseExam({ course, lessons, n, past }) {
  return `Курс «${course.title}». Цель: ${course.goal}
Уроки (slug и текст):
${lessons.map((l) => `=== ${l.slug} · ${l.title} ===\n${l.text.slice(0, 5000)}`).join('\n\n')}

Составь экзамен из ${n} вопросов на английском, как в сертификационном экзамене: сценарии («что сделает Product Owner…»), «выбери лучшее»,
понятия и роли${course.kind === 'domain' ? ', и не меньше 6 задач с числами (маржа, уровень маржи, своп, стоимость пункта и т.п.)' : ''}.
Покрой все уроки примерно поровну. Каждый вопрос — 4 варианта, ровно один верный; неверные — правдоподобные. Ответ однозначно следует из уроков.
"lesson" — slug урока, к которому относится вопрос. "explain" — почему верно, одна фраза по-русски.
${past.length ? `Эти вопросы уже были — не повторяй:\n${past.map((q) => `- ${q}`).join('\n')}\n` : ''}
Верни JSON: {"questions": [{"q": "…", "options": ["…", "…", "…", "…"], "answer": 0-3, "explain": "…", "lesson": "<slug>"}]}`;
}

// C19: повторение сданной темы перед интервью — выжимка на 3 минуты и 5 вопросов
const REVIEW_SYSTEM = 'Ты готовишь короткое повторение учебной темы перед собеседованием. Только по тексту урока. Отвечай только одним JSON-объектом без пояснений и без markdown.';
function topicReview({ lessonText, past }) {
  return `Урок:
"""
${lessonText.slice(0, 14000)}
"""

1. "summary" — выжимка на 3 минуты чтения, markdown на английском: главная мысль, 5–7 пунктов с ключевыми понятиями и формулами, 2–3 фразы «как сказать на интервью».
2. "questions" — 5 вопросов на английском, 4 варианта, один верный, на понимание, не на память. "explain" — одна фраза по-русски.
${past.length ? `Не повторяй эти вопросы:\n${past.map((q) => `- ${q}`).join('\n')}\n` : ''}
Верни JSON: {"summary": "…", "questions": [{"q": "…", "options": ["…", "…", "…", "…"], "answer": 0-3, "explain": "…"}]}`;
}

// C15: PDF или DOCX без стилей → формат CV.md, слово в слово
const CV_LAYOUT_SYSTEM = 'Ты раскладываешь текст CV в markdown. Не меняешь, не переводишь, не добавляешь и не убираешь ни одного слова. Возвращаешь только markdown, без пояснений и без ограждений кода.';

function cvLayout({ text }) {
  return `Разложи текст CV в формат:
# ИМЯ
Строка позиционирования
Контакты

## Раздел (Career Profile, Career Highlights, Experience, Education, Languages и т.п.)
Текст раздела
- Буллет

### Компания — Должность
Даты · формат работы
_Описание компании курсивом_
- Буллет

Весь текст — дословно, в исходном порядке. Переносы строк внутри абзаца и буллета склей. Символы буллетов замени на «- ».

Текст CV:
"""
${String(text).slice(0, 12000)}
"""`;
}

// C14: разбор прошлого тестового — агент читает рабочую папку по скилу test-debrief
function testDebrief({ slug, meta, files }) {
  return `${BACKGROUND}

Задача: скил test-debrief (\`.claude/skills/test-debrief/SKILL.md\`) для тестового \`test-tasks/${slug}/\`.
- Задание: \`test-tasks/${slug}/task.md\`; рабочая папка: \`test-tasks/${slug}/work/\` (${files} файлов). Читай только внутри \`test-tasks/${slug}/\`.
- Что известно: компания «${meta.company || '—'}», роль «${meta.role || '—'}», результат: ${meta.result || 'pending'}${meta.feedback ? `, фидбек компании: «${meta.feedback}»` : ''}${meta.hours ? `, часов: ${meta.hours}` : ''}.
- Плейбук (не дублируй то, что в нём уже есть): \`test-tasks/PLAYBOOK.md\`; библиотека: \`test-tasks/LIBRARY.md\`.

Результат — строго \`test-tasks/${slug}/debrief.md\` и \`test-tasks/${slug}/debrief.json\` по схеме скила. Ничего другого не меняй.`;
}

// C14: план нового тестового — один ход, весь контекст кладёт сервер
const TEST_PLAN_SYSTEM = 'Ты опытный наставник кандидата на роль продуктового и бизнес-лидера. Составляешь план выполнения тестового задания по этапам с опорой на его прошлые тестовые. Решения по сути задания оставляешь кандидату. Ничего не выдумываешь о компании и о библиотеке сверх данных. Отвечай только одним JSON-объектом без пояснений и без markdown.';

function testPlan({ meta, task, brief, fit, playbook, library, similar, types, prev, error }) {
  const b = fit?.buckets || {};
  return `Тестовое задание: ${meta.role || '—'}${meta.company ? ` в компании ${meta.company}` : ''}.${meta.due ? ` Срок сдачи: ${meta.due}.` : ''}${meta.budgetHours ? ` Кандидат готов потратить: ${meta.budgetHours} ч.` : ''}

## Текст задания
${task}

## Файлы задания
${brief.length ? brief.map((f) => `### ${f.name}${f.truncated ? ` (обрезано, всего ${f.chars} символов)` : ''}\n${f.text || '(текст не извлечён)'}`).join('\n\n') : '—'}

## Вакансия (из разбора)
${fit ? `Что болит: ${fit.pain || '—'}\nСитуация: ${fit.situation || '—'}\nМинимум: ${(b.minimum || []).join('; ') || '—'}\nЧто делать в роли: ${fit.what_you_do || '—'}` : 'разбора вакансии нет'}

## Плейбук кандидата — как он делает тестовые
${playbook}

## Библиотека готовых кусков (в "assets" — только эти id)
${library || 'пусто'}

## Похожие прошлые тестовые (разборы)
${similar.length ? similar.map((s) => `### ${s.slug} · ${s.type || ''} · результат: ${s.result}\n${s.debrief}`).join('\n\n') : 'похожих нет — опирайся на плейбук и поставь "new_type": true'}

## Что сделать
1. Пойми, что на самом деле оценивают (ход мысли, приоритизация, деньги, исполнение…) и что сдавать: формат, объём, срок, критерии — только из текста задания.
2. Разбей работу на 4–8 этапов. У этапа: цель, конкретный результат (файл, таблица, раздел ответа), часы, что решает кандидат ("me"),
   что делает агент ("agent"), id кусков библиотеки, которые брать ("assets"), и проверка в конце этапа ("checkpoint").
   Первый этап — понять задание и данные; последний — проверка перед сдачей и подготовка защиты. Сумма часов — в бюджете задания${meta.budgetHours ? ` и не больше ${meta.budgetHours} ч` : ''}.
3. Вопросы компании до старта — только те, ответ на которые меняет выводы; не больше 3; можно ни одного.
4. Риски и ловушки — из разборов прошлых тестовых и из самого задания (данные, формат, время).
Пиши по-русски, коротко и конкретно. Не решай задание за кандидата: никаких готовых выводов, диагнозов и цифр.
${error ? `\nПрошлый вариант не прошёл проверку: ${error}. Исправь.\nПрошлый вариант: ${prev}\n` : ''}
Верни JSON: {"type": "${Object.keys(types).join('|')}", "new_type": false,
 "understanding": {"evaluates": ["…"], "deliverables": ["…"], "format": "…", "budget_hours": 0, "deadline": "…"},
 "stages": [{"title": "…", "goal": "…", "result": "…", "hours": 0, "me": "…", "agent": "…", "assets": ["id"], "checkpoint": "…"}],
 "questions": [{"q": "…", "why": "что изменится в выводах"}], "risks": ["…"]}`;
}

// ---------- C22: симулятор A/B-тестов ----------
const SIM_SCENARIO_SYSTEM = 'Ты пишешь учебную ситуацию для тренажёра A/B-тестов: правдоподобный продукт, проблема и изменение в варианте B. Ты не знаешь и не придумываешь результат теста. Отвечай только одним JSON-объектом без пояснений и без markdown.';
const SIM_TRAP_HINT = {
  srm: 'вариант B добавляет шаг, который грузится отдельно (новая страница, редирект, внешний виджет оплаты) — естественное место, где часть пользователей может потеряться до учёта. Не упоминай никаких проблем с учётом.',
  novelty: 'вариант B — заметное визуальное изменение интерфейса (новый дизайн блока, новая подача).',
  weekday: 'у продукта разное поведение в будни и выходные (работа против досуга), изменение в B связано с этим ритмом.',
  tradeoff_rev: 'вариант B может поднять конверсию за счёт денег: скидка, более дешёвый тариф по умолчанию, ниже порог бесплатной доставки.',
  tradeoff_guard: 'вариант B — агрессивный приём роста (таймер срочности, предвыбранная опция, упрощённая регистрация без подтверждения), который может ударить по качеству: возвраты, отписки, жалобы, отток. Первая защитная метрика — именно такая, "better": "down".',
};
function simScenario({ level, levelTitle, industry, trap }) {
  return `Тренажёр A/B-тестов, уровень ${level} «${levelTitle}». Отрасль: ${industry}.
${SIM_TRAP_HINT[trap] ? `Каким должно быть изменение: ${SIM_TRAP_HINT[trap]}\n` : ''}
Правила:
- Продукт вымышленный, но правдоподобный для отрасли; без реальных брендов.
- Текст по-русски, названия метрик — как говорят в индустрии (можно английские термины).
- Не пиши, чем закончится тест, и не намекай на проблемы в данных; в названии теста — только суть изменения.
- Числа правдоподобны для отрасли: трафик в день на страницу теста, базовая конверсия (доля), средний чек.
- 1–2 защитные метрики, которые разумно смотреть для этого изменения (доля пользователей с событием), с базовым уровнем и направлением: "up" — чем больше, тем лучше, "down" — чем меньше.

Верни JSON:
{"title": "короткое название теста", "industry": "${industry}", "product": "что за продукт, 1–2 фразы", "context": "ситуация: что происходит в метриках, почему команда думает об изменении, 3–5 фраз",
 "problem": "проблема одной фразой", "change_a": "что видит пользователь в A (как сейчас)", "change_b": "что меняется в B, конкретно",
 "traffic_per_day": <целое>, "base_conv": <доля, напр. 0.0xx>, "aov": <средний чек>, "currency": "$|€|₽", "conv_name": "название главной конверсии, до 40 знаков", "rpv_name": "Revenue per visitor",
 "extra_metrics": [{"name": "до 40 знаков", "better": "up|down", "base": <доля>}], "primary_ok": ["conv"], "guard_must": ["…"]}
Числа — свои для этого продукта и отрасли (у тревела чек сотни, у мобильной игры — единицы, у B2B SaaS — сотни и тысячи), не копируй шаблон.
"primary_ok" — какие метрики разумно взять главной (из conv, rpv, g1, g2), "guard_must" — какие защитные обязательно смотреть.`;
}

// Свой тест: один ход с инструментом Read (только картинки), без контекста проекта; предлагает правдоподобные исходные цифры
const SIM_OWN_SYSTEM = 'Ты помогаешь превратить A/B-тест кандидата в учебную симуляцию. Читаешь только переданные скриншоты инструментом Read, ничего не пишешь и не ищешь. Финальный ответ — только один JSON-объект без пояснений и без markdown.';
function simOwn({ own, files }) {
  return `Ты помогаешь кандидату превратить его A/B-тест в учебную симуляцию (тренажёр CV Checker, раздел «Обучение → Симулятор»).
${files.length ? 'Сначала прочитай скриншоты инструментом Read (абсолютные пути ниже), потом ответь одним JSON-объектом.' : 'Ответь одним JSON-объектом.'}

Описание теста от кандидата:
"""
${own.description || '—'}
"""
Гипотеза: ${own.hypothesis || '—'}
Метрика (если указал): ${own.metric || '—'}
Отрасль (если указал): ${own.industry || '—'}
${files.length ? `Скриншоты вариантов:\n${files.map((f) => `- ${f}`).join('\n')}\n` : ''}
Задача:
1. Пойми, что меняется между A и B. Если по описанию и скриншотам это непонятно или неясно, на какую метрику изменение должно влиять, — не угадывай: верни {"ok": false, "questions": ["…"]} (2–5 вопросов по-русски).
2. Иначе предложи правдоподобные для отрасли исходные цифры и диапазон истинного эффекта (относительный, от −0.1 до +0.3) с обоснованием — на что похоже по известным бенчмаркам.
3. Перечисли риски, вероятные для такого изменения, из списка: novelty, srm, simpson, weekday, tradeoff_rev, tradeoff_guard.

Верни JSON:
{"ok": true, "title": "…", "industry": "…", "product": "…", "context": "3–5 фраз по-русски", "problem": "…", "change_a": "…", "change_b": "…",
 "traffic_per_day": <целое>, "base_conv": <доля>, "aov": <средний чек>, "currency": "$|€|₽", "conv_name": "до 40 знаков", "rpv_name": "Revenue per visitor",
 "extra_metrics": [{"name": "до 40 знаков", "better": "up|down", "base": <доля>}], "primary_ok": ["conv"], "guard_must": ["…"],
 "effect_range": [<от>, <до>], "rationale": "почему такие цифры и диапазон, 2–4 фразы", "risks": ["novelty"]}`;
}

const SIM_DEBRIEF_SYSTEM = 'Ты — строгий наставник по экспериментам (Growth / Product). Оцениваешь, как кандидат провёл учебный A/B-тест и обосновал решение. Без похвалы и без переписывания его ответа. Отвечай только одним JSON-объектом без пояснений и без markdown.';
function simDebrief({ scenario, truth, design, calc, decision, score, decisions, flags }) {
  const m = (k) => scenario.metrics.find((x) => x.key === k)?.name || k;
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
  return `Ситуация: ${scenario.title}. ${scenario.product} ${scenario.context}
A: ${scenario.change_a}
B: ${scenario.change_b}

Дизайн кандидата: гипотеза «${design.hypothesis || '—'}»; главная метрика — ${m(design.primary)}; защитные — ${design.guards.map(m).join(', ') || 'нет'};
MDE ${pct(design.mde)}, α ${design.alpha}, мощность ${design.power}, доля B ${design.split}, ${design.days} дн. (нужно по расчёту ≈ ${calc.daysNeeded} дн., ${calc.perArm} на вариант).

Данные на день решения (${decision.day} из ${design.days}): A ${decision.at.n.A}, B ${decision.at.n.B}; SRM p = ${decision.at.srm.p}.
${decision.at.metrics.map((x) => `- ${x.name}: A ${x.type === 'mean' ? x.a : pct(x.a)}, B ${x.type === 'mean' ? x.b : pct(x.b)}, отн. ${pct(x.rel)}, p = ${x.p}, P(B лучше) = ${x.bayes?.pBetter}`).join('\n')}

Решение кандидата: «${decisions[decision.decision]}». Заметил: ${decision.flags.map((f) => flags[f]).join(', ') || 'ничего не отметил'}.
Обоснование кандидата:
"""
${decision.reason || '(пусто)'}
"""

Правда (кандидат её не видел): ${truth.text}. Истинные эффекты: ${Object.entries(truth.effects).map(([k, v]) => `${m(k)} ${pct(v)}`).join(', ')}.
Оценка приложения: ${score.total}/100 (дизайн ${score.design}/30, процесс ${score.process}/30, решение ${score.decision}/40). Замечания: ${score.notes.join('; ') || 'нет'}.

Оцени ОБОСНОВАНИЕ (не только решение):
- "grade": 1–4 (4 — решение и логика как у сильного Growth PM: метрики, интервалы, риски, следующий шаг; 1 — решение по одному p-value или без логики);
- "verdict": одна-две фразы по-русски, по существу;
- "missed": 1–4 пункта, что упущено в рассуждении (конкретно: какую цифру не посмотрел, какой риск не назвал);
- "strong": 2–4 тезиса, на что опирался бы сильный кандидат (не переписывай его текст);
- "interview": 2–3 фразы на английском — как коротко объяснить решение CPO на интервью, с цифрами из данных.
Верни JSON: {"grade": 3, "verdict": "…", "missed": ["…"], "strong": ["…"], "interview": "…"}`;
}

module.exports = { simScenario, SIM_SCENARIO_SYSTEM, simOwn, SIM_OWN_SYSTEM, simDebrief, SIM_DEBRIEF_SYSTEM, reqMatch, REQ_MATCH_SYSTEM, reqSuggest, REQ_SUGGEST_SYSTEM, courseOutline, courseExam, EXAM_SYSTEM, topicReview, REVIEW_SYSTEM, topicsMatch, TOPICS_MATCH_SYSTEM, cvLayout, CV_LAYOUT_SYSTEM, testDebrief, testPlan, TEST_PLAN_SYSTEM, interviewerQuestions, HRQ_SYSTEM, answerFacts, ANSWER_FACTS_SYSTEM, whyUs, WHY_SYSTEM, companyResearch, companySay, COMPANY_SAY_SYSTEM, insightParse, INSIGHT_SYSTEM, interviewTopics, TOPICS_SYSTEM, topicLesson, topicVideo, topicTest, TEST_SYSTEM, topicTranslate, TRANSLATE_SYSTEM,
  applyMessage, APPLY_MSG_SYSTEM, fit, fitQuick, FIT_QUICK_SYSTEM, tailor, letter, letterGenerate, voiceProfile, outline, caseRound1, caseRound2, caseScan, formFill, verdict, outreach, interviewPrep, practice, keywords, masterImport, answers, answerRedo, edtechCompanies, sectorCompany };
