// C25 · Спросить Claude в уроке (docs/specs/50-lesson-chat.md): разговоры при уроке.
// knowledge-base/learning/<slug>/chats/<id>.json — {id, created, lang, section, quote, course, messages: [{role, text, at, model, cost, action}]}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const learning = require('./learning');

const QUOTE_MAX = 1500, QUESTION_MAX = 2000, HISTORY = 10;
const ACTIONS = {
  explain: 'Объясни подробнее',
  simpler: 'Объясни проще',
  example: 'Приведи пример с числами',
  interview: 'Как об этом спросят на интервью и что хотят услышать',
};
const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const idOk = (id) => /^[a-z0-9]{8}$/.test(String(id || ''));
function cdir(slug) { if (!learning.slugOk(slug)) throw err(400, 'плохой slug'); return path.join(learning.dir(slug), 'chats'); }
const file = (slug, id) => { if (!idOk(id)) throw err(400, 'плохой id'); return path.join(cdir(slug), `${id}.json`); };
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const write = (slug, c) => { fs.mkdirSync(cdir(slug), { recursive: true }); c.updated = now(); fs.writeFileSync(file(slug, c.id), `${JSON.stringify(c, null, 2)}\n`); return c; };

function list(slug) {
  const d = cdir(slug);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => read(path.join(d, f))).filter(Boolean)
    .map((c) => ({ id: c.id, created: c.created, updated: c.updated, quote: (c.quote || '').slice(0, 160), first: (c.messages.find((m) => m.role === 'user')?.text || '').slice(0, 160), n: c.messages.length }))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
const count = (slug) => { try { return list(slug).length; } catch { return 0; } };
function get(slug, id) { const c = read(file(slug, id)); if (!c) throw err(404, 'нет такого разговора'); return c; }
// Вопрос пользователя: готовое действие или свой текст
function question(body) {
  const q = String(body?.question || '').trim().slice(0, QUESTION_MAX);
  const action = ACTIONS[body?.action] ? body.action : null;
  if (!q && !action) throw err(400, 'напиши вопрос или выбери действие');
  return { text: q || ACTIONS[action], action };
}
function create(slug, body) {
  if (!learning.lesson(slug, 'en')) throw err(400, 'урока нет');
  const quote = String(body?.quote || '').replace(/\s+\n/g, '\n').trim();
  const c = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 8), created: now(), lang: body?.lang === 'ru' ? 'ru' : 'en',
    section: String(body?.section || '').trim().slice(0, 160), quote: quote.slice(0, QUOTE_MAX), cut: quote.length > QUOTE_MAX,
    course: learning.slugOk(body?.course) ? body.course : null, messages: [] };
  const q = question(body);
  c.messages.push({ role: 'user', text: q.text, action: q.action, at: now() });
  return write(slug, c);
}
function ask(slug, id, body) {
  const c = get(slug, id);
  const q = question(body);
  c.messages.push({ role: 'user', text: q.text, action: q.action, at: now() });
  return write(slug, c);
}
function answer(slug, id, text, meta = {}) {
  const c = get(slug, id);
  c.messages.push({ role: 'assistant', text: String(text || '').trim(), at: now(), model: meta.model || null, cost: meta.cost ?? null });
  return write(slug, c);
}
function remove(slug, id) { fs.rmSync(file(slug, id), { force: true }); }
const history = (c) => c.messages.slice(-HISTORY - 1, -1);

module.exports = { ACTIONS, QUOTE_MAX, QUESTION_MAX, list, count, get, create, ask, answer, remove, history };
