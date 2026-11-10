// ---------- обучение: курсы (C19, docs/specs/44-courses.md) ----------
// #/learn — курсы; #/learn/topics — все темы библиотеки; #/learn/new — новый курс; #/learn/c/<slug> — курс.
// Урок курса — тема общей библиотеки: панель урока та же, что в «Углубиться в темы» (renderTopic / bindTopic).

let learnData = null;
let learnTimer = null;
let courseEdit = null;     // правка структуры: копия модулей
let courseSig = '';
let examAnswers = {};
let examResult = null;
let examTick = null;

const COURSE_JOB_LABEL = { outline: 'Opus собирает структуру курса: ищет программы и источники…', courseexam: 'Составляю пробный экзамен…' };

async function loadLearn(r) {
  clearTimeout(learnTimer);
  clearInterval(examTick);
  if (typeof simTimer !== 'undefined') clearTimeout(simTimer);
  const sub = r.sub || '';
  if (sub === 'sim' || sub.startsWith('sim/')) return loadSim(sub);
  if (sub.startsWith('c/')) return renderCourse(sub.slice(2));
  if (sub === 'new') return renderCourseNew();
  const root = $('#learnView');
  if (!learnData) root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Читаю курсы…</div></div>';
  try { learnData = await api('/api/learn'); } catch (e) { root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`; return; }
  const d = learnData;
  const tabs = [['', `Курсы · ${d.courses.length}`], ['topics', `Все темы · ${d.topics.length}`], ['sim', 'Симулятор']];
  root.innerHTML = `<div class="page-wrap">
    <section class="home-head">
      <div><h1>Обучение</h1>
        <p class="lead">Курсы по роли или домену: структура → уроки с видео → тесты → пробный экзамен. Уроки — общая библиотека с подготовкой к интервью: сданное засчитывается везде. Симулятор — практика A/B-тестов.</p></div>
      <a class="btn primary" href="#/learn/new">+ Новый курс</a>
    </section>
    <section class="stack">
      <div class="seg" role="group" aria-label="Раздел обучения">${tabs.map(([k, l]) => `<button type="button" data-ltab="${k}" aria-pressed="${sub === k}">${l}</button>`).join('')}</div>
      ${sub === 'topics' ? learnTopicsHtml(d) : learnCoursesHtml(d)}
    </section></div>`;
  root.querySelectorAll('[data-ltab]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.ltab ? `#/learn/${b.dataset.ltab}` : '#/learn'; }));
}

function learnCoursesHtml(d) {
  if (!d.courses.length) return '<div class="table-box empty-box">Курсов пока нет. «+ Новый курс»: тема, цель, уровень и сколько часов в неделю — агент соберёт структуру, ты её поправишь и утвердишь.</div>';
  return `<div class="sug-list">${d.courses.map((c) => `<a class="ncard test-row" href="#/learn/c/${enc(c.slug)}">
      <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>${esc(c.title)}</strong>
        <span class="row" style="gap:6px"><span class="chip">${esc(d.kinds[c.kind] || c.kind)}</span>
          <span class="pill ${c.done ? 'good' : c.status === 'draft' ? 'neutral' : 'info'}">${c.done ? 'пройден' : c.status === 'draft' ? 'структура' : `${c.passed}/${c.total} уроков`}</span></span></div>
      <p class="muted small" style="margin:4px 0 0">${esc(c.goal)} · ${c.hours_per_week} ч в неделю${c.examPassed ? ' · экзамен сдан' : ''}</p>
      ${c.total ? `<div class="c-bar" style="margin-top:6px"><span style="width:${Math.round((c.passed / c.total) * 100)}%"></span></div>` : ''}</a>`).join('')}</div>`;
}

function learnTopicsHtml(d) {
  if (!d.topics.length) return '<div class="table-box empty-box">В библиотеке пока нет тем.</div>';
  const st = (t) => (t.passed ? '<span class="pill good">сдано</span>' : t.expired ? '<span class="pill warn">повторить</span>' : t.hasLesson ? '<span class="pill info">урок есть</span>' : '<span class="pill neutral">не начато</span>');
  return `<div class="table-box"><table class="apps"><thead><tr><th>Тема</th><th>Статус</th><th>Где</th></tr></thead><tbody>
    ${d.topics.map((t) => `<tr><td>${esc(t.title_en || t.slug)}${t.title_ru ? `<div class="muted small">${esc(t.title_ru)}</div>` : ''}</td><td>${st(t)}${t.score != null ? ` <span class="muted small">${Math.round(t.score * 100)}%</span>` : ''}</td>
      <td class="small">${[...t.courses.map((c) => `<a href="#/learn/c/${enc(c.slug)}">курс: ${esc(c.title)}</a>`), ...t.vacancies.slice(0, 3).map((v) => `<a href="#/v/${enc(v)}">${esc(v)}</a>`)].join('<br>')
        || '<span class="muted">—</span>'}${t.vacancies.length > 3 ? `<br><span class="muted">и ещё ${t.vacancies.length - 3}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- новый курс ----------
function renderCourseNew() {
  $('#learnView').innerHTML = `<div class="page-wrap"><a href="#/learn" class="back">← Обучение</a>
    <h1>Новый курс</h1>
    <p class="lead">Опиши, чему и зачем учиться. Opus найдёт, что обычно входит в такую программу, и соберёт модули и уроки — ты поправишь структуру до того, как создаются уроки.</p>
    <form class="card stack" id="courseNew">
      <div class="form-grid two">
        <label>Название<input name="title" required placeholder="Product Owner (PSPO I-style)"></label>
        <label>Тип<select name="kind"><option value="role">роль</option><option value="domain">домен</option><option value="skill">навык</option></select></label>
        <label>Уровень<select name="level"><option value="beginner">с нуля</option><option value="intermediate" selected>средний</option><option value="advanced">продвинутый</option></select></label>
        <label>Часов в неделю<input type="number" name="hours_per_week" min="0.5" step="0.5" value="5"></label>
        <label>Недель <span class="muted small">необязательно</span><input type="number" name="weeks" min="1" max="52"></label>
      </div>
      <label>Тема<input name="topic" placeholder="Scrum и роль Product Owner: ценность, бэклог, стейкхолдеры, Evidence-Based Management"></label>
      <label>Цель — зачем этот курс<textarea name="goal" rows="3" required placeholder="Сдать PSPO I и уверенно отвечать на интервью Product Owner"></textarea></label>
      <label>На что опираться <span class="muted small">ссылки или названия, необязательно</span><textarea name="refs" rows="2" placeholder="Scrum Guide 2020, scrum.org learning path PSPO"></textarea></label>
      <div class="row"><button type="submit" class="primary">Создать и собрать структуру</button><span class="hint" style="margin:0">Opus с поиском ≈ $1–1,5, 2–4 минуты. Уроки — потом, при первом открытии.</span></div>
      <p class="error" id="courseNewErr"></p>
    </form></div>`;
  $('#courseNew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { slug } = await api('/api/learn/courses', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      learnData = null;
      location.hash = `#/learn/c/${enc(slug)}`;
    } catch (err) { $('#courseNewErr').textContent = err.message; btn.disabled = false; }
  });
}

// ---------- курс ----------
async function renderCourse(slug, quiet = false) {
  clearTimeout(learnTimer);
  const root = $('#learnView');
  let d;
  try { d = await api(`/api/learn/courses/${enc(slug)}`); } catch (e) {
    root.innerHTML = `<div class="page-wrap"><a href="#/learn" class="back">← Обучение</a><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  if (location.hash !== `#/learn/c/${enc(slug)}`) return;
  const busy = Object.values(d.jobs).some(jobBusy);
  const sig = JSON.stringify([d.course.updated, Object.values(d.jobs).map((j) => j.state), d.progress.passed, !!d.exam, d.exam?.started]);
  if (!(quiet && sig === courseSig) && !(quiet && courseEdit)) {
    courseSig = sig;
    root.innerHTML = `<div class="page-wrap"><a href="#/learn" class="back">← Обучение</a>${courseHtml(d)}</div>`;
    bindCourse(d);
  }
  if (busy) learnTimer = setTimeout(() => { if (location.hash === `#/learn/c/${enc(slug)}`) renderCourse(slug, true); }, 4000);
}

const courseJobBox = (j, label) => (!j || (!jobBusy(j) && j.state !== 'error') ? ''
  : `<div class="running">${jobBusy(j) ? `<span class="spin"></span>${label}` : `<span class="error">Ошибка: ${esc(j.error)}</span>`}</div>${jobBusy(j) ? `<div class="feed" data-feed="${j.id}"></div>` : ''}`);

function courseHtml(d) {
  const c = d.course, p = d.progress;
  const draft = c.status === 'draft';
  const oBusy = jobBusy(d.jobs.outline);
  return `<section class="home-head">
      <div><h1>${esc(c.title)}</h1>
        <p class="lead"><span class="chip">${esc(d.kinds[c.kind])}</span> <span class="chip">${esc(d.levels[c.level])}</span> ${esc(c.goal)}</p></div>
      <div class="row">${draft ? '' : `<span class="pill ${p.done ? 'good' : 'info'}">${p.done ? 'курс пройден' : `сдано ${p.passed}/${p.total}`}</span>`}</div>
    </section>
    ${courseJobBox(d.jobs.outline, COURSE_JOB_LABEL.outline)}
    ${draft ? courseDraftHtml(d, oBusy) : coursePlanHtml(d)}
    ${draft ? '' : courseLessonsHtml(d)}
    ${draft ? '' : courseExamHtml(d)}
    ${courseMaterialsHtml(d)}
    ${(c.sources || []).length ? `<details class="card"><summary><strong>Источники структуры · ${c.sources.length}</strong></summary>${c.outlineNote ? `<p class="muted small">${esc(c.outlineNote)}</p>` : ''}
      <ul class="tight small">${c.sources.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ul></details>` : ''}
    <p class="row small">${draft ? '' : '<button type="button" class="link-btn inline" id="cEditStruct">править структуру</button> · '}<button type="button" class="link-btn inline" id="cDelete">удалить курс</button>
      <span class="muted">уроки останутся в библиотеке</span></p>`;
}

// Черновик: структура на утверждение, правка до генерации уроков
function courseDraftHtml(d, oBusy) {
  const c = d.course;
  if (!c.modules.length) {
    return `<section class="card">${oBusy ? '' : `<p class="muted">Структуры нет.</p><button type="button" class="primary small" id="cOutline">Собрать структуру (Opus ≈ $1–1,5)</button>`}</section>`;
  }
  const mods = courseEdit || c.modules;
  const total = mods.reduce((n, m) => n + m.lessons.length, 0);
  const perWeek = Math.max(1, Math.floor((c.hours_per_week * 60) / 30));
  return `<section class="card stack">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2 style="margin:0">Структура на утверждение</h2>
      <span class="muted small">${total} уроков · ≈ ${Math.ceil(total / perWeek)} нед. при ${c.hours_per_week} ч в неделю · урок ≈ $0.3–0.5 при первом открытии</span></div>
    ${c.outlineNote ? `<p class="muted small" style="margin:0">${esc(c.outlineNote)}</p>` : ''}
    <div class="c-struct">${mods.map((m, mi) => `<div class="c-mod">
      <div class="row" style="gap:6px"><input class="c-mod-title" data-mt="${mi}" value="${esc(m.title)}" aria-label="Название модуля">
        <button type="button" class="link-btn inline" data-mup="${mi}" title="модуль выше">↑</button><button type="button" class="link-btn inline" data-mdel="${mi}">удалить модуль</button></div>
      <ol class="c-lessons">${m.lessons.map((l, li) => `<li class="c-les">
        <div class="row" style="gap:6px;flex-wrap:wrap"><input data-lt="${mi}:${li}" value="${esc(l.title_en)}" aria-label="Урок">
          ${l.reused ? '<span class="chip info">урок уже в библиотеке</span>' : ''}
          <button type="button" class="link-btn inline" data-lup="${mi}:${li}" title="выше">↑</button>
          <button type="button" class="link-btn inline" data-ldown="${mi}:${li}" title="ниже">↓</button>
          ${mi > 0 ? `<button type="button" class="link-btn inline" data-lprev="${mi}:${li}" title="в прошлый модуль">⇡ модуль</button>` : ''}
          <button type="button" class="link-btn inline" data-ldel="${mi}:${li}">удалить</button></div>
        <input class="small c-goal" data-lg="${mi}:${li}" value="${esc(l.goal || '')}" placeholder="цель урока" aria-label="Цель урока">
        ${(l.covers || []).length ? `<div class="muted small">${l.covers.map(esc).join(' · ')}</div>` : ''}</li>`).join('')}</ol>
      <button type="button" class="link-btn inline small" data-ladd="${mi}">+ урок</button></div>`).join('')}</div>
    <div class="row"><button type="button" class="link-btn inline small" id="cModAdd">+ модуль</button></div>
    <div class="row" style="flex-wrap:wrap">
      <button type="button" class="small" id="cSave" ${courseEdit ? '' : 'disabled'}>Сохранить правки</button>
      <button type="button" class="primary small" id="cApprove">Утвердить и начать</button>
      <button type="button" class="small" id="cOutline" ${oBusy ? 'disabled' : ''}>Собрать заново (≈ $1–1,5)</button></div>
    <p class="error" id="cErr"></p></section>`;
}

function coursePlanHtml(d) {
  const p = d.progress;
  const left = Math.round(p.minutesLeft / 60 * 10) / 10;
  return `<section class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span><strong>Неделя ${p.week}</strong> · по плану ${p.perWeek} ${plural(p.perWeek, ['урок', 'урока', 'уроков'])} в неделю (${d.course.hours_per_week} ч), курс ≈ ${p.weeksNeeded} нед.</span>
      <span class="muted small">осталось ≈ ${left} ч${p.expired ? ` · повторить: ${p.expired}` : ''}${p.behind && !p.done ? ` · отстаёшь на ${p.behind}` : ''}</span></div>
    <div class="c-bar" style="margin-top:8px"><span style="width:${p.total ? Math.round((p.passed / p.total) * 100) : 0}%"></span></div></section>`;
}

function courseLessonsHtml(d) {
  const p = d.progress;
  const week = new Set(p.thisWeek);
  const byMod = [];
  for (const l of p.lessons) { if (!byMod[l.mi]) byMod[l.mi] = { title: l.module, list: [] }; byMod[l.mi].list.push(l); }
  const title = (t) => (topicLang === 'ru' ? t.title_ru : t.title_en) || t.title_en;
  return `<section class="card iv-sec topics">${byMod.filter(Boolean).map((m) => `<h3 class="st-h">${esc(m.title)}</h3>
    <ul class="tp-list">${m.list.map((t) => `<li class="tp-row ${openTopic === t.slug ? 'open' : ''}">
      <div class="tp-main"><button type="button" class="link-btn tp-title" data-ctopic="${esc(t.slug)}">${esc(title(t))}</button> ${topicPill(t)}
        ${week.has(t.slug) && !t.passed ? '<span class="chip info">на этой неделе</span>' : ''}${t.reused ? '<span class="chip">из библиотеки</span>' : ''}</div>
      ${t.goal ? `<div class="muted small">${esc(t.goal)}</div>` : ''}
      ${openTopic === t.slug ? '<div id="topicPanel" class="topic-panel"><p class="muted small"><span class="spin"></span>Загружаю урок…</p></div>' : ''}
    </li>`).join('')}</ul>`).join('')}</section>`;
}

function courseExamHtml(d) {
  const c = d.course, p = d.progress, e = d.exam;
  const j = d.jobs.courseexam;
  const last = d.examAttempts.slice(-1)[0];
  const allLessons = p.lessons.every((l) => l.hasLesson);
  const res = examResult?.slug === c.slug ? examResult : null;
  let body;
  if (jobBusy(j)) body = courseJobBox(j, COURSE_JOB_LABEL.courseexam);
  else if (e?.started) {
    body = `<form id="exForm" class="tp-form"><p class="row" style="justify-content:space-between"><strong>Идёт экзамен</strong><span class="mono" id="exTimer"></span></p>
      ${e.questions.map((q, n) => `<fieldset><legend>${n + 1}. ${esc(q.q)}</legend>${q.options.map((o, k) => `<label class="tp-opt"><input type="radio" name="${esc(q.id)}" value="${k}" ${examAnswers[q.id] === k ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</fieldset>`).join('')}
      <div class="row"><button type="submit" class="primary small">Сдать экзамен</button><span class="hint" style="margin:0" id="exLeft"></span></div></form>`;
  } else if (e) body = `<p class="small">Готово: ${e.total} вопросов, ${e.minutes} минут, проходной ${Math.round(e.pass * 100)}%. Таймер стартует по кнопке.</p><button type="button" class="primary small" id="exStart">Начать экзамен</button>`;
  else body = `<p class="muted small" style="margin:0 0 6px">${c.exam.questions} вопросов по всем урокам, ${c.exam.minutes} минут, проходной ${Math.round(c.exam.pass * 100)}%.
      ${p.passed < p.total ? `Лучше после всех уроков: сдано ${p.passed} из ${p.total}.` : ''}</p>
    <button type="button" class="${p.passed === p.total ? 'primary' : ''} small" id="exMake" ${allLessons ? '' : 'disabled'}>${last ? 'Новый экзамен' : 'Составить экзамен'} (≈ $0.1–0.2)</button>
    ${allLessons ? '' : '<span class="hint">сначала открой все уроки — экзамен строится по их тексту</span>'}`;
  return `<section class="card stack"><h2 style="margin:0">Пробный экзамен${p.examPassed ? ' · <span class="good-text">сдан</span>' : ''}</h2>
    ${res ? `<div class="banner ${res.passed ? 'good' : 'warn'}"><p style="margin:0"><strong>${res.right} из ${res.total} · ${Math.round(res.score * 100)}%</strong> за ${res.minutes} мин —
        ${res.passed ? 'экзамен сдан.' : res.late ? 'время вышло.' : `нужно ${Math.round(c.exam.pass * 100)}%.`}</p></div>
      ${res.weak.length ? `<p class="small">Больше всего ошибок: ${res.weak.slice(0, 4).map((w) => `<button type="button" class="link-btn inline" data-ctopic="${esc(w.slug)}">${esc(w.title)}</button> (${w.wrong})`).join(', ')}</p>` : ''}
      ${res.wrong.length ? `<details><summary class="small">Ошибки · ${res.wrong.length}</summary><ol class="tp-wrong">${res.wrong.map((w) => `<li><strong>${esc(w.q)}</strong>
        <div class="small">Твой ответ: ${w.chosen != null ? esc(w.options[w.chosen]) : '—'} · верно: <strong>${esc(w.options[w.correct])}</strong></div><div class="muted small">${esc(w.explain)}</div></li>`).join('')}</ol></details>` : ''}`
      : last ? `<p class="muted small" style="margin:0">Последняя попытка: ${Math.round(last.score * 100)}% за ${last.minutes} мин${last.passed ? ' — сдан' : ''}. Попыток: ${d.examAttempts.length}.</p>` : ''}
    ${j?.state === 'error' ? courseJobBox(j, '') : ''}${body}</section>`;
}

function courseMaterialsHtml(d) {
  const ms = d.course.materials || [];
  return `<details class="card" ${ms.length ? '' : ''}><summary><strong>Мои материалы · ${ms.length}</strong> <span class="muted small">уроки и структура опираются на них</span></summary>
    <ul class="tight small">${ms.map((m, i) => `<li>${m.type === 'link' ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title || m.url)}</a>` : esc(m.file)}
      <button type="button" class="link-btn inline" data-mrm="${i}">убрать</button></li>`).join('') || '<li class="muted">нет</li>'}</ul>
    <div class="row" style="gap:8px;flex-wrap:wrap"><label class="small">Файл (PDF, DOCX, MD, TXT) <input type="file" id="cMat" multiple></label></div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px"><input id="cLinkUrl" placeholder="https://…" aria-label="Ссылка"><input id="cLinkTitle" placeholder="название" aria-label="Название ссылки">
      <button type="button" class="small" id="cLinkAdd">Добавить ссылку</button></div>
    <p class="muted small" style="margin:6px 0 0">Новые материалы учитываются в уроках, которые создаются после загрузки, и при «Собрать заново».</p></details>`;
}

function bindCourse(d) {
  const slug = d.course.slug;
  const base = `/api/learn/courses/${enc(slug)}`;
  const reload = () => renderCourse(slug);
  for (const j of Object.values(d.jobs)) if (jobBusy(j)) attachFeed(j);
  $('#cOutline')?.addEventListener('click', async (e) => {
    if (d.course.modules.length && !confirm('Собрать структуру заново? Текущая заменится (созданные уроки останутся в библиотеке). Opus ≈ $1–1,5.')) return;
    e.target.disabled = true;
    try { await api(`${base}/outline`, { method: 'POST' }); } catch (err) { alert(err.message); }
    courseEdit = null;
    reload();
  });
  $('#cDelete')?.addEventListener('click', async () => {
    if (!confirm('Удалить курс? Уроки и сданные темы останутся в библиотеке.')) return;
    await api(base, { method: 'DELETE' });
    learnData = null;
    location.hash = '#/learn';
  });
  $('#cEditStruct')?.addEventListener('click', async () => {
    if (!confirm('Вернуть курс в правку структуры? Уроки и сдачи сохранятся.')) return;
    await api(base, { method: 'PATCH', body: { status: 'draft' } });
    reload();
  });
  bindCourseDraft(d, base, reload);
  // Уроки: та же панель, что в подготовке к интервью; задачи — по адресам курса
  document.querySelectorAll('[data-ctopic]').forEach((b) => b.addEventListener('click', () => {
    openTopic = openTopic === b.dataset.ctopic ? null : b.dataset.ctopic;
    topicResult = null;
    reload();
  }));
  if (openTopic && $('#topicPanel')) loadCourseTopic(d, reload);
  bindExam(d, base, reload);
  // Материалы
  $('#cMat')?.addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      const r = await fetch(`${base}/materials`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
      if (!r.ok) alert(`${f.name}: ${(await r.json().catch(() => ({}))).error || r.status}`);
    }
    reload();
  });
  $('#cLinkAdd')?.addEventListener('click', async () => {
    try { await api(`${base}/links`, { method: 'POST', body: { url: $('#cLinkUrl').value.trim(), title: $('#cLinkTitle').value.trim() } }); reload(); } catch (err) { alert(err.message); }
  });
  document.querySelectorAll('[data-mrm]').forEach((b) => b.addEventListener('click', async () => { await api(`${base}/materials/${b.dataset.mrm}`, { method: 'DELETE' }); reload(); }));
}

async function loadCourseTopic(d, reload) {
  const box = $('#topicPanel');
  const t = d.progress.lessons.find((x) => x.slug === openTopic);
  if (!box || !t) return;
  let data;
  try { data = await api(`/api/topics/${enc(t.slug)}?lang=${topicLang}`); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  if (!$('#topicPanel') || openTopic !== t.slug) return;
  const jobsFor = Object.fromEntries(Object.entries(d.jobs).filter(([, j]) => j.topic === t.slug));
  const ctx = { jobs: jobsFor, topicReload: reload,
    topicStart: async (p, body) => { try { await api(`/api/learn/courses/${enc(d.course.slug)}/${p}`, { method: 'POST', body: body || {} }); } catch (e) { alert(e.message); } reload(); } };
  box.innerHTML = renderTopic(ctx, t, data);
  bindTopic(ctx, t, data);
  for (const j of Object.values(jobsFor)) if (jobBusy(j)) attachFeed(j);
}

function bindCourseDraft(d, base, reload) {
  if (d.course.status !== 'draft' || !d.course.modules.length) return;
  const mods = () => (courseEdit = courseEdit || JSON.parse(JSON.stringify(d.course.modules)));
  const redraw = () => { const y = window.scrollY; $('#learnView').querySelector('.page-wrap').innerHTML = `<a href="#/learn" class="back">← Обучение</a>${courseHtml(d)}`; bindCourse(d); window.scrollTo(0, y); };
  const at = (v) => v.split(':').map(Number);
  document.querySelectorAll('[data-mt]').forEach((i) => i.addEventListener('input', () => { mods()[i.dataset.mt].title = i.value; $('#cSave').disabled = false; }));
  document.querySelectorAll('[data-lt]').forEach((i) => i.addEventListener('input', () => { const [m, l] = at(i.dataset.lt); mods()[m].lessons[l].title_en = i.value; $('#cSave').disabled = false; }));
  document.querySelectorAll('[data-lg]').forEach((i) => i.addEventListener('input', () => { const [m, l] = at(i.dataset.lg); mods()[m].lessons[l].goal = i.value; $('#cSave').disabled = false; }));
  const act = (sel, fn) => document.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => { fn(b); redraw(); }));
  act('[data-ldel]', (b) => { const [m, l] = at(b.dataset.ldel); mods()[m].lessons.splice(l, 1); });
  act('[data-lup]', (b) => { const [m, l] = at(b.dataset.lup); const ls = mods()[m].lessons; if (l > 0) [ls[l - 1], ls[l]] = [ls[l], ls[l - 1]]; });
  act('[data-ldown]', (b) => { const [m, l] = at(b.dataset.ldown); const ls = mods()[m].lessons; if (l < ls.length - 1) [ls[l + 1], ls[l]] = [ls[l], ls[l + 1]]; });
  act('[data-lprev]', (b) => { const [m, l] = at(b.dataset.lprev); const x = mods()[m].lessons.splice(l, 1)[0]; mods()[m - 1].lessons.push(x); });
  act('[data-ladd]', (b) => { const t = prompt('Урок (название по-английски)'); if (t) mods()[b.dataset.ladd].lessons.push({ title_en: t, title_ru: t, goal: '' }); });
  act('[data-mdel]', (b) => { if (confirm('Удалить модуль со всеми уроками?')) mods().splice(Number(b.dataset.mdel), 1); });
  act('[data-mup]', (b) => { const i = Number(b.dataset.mup); const ms = mods(); if (i > 0) [ms[i - 1], ms[i]] = [ms[i], ms[i - 1]]; });
  $('#cModAdd')?.addEventListener('click', () => { const t = prompt('Модуль'); if (t) { mods().push({ title: t, lessons: [] }); redraw(); } });
  const saveStruct = async () => {
    if (!courseEdit) return true;
    try { await api(`${base}/modules`, { method: 'PUT', body: { modules: courseEdit } }); courseEdit = null; return true; } catch (e) { $('#cErr').textContent = e.message; return false; }
  };
  $('#cSave')?.addEventListener('click', async () => { if (await saveStruct()) reload(); });
  $('#cApprove')?.addEventListener('click', async () => {
    if (!(await saveStruct())) return;
    try { await api(base, { method: 'PATCH', body: { status: 'active' } }); } catch (e) { $('#cErr').textContent = e.message; return; }
    reload();
  });
}

function bindExam(d, base, reload) {
  const slug = d.course.slug;
  $('#exMake')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    examResult = null;
    try { await api(`${base}/exam`, { method: 'POST' }); } catch (err) { alert(err.message); }
    reload();
  });
  $('#exStart')?.addEventListener('click', async () => {
    if (!confirm(`Начать экзамен? Таймер — ${d.exam.minutes} минут, останавливать нельзя.`)) return;
    examAnswers = {};
    try { await api(`${base}/exam/start`, { method: 'POST' }); } catch (err) { alert(err.message); }
    reload();
  });
  const form = $('#exForm');
  if (!form) return;
  const end = Date.parse(d.exam.started) + d.exam.minutes * 60000;
  clearInterval(examTick);
  const tick = () => {
    const s = Math.max(0, Math.round((end - Date.now()) / 1000));
    const el = $('#exTimer');
    if (!el) { clearInterval(examTick); return; }
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('warn-text', s < 300);
    if (!s) { clearInterval(examTick); form.requestSubmit(); }
  };
  tick();
  examTick = setInterval(tick, 1000);
  const left = () => { $('#exLeft').textContent = `без ответа: ${d.exam.questions.filter((q) => examAnswers[q.id] == null).length}`; };
  form.addEventListener('change', (e) => { if (e.target.name) examAnswers[e.target.name] = Number(e.target.value); left(); });
  left();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearInterval(examTick);
    try { examResult = { slug, ...(await api(`${base}/exam/submit`, { method: 'POST', body: { answers: examAnswers } })) }; } catch (err) { alert(err.message); return; }
    examAnswers = {};
    reload();
  });
}
