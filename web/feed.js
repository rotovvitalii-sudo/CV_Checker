// Лента вакансий (S1, docs/specs/03-job-feed.md): чтение job-search/feed.py, пропуски, обновление.
// Сортирует словарь classify.py; модель здесь не вызывается — фит запускается только на «Сохранить».
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { jobs } = require('./agent');
const events = require('./events');

const ROOT = path.resolve(__dirname, '..');
const PY = path.join(ROOT, '.venv', 'bin', 'python');
const RAW = path.join(ROOT, 'job-search', 'raw');
const SKIPPED = path.join(ROOT, 'web', 'data', 'feed-skipped.json');
const REFRESH_PAGES = 15;

const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
function stamp() {
  // applications.json сюда не входит: он сохраняется при каждом опросе списка. Входящие
  // отфильтровывает сервер (inboxUrls в /api/feed)
  let s = mtime(SKIPPED) + mtime(path.join(ROOT, 'job-search', 'corpus', 'jobs.jsonl'))
    + mtime(path.join(ROOT, 'vacancies'));
  if (fs.existsSync(RAW)) for (const f of fs.readdirSync(RAW)) s += mtime(path.join(RAW, f));
  return s;
}

function py(args) {
  return new Promise((resolve, reject) => {
    execFile(PY, args, { cwd: ROOT, maxBuffer: 64 << 20, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

let cache = { stamp: null, data: null };
async function feed() {
  const s = stamp();
  if (cache.stamp !== s) cache = { stamp: s, data: await py(['job-search/feed.py', '--json']) };
  return cache.data;
}

const getOne = (key) => py(['job-search/feed.py', '--get', key]);

// ---------- пропуски ----------

function readSkipped() {
  try { return fs.existsSync(SKIPPED) ? JSON.parse(fs.readFileSync(SKIPPED, 'utf8')) : {}; } catch { return {}; }
}
function writeSkipped(s) {
  fs.mkdirSync(path.dirname(SKIPPED), { recursive: true });
  fs.writeFileSync(SKIPPED, JSON.stringify(s, null, 2));
}
function skip(key, info = {}) {
  const s = readSkipped();
  s[key] = { at: new Date().toISOString(), title: info.title || '', company: info.company || '', url: info.url || '' };
  writeSkipped(s);
}
function unskip(key) {
  const s = readSkipped();
  delete s[key];
  writeSkipped(s);
}

// ---------- обновление: fetch.py --fresh в фоне ----------
// Задача живёт в общем списке jobs, поэтому прогресс отдаётся тем же SSE, что и задачи агента.

let refreshJob = null;

// mode: 'all' — открытые доски (fetch.py --fresh) и EdTech-компании; 'edtech' — только EdTech (S6)
// Отрасли (S6 EdTech, S7 FinTech): общий сборщик edtech.py с параметром --sector
const SECTORS = ['edtech', 'fintech'];
const sectorStep = (s) => ['job-search/edtech.py', '--sector', s, 'fetch'];
const REFRESH_STEPS = {
  all: [['job-search/fetch.py', '--fresh', '--pages', String(REFRESH_PAGES)], ...SECTORS.map(sectorStep)],
  edtech: [sectorStep('edtech')],
  fintech: [sectorStep('fintech')],
};

function refresh(mode = 'all') {
  if (refreshJob && refreshJob.state === 'running') return refreshJob;
  const job = {
    id: crypto.randomUUID().slice(0, 8), kind: 'fetch', target: 'feed', state: 'running',
    created: Date.now(), started: Date.now(), finished: null, error: null, events: [], listeners: new Set(),
  };
  const emit = (ev) => {
    ev.t = Date.now();
    job.events.push(ev);
    if (job.events.length > 300) job.events.shift();
    for (const fn of job.listeners) fn(ev);
  };
  jobs.set(job.id, job);
  refreshJob = job;

  job.mode = mode;
  const before = new Set((cache.data?.items || []).map((i) => i.key));
  const onLine = (buf) => String(buf).split('\n').map((l) => l.trim()).filter(Boolean)
    .forEach((l) => emit({ kind: /лимит|не отвечает|error/i.test(l) ? 'warn' : 'tool', text: l }));
  const steps = REFRESH_STEPS[mode] || REFRESH_STEPS.all;

  const runStep = (i) => {
    if (i >= steps.length) return finish();
    const [script, ...args] = steps[i];
    const sector = args.includes('--sector') ? args[args.indexOf('--sector') + 1] : null;
    emit({ kind: 'state', text: sector ? `опрашиваю страницы карьеры ${sector === 'fintech' ? 'FinTech' : 'EdTech'}-компаний…` : 'скачиваю свежие вакансии с открытых досок…' });
    const child = spawn(PY, [script, ...args], { cwd: ROOT });
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('close', (code) => {
      if (code !== 0) job.error = `${script} завершился с кодом ${code}`;
      runStep(i + 1); // сбой одного источника не отменяет остальные
    });
  };

  const finish = async () => {
    try {
      const data = await feed();
      const fresh = data.items.filter((i) => !before.has(i.key));
      const n = (sec) => fresh.filter((i) => i.section === sec).length;
      job.summary = { added: fresh.length, fit: n('fit'), product: n('product'), edtech: n('edtech'), fintech: n('fintech') };
      const all = `+${fresh.length}: подходят ${n('fit')}, продуктовые ${n('product')}, EdTech ${n('edtech')}, FinTech ${n('fintech')}`;
      if (fresh.length) events.add({ type: 'feed', title: 'Лента обновлена', link: '#/feed', text: all });
      // W4: новая вакансия в целевой компании
      require('./targets').freshMatches(fresh).forEach((i) => events.add({
        type: 'target', title: `Целевая компания: ${i.company}`, text: i.title, link: '#/feed' }));
      // P1 S7: новая роль «обучение клиентов» у FinTech-компании — отдельное уведомление
      fresh.filter((i) => i.section === 'fintech' && i.role_group === 'edu').forEach((i) => events.add({
        type: 'strong_fit', title: i.academy_signal ? 'FinTech строит академию без продакта — поток B' : 'FinTech строит обучение клиентов',
        text: `${i.title} — ${i.company}`, link: '#/feed' }));
      emit({ kind: 'result', text: mode === 'all' ? `${all.replace(/^\+(\d+):/, '+$1 в ленте:')}`
        : `+${n(mode)} новых ${mode === 'fintech' ? 'FinTech' : 'EdTech'}-вакансий` });
    } catch (e) {
      job.error = job.error || e.message;
    }
    job.state = job.error ? 'error' : 'done';
    job.finished = Date.now();
    emit({ kind: 'state', text: job.error ? `ошибка: ${job.error}` : 'готово', done: true });
  };

  runStep(0);
  return job;
}

// S6 P1 · компания вручную: токен из ссылки на доску системы найма (если ссылка такая) + пробник по названию
const BOARD_SLUG = [/jobs\.lever\.co\/([^/?#]+)/, /greenhouse\.io\/([^/?#]+)/, /jobs\.ashbyhq\.com\/([^/?#]+)/, /apply\.workable\.com\/([^/?#]+)/,
  /jobs\.smartrecruiters\.com\/([^/?#]+)/, /\/\/([^./]+)\.recruitee\.com/, /\/\/([^./]+)\.jobs\.personio\.(?:de|com)/];
function addCompany(sector, { name, careersUrl = '', country = '', segment = '' }) {
  const slugs = BOARD_SLUG.map((re) => String(careersUrl).match(re)?.[1]).filter((x) => x && !['v1', 'embed', 'boards', 'job-boards'].includes(x));
  return py(['job-search/edtech.py', '--sector', SECTORS.includes(sector) ? sector : 'edtech', 'add', '--name', name,
    '--careers-url', careersUrl, '--country', country, '--segment', segment, ...(slugs.length ? ['--slugs', slugs.join(',')] : [])]);
}

const companies = (sector = 'edtech') => py(['job-search/edtech.py', '--sector', SECTORS.includes(sector) ? sector : 'edtech', 'list', '--json']);

const currentRefresh = () => (refreshJob && refreshJob.state === 'running' ? refreshJob : null);

module.exports = { feed, getOne, skip, unskip, refresh, currentRefresh, readSkipped, companies, addCompany };
