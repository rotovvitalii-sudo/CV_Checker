// C19: курсы (docs/specs/44-courses.md) — knowledge-base/learning/courses/<slug>/course.json, материалы, пробный экзамен.
// Урок курса — тема общей библиотеки knowledge-base/learning/<slug>/ (урок, видео, перевод, тест — как W8).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const learning = require('./learning');

const DIR = path.join(learning.LEARN, 'courses');
const KINDS = { role: 'роль', domain: 'домен', skill: 'навык' };
const LEVELS = { beginner: 'с нуля', intermediate: 'средний', advanced: 'продвинутый' };
const LESSON_MIN = 30; // урок + видео + тест
const EXAM = { role: { questions: 40, minutes: 30, pass: 0.85 }, domain: { questions: 40, minutes: 45, pass: 0.8 }, skill: { questions: 30, minutes: 30, pass: 0.8 } };
const GRACE_S = 60; // запас на отправку после таймера

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,59}$/.test(String(s || ''));
const toSlug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const cdir = (slug) => { if (!slugOk(slug)) throw err(400, 'bad name'); return path.join(DIR, slug); };
const file = (slug) => path.join(cdir(slug), 'course.json');

function get(slug) {
  const c = readJSON(file(slug));
  if (!c) throw err(404, 'нет такого курса');
  return c;
}
const save = (slug, c) => writeJSON(file(slug), { ...c, slug, updated: now() });
const lessons = (c) => (c.modules || []).flatMap((m, mi) => (m.lessons || []).map((l) => ({ ...l, module: m.title, mi })));

function create(b) {
  const title = String(b.title || '').trim();
  if (!title || !String(b.goal || '').trim()) throw err(400, 'нужны название и цель');
  let slug = toSlug(b.slug || title) || `course-${crypto.randomUUID().slice(0, 6)}`;
  for (let i = 2; fs.existsSync(path.join(DIR, slug)); i++) slug = `${toSlug(title)}-${i}`;
  const kind = KINDS[b.kind] ? b.kind : 'role';
  const c = { slug, title, kind, topic: String(b.topic || title).trim(), goal: String(b.goal).trim(), level: LEVELS[b.level] ? b.level : 'intermediate',
    hours_per_week: Math.max(0.5, Number(b.hours_per_week) || 3), weeks: Number(b.weeks) > 0 ? Number(b.weeks) : null,
    refs: String(b.refs || '').trim(), exam: { ...EXAM[kind] }, materials: [], modules: [], sources: [], status: 'draft', created: now() };
  save(slug, c);
  return c;
}

// Структура от агента (outline.json) → модули и уроки; slug урока уникален в курсе и не пересекается с чужой темой случайно
function normOutline(raw) {
  const seen = new Set();
  const modules = (Array.isArray(raw?.modules) ? raw.modules : []).map((m) => ({
    title: String(m?.title || '').trim().slice(0, 120),
    lessons: (Array.isArray(m?.lessons) ? m.lessons : []).map((l) => {
      let slug = toSlug(l?.slug || l?.title_en);
      if (!slugOk(slug) || seen.has(slug)) return null;
      seen.add(slug);
      return { slug, title_en: String(l.title_en || '').trim().slice(0, 140), title_ru: String(l.title_ru || l.title_en || '').trim().slice(0, 140),
        goal: String(l.goal || '').trim().slice(0, 400), covers: (Array.isArray(l.covers) ? l.covers : []).map((x) => String(x).slice(0, 160)).slice(0, 8),
        minutes: Math.min(30, Math.max(10, Number(l.minutes) || 20)) };
    }).filter((l) => l && l.title_en),
  })).filter((m) => m.title && m.lessons.length);
  const sources = (Array.isArray(raw?.sources) ? raw.sources : []).filter((x) => /^https?:\/\//.test(x?.url || '')).map((x) => ({ title: String(x.title || x.url).slice(0, 160), url: x.url })).slice(0, 15);
  return { modules, sources, glossary: (Array.isArray(raw?.glossary) ? raw.glossary : []).map(String).slice(0, 60) };
}

// Правка структуры из интерфейса: названия, цели, порядок, новые уроки; сделанные уроки остаются в библиотеке как есть
function setModules(slug, modules) {
  const c = get(slug);
  const old = Object.fromEntries(lessons(c).map((l) => [l.slug, l]));
  const seen = new Set();
  c.modules = (Array.isArray(modules) ? modules : []).map((m) => ({
    title: String(m?.title || '').trim().slice(0, 120) || 'Модуль',
    lessons: (Array.isArray(m?.lessons) ? m.lessons : []).map((l) => {
      let slug = slugOk(l?.slug) ? l.slug : toSlug(l?.title_en);
      if (!slugOk(slug)) return null;
      if (seen.has(slug)) return null;
      seen.add(slug);
      const o = old[slug] || {};
      return { ...o, slug, title_en: String(l.title_en || o.title_en || '').trim().slice(0, 140), title_ru: String(l.title_ru || o.title_ru || l.title_en || '').trim().slice(0, 140),
        goal: String(l.goal ?? o.goal ?? '').trim().slice(0, 400), minutes: o.minutes || 20 };
    }).filter((l) => l && l.title_en),
  })).filter((m) => m.lessons.length);
  save(slug, c);
  return c;
}

// Урок курса → тема из библиотеки (сверка как у вакансии): совпавший получает slug готового урока
function applyMatches(slug, matches) {
  const c = get(slug);
  const all = lessons(c);
  const mapped = learning.applyMatches(all.map((l) => ({ ...l, why: { requirement: l.goal } })), matches);
  let i = 0;
  for (const m of c.modules) m.lessons = m.lessons.map((l) => { const x = mapped[i++]; return { ...l, slug: x.slug, reused: !!x.reused }; });
  save(slug, c);
  return c;
}

// Прогресс и план по неделям при заданных часах
function progress(c, at = Date.now()) {
  const ls = lessons(c).map((l) => ({ ...l, ...learning.status(l.slug), title_en: l.title_en, title_ru: l.title_ru }));
  const passed = ls.filter((l) => l.passed).length;
  const perWeek = Math.max(1, Math.floor((c.hours_per_week * 60) / LESSON_MIN));
  const weeksNeeded = Math.ceil(ls.length / perWeek);
  const week = c.approved ? Math.floor((at - Date.parse(c.approved)) / (7 * 864e5)) : 0;
  const examPassed = !!readAttempts(c.slug).find((a) => a.passed);
  return {
    lessons: ls, passed, total: ls.length, expired: ls.filter((l) => l.expired).length, perWeek, weeksNeeded, week: week + 1,
    thisWeek: ls.slice(week * perWeek, (week + 1) * perWeek).map((l) => l.slug), behind: Math.max(0, Math.min(ls.length, (week + 1) * perWeek) - passed),
    minutesLeft: ls.filter((l) => !l.passed).length * LESSON_MIN, examPassed, done: ls.length > 0 && passed === ls.length && examPassed,
  };
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((s) => slugOk(s) && fs.existsSync(path.join(DIR, s, 'course.json'))).map((s) => {
    const c = get(s);
    const p = progress(c);
    return { slug: s, title: c.title, kind: c.kind, goal: c.goal, level: c.level, status: c.status, hours_per_week: c.hours_per_week,
      passed: p.passed, total: p.total, examPassed: p.examPassed, done: p.done, created: c.created };
  }).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// Темы → в каких курсах (для «Все темы» и вакансий)
function coursesOf(slug) {
  return list().filter((c) => lessons(get(c.slug)).some((l) => l.slug === slug)).map((c) => ({ slug: c.slug, title: c.title }));
}

// ---------- материалы ----------
const matDir = (slug) => path.join(cdir(slug), 'materials');
function addMaterial(slug, name, buf) {
  const c = get(slug);
  const clean = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  if (!/\.(pdf|docx|md|txt)$/i.test(clean)) throw err(400, 'PDF, DOCX, MD или TXT');
  fs.mkdirSync(matDir(slug), { recursive: true });
  fs.writeFileSync(path.join(matDir(slug), clean), buf);
  c.materials = [...(c.materials || []).filter((m) => m.file !== clean), { type: 'file', file: clean, at: now() }];
  save(slug, c);
  return clean;
}
function addLink(slug, url, title) {
  if (!/^https?:\/\//.test(String(url || ''))) throw err(400, 'нужна ссылка http(s)');
  const c = get(slug);
  c.materials = [...(c.materials || []), { type: 'link', url: String(url).slice(0, 500), title: String(title || '').slice(0, 160), at: now() }];
  save(slug, c);
}
function removeMaterial(slug, i) {
  const c = get(slug);
  const m = (c.materials || [])[i];
  if (!m) throw err(404, 'нет такого материала');
  if (m.type === 'file') { fs.rmSync(path.join(matDir(slug), m.file), { force: true }); fs.rmSync(path.join(matDir(slug), '_text', `${m.file}.txt`), { force: true }); }
  c.materials.splice(i, 1);
  save(slug, c);
}
// Пути, которые читает агент: текстовая версия файла (PDF / DOCX → _text/*.txt), ссылки — как есть
function materialRefs(slug) {
  const c = get(slug);
  const rel = (p) => path.relative(path.resolve(DIR, '..', '..', '..'), p);
  return (c.materials || []).map((m) => (m.type === 'link' ? `ссылка: ${m.url}${m.title ? ` (${m.title})` : ''}`
    : `файл: ${rel(fs.existsSync(path.join(matDir(slug), '_text', `${m.file}.txt`)) ? path.join(matDir(slug), '_text', `${m.file}.txt`) : path.join(matDir(slug), m.file))}`));
}

// Контекст урока для агента: цель курса, модуль, соседние уроки, материалы
function lessonContext(slug, lessonSlug) {
  const c = get(slug);
  const ls = lessons(c);
  const i = ls.findIndex((l) => l.slug === lessonSlug);
  if (i < 0) throw err(404, 'нет такого урока в курсе');
  return { slug: c.slug, title: c.title, kind: c.kind, goal: c.goal, level: LEVELS[c.level], module: ls[i].module, lesson: ls[i], n: i + 1, total: ls.length,
    prev: ls.slice(0, i).map((l) => l.title_en), next: ls.slice(i + 1).map((l) => l.title_en), glossary: c.glossary || [], materials: materialRefs(slug) };
}

// ---------- пробный экзамен ----------
const examFile = (slug) => path.join(cdir(slug), 'exam-current.json');
const attemptsFile = (slug) => path.join(cdir(slug), 'exam-attempts.jsonl');
function readAttempts(slug) {
  try { return fs.readFileSync(attemptsFile(slug), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function normExam(raw, c) {
  const known = new Set(lessons(c).map((l) => l.slug));
  const qs = (Array.isArray(raw?.questions) ? raw.questions : []).filter((q) => q && q.q && Array.isArray(q.options) && q.options.length === 4
    && Number.isInteger(Number(q.answer)) && Number(q.answer) >= 0 && Number(q.answer) < 4);
  if (qs.length < Math.round(c.exam.questions * 0.8)) throw new Error(`экзамен: ${qs.length} корректных вопросов из ${c.exam.questions}`);
  return qs.slice(0, c.exam.questions).map((q) => {
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    return { id: crypto.randomUUID().slice(0, 6), q: String(q.q).trim(), options: order.map((i) => String(q.options[i]).trim()), answer: order.indexOf(Number(q.answer)),
      explain: String(q.explain || '').trim(), lesson: known.has(q.lesson) ? q.lesson : null };
  });
}
const saveExam = (slug, questions) => writeJSON(examFile(slug), { at: now(), started: null, questions });
function publicExam(slug) {
  const e = readJSON(examFile(slug));
  if (!e) return null;
  const c = get(slug);
  return { at: e.at, started: e.started, minutes: c.exam.minutes, pass: c.exam.pass, total: e.questions.length,
    questions: e.started ? e.questions.map(({ id, q, options }) => ({ id, q, options })) : [] };
}
function startExam(slug) {
  const e = readJSON(examFile(slug));
  if (!e) throw err(400, 'экзамена ещё нет');
  if (!e.started) { e.started = now(); writeJSON(examFile(slug), e); }
  return publicExam(slug);
}
function gradeExam(slug, answers) {
  const c = get(slug);
  const e = readJSON(examFile(slug));
  if (!e?.started) throw err(400, 'экзамен не начат');
  const spent = (Date.now() - Date.parse(e.started)) / 1000;
  const late = spent > c.exam.minutes * 60 + GRACE_S;
  const res = e.questions.map((q) => ({ id: q.id, q: q.q, options: q.options, chosen: Number.isInteger(answers?.[q.id]) ? answers[q.id] : null, correct: q.answer,
    ok: !late && answers?.[q.id] === q.answer, explain: q.explain, lesson: q.lesson }));
  const right = res.filter((r) => r.ok).length;
  const score = Math.round((right / res.length) * 100) / 100;
  const titles = Object.fromEntries(lessons(c).map((l) => [l.slug, l.title_en]));
  const byLesson = {};
  for (const r of res.filter((x) => !x.ok && x.lesson)) byLesson[r.lesson] = (byLesson[r.lesson] || 0) + 1;
  const rec = { at: now(), right, total: res.length, score, passed: !late && score >= c.exam.pass, minutes: Math.round(spent / 60), late, questions: e.questions.map((q) => q.q) };
  fs.appendFileSync(attemptsFile(slug), `${JSON.stringify(rec)}\n`);
  fs.rmSync(examFile(slug), { force: true });
  return { ...rec, wrong: res.filter((r) => !r.ok), weak: Object.entries(byLesson).sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ slug: s, title: titles[s] || s, wrong: n })) };
}
const pastExamQuestions = (slug) => readAttempts(slug).flatMap((a) => a.questions || []).slice(-80);

// ---------- повторение темы (сдана в курсе, всплыла в вакансии) ----------
const reviewFile = (slug) => path.join(learning.dir(slug), 'review.json');
function normReview(raw) {
  const qs = (Array.isArray(raw?.questions) ? raw.questions : []).filter((q) => q && q.q && Array.isArray(q.options) && q.options.length === 4
    && Number.isInteger(Number(q.answer)) && Number(q.answer) >= 0 && Number(q.answer) < 4).slice(0, 5);
  if (!String(raw?.summary || '').trim() || qs.length < 3) throw new Error('повторение: нет выжимки или вопросов');
  return { at: now(), summary: String(raw.summary).trim(), questions: qs.map((q) => {
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    return { id: crypto.randomUUID().slice(0, 6), q: String(q.q).trim(), options: order.map((i) => String(q.options[i]).trim()), answer: order.indexOf(Number(q.answer)), explain: String(q.explain || '').trim() };
  }) };
}
function publicReview(slug) {
  const r = readJSON(reviewFile(slug));
  return r ? { at: r.at, summary: r.summary, questions: r.questions.map(({ id, q, options }) => ({ id, q, options })), last: r.last || null } : null;
}
function gradeReview(slug, answers) {
  const r = readJSON(reviewFile(slug));
  if (!r) throw err(400, 'повторения нет');
  const res = r.questions.map((q) => ({ q: q.q, options: q.options, chosen: answers?.[q.id] ?? null, correct: q.answer, ok: answers?.[q.id] === q.answer, explain: q.explain }));
  r.last = { at: now(), right: res.filter((x) => x.ok).length, total: res.length };
  writeJSON(reviewFile(slug), r);
  return { ...r.last, wrong: res.filter((x) => !x.ok) };
}

module.exports = { DIR, KINDS, LEVELS, EXAM, LESSON_MIN, slugOk, cdir, get, save, lessons, create, normOutline, setModules, applyMatches, progress, list, coursesOf,
  addMaterial, addLink, removeMaterial, matDir, materialRefs, lessonContext, normExam, saveExam, publicExam, startExam, gradeExam, readAttempts, pastExamQuestions,
  reviewFile, normReview, publicReview, gradeReview };
