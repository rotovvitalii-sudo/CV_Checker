// Состояние приложения: статусы, надиктовки, фит и метрики пакетов.
// Источник истины по артефактам — файлы в vacancies/ и output/; здесь только то, чего в них нет,
// плюс кэш метрик (пересчитываются, когда меняется mtime файла).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ROOT } = require('./agent');
const serial = require('./serial');

const DATA = path.join(ROOT, 'web', 'data');
const STATE = path.join(DATA, 'applications.json');
const VACANCIES = path.join(ROOT, 'vacancies');
const OUTPUT = path.join(ROOT, 'output');
const CORPUS = path.join(ROOT, 'job-search', 'corpus', 'jobs.jsonl');
const PY = path.join(ROOT, '.venv', 'bin', 'python');

const MANUAL_NO_TEXT = 'Текста вакансии нет';
const STATUSES = ['new', 'ready', 'sent', 'replied', 'interview', 'offer', 'rejected', 'skip', 'no_reply'];
const CHANNELS = ['site', 'board', 'email', 'linkedin', 'referral', 'recruiter', 'other'];

// Без фоллоу-апов (решение 2026-10-26): отправленная заявка без ответа через NO_REPLY_DAYS сама уходит в архив
// со статусом «Без ответа». Срок — knowledge-base/profile.json → no_reply_days (экран «Профиль»), по умолчанию 14.
const NO_REPLY_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

function noReplyDays() {
  try {
    const n = Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge-base', 'profile.json'), 'utf8')).no_reply_days);
    return n >= 1 && n <= 90 ? n : NO_REPLY_DAYS;
  } catch { return NO_REPLY_DAYS; }
}

// Сколько ждём ответа и когда заявка уйдёт в «Без ответа»
function waitingState(a, now = Date.now(), days = noReplyDays()) {
  if (a.status !== 'sent' || !a.sent) return null;
  const sentAt = Date.parse(a.sent.at);
  const noReplyAt = sentAt + days * DAY;
  return { daysSinceSent: Math.floor((now - sentAt) / DAY), noReplyAt: new Date(noReplyAt).toISOString(),
    daysLeft: Math.max(0, Math.ceil((noReplyAt - now) / DAY)), days };
}

// Смена статуса всегда оставляет след в истории
function setStatus(a, to, { at, note } = {}) {
  if (a.status === to) return;
  a.history = a.history || [];
  a.history.push({ at: at || new Date().toISOString(), from: a.status, to, ...(note ? { note } : {}) });
  a.status = to;
}

const state = { apps: {}, inbox: {} };

function load() {
  fs.mkdirSync(path.join(DATA, 'inbox'), { recursive: true });
  if (fs.existsSync(STATE)) {
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    state.apps = saved.apps || {};
    state.inbox = saved.inbox || {};
  }
  // Задачи прошлого запуска сервера не переживают перезапуск
  for (const it of Object.values(state.inbox)) if (it.state === 'running') { it.state = 'error'; it.error = 'сервер перезапущен'; }
}

function save() {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}

function app(name) {
  if (!state.apps[name]) state.apps[name] = { status: 'new', dictation: '', created: Date.now() };
  return state.apps[name];
}

// ---------- файлы ----------

function safeName(name) {
  if (!name || name.includes('/') || name.includes('..') || name.startsWith('.')) throw new Error('bad name');
  return name;
}

const outDir = (name) => path.join(OUTPUT, safeName(name));
const exists = (p) => fs.existsSync(p);
const mtime = (p) => (exists(p) ? fs.statSync(p).mtimeMs : 0);
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

function letterFile(name) {
  const dir = outDir(name);
  if (!exists(dir)) return null;
  if (exists(path.join(dir, 'Cover Letter.md'))) return 'Cover Letter.md';
  // Структура письма (C7, 04-letter-outline.md) и трассировки — не письмо
  return fs.readdirSync(dir).find((f) => f.endsWith('.md') && /letter|message/i.test(f) && !/trace|outline|summary/i.test(f)) || null;
}

function listFiles(name) {
  const dir = outDir(name);
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
}

// ---------- фит ----------

let corpusCache = { m: 0, rows: [] };
function corpus() {
  const m = mtime(CORPUS);
  if (m !== corpusCache.m) {
    corpusCache = { m, rows: m ? fs.readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [] };
  }
  return corpusCache.rows;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-я]+/g, ' ').trim();

function fitFromCorpus(name, fm) {
  const n = norm(name);
  return corpus().find((j) => norm(`${j.title} - ${j.company}`.replace(/[/:]/g, '-')) === n)
    || corpus().find((j) => fm.url && j.url && j.url.split('?')[0] === fm.url.split('?')[0])
    || (() => {
      // Имя файла могли сократить вручную: тогда ищем единственную запись по компании
      const company = norm(name.split(' - ').slice(-1)[0]);
      const same = corpus().filter((j) => norm(j.company) === company);
      return same.length === 1 ? same[0] : null;
    })();
}

function pickFit(j) {
  if (!j) return null;
  const keys = ['total', 'scores', 'bucket', 'flags', 'hard_filters', 'current_task', 'why', 'anchor_case', 'anchor_card', 'anchor_card_missing',
    'gaps', 'title', 'company', 'url', 'location', 'work_format', 'seniority', 'domain', 'salary',
    'what_you_do', 'source', 'date_posted'];
  return Object.fromEntries(keys.filter((k) => j[k] !== undefined).map((k) => [k, j[k]]));
}

// ---------- метрики (скрипты scorer/) ----------

// Скрипты гоняются строго по одному (общая очередь с рендером Master CV, см. serial.js)
function py(args) {
  return serial(() => new Promise((resolve) => {
    execFile(PY, args, { cwd: ROOT, timeout: 120000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  }));
}

// База, из которой собрано адаптированное CV: версия Master на момент запуска tailor-cv.
// Пакеты, собранные до появления версий, считаются собранными из v1.
function baseFile(a) {
  const p = path.join(ROOT, 'knowledge-base', 'master-cv', 'versions', `v${String(a.baseVersion || 1).padStart(3, '0')}`, 'base-cv.md');
  return exists(p) ? p : path.join(ROOT, 'knowledge-base', 'base-cv.md');
}

function recruiterScore(name) {
  const p = path.join(outDir(name), '03-score.md');
  if (!exists(p)) return null;
  const all = [...fs.readFileSync(p, 'utf8').matchAll(/Итог:?\s*\**\s*(\d(?:[.,]\d)?)\s*\/\s*5/g)];
  return all.length ? parseFloat(all[all.length - 1][1].replace(',', '.')) : null;
}

async function cvMetrics(name, force = false) {
  const dir = outDir(name);
  const docx = path.join(dir, 'CV.docx');
  const kw = path.join(dir, '01-keywords.json');
  if (!exists(docx) || !exists(kw)) return null;
  const a = app(name);
  // Шапка CV начинается с точного названия роли из вакансии (tailor-cv, правило 3b)
  const vf = path.join(VACANCIES, `${name}.md`);
  const role = exists(vf) ? frontmatter(fs.readFileSync(vf, 'utf8')).role || '' : '';
  const stamp = `${mtime(docx) + mtime(path.join(dir, 'CV.md')) + mtime(path.join(dir, '03-score.md'))}:v${a.baseVersion || 1}:t30:w1:${role}`;
  if (!force && a.cv && a.cv.stamp === stamp) return a.cv;
  const [cv, diff] = await Promise.all([
    py(['scorer/check_cv.py', '--docx', docx, '--keywords', kw, '--json']),
    exists(path.join(dir, 'CV.md'))
      ? py(['scorer/check_diff.py', '--base', baseFile(a), '--cv', path.join(dir, 'CV.md'), ...(role ? ['--title', role] : []), '--json'])
      : null,
  ]);
  const summary = readJSON(path.join(dir, 'summary.json')) || {};
  a.cv = {
    stamp,
    coverage: cv?.score ?? null,
    must: cv ? `${cv.must.hit.length}/${cv.must.hit.length + cv.must.miss.length}` : null,
    nice: cv ? `${cv.nice.hit.length}/${cv.nice.hit.length + cv.nice.miss.length}` : null,
    mustMiss: cv?.must.miss || [],
    // W1: верхняя треть CV (до Experience) — главная задача роли и обязательные ключи
    topThird: cv?.top_third ? { pass: cv.top_third.pass, task: cv.top_third.task_visible, hit: cv.top_third.must_hit_n, need: cv.top_third.need,
      missingTop: (cv.must?.hit || []).filter((k) => !cv.top_third.must_hit.includes(k)).slice(0, 6) } : null,
    pages: cv?.pdf_pages ?? null,
    bottomFree: cv?.bottom_free_mm ?? null,
    lengthOk: cv?.length_ok ?? null,
    words: cv?.words ?? null,
    change: diff?.change ?? null,
    changeOk: diff?.pass ?? null,
    taglineOk: diff?.tagline_ok ?? null, expectedTitle: diff?.expected_title || '', tagline: diff?.tagline || '',
    recruiter: summary.recruiter_score ?? recruiterScore(name),
    gaps: summary.top_gaps || [],
    note: summary.note || '',
  };
  save();
  return a.cv;
}

async function letterMetrics(name, force = false) {
  const dir = outDir(name);
  const lf = letterFile(name);
  if (!lf) return null;
  const a = app(name);
  const trace = path.join(dir, '04-cover-letter-trace.md');
  const genTrace = path.join(dir, '04-generated-trace.json');
  const summaryFile = path.join(dir, 'letter-summary.json');
  const stamp = mtime(path.join(dir, lf)) + mtime(trace) + mtime(genTrace) + mtime(summaryFile);
  if (!force && a.letter && a.letter.stamp === stamp) return a.letter;
  const summary = readJSON(summaryFile) || {};
  // C8: письмо, сгенерированное агентом, проверяется по фактам (check_generated), а не по доле надиктовки
  const mode = summary.mode === 'generated' ? 'generated' : 'dictated';
  const [share, hum, gen] = await Promise.all([
    mode === 'dictated' && exists(trace) ? py(['scorer/check_letter.py', '--trace', trace, '--json']) : null,
    py(['scorer/check_humanize.py', '--file', path.join(dir, lf), '--json']),
    mode === 'generated' ? py(['scorer/check_generated.py', '--name', name, '--json']) : null,
  ]);
  a.letter = {
    stamp, file: lf, mode,
    facts: gen ? { ok: gen.facts_ok, total: gen.facts, pass: gen.pass, issues: gen.issues || [] } : null,
    share: share?.dictated_share ?? null, shareOk: share?.pass ?? null,
    humanize: hum?.score ?? null, humanizeOk: hum?.pass ?? null,
    words: hum?.words ?? null,
    questions: summary.questions || [], removed: summary.removed || [], note: summary.note || '',
  };
  save();
  return a.letter;
}

// ---------- имена файлов при экспорте (E1, docs/specs/12-cv-export-filename.md) ----------

const MAX_EXPORT = 80;
const fileSafe = (s) => String(s || '')
  .replace(/[\/\\:*?"<>|]+/g, ' ')
  .replace(/[\s_]+/g, '_')
  .replace(/^_+|_+$/g, '');

// «# ALEX MORGAN» из Master CV → «Alex_Morgan»
function personName() {
  const first = (fs.existsSync(path.join(ROOT, 'knowledge-base', 'base-cv.md'))
    ? fs.readFileSync(path.join(ROOT, 'knowledge-base', 'base-cv.md'), 'utf8') : '').split('\n')[0] || '';
  const words = first.replace(/^#\s*/, '').trim().split(/\s+/).filter(Boolean);
  return fileSafe(words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')) || 'CV';
}

// Позиция до сути: «Product Lead - AI Investing» → «Product Lead», «Country Manager, Poland» → «Country Manager»
const shortRole = (r) => String(r || '').split(/\s[-—–]\s|,|\(|\|/)[0].trim();
// Компания без пояснений: «Globex (expert network; …)» → «Globex»
const shortCompany = (c) => String(c || '').split(/\(|;/)[0].trim();

function exportBase(prefix, role, company) {
  const head = `${prefix}_${personName()}`;
  const tail = fileSafe(company);
  let mid = fileSafe(role);
  const room = MAX_EXPORT - head.length - tail.length - 2 - 5; // 2 разделителя, 5 на «.docx»
  if (mid.length > room) mid = mid.slice(0, Math.max(0, room)).replace(/_+$/, '');
  return [head, mid, tail].filter(Boolean).join('_');
}

function exportNames(name, info) {
  const a = app(name);
  const role = a.exportRole || shortRole(info.role);
  const company = a.exportCompany || shortCompany(info.company);
  const cv = exportBase('CV', role, company);
  return {
    role, company, custom: !!(a.exportRole || a.exportCompany),
    defaultRole: shortRole(info.role), defaultCompany: shortCompany(info.company),
    cv, cvDocx: `${cv}.docx`, cvPdf: `${cv}.pdf`,
    letter: `${exportBase('Cover_Letter', role, company)}${info.letterFile ? path.extname(info.letterFile) : '.md'}`,
    // C10: файлы письма для отправки — то же имя, что и у .md, с другим расширением
    letterPdf: `${exportBase('Cover_Letter', role, company)}.pdf`,
    letterDocx: `${exportBase('Cover_Letter', role, company)}.docx`,
  };
}

const masterExportName = (n, ext) => `CV_${personName()}_Master_v${String(n).padStart(3, '0')}${ext}`;

// W6: этапы воронки по воркбуку — отклик → рекрутер → hiring manager → финал → оффер.
// Явно отмеченный этап, иначе выводится из статусов: replied → рекрутер, interview → hiring manager.
const FUNNEL = ['applied', 'recruiter', 'hiring_manager', 'final', 'offer'];
const STATUS_STAGE = { sent: 'applied', replied: 'recruiter', interview: 'hiring_manager', offer: 'offer' };
function funnelStage(a) {
  if (!a.sent && !a.stage) return null;
  if (a.stage) return a.stage;
  const seen = [a.status, ...(a.history || []).map((h) => h.to)].map((s) => STATUS_STAGE[s]).filter(Boolean);
  return seen.sort((x, y) => FUNNEL.indexOf(y) - FUNNEL.indexOf(x))[0] || 'applied';
}

// W3: вердикт первого отбора — из summary.json адаптации или отдельного 03-verdict.json (что новее)
function verdictOf(name) {
  const dir = outDir(name);
  const opts = [['summary.json', 'tailored'], ['03-verdict.json', null]].map(([f, src]) => {
    const p = path.join(dir, f);
    const j = readJSON(p);
    return j && ['yes', 'no', 'maybe'].includes(j.verdict) ? { j, m: mtime(p), src: src || j.cv || 'tailored' } : null;
  }).filter(Boolean).sort((x, y) => y.m - x.m);
  if (!opts.length) return null;
  const { j, m, src } = opts[0];
  return { verdict: j.verdict, reason: j.main_reason || '', tag: String(j.reason_tag || 'other').toLowerCase().trim(), cv: src, at: new Date(m).toISOString() };
}

// ---------- сборка карточек ----------

function scan() {
  const names = new Set();
  if (exists(VACANCIES)) for (const f of fs.readdirSync(VACANCIES)) if (f.endsWith('.md')) names.add(f.slice(0, -3));
  if (exists(OUTPUT)) for (const d of fs.readdirSync(OUTPUT)) if (fs.statSync(path.join(OUTPUT, d)).isDirectory()) names.add(d);
  return [...names];
}

function vacancyInfo(name) {
  const vf = path.join(VACANCIES, `${name}.md`);
  const md = exists(vf) ? fs.readFileSync(vf, 'utf8') : '';
  const fm = frontmatter(md);
  const a = app(name);
  const fromCorpus = pickFit(fitFromCorpus(name, fm));
  if (!a.fit) {
    if (fromCorpus) a.fit = fromCorpus;
    else if (fm.job_fit_score) a.fit = { total: parseInt(fm.job_fit_score, 10) };
  } else if (fromCorpus && fromCorpus.total === a.fit.total) {
    // Фит сохранён до появления новых полей (what_you_do, source, date_posted) — дополняем из корпуса,
    // только если это та же оценка; баллы не трогаем
    for (const [k, v] of Object.entries(fromCorpus)) if (a.fit[k] === undefined) a.fit[k] = v;
  }
  const dir = outDir(name);
  const hasCV = exists(path.join(dir, 'CV.docx'));
  const lf = letterFile(name);
  return {
    name,
    hasVacancy: !!md,
    // Ручная заявка (C4) без вставленного текста — файл есть, текста вакансии нет
    hasVacancyText: !!md && !md.includes(MANUAL_NO_TEXT),
    url: fm.url || a.fit?.url || '',
    apply: fm.apply || '',
    company: fm.company || a.fit?.company || name.split(' - ').slice(-1)[0],
    role: fm.role || a.fit?.title || name.split(' - ').slice(0, -1).join(' - '),
    status: a.status,
    fit: a.fit || null,
    hasCV, letterFile: lf,
    hasKeywords: exists(path.join(dir, '01-keywords.json')),
    baseVersion: hasCV ? (a.baseVersion || 1) : null,
    builtAt: hasCV ? mtime(path.join(dir, 'CV.docx')) : null,
    cv: a.cv || null, letter: a.letter || null,
    dictation: a.dictation || '',
    jobs: a.jobs || {},
    files: listFiles(name),
    created: a.created,
    sent: a.sent || null,
    history: a.history || [],
    waiting: waitingState(a),
    exportRole: a.exportRole || '', exportCompany: a.exportCompany || '',
    foundOn: a.foundOn || null,
    submittedAnswers: a.submittedAnswers || [],
    verdict: verdictOf(name), verdictAgree: a.verdictAgree || '', offerChecklist: a.offerChecklist || {},
    stage: funnelStage(a), stageExplicit: !!a.stage, stageHistory: a.stageHistory || [],
    rejection: a.rejection || null, debriefs: a.debriefs || [],
    // C10: страниц в последнем PDF письма — актуально, только если PDF собран из текущего письма
    letterPdf: a.letterPdf && lf && a.letterPdf.stamp === mtime(path.join(dir, lf)) ? a.letterPdf : null,
  };
}

module.exports = {
  load, save, state, app, scan, vacancyInfo, cvMetrics, letterMetrics, safeName, outDir, pickFit,
  exportNames, masterExportName, FUNNEL, STATUSES, CHANNELS, setStatus, noReplyDays, DAY, DATA, VACANCIES, OUTPUT, get inbox() { return state.inbox; },
};
