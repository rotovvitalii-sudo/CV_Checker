// S4 P1 · библиотека ответов на повторяющиеся вопросы форм (docs/specs/06-form-answers.md).
// Ответ, который ты проверил или поправил, сохраняется в knowledge-base/answer-library.json и при следующей
// подготовке ответов подставляется без агента — если вопрос совпал и ответ укладывается в лимит символов.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('./agent');

const FILE = path.join(ROOT, 'knowledge-base', 'answer-library.json');
const STOP = new Set(['a', 'an', 'the', 'you', 'your', 'do', 'does', 'did', 'is', 'are', 'to', 'of', 'in', 'for', 'and', 'or', 'with', 'what', 'why', 'how', 'us', 'our', 'we', 'this', 'that', 'have', 'has', 'be', 'please', 'describe', 'tell', 'about', 'me']);
const MATCH = 0.6;

function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function write(list) { fs.writeFileSync(FILE, `${JSON.stringify(list, null, 2)}\n`); }

// Слова вопроса без служебных: «Why do you want to join us?» ≈ «Why do you want to join our team?»
const words = (q) => new Set(String(q).toLowerCase().replace(/\(\d+\)\s*$/, '').match(/[a-zа-яё0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) || []);
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common += 1;
  return common / Math.max(x.size, y.size);
}

function list() { return read().sort((a, b) => (b.used || 0) - (a.used || 0) || b.at.localeCompare(a.at)); }

// Лучшее совпадение, которое укладывается в лимит вопроса
function match(q, limit) {
  let best = null;
  for (const e of read()) {
    if (limit && e.a.length > limit) continue;
    const s = similarity(q, e.q);
    if (s >= MATCH && (!best || s > best.score)) best = { ...e, score: s };
  }
  return best;
}

function add({ q, a, vacancy }) {
  const question = String(q || '').trim().slice(0, 300);
  const answer = String(a || '').trim().slice(0, 5000);
  if (!question || !answer) throw new Error('нужны вопрос и ответ');
  const all = read();
  // Тот же вопрос (почти дословно) — заменяем ответ, а не плодим дубли
  const same = all.find((e) => similarity(e.q, question) >= 0.9);
  const at = new Date().toISOString();
  if (same) Object.assign(same, { q: question, a: answer, at, vacancy: vacancy || same.vacancy });
  else all.push({ id: crypto.randomUUID().slice(0, 8), q: question, a: answer, at, vacancy: vacancy || '', used: 0 });
  write(all);
  return same || all[all.length - 1];
}

function update(id, body) {
  const all = read();
  const e = all.find((x) => x.id === id);
  if (!e) return null;
  if (typeof body.q === 'string' && body.q.trim()) e.q = body.q.trim().slice(0, 300);
  if (typeof body.a === 'string' && body.a.trim()) e.a = body.a.trim().slice(0, 5000);
  e.at = new Date().toISOString();
  write(all);
  return e;
}

function remove(id) { write(read().filter((x) => x.id !== id)); }

function markUsed(ids) {
  if (!ids.length) return;
  const all = read();
  for (const e of all) if (ids.includes(e.id)) e.used = (e.used || 0) + 1;
  write(all);
}

// Ответ из библиотеки в формате 05-answers.json
const asAnswer = (q, e) => ({
  q: q.q, limit: q.limit ?? null, type: 'library', status: 'ok', library: e.id,
  note: `Из библиотеки ответов${e.vacancy ? ` (сохранён в заявке «${e.vacancy}»)` : ''} — без агента.`,
  variants: [{ label: 'library', text: e.a }], sources: ['library'],
});

// 05-answers.md — из JSON (для humanizer-проверки и чтения глазами)
function toMd(title, data) {
  const lab = { short: 'Short', long: 'Long', library: 'Library' };
  return `# Ответы на вопросы формы — ${title}\n\n${(data.questions || []).map((x) => `## ${x.q}\n\n${(x.variants || [])
    .map((v) => `**${lab[v.label] || v.label}:** ${v.text}`).join('\n\n')}`).join('\n\n')}\n`;
}

module.exports = { list, match, add, update, remove, markUsed, asAnswer, toMd, similarity, FILE };
