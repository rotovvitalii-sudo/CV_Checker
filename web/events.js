// Лента событий для колокольчика и системных уведомлений (C3, docs/specs/10-notifications.md).
// web/data/events.jsonl — по строке на событие; прочитанность хранится там же (перезапись файла).
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(path.resolve(__dirname, '..'), 'web', 'data', 'events.jsonl');
const KEEP = 300; // старше — выбрасываем, колокольчику больше не нужно

let events = null;

function load() {
  if (events) return events;
  events = fs.existsSync(FILE)
    ? fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  return events;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
}

let lastId = 0;
// type: job_done | job_error | strong_fit | no_reply | feed …; link — маршрут приложения (#/v/…)
function add({ type, title, text = '', link = '#/' }) {
  load();
  const id = Math.max(Date.now(), lastId + 1);
  lastId = id;
  const ev = { id, at: new Date(id).toISOString(), type, title, text, link, read: false };
  events.push(ev);
  if (events.length > KEEP) events = events.slice(-KEEP);
  persist();
  return ev;
}

function list({ since = 0, limit = 40 } = {}) {
  load();
  const out = events.filter((e) => e.id > since).slice(-limit).reverse();
  return { events: out, unread: events.filter((e) => !e.read).length, lastId: events.length ? events[events.length - 1].id : 0 };
}

function markRead({ ids, all }) {
  load();
  const set = new Set((ids || []).map(Number));
  let n = 0;
  for (const e of events) if (!e.read && (all || set.has(e.id))) { e.read = true; n += 1; }
  if (n) persist();
  return n;
}

module.exports = { add, list, markRead };
