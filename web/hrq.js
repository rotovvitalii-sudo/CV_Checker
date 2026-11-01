// W10: мои вопросы к интервьюеру (docs/specs/38-interviewer-questions.md) — хранение, язык вакансии, проверка, слияние при перегенерации.
// Генерирует агент (Opus, один ход); здесь всё без агента.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = '10-interviewer-questions.json';
const STAGES = ['recruiter', 'hiring_manager', 'final'];
const STATUSES = ['todo', 'asked', 'skipped', 'moot']; // не задан / задан / не успел / отпал
const CATEGORIES = ['role', 'team', 'success', 'company', 'process'];
const BASIS = ['pain', 'news', 'value', 'gap', 'role', 'process'];
const LANGS = { en: 'английском', pl: 'польском', de: 'немецком', uk: 'украинском', ru: 'русском' };

const file = (dir) => path.join(dir, FILE);
const read = (dir) => { try { return JSON.parse(fs.readFileSync(file(dir), 'utf8')); } catch { return { stages: {} }; } };
function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir), `${JSON.stringify(data, null, 2)}\n`);
}
const newId = () => crypto.randomUUID().slice(0, 8);
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// Язык вакансии по тексту: польские буквы и служебные слова, кириллица, немецкие умляуты; иначе английский
// Файл вакансии начинается с нашего разбора по-русски — язык берём только из раздела «Текст вакансии»
function lang(text) {
  const raw = String(text || '');
  const at = raw.search(/^## Текст вакансии/m);
  const t = (at >= 0 ? raw.slice(at).replace(/^## Текст вакансии.*$/m, '') : raw.replace(/^---\n[\s\S]*?\n---\n/, '')).slice(0, 6000).toLowerCase();
  const n = t.length || 1;
  const cyr = (t.match(/[а-яёіїєґ]/g) || []).length;
  if (cyr / n > 0.2) return /[іїєґ]/.test(t) ? 'uk' : 'ru';
  const pl = (t.match(/[ąęśźżłńć]/g) || []).length + (t.match(/\b(oraz|jest|dla|się|będzie|wymagania|doświadczenie)\b/g) || []).length * 3;
  if (pl / n > 0.004) return 'pl';
  const de = (t.match(/[äöüß]/g) || []).length + (t.match(/\b(und|wir|sie|für|mit|erfahrung|kenntnisse)\b/g) || []).length * 3;
  if (de / n > 0.006) return 'de';
  return 'en';
}

const clip = (s, n) => String(s || '').trim().slice(0, n);
function normItem(x, extra = {}) {
  const b = x?.basis && typeof x.basis === 'object' ? x.basis : {};
  return {
    id: newId(), q: clip(x?.q, 400), goal: clip(x?.goal, 400), why: clip(x?.why, 600),
    basis: { type: BASIS.includes(b.type) ? b.type : 'role', ref: clip(b.ref, 200), url: /^https?:\/\//.test(b.url || '') ? clip(b.url, 400) : '' },
    category: CATEGORIES.includes(x?.category) ? x.category : 'role', top: !!x?.top, followup: clip(x?.followup, 300),
    manual: false, edited: false, status: 'todo', answer: '', answeredAt: null, ...extra,
  };
}
// Вопрос, который перегенерация не трогает: правленый, ручной или уже с отметкой
const kept = (it) => it.manual || it.edited || it.status !== 'todo';

// Темы, которые на звонке не поднимаем, и пустые вопросы
const STOP = /\b(salary|compensation|bonus|equity|stock options|vacation|paid time off|pto|holidays?|remote|work from home|hybrid)\b|what is (your|the) culture like|typical day/i;
function check(items, research, code, { full = true } = {}) {
  const issues = [];
  const urls = new Set(research ? [...research.sources.map((s) => s.url), ...research.snapshot.news.map((n) => n.url),
    ...research.values.flatMap((v) => v.evidence.map((e) => e.url))].filter(Boolean) : []);
  if (full && (items.length < 5 || items.length > 8)) issues.push(`вопросов ${items.length}, нужно 5–8`);
  const tops = items.filter((x) => x.top).length;
  if (full && tops !== 3) issues.push(`главных ${tops}, нужно ровно 3`);
  if (full && !items.some((x) => x.category === 'process')) issues.push('нет вопроса о следующих шагах');
  if (full && !items.some((x) => ['pain', 'news'].includes(x.basis.type))) issues.push('нет вопроса из «что болит» или новости');
  for (const x of items) {
    const tag = `«${x.q.slice(0, 40)}…»`;
    if (!x.q || !x.goal || !x.why) issues.push(`${tag}: нет вопроса, цели или аргументации`);
    if (words(x.q) > 30) issues.push(`${tag}: длиннее 30 слов`);
    if (STOP.test(x.q)) issues.push(`${tag}: тема не для этого звонка`);
    if (x.basis.url && !urls.has(x.basis.url)) issues.push(`${tag}: ссылка не из разбора компании`);
  }
  return { pass: !issues.length, issues, lang: code };
}

// «Перегенерировать список»: правленые, ручные и заданные остаются на месте, новые — после них; главных не больше 3
function merge(old, fresh) {
  const keep = old.filter(kept);
  let tops = keep.filter((x) => x.top).length;
  const add = fresh.map((x) => {
    if (x.top && tops >= 3) return { ...x, top: false };
    if (x.top) tops += 1;
    return x;
  });
  return [...keep, ...add];
}

module.exports = { FILE, STAGES, STATUSES, CATEGORIES, LANGS, read, save, lang, normItem, kept, check, merge, newId, words };
