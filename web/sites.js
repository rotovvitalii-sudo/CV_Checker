// Каталог сайтов вакансий (C5, docs/specs/16-job-sites.md): ссылки на площадки с логином,
// которые приложение не обходит, и отметки «когда смотрел». Файл web/data/job-sites.json
// создаётся из DEFAULT_SITES при первом запуске; дальше каталог правится на вкладке «Сайты».
const fs = require('node:fs');
const path = require('node:path');
const { DATA } = require('./store');

const FILE = path.join(DATA, 'job-sites.json');
const STALE_DAYS = 7;
const GROUPS = { global: 'Глобальные и remote', pl: 'Польша', ua: 'Украина', industry: 'Отраслевые', custom: 'Свои' };

// Ссылки проверены 2026-10-14: каждая ведёт на страницу вакансий
const DEFAULT_SITES = [
  ['linkedin', 'LinkedIn Jobs', 'https://www.linkedin.com/jobs/', 'global', 'Главный канал: рекрутеры, Easy Apply, сигналы найма', true],
  ['indeed', 'Indeed', 'https://pl.indeed.com/', 'global', 'Агрегатор, польская версия; много вакансий с сайтов компаний', false],
  ['glassdoor', 'Glassdoor', 'https://www.glassdoor.com/Job/index.htm', 'global', 'Вакансии плюс отзывы и зарплаты по компании', true],
  ['wellfound', 'Wellfound', 'https://wellfound.com/jobs', 'global', 'Стартапы: роль, вилка и доля видны сразу', true],
  ['wttj', 'Welcome to the Jungle', 'https://www.welcometothejungle.com/en/jobs', 'global', 'Бывший Otta: Европа и remote, хорошие фильтры по роли', true],
  ['wwr', 'We Work Remotely', 'https://weworkremotely.com/', 'global', 'Только удалёнка; отклик на сайте компании', false],
  ['pracuj', 'Pracuj.pl', 'https://www.pracuj.pl/', 'pl', 'Крупнейший сайт вакансий в Польше, есть менеджерские роли', true],
  ['justjoin', 'Just Join IT', 'https://justjoin.it/', 'pl', 'IT и продукт в Польше, вилка всегда указана', false],
  ['nofluff', 'No Fluff Jobs', 'https://nofluffjobs.com/pl', 'pl', 'IT и продукт, вилка обязательна. Встроенный браузер Claude сайт не открывает', false],
  ['theprotocol', 'theprotocol.it', 'https://theprotocol.it/', 'pl', 'IT-вакансии группы Pracuj', false],
  ['rocketjobs', 'RocketJobs', 'https://rocketjobs.pl/', 'pl', 'Не-IT роли от Just Join IT: продукт, маркетинг, продажи', false],
  ['djinni', 'Djinni', 'https://djinni.co/jobs/', 'ua', 'Анонимный профиль, рекрутеры пишут сами', true],
  ['dou', 'DOU', 'https://jobs.dou.ua/', 'ua', 'Вакансии украинских IT- и продуктовых компаний', false],
  ['workua', 'Work.ua', 'https://www.work.ua/jobs/', 'ua', 'Крупнейший сайт вакансий Украины, все отрасли', false],
  ['robotaua', 'Robota.ua', 'https://robota.ua/', 'ua', 'Второй крупный сайт Украины, все отрасли', false],
  ['edsurge', 'EdSurge Jobs', 'https://jobsboard.edsurge.com/', 'industry', 'EdTech: продукт, рост, контент', false],
  ['efc', 'eFinancialCareers', 'https://www.efinancialcareers.com/', 'industry', 'FinTech и финансы, брокеры и биржи', false],
  ['cryptojobslist', 'CryptoJobsList', 'https://cryptojobslist.com/', 'industry', 'Крипто и Web3, есть не-инженерные роли', false],
  ['web3career', 'Web3.career', 'https://web3.career/', 'industry', 'Web3: продукт, маркетинг, комьюнити', false],
  ['cryptocurrencyjobs', 'Cryptocurrency Jobs', 'https://cryptocurrencyjobs.co/', 'industry', 'Крипто-вакансии с фильтром по роли', false],
].map(([id, name, url, group, note, login]) => ({ id, name, url, group, note, login }));

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { sites: DEFAULT_SITES, visits: {} }; }
}

function write(d) {
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

function list() {
  const d = read();
  return {
    groups: GROUPS, staleDays: STALE_DAYS,
    sites: d.sites.map((s) => ({ ...s, lastVisit: d.visits[s.id] || null })),
  };
}

const find = (d, id) => d.sites.find((s) => s.id === id);
const byId = (id) => find(read(), id) || null;

function visit(id) {
  const d = read();
  if (!find(d, id)) return null;
  d.visits[id] = new Date().toISOString();
  write(d);
  return d.visits[id];
}

const cleanUrl = (u) => {
  const v = String(u || '').trim();
  if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(v)) throw new Error('нужна ссылка вида https://…');
  return v;
};

function add({ name, url, note, login }) {
  const d = read();
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new Error('нужно название');
  const base = n.toLowerCase().replace(/[^a-z0-9а-я]+/g, '').slice(0, 24) || 'site';
  let id = base;
  for (let i = 2; find(d, id); i++) id = `${base}${i}`;
  const s = { id, name: n, url: cleanUrl(url), group: 'custom', note: String(note || '').trim().slice(0, 160), login: !!login, custom: true };
  d.sites.push(s);
  write(d);
  return s;
}

function update(id, body) {
  const d = read();
  const s = find(d, id);
  if (!s) return null;
  if (typeof body.name === 'string' && body.name.trim()) s.name = body.name.trim().slice(0, 60);
  if (body.url !== undefined) s.url = cleanUrl(body.url);
  if (typeof body.note === 'string') s.note = body.note.trim().slice(0, 160);
  if (typeof body.login === 'boolean') s.login = body.login;
  if (typeof body.hidden === 'boolean') { if (body.hidden) s.hidden = true; else delete s.hidden; }
  write(d);
  return s;
}

// Удалить можно только свой сайт; сайты каталога скрываются
function remove(id) {
  const d = read();
  const s = find(d, id);
  if (!s || !s.custom) return false;
  d.sites = d.sites.filter((x) => x.id !== id);
  delete d.visits[id];
  write(d);
  return true;
}

if (!fs.existsSync(FILE)) write(read());

module.exports = { list, visit, add, update, remove, byId, STALE_DAYS };
