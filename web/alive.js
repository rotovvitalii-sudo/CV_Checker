// W2 · «Вакансия ещё живая?» (docs/specs/24-vacancy-alive.md): бесплатная проверка до платных шагов агента.
// Открытые API систем найма отвечают, есть ли вакансия в списке компании; иначе — код ответа и текст страницы.
// Кэш 12 часов: web/data/alive.json → { name: { status: open|closed|unknown, at, ats, note } }.
const fs = require('node:fs');
const path = require('node:path');
const { DATA } = require('./store');

const FILE = path.join(DATA, 'alive.json');
const TTL = 12 * 60 * 60 * 1000;
const OLD_DAYS = 45;
const CLOSED_RE = /job not found|no longer (available|accepting|open)|position (has been )?(filled|closed)|this job is (closed|no longer)|job (has been )?(closed|expired)|page not found/i;
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };

const cache = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

async function get(url, json = true) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    const body = json ? await r.json().catch(() => null) : await r.text().catch(() => '');
    return { code: r.status, body };
  } finally { clearTimeout(t); }
}

// Проверка по системе найма: open | closed | unknown
async function probe(url) {
  let m;
  if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
    const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`);
    if (r.code === 200 && Array.isArray(r.body?.jobs)) return { ats: 'ashby', status: r.body.jobs.some((j) => j.id === m[2]) ? 'open' : 'closed' };
    return { ats: 'ashby', status: 'unknown', note: `API ответил ${r.code}` };
  }
  if ((m = url.match(/jobs\.(eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i))) {
    const r = await get(`https://api.${m[1] ? 'eu.' : ''}lever.co/v0/postings/${m[2]}/${m[3]}`);
    return { ats: 'lever', status: r.code === 200 ? 'open' : r.code === 404 ? 'closed' : 'unknown', note: r.code >= 300 && r.code !== 404 ? `API ответил ${r.code}` : '' };
  }
  if ((m = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i))) {
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
    return { ats: 'greenhouse', status: r.code === 200 ? 'open' : r.code === 404 ? 'closed' : 'unknown' };
  }
  if ((m = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/i))) {
    const r = await get(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`);
    return { ats: 'smartrecruiters', status: r.code === 200 ? 'open' : r.code === 404 ? 'closed' : 'unknown' };
  }
  if ((m = url.match(/apply\.workable\.com\/([^/?#]+)\/j\/([A-Z0-9]+)/i))) {
    const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${m[1]}`);
    if (r.code === 200 && Array.isArray(r.body?.jobs)) return { ats: 'workable', status: r.body.jobs.some((j) => j.shortcode === m[2]) ? 'open' : 'closed' };
    return { ats: 'workable', status: 'unknown', note: r.code === 429 ? 'Workable ограничил частоту' : `API ответил ${r.code}` };
  }
  // Остальное (Recruitee, Personio, сайт компании): код ответа и текст страницы
  const r = await get(url, false);
  if (r.code === 404 || r.code === 410) return { ats: 'page', status: 'closed' };
  if (r.code === 200) return { ats: 'page', status: CLOSED_RE.test(String(r.body).slice(0, 20000)) ? 'closed' : 'unknown', note: 'по тексту страницы' };
  return { ats: 'page', status: 'unknown', note: `страница ответила ${r.code}` };
}

function ageDays(datePosted) {
  const t = Date.parse(datePosted || '');
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

// info — store.vacancyInfo(name); force — не брать из кэша
async function check(name, info, force = false) {
  const url = [info.url, info.apply].map((u) => String(u || '').trim()).find((u) => /^https?:\/\//.test(u));
  const age = ageDays(info.fit?.date_posted);
  const base = { age, old: age != null && age > OLD_DAYS, oldDays: OLD_DAYS };
  if (!url) return { ...base, status: 'unknown', note: 'нет ссылки на вакансию', at: null };
  const all = cache();
  const c = all[name];
  if (!force && c && c.url === url && Date.now() - Date.parse(c.at) < TTL) return { ...base, ...c, cached: true };
  let r;
  try { r = await probe(url); } catch (e) { r = { status: 'unknown', note: e.name === 'AbortError' ? 'сайт не ответил за 8 с' : 'ошибка сети' }; }
  const rec = { ...r, url, at: new Date().toISOString(), prev: c?.status || null };
  all[name] = rec;
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  return { ...base, ...rec, cached: false };
}

const cached = (name) => cache()[name] || null;

module.exports = { check, cached, ageDays, OLD_DAYS };
