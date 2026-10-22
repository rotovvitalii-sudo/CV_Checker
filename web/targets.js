// W4 · Целевые компании и контакты (docs/specs/26-target-companies.md).
// До 15 компаний мечты: чем интересна, страница карьеры, открытые вакансии из ленты и баз EdTech/FinTech,
// люди внутри (круг, статус общения) и черновик первого сообщения. Сообщения отправляешь сам.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('./agent');
const { DATA } = require('./store');

const FILE = path.join(DATA, 'targets.json');
const SOFT_LIMIT = 15;
const CIRCLES = ['close', 'known', 'stranger'];          // знаю близко · помнит меня · пока не знакомы
const STATUSES = ['none', 'written', 'talked', 'referred']; // не писал → написал → поговорили → рекомендовал
const REMIND_DAYS = 7;

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9а-яё]+/g, ' ').replace(/\b(inc|ltd|llc|gmbh|sa|plc|group|technologies)\b/g, '').trim();
const id = () => crypto.randomUUID().slice(0, 8);

function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { companies: [], prefs: {} }; } }
function write(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

// Публичная страница вакансий по системе найма — если в базе нет careers_url
const BOARDS = {
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`, lever: (t) => `https://jobs.lever.co/${t}`, greenhouse: (t) => `https://job-boards.greenhouse.io/${t}`,
  workable: (t) => `https://apply.workable.com/${t}/`, smartrecruiters: (t) => `https://jobs.smartrecruiters.com/${t}`,
  recruitee: (t) => `https://${t}.recruitee.com/`, personio: (t) => `https://${t}.jobs.personio.de/`,
};
const boardUrl = (ats, token) => (token && BOARDS[ats] ? BOARDS[ats](token) : '');

// Компания в базах EdTech / FinTech (S6/S7) — там уже известны система найма и страница карьеры
function sectorMatch(name) {
  const n = norm(name);
  for (const sector of ['edtech', 'fintech']) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(ROOT, 'job-search', sector, 'companies.json'), 'utf8')); } catch {}
    const c = list.find((x) => norm(x.name) === n);
    if (c) return { sector, ats: c.ats, status: c.status, careersUrl: c.careers_url || boardUrl(c.ats, c.token) };
  }
  return null;
}

const companyMatches = (target, company) => {
  const a = norm(target), b = norm(company);
  return !!a && !!b && (a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `));
};

function list(feedItems = []) {
  const d = read();
  const now = Date.now();
  return {
    limit: SOFT_LIMIT, prefs: d.prefs || {},
    companies: d.companies.map((c) => {
      const base = sectorMatch(c.name);
      const vacancies = feedItems.filter((i) => companyMatches(c.name, i.company))
        .map((i) => ({ key: i.key, title: i.title, url: i.url, section: i.section, posted: i.posted }));
      return {
        ...c, base, vacancies,
        careersUrl: c.careersUrl || base?.careersUrl || '',
        auto: base?.status === 'ok',
        contacts: (c.contacts || []).map((p) => ({ ...p,
          remind: p.status === 'written' && p.lastMsgAt && now - Date.parse(p.lastMsgAt) > REMIND_DAYS * 86400000 })),
      };
    }),
  };
}

function find(d, cid) { return d.companies.find((c) => c.id === cid); }

function add({ name, why, careersUrl }) {
  const d = read();
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw new Error('нужно название компании');
  if (d.companies.some((c) => norm(c.name) === norm(n))) throw new Error('эта компания уже в списке');
  const c = { id: id(), name: n, why: String(why || '').trim().slice(0, 300), careersUrl: String(careersUrl || '').trim().slice(0, 300), addedAt: new Date().toISOString(), contacts: [] };
  d.companies.push(c);
  write(d);
  return { company: c, over: d.companies.length > SOFT_LIMIT };
}

function update(cid, body) {
  const d = read();
  const c = find(d, cid);
  if (!c) return null;
  for (const k of ['why', 'careersUrl']) if (typeof body[k] === 'string') c[k] = body[k].trim().slice(0, 300);
  if (body.checked) c.checkedAt = new Date().toISOString(); // «смотрел страницу карьеры» — для компаний без API
  write(d);
  return c;
}

function remove(cid) {
  const d = read();
  d.companies = d.companies.filter((c) => c.id !== cid);
  write(d);
}

function addContact(cid, body) {
  const d = read();
  const c = find(d, cid);
  if (!c) throw new Error('нет такой компании');
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw new Error('нужно имя');
  const p = { id: id(), name, role: String(body.role || '').trim().slice(0, 100), circle: CIRCLES.includes(body.circle) ? body.circle : 'stranger',
    link: String(body.link || '').trim().slice(0, 300), status: 'none', note: '', language: body.language || 'en', at: new Date().toISOString() };
  (c.contacts = c.contacts || []).push(p);
  write(d);
  return p;
}

function updateContact(cid, pid, body) {
  const d = read();
  const p = (find(d, cid)?.contacts || []).find((x) => x.id === pid);
  if (!p) return null;
  for (const k of ['name', 'role', 'link', 'note', 'language']) if (typeof body[k] === 'string') p[k] = body[k].trim().slice(0, k === 'note' ? 1000 : 300);
  if (CIRCLES.includes(body.circle)) p.circle = body.circle;
  if (STATUSES.includes(body.status) && body.status !== p.status) {
    p.status = body.status;
    if (body.status === 'written') { p.lastMsgAt = new Date().toISOString(); delete p.reminded; }
  }
  if (body.reminded) p.reminded = new Date().toISOString();
  if (body.draft !== undefined) p.draft = body.draft;
  write(d);
  return p;
}

function removeContact(cid, pid) {
  const d = read();
  const c = find(d, cid);
  if (c) c.contacts = (c.contacts || []).filter((x) => x.id !== pid);
  write(d);
}

function setPrefs(body) {
  const d = read();
  d.prefs = { ...(d.prefs || {}), ...Object.fromEntries(['role', 'domain', 'task'].filter((k) => typeof body[k] === 'string').map((k) => [k, body[k].trim().slice(0, 200)])) };
  write(d);
  return d.prefs;
}

// Новые вакансии ленты в целевых компаниях — для уведомления после обновления ленты
function freshMatches(items) {
  const d = read();
  return items.filter((i) => d.companies.some((c) => companyMatches(c.name, i.company)));
}

// Есть контакт, с которым поговорили или который рекомендовал, — для статистики заявок
function warmCompanies() {
  return read().companies.filter((c) => (c.contacts || []).some((p) => ['talked', 'referred'].includes(p.status))).map((c) => c.name);
}

const contactOf = (cid, pid) => {
  const d = read();
  const c = find(d, cid);
  return c ? { company: c, contact: (c.contacts || []).find((x) => x.id === pid) } : {};
};

module.exports = { list, add, update, remove, addContact, updateContact, removeContact, setPrefs, freshMatches, warmCompanies,
  contactOf, companyMatches, CIRCLES, STATUSES, SOFT_LIMIT, REMIND_DAYS };
