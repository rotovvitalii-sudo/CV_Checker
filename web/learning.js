// W8 · библиотека тем для подготовки к собеседованию (docs/specs/33-interview-topics.md).
// knowledge-base/learning/<slug>/: lesson.en.md, lesson.ru.md, meta.json, attempts.jsonl, test-current.json.
// Тема общая для всех вакансий: сдана — значит сдана везде, пока не истёк срок (profile.json → topic_valid_days).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LEARN = path.join(ROOT, 'knowledge-base', 'learning');
const PASS = 0.8;
const QUESTIONS = 8;
const VALID_DAYS = 90;
const DAY = 864e5;

const slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,59}$/.test(String(s || ''));
const dir = (slug) => path.join(LEARN, slug);
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function validDays() {
  const n = Number(readJSON(path.join(ROOT, 'knowledge-base', 'profile.json'), {}).topic_valid_days);
  return Number.isFinite(n) && n >= 7 ? Math.round(n) : VALID_DAYS;
}

const meta = (slug) => readJSON(path.join(dir(slug), 'meta.json'));
const lesson = (slug, lang = 'en') => readText(path.join(dir(slug), `lesson.${lang}.md`));
function attempts(slug) {
  return readText(path.join(dir(slug), 'attempts.jsonl')).split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Сдана, если последняя успешная попытка не старше срока годности
function status(slug, now = Date.now()) {
  const m = meta(slug);
  const log = attempts(slug);
  const pass = log.filter((a) => a.passed).slice(-1)[0] || null;
  const days = validDays();
  const expired = !!pass && now - Date.parse(pass.at) > days * DAY;
  return {
    slug, hasLesson: !!lesson(slug, 'en'), hasRu: !!lesson(slug, 'ru'), title_en: m?.title_en || '', title_ru: m?.title_ru || '',
    video: m?.video || null, passed: !!pass && !expired, expired, passedAt: pass?.at || null,
    score: pass ? pass.score : null, attempts: log.length, lastScore: log.length ? log[log.length - 1].score : null,
    hasTest: fs.existsSync(path.join(dir(slug), 'test-current.json')), validDays: days,
  };
}

function library() {
  if (!fs.existsSync(LEARN)) return [];
  return fs.readdirSync(LEARN).filter((s) => slugOk(s) && fs.existsSync(path.join(dir(s), 'meta.json')))
    .map((s) => ({ slug: s, title_en: meta(s)?.title_en || s }));
}

// ---------- темы вакансии ----------
const topicsFile = (outDir) => path.join(outDir, '08-topics.json');
function vacancyTopics(outDir) {
  const t = readJSON(topicsFile(outDir));
  return t && Array.isArray(t.topics) ? t : null;
}

// Ответ модели → 4–8 тем без дублей; slug из библиотеки переиспользуется
function normTopics(raw) {
  const list = Array.isArray(raw?.topics) ? raw.topics : [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const slug = String(t?.slug || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!slugOk(slug) || seen.has(slug) || !t.title_en) continue;
    seen.add(slug);
    out.push({ slug, title_en: String(t.title_en).trim(), title_ru: String(t.title_ru || t.title_en).trim(),
      why: { cv_line: String(t.why?.cv_line || '').trim(), requirement: String(t.why?.requirement || '').trim() },
      priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium' });
  }
  return out.slice(0, 8);
}

function readiness(outDir) {
  const t = vacancyTopics(outDir);
  if (!t || !t.topics.length) return null;
  const passed = t.topics.filter((x) => status(x.slug).passed).length;
  return { passed, total: t.topics.length };
}

// ---------- тест ----------
// Варианты перемешиваем на сервере (модели любят ставить верный первым); верные ответы клиенту не уходят
function normTest(raw) {
  const qs = (Array.isArray(raw?.questions) ? raw.questions : []).filter((q) => q && q.q && Array.isArray(q.options) && q.options.length === 4
    && Number.isInteger(Number(q.answer)) && Number(q.answer) >= 0 && Number(q.answer) < 4).slice(0, QUESTIONS);
  if (qs.length < 6) throw new Error(`тест: ${qs.length} корректных вопросов из ${QUESTIONS}`);
  return qs.map((q) => {
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    return { id: crypto.randomUUID().slice(0, 6), q: String(q.q).trim(), options: order.map((i) => String(q.options[i]).trim()),
      answer: order.indexOf(Number(q.answer)), explain: String(q.explain || '').trim(), section: String(q.section || '').trim(),
      from: q.from === 'video' ? 'video' : 'lesson' };
  });
}
function saveTest(slug, questions) {
  fs.writeFileSync(path.join(dir(slug), 'test-current.json'), JSON.stringify({ at: new Date().toISOString(), questions }, null, 2));
}
function publicTest(slug) {
  const t = readJSON(path.join(dir(slug), 'test-current.json'));
  if (!t) return null;
  return { at: t.at, questions: t.questions.map(({ id, q, options, from }) => ({ id, q, options, from })) };
}
// Тексты прошлых вопросов — чтобы пересдача была новым набором
const pastQuestions = (slug) => attempts(slug).flatMap((a) => a.questions || []).slice(-24);

function grade(slug, answers) {
  const f = path.join(dir(slug), 'test-current.json');
  const t = readJSON(f);
  if (!t) throw new Error('теста нет — нажми «Тема изучена»');
  const res = t.questions.map((q) => ({ id: q.id, q: q.q, chosen: Number.isInteger(answers?.[q.id]) ? answers[q.id] : null,
    correct: q.answer, ok: answers?.[q.id] === q.answer, explain: q.explain, section: q.section, options: q.options }));
  const right = res.filter((r) => r.ok).length;
  const score = right / res.length;
  const rec = { at: new Date().toISOString(), right, total: res.length, score: Math.round(score * 100) / 100, passed: score >= PASS,
    questions: t.questions.map((q) => q.q) };
  fs.appendFileSync(path.join(dir(slug), 'attempts.jsonl'), `${JSON.stringify(rec)}\n`);
  fs.rmSync(f, { force: true });
  return { ...rec, wrong: res.filter((r) => !r.ok) };
}

module.exports = { LEARN, PASS, QUESTIONS, slugOk, dir, meta, lesson, attempts, status, library, vacancyTopics, topicsFile,
  normTopics, readiness, normTest, saveTest, publicTest, pastQuestions, grade, validDays };
