// CV Checker Web — локальная оболочка над конвейером (job-scout → tailor-cv → cover-letter).
// Запуск: npm run app → http://127.0.0.1:4317. Слушает только localhost: сервер запускает агента с правом записи.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { marked } = require('marked');
const { runJob, jobs, publicJob, ROOT, checkStatus, ensureReady, getStatus, readModels, saveModels, TASKS, MODEL_CHOICES } = require('./agent');
const runs = require('./runs');
const prompts = require('./prompts');
const store = require('./store');
const master = require('./master');
const brief = require('./brief');
const feed = require('./feed');
const events = require('./events');
const sites = require('./sites');
const cases = require('./cases');
const autofill = require('./autofill');
const alive = require('./alive');
const targets = require('./targets');
const money = require('./money');
const answerLib = require('./answer-lib');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4317;
const INBOX = path.join(store.DATA, 'inbox');
const DOWNLOADABLE = new Set(['.docx', '.pdf', '.md', '.json', '.log']);

store.load();
master.init();
const restored = runs.backfill();
if (restored) console.log(`журнал агента: восстановлено ${restored} запусков из логов`);
checkStatus();
setInterval(checkStatus, 5 * 60 * 1000);
const app = express();
app.use(express.json({ limit: '2mb' }));
// Express 5 оставляет req.body undefined у запросов без тела (кнопки шлют POST без body)
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use(express.static(path.join(__dirname, 'public')));

// Не запускаем агента, если CLI не залогинен: ошибка сразу, а не после запуска задачи
const agentReady = async (req, res, next) => {
  const r = await ensureReady();
  if (r.ok) return next();
  res.status(409).json({ error: r.error, agent: getStatus().state });
};

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(e.message === 'bad name' ? 400 : 500).json({ error: e.message });
});

function withJobs(info) {
  const out = {};
  for (const [k, id] of Object.entries(info.jobs || {})) {
    const j = publicJob(jobs.get(id));
    if (j) out[k] = j;
  }
  return { ...info, jobs: out };
}

function inboxList() {
  return Object.values(store.inbox)
    .map((it) => ({ ...it, job: publicJob(jobs.get(it.jobId)) }))
    .sort((a, b) => b.created - a.created);
}

// ---------- список и карточка ----------

app.get('/api/vacancies', wrap(async (req, res) => {
  const matches = await master.vacancyMatches();
  // W4: «есть контакт» — в целевой компании есть человек со статусом «поговорили» / «рекомендовал»
  const warm = targets.warmCompanies();
  const m = money.get().money;
  const items = store.scan().map((n) => {
    const info = store.vacancyInfo(n);
    return { ...withJobs(info), master: matches[n] || null, warm: warm.some((c) => targets.companyMatches(c, info.company)),
      salaryMismatch: money.mismatch(info.submittedAnswers, m) };
  });
  store.save();
  res.json({ items, inbox: inboxList(), statuses: store.STATUSES, masterVersion: master.activeVersion() });
}));

app.get('/api/vacancies/:name', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  await store.cvMetrics(name);
  await store.letterMetrics(name);
  const info = withJobs(store.vacancyInfo(name));
  info.master = (await master.vacancyMatches())[name] || null;
  info.masterVersion = master.activeVersion();
  info.cvStale = info.hasCV ? master.isStale(info.baseVersion) : false;
  info.exportNames = store.exportNames(name, info);
  info.agentUsage = runs.forTarget(name);
  info.formQuestions = store.app(name).formQuestions || '';
  info.answers = readAnswers(name);
  info.outline = await readOutline(name);
  info.letterFacts = info.letter?.mode === 'generated' ? readGeneratedTrace(name) : null;
  info.cardRefs = cardRefs(name, info);
  info.interview = readInterview(name);
  info.letterPrev = letterPrev(name);
  info.hasVoice = fs.existsSync(VOICE);
  info.salaryMismatch = money.mismatch(info.submittedAnswers);
  info.brief = brief.build({ dir: store.outDir(name), fit: info.fit, master: info.master, url: info.url });
  const dir = store.outDir(name);
  info.letterText = info.letterFile ? fs.readFileSync(path.join(dir, info.letterFile), 'utf8') : '';
  res.json(info);
}));

app.patch('/api/vacancies/:name', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (req.body.status !== undefined) {
    if (!store.STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'bad status' });
    if (req.body.status === 'sent' && !a.sent) return res.status(400).json({ error: 'отметь отправку через диалог: нужны дата и канал' });
    store.setStatus(a, req.body.status, { at: req.body.at, note: req.body.note });
  }
  if (typeof req.body.dictation === 'string') a.dictation = req.body.dictation;
  if (typeof req.body.formQuestions === 'string') a.formQuestions = req.body.formQuestions.slice(0, 8000);
  // W6: этап воронки; статус подтягивается: рекрутер → «Ответили», hiring manager / финал → «Интервью», оффер → «Оффер»
  if (req.body.stage !== undefined) {
    if (!store.FUNNEL.includes(req.body.stage)) return res.status(400).json({ error: 'неизвестный этап' });
    if (!a.sent) return res.status(400).json({ error: 'этапы — после отметки отправки' });
    if (a.stage !== req.body.stage) {
      a.stage = req.body.stage;
      (a.stageHistory = a.stageHistory || []).push({ at: new Date().toISOString(), stage: a.stage });
      const to = { recruiter: 'replied', hiring_manager: 'interview', final: 'interview', offer: 'offer' }[a.stage];
      const rank = { sent: 1, replied: 2, interview: 3, offer: 4 };
      if (to && !['rejected', 'skip'].includes(a.status) && (rank[to] || 0) > (rank[a.status] || 0)) store.setStatus(a, to, { note: `этап: ${a.stage}` });
    }
  }
  // W7 P1: чеклист «перед тем как сказать да» — отмеченные пункты
  if (req.body.offerChecklist && typeof req.body.offerChecklist === 'object') {
    a.offerChecklist = Object.fromEntries(Object.entries(req.body.offerChecklist).filter(([, v]) => v).map(([k]) => [String(k).slice(0, 30), true]));
  }
  // W3: согласен ли ты с главной причиной вердикта
  if (['yes', 'partial', 'no', ''].includes(req.body.verdictAgree)) { if (req.body.verdictAgree) a.verdictAgree = req.body.verdictAgree; else delete a.verdictAgree; }
  // Своя позиция / компания для имени файла; пустая строка — вернуть вычисленную
  for (const k of ['exportRole', 'exportCompany']) {
    if (typeof req.body[k] === 'string') {
      const v = req.body[k].trim().slice(0, 60);
      if (v) a[k] = v; else delete a[k];
    }
  }
  a.updated = Date.now();
  store.save();
  res.json({ ok: true });
}));

// ---------- отправка и фоллоу-ап (M1, docs/specs/01-sent-and-follow-up.md) ----------

const isoDate = (v) => {
  if (!v) return new Date().toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error('bad date');
  // дата без времени из <input type=date> — ставим полдень, чтобы не уехать на соседний день
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`).toISOString() : new Date(t).toISOString();
};

app.post('/api/vacancies/:name/sent', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  const info = store.vacancyInfo(name);
  const { channel, target = '', note = '', checklist = {} } = req.body;
  if (!store.CHANNELS.includes(channel)) return res.status(400).json({ error: 'выбери канал' });
  const reviewed = checklist.skipped || ((!info.hasCV || checklist.cv) && (!info.letterFile || checklist.letter));
  if (!reviewed) return res.status(400).json({ error: 'отметь, что CV и письмо проверены, или «отправил без проверки»' });
  let at;
  try { at = isoDate(req.body.at); } catch { return res.status(400).json({ error: 'неверная дата' }); }
  a.sent = {
    at, channel, target: String(target).trim(), note: String(note).trim(),
    cvBaseVersion: info.hasCV ? info.baseVersion : null,
    letterFile: info.letterFile || null,
    letterMode: info.letterFile ? (info.letter?.mode || 'dictated') : 'none',
    package: info.hasCV,
    checklist: { cv: !!checklist.cv, letter: !!checklist.letter, skipped: !!checklist.skipped },
  };
  store.setStatus(a, 'sent', { at, note: `канал: ${channel}` });
  a.updated = Date.now();
  store.save();
  res.json({ ok: true, sent: a.sent });
}));

// C5: на каком сайте каталога найдена вакансия → {id, name} или null
function foundOnOf(id) {
  const s = id ? sites.byId(String(id)) : null;
  return s ? { id: s.id, name: s.name } : null;
}

// C4: отклик вне приложения — файл вакансии + запись отправки «без пакета», без агента
app.post('/api/vacancies/manual', wrap(async (req, res) => {
  const company = String(req.body.company || '').trim();
  const role = String(req.body.role || '').trim();
  const channel = String(req.body.channel || 'other');
  if (!company || !role) return res.status(400).json({ error: 'нужны компания и роль' });
  if (!store.CHANNELS.includes(channel)) return res.status(400).json({ error: 'неизвестный канал' });
  let at;
  try { at = isoDate(req.body.at); } catch { return res.status(400).json({ error: 'неверная дата' }); }
  const name = `${role} - ${company}`.replace(/[\/:]/g, '-').replace(/\s+/g, ' ').slice(0, 120).trim();
  const norm = (x) => String(x).toLowerCase().replace(/[^a-zа-я0-9]+/g, '');
  const dup = store.scan().find((n) => norm(n) === norm(name));
  if (dup) return res.status(409).json({ error: 'такая заявка уже есть', existing: dup });
  const url = String(req.body.url || '').trim();
  const fm = ['---', `role: ${role}`, `company: ${company}`, url && `url: ${url}`, 'source: manual',
    `added: ${new Date().toISOString().slice(0, 10)}`, '---'].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(store.VACANCIES, `${name}.md`), `${fm}\n\n# ${role} — ${company}\n\n` +
    '_Заявка добавлена вручную: отклик был сделан вне приложения. Текста вакансии нет — чтобы оценить фит, вставь его сюда._\n');
  const a = store.app(name);
  a.sent = { at, channel, target: url, note: String(req.body.note || '').trim(), cvBaseVersion: master.activeVersion(),
    letterFile: null, letterMode: 'none', package: false, checklist: { cv: false, letter: false, skipped: true }, manual: true };
  const found = foundOnOf(req.body.foundOn);
  if (found) a.foundOn = found;
  store.setStatus(a, 'sent', { at, note: `вне приложения, канал: ${channel}` });
  store.save();
  res.json({ ok: true, name });
}));

// ---------- мои ответы при подаче (C6, docs/specs/17-submitted-answers.md) ----------

function answerPair(body) {
  const q = String(body.q ?? '').trim();
  const a = String(body.a ?? '').replace(/\s+$/, '').replace(/^\s*\n/, '');
  if (!q) throw new Error('впиши вопрос');
  if (!a.trim()) throw new Error('впиши ответ');
  if (q.length > 300) throw new Error('вопрос длиннее 300 символов');
  if (a.length > 5000) throw new Error('ответ длиннее 5000 символов');
  return { q, a };
}

app.post('/api/vacancies/:name/submitted-answers', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  let pair;
  try { pair = answerPair(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const a = store.app(name);
  const item = { id: crypto.randomUUID().slice(0, 8), ...pair, at: new Date().toISOString() };
  (a.submittedAnswers = a.submittedAnswers || []).push(item);
  store.save();
  res.json(item);
}));

app.patch('/api/vacancies/:name/submitted-answers/:id', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const item = (store.app(name).submittedAnswers || []).find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'нет такого ответа' });
  let pair;
  try { pair = answerPair(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  Object.assign(item, pair, { updated: new Date().toISOString() });
  store.save();
  res.json(item);
}));

app.delete('/api/vacancies/:name/submitted-answers/:id', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  const before = (a.submittedAnswers || []).length;
  a.submittedAnswers = (a.submittedAnswers || []).filter((x) => x.id !== req.params.id);
  if (a.submittedAnswers.length === before) return res.status(404).json({ error: 'нет такого ответа' });
  store.save();
  res.json({ ok: true });
}));

// Отмена отметки: возвращаемся к подготовке, след остаётся в истории
app.delete('/api/vacancies/:name/sent', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (a.status !== 'sent' || !a.sent) return res.status(400).json({ error: 'заявка не в статусе «Отправлено»' });
  const info = store.vacancyInfo(name);
  delete a.sent;
  store.setStatus(a, info.hasCV && info.letterFile ? 'ready' : 'new', { note: 'отправка отменена' });
  store.save();
  res.json({ ok: true });
}));

// Отрендеренный markdown (report.md, вакансия и т.п.) для модалки
app.get('/api/vacancies/:name/doc', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const file = String(req.query.file || '');
  let p;
  if (file === '__vacancy__') p = path.join(store.VACANCIES, `${name}.md`);
  else {
    if (!file.endsWith('.md') || file.includes('/') || file.includes('..')) return res.status(400).json({ error: 'bad file' });
    p = path.join(store.outDir(name), file);
  }
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'нет файла' });
  const md = fs.readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  res.json({ html: marked.parse(md) });
}));

// ---------- файлы письма: PDF и DOCX (C10, docs/specs/21-letter-export.md) ----------

// Пересобирает, только если изменилось содержимое письма или шапки CV; запоминает число страниц для предупреждения
function buildLetterFiles(name, force = false) {
  return new Promise((resolve) => {
    execFile(path.join(ROOT, '.venv', 'bin', 'python'), ['scorer/build_letter.py', '--name', name, '--json', ...(force ? ['--force'] : [])],
      { cwd: ROOT, timeout: 240000 }, (err, stdout) => {
        let r;
        try { r = JSON.parse(stdout); } catch { r = { error: 'сборка файлов письма не запустилась' }; }
        if (!r.error) {
          const lf = path.join(store.outDir(name), store.vacancyInfo(name).letterFile || 'Cover Letter.md');
          store.app(name).letterPdf = { pages: r.pages, stamp: fs.existsSync(lf) ? fs.statSync(lf).mtimeMs : 0 };
          store.save();
        }
        resolve(r);
      });
  });
}

// Третий сегмент — имя для просмотрщика PDF, как у CV (E1)
app.get(['/letter-file/:name/:fmt', '/letter-file/:name/:fmt/:label'], wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const fmt = req.params.fmt;
  if (!['pdf', 'docx'].includes(fmt)) return res.status(400).json({ error: 'формат: pdf или docx' });
  const r = await buildLetterFiles(name);
  if (r.error || !r[fmt]) return res.status(400).json({ error: r.error || 'файл не собран' });
  const names = store.exportNames(name, store.vacancyInfo(name));
  sendNamed(req, res, path.join(ROOT, r[fmt]), fmt === 'pdf' ? names.letterPdf : names.letterDocx);
}));

// inline с именем: «Сохранить» в просмотрщике PDF предлагает то же имя, что и скачивание
const inlineName = (fname) => `inline; filename="${fname.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fname)}`;

function sendNamed(req, res, p, fname) {
  if (req.query.download) res.download(p, fname);
  else res.sendFile(p, { headers: { 'Content-Disposition': inlineName(fname) } });
}

// Третий сегмент пути — человекочитаемое имя (для просмотрщика PDF); на выдачу не влияет
app.get(['/files/:name/:file', '/files/:name/:file/:label'], wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const file = req.params.file;
  if (file.includes('/') || file.includes('..') || !DOWNLOADABLE.has(path.extname(file))) return res.status(400).end();
  const p = path.join(store.outDir(name), file);
  if (!fs.existsSync(p)) return res.status(404).end();
  const info = store.vacancyInfo(name);
  const names = store.exportNames(name, info);
  const fname = file === 'CV.docx' ? names.cvDocx : file === 'CV.pdf' ? names.cvPdf
    : file === info.letterFile ? names.letter : `${name} - ${file}`;
  sendNamed(req, res, p, fname);
}));

app.post('/api/vacancies/:name/reveal', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const dir = fs.existsSync(store.outDir(name)) ? store.outDir(name) : path.join(store.VACANCIES, `${name}.md`);
  execFile('open', fs.statSync(dir).isDirectory() ? [dir] : ['-R', dir]);
  res.json({ ok: true });
}));

// ---------- шаг 1: новая вакансия → фит ----------

// ---------- быстрый фит (2026-10-27): один ход модели без инструментов, остальное — сервер ----------
// Контекст, который агент раньше собирал 16 ходами (бриф, профиль, карточки), кладётся в один промпт.
function fitQuickPrompt(vacancy) {
  const read = (f, d = '') => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return d; } };
  const briefText = read('job-fit-search-brief.md') || read('examples/demo/job-fit-search-brief.md');
  let profile = {};
  try { profile = JSON.parse(read('knowledge-base/profile.json', '{}')); } catch {}
  const cardsIndex = read('knowledge-base/cards/INDEX.md').split('\n').filter((l) => l.startsWith('| [')).join('\n');
  return prompts.fitQuick({ briefText, profile, cardsIndex, vacancy });
}

const SCORE_MAX = { task_fit: 4, domain: 2, role_type: 2, logistics: 2 };
// Ответ модели → job.json для score_job.py (баллы зажаты в шкалу) + ключи и требования для шага 1 tailor-cv
function parseQuickFit(text) {
  const t = String(text || '');
  const from = t.indexOf('{'), to = t.lastIndexOf('}');
  if (from < 0 || to < from) throw new Error('модель не вернула JSON');
  const d = JSON.parse(t.slice(from, to + 1));
  const scores = Object.fromEntries(Object.entries(SCORE_MAX).map(([k, max]) => [k, Math.max(0, Math.min(max, Math.round(Number(d.scores?.[k]) || 0)))]));
  const { keywords, requirements, ...job } = d;
  return { job: { ...job, scores }, keywords: keywords || {}, requirements: requirements || {} };
}

// 01-keywords.json и 01-requirements.md из быстрого фита — черновик (source: quick); tailor-cv переделает шаг 1
function writeQuickKeywords(name, keywords, requirements, title) {
  const dir = store.outDir(name);
  const kwFile = path.join(dir, '01-keywords.json');
  let old = null;
  try { old = JSON.parse(fs.readFileSync(kwFile, 'utf8')); } catch {}
  if (old && old.source !== 'quick') return; // ключи полного шага 1 не трогаем
  const list = (x) => (Array.isArray(x) ? x.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 25) : []);
  const must = list(keywords.must), nice = list(keywords.nice);
  if (!must.length) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(kwFile, `${JSON.stringify({ source: 'quick', must, nice }, null, 2)}\n`);
  const row = (r) => `| ${String(r.req || '').replace(/\|/g, '/')} | ${String(r.evidence || '').replace(/\|/g, '/')} |`;
  const reqs = (k) => (Array.isArray(requirements[k]) ? requirements[k] : []).filter((r) => r && r.req);
  fs.writeFileSync(path.join(dir, '01-requirements.md'), `# Требования: ${title}\n\n_Черновик быстрого фита — tailor-cv уточнит на шаге 1._\n\n`
    + `## Must\n\n| Требование | Что считается доказательством |\n|---|---|\n${reqs('must').map(row).join('\n')}\n\n`
    + `## Nice\n\n| Требование | Доказательство |\n|---|---|\n${reqs('nice').map(row).join('\n')}\n`);
}

function scoreJobAdd(args) {
  return new Promise((resolve, reject) => {
    execFile(path.join(ROOT, '.venv', 'bin', 'python'), ['scorer/score_job.py', 'add', ...args], { cwd: ROOT, timeout: 60000 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout)));
  });
}

// Быстрый фит: target — id входящей или имя вакансии; existing — вакансия уже есть (переоценка)
function runQuickFit({ target, vacancy, url, source, existing, onResult }) {
  const id = existing ? crypto.randomUUID().slice(0, 8) : target;
  const jobFile = path.join(INBOX, `${id}.job.json`);
  const resultFile = path.join(INBOX, `${id}.result.json`);
  fs.rmSync(resultFile, { force: true });
  return runJob({
    kind: 'fitquick', target, system: prompts.FIT_QUICK_SYSTEM,
    prompt: fitQuickPrompt(vacancy),
    logFile: path.join(INBOX, `${id}.log`),
    onDone: async (job) => {
      const q = parseQuickFit(job.finalText);
      fs.writeFileSync(jobFile, JSON.stringify({ ...q.job, url: url || q.job.url || '', source: source || q.job.source || 'manual',
        raw_text: vacancy, fit_mode: 'quick' }, null, 2));
      await scoreJobAdd([existing ? '--no-save' : '--save-always', '--result', resultFile, jobFile]);
      if (!fs.existsSync(resultFile)) throw new Error('score_job.py не записал результат');
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      const name = existing || (r.vacancy_file ? path.basename(r.vacancy_file, '.md') : null);
      if (!name) throw new Error('скоринг прошёл, но файл вакансии не создан');
      writeQuickKeywords(name, q.keywords, q.requirements, `${q.job.title || ''} — ${q.job.company || ''}`);
      await onResult(r, name, job);
    },
  });
}

function startFit(item) {
  const id = item.id;
  const resultFile = path.join(INBOX, `${id}.result.json`);
  // Есть текст вакансии — быстрый фит (один ход, ≈ $0.003); только ссылка — агент (ему нужен WebFetch)
  const textFile = path.join(INBOX, `${id}.txt`);
  if (item.hasText && fs.existsSync(textFile)) {
    const job = runQuickFit({ target: id, vacancy: fs.readFileSync(textFile, 'utf8'), url: item.url, source: item.source,
      onResult: async (r, name, j) => applyInboxFit(item, r, name, j) });
    return trackInboxJob(item, job);
  }
  fs.rmSync(resultFile, { force: true });
  const job = runJob({
    kind: 'fit', target: id,
    prompt: prompts.fit({ id, text: item.hasText, url: item.url }),
    logFile: path.join(INBOX, `${id}.log`),
    onDone: async () => {
      if (!fs.existsSync(resultFile)) throw new Error('агент не записал результат скоринга');
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      if (r.status === 'needs_text') {
        item.state = 'needs_text';
        item.reason = r.reason || 'не удалось открыть ссылку';
        store.save();
        return;
      }
      if (!r.vacancy_file) throw new Error('скоринг прошёл, но файл вакансии не создан');
      applyInboxFit(item, r, path.basename(r.vacancy_file, '.md'), job, 'deep');
    },
  });
  return trackInboxJob(item, job);
}

function applyInboxFit(item, r, name, job, mode = 'quick') {
  job.vacancy = name;
  const a = store.app(name);
  a.fit = { ...store.pickFit(r), mode, model: job.actualModel || job.model || null };
  if (item.foundOn && !a.foundOn) a.foundOn = item.foundOn;
  if ((a.fit?.total ?? 0) >= 7 && a.fit.bucket !== 'corpus') {
    events.add({ type: 'strong_fit', title: `Сильный фит: ${a.fit.total}/10`, text: name, link: `#/v/${encodeURIComponent(name)}` });
  }
  if (item.url && a.fit && !a.fit.url) a.fit.url = item.url;
  item.state = 'done';
  item.name = name;
  store.save();
}

function trackInboxJob(item, job) {
  item.jobId = job.id;
  item.state = 'running';
  item.reason = '';
  job.listeners.add((ev) => {
    if (ev.done && job.error) { item.state = 'error'; item.reason = job.error; store.save(); }
  });
  store.save();
  return job;
}

// Новая входящая вакансия → фит агентом. Источник — форма, быстрое добавление или лента (S1)
function createInbox({ text, url, source, foundOn }) {
  const id = crypto.randomUUID().slice(0, 8);
  if (text) fs.writeFileSync(path.join(INBOX, `${id}.txt`), url ? `Ссылка: ${url}\n\n${text}` : text);
  const item = {
    id, url, hasText: !!text, created: Date.now(), ...(source ? { source } : {}), ...(foundOn ? { foundOn } : {}),
    preview: (text.split('\n').find((l) => l.trim()) || url).slice(0, 90),
  };
  store.inbox[id] = item;
  const job = startFit(item);
  return { id, jobId: job.id };
}

app.post('/api/vacancies', agentReady, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  const url = String(req.body.url || '').trim();
  if (!text && !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'нужен текст вакансии или ссылка' });
  res.json(createInbox({ text, url, foundOn: foundOnOf(req.body.foundOn) }));
}));

// ---------- лента вакансий (S1, docs/specs/03-job-feed.md) ----------

app.get('/api/feed', wrap(async (req, res) => {
  const data = await feed.feed();
  const norm = (u) => String(u || '').split('?')[0].replace(/\/+$/, '');
  const inboxUrls = new Set(Object.values(store.inbox).map((it) => norm(it.url)).filter(Boolean));
  const r = feed.currentRefresh();
  res.json({ ...data, items: data.items.filter((i) => !inboxUrls.has(norm(i.url))), refresh: r ? publicJob(r) : null });
}));

// S1 P1 · счётчик «N новых» в меню: только ключи вакансий ленты (без пропущенных)
app.get('/api/feed/keys', wrap(async (req, res) => {
  const data = await feed.feed();
  res.json({ keys: data.items.map((i) => i.key), generatedAt: data.generatedAt });
}));

app.post('/api/feed/save', agentReady, wrap(async (req, res) => {
  const j = await feed.getOne(String(req.body.key || ''));
  if (!j) return res.status(404).json({ error: 'вакансия не найдена в ленте — обнови ленту' });
  const head = [`${j.title} — ${j.company}`, [j.location, j.seniority, j.salary].filter(Boolean).join(' · '),
    `Источник: ${j.source}${j.posted ? `, опубликовано ${j.posted}` : ''}`].filter(Boolean).join('\n');
  res.json(createInbox({ text: `${head}\n\n${j.description}`, url: j.url, source: `feed:${j.source}` }));
}));

app.post('/api/feed/skip', wrap(async (req, res) => {
  const key = String(req.body.key || '');
  if (!key) return res.status(400).json({ error: 'нет ключа' });
  feed.skip(key, req.body);
  res.json({ ok: true });
}));

app.delete('/api/feed/skip', wrap(async (req, res) => {
  feed.unskip(String(req.body.key || ''));
  res.json({ ok: true });
}));

app.post('/api/feed/refresh', wrap(async (req, res) => {
  const mode = ['edtech', 'fintech'].includes(req.body.mode) ? req.body.mode : 'all';
  res.json({ job: publicJob(feed.refresh(mode)) });
}));

// ---------- раздел «EdTech» (S6, docs/specs/14-edtech-careers.md) ----------

// Базы компаний по отраслям (S6 EdTech, S7 FinTech)
const SECTOR_NAMES = ['edtech', 'fintech'];
const sectorAgentJob = {};
const sectorOf = (req) => (SECTOR_NAMES.includes(req.params.sector) ? req.params.sector : null);

app.get('/api/feed/:sector/companies', wrap(async (req, res) => {
  const sector = sectorOf(req);
  if (!sector) return res.status(404).json({ error: 'нет такой отрасли' });
  const data = await feed.companies(sector);
  const j = sectorAgentJob[sector] && jobs.get(sectorAgentJob[sector]);
  res.json({ ...data, agent: j ? publicJob(j) : null });
}));

app.post('/api/feed/:sector/discover', agentReady, wrap(async (req, res) => {
  const sector = sectorOf(req);
  if (!sector) return res.status(404).json({ error: 'нет такой отрасли' });
  const cur = sectorAgentJob[sector] && jobs.get(sectorAgentJob[sector]);
  if (cur && ['running', 'queued'].includes(cur.state)) return res.status(409).json({ error: 'агент уже расширяет базу' });
  const limit = Math.min(50, Math.max(5, Number(req.body.limit) || 30));
  const job = runJob({
    kind: 'edtech', target: `${sector}-base`,
    prompt: prompts.edtechCompanies({ limit, sector }),
    logFile: path.join(store.DATA, `${sector}-agent.log`),
  });
  sectorAgentJob[sector] = job.id;
  res.json({ jobId: job.id });
}));

// S6 P1 · добавить компанию вручную: сначала бесплатный пробник edtech.py add; не вышло — по кнопке агент
app.post('/api/feed/:sector/companies', wrap(async (req, res) => {
  const sector = sectorOf(req);
  if (!sector) return res.status(404).json({ error: 'нет такой отрасли' });
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'нужно название компании' });
  const careersUrl = String(req.body.careersUrl || '').trim().slice(0, 300);
  if (careersUrl && !/^https?:\/\//.test(careersUrl)) return res.status(400).json({ error: 'ссылка должна начинаться с http' });
  try {
    const existed = (await feed.companies(sector)).companies.some((c) => c.name.toLowerCase() === name.toLowerCase());
    const r = await feed.addCompany(sector, { name, careersUrl, country: String(req.body.country || '').trim(), segment: String(req.body.segment || '').trim() });
    res.json({ ...r, existed });
  } catch (e) { res.status(400).json({ error: `пробник не сработал: ${e.message}` }); }
}));

app.post('/api/feed/:sector/companies/find', agentReady, wrap(async (req, res) => {
  const sector = sectorOf(req);
  if (!sector) return res.status(404).json({ error: 'нет такой отрасли' });
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'нужно название компании' });
  const cur = sectorAgentJob[sector] && jobs.get(sectorAgentJob[sector]);
  if (cur && ['running', 'queued'].includes(cur.state)) return res.status(409).json({ error: 'агент уже работает с базой' });
  const job = runJob({
    kind: 'edtech', target: `${sector}-base`,
    prompt: prompts.sectorCompany({ sector, name, careersUrl: String(req.body.careersUrl || '').trim().slice(0, 300) }),
    logFile: path.join(store.DATA, `${sector}-agent.log`),
  });
  sectorAgentJob[sector] = job.id;
  res.json({ jobId: job.id });
}));

// ---------- каталог сайтов вакансий (C5, docs/specs/16-job-sites.md) ----------

app.get('/api/job-sites', wrap(async (req, res) => res.json(sites.list())));

app.post('/api/job-sites/:id/visit', wrap(async (req, res) => {
  const at = sites.visit(req.params.id);
  if (!at) return res.status(404).json({ error: 'нет такого сайта' });
  res.json({ ok: true, at });
}));

app.post('/api/job-sites', wrap(async (req, res) => {
  try { res.json(sites.add(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.patch('/api/job-sites/:id', wrap(async (req, res) => {
  let s;
  try { s = sites.update(req.params.id, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!s) return res.status(404).json({ error: 'нет такого сайта' });
  res.json(s);
}));

app.delete('/api/job-sites/:id', wrap(async (req, res) => {
  if (!sites.remove(req.params.id)) return res.status(400).json({ error: 'удалить можно только свой сайт — сайты каталога скрываются' });
  res.json({ ok: true });
}));

// ---------- подготовка к собеседованию (W5, docs/specs/27-interview-prep.md) ----------

const STORIES = path.join(ROOT, 'knowledge-base', 'stories.json');
function readInterview(name) {
  const dir = store.outDir(name);
  let prep = null;
  try { prep = JSON.parse(fs.readFileSync(path.join(dir, '07-interview.json'), 'utf8')); } catch {}
  let log = [];
  try { log = fs.readFileSync(path.join(dir, '07-practice.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  return { prep, practice: log };
}

// Общий банк историй: истории из всех подготовок, без дублей по карточке и теме
function mergeStories(stories, vacancy) {
  let bank = [];
  try { bank = JSON.parse(fs.readFileSync(STORIES, 'utf8')); } catch {}
  for (const s of stories || []) {
    if (!s.card) continue;
    const i = bank.findIndex((b) => b.card === s.card && b.theme === s.theme);
    const rec = { ...s, updated: new Date().toISOString(), vacancies: [...new Set([...(i >= 0 ? bank[i].vacancies || [] : []), vacancy])] };
    if (i >= 0) bank[i] = rec; else bank.push(rec);
  }
  fs.writeFileSync(STORIES, JSON.stringify(bank, null, 2));
}

app.post('/api/vacancies/:name/interview', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (lacksText(name)) return res.status(400).json({ error: NO_TEXT });
  const a = store.app(name);
  if (busy(a, 'interview')) return res.status(409).json({ error: 'уже идёт' });
  if (!fs.existsSync(path.join(store.VACANCIES, `${name}.md`))) return res.status(400).json({ error: 'нет текста вакансии' });
  const dir = store.outDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '07-interview.json');
  const before = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
  const job = runJob({
    kind: 'interview', target: name,
    prompt: prompts.interviewPrep({ name, hasCV: fs.existsSync(path.join(dir, 'CV.md')) }),
    logFile: path.join(dir, 'agent-interview.log'),
    onDone: async () => {
      if (!fs.existsSync(f) || fs.statSync(f).mtimeMs === before) throw new Error('агент не записал 07-interview.json');
      const prep = JSON.parse(fs.readFileSync(f, 'utf8'));
      mergeStories(prep.stories, name);
    },
  });
  attach(name, 'interview', job);
  res.json({ jobId: job.id });
}));

// Тренажёр: вопрос + твой ответ (голосом или текстом) → оценка 1–4, чего не хватило, уточнения. Без похвалы и переписывания
app.post('/api/vacancies/:name/practice', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (busy(a, 'practice')) return res.status(409).json({ error: 'предыдущий ответ ещё оценивается' });
  const question = String(req.body.question || '').trim().slice(0, 500);
  const answer = String(req.body.answer || '').trim().slice(0, 6000);
  if (!question || answer.split(/\s+/).length < 10) return res.status(400).json({ error: 'нужны вопрос и ответ хотя бы из 10 слов' });
  const dir = store.outDir(name);
  fs.mkdirSync(path.join(store.DATA, 'practice'), { recursive: true });
  const outRel = `web/data/practice/${crypto.randomUUID().slice(0, 8)}.json`;
  const out = path.join(ROOT, outRel);
  const job = runJob({
    kind: 'practice', target: name,
    prompt: prompts.practice({ name, question, answer, out: outRel }),
    logFile: path.join(store.DATA, 'practice', 'agent.log'),
    onDone: async () => {
      let r;
      try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { throw new Error('агент не записал оценку'); }
      fs.mkdirSync(dir, { recursive: true });
      const rec = { at: new Date().toISOString(), question, answer, score: r.score, criteria: r.criteria || {}, missing: r.missing || [], followups: r.followups || [], parent: req.body.parent || null };
      fs.appendFileSync(path.join(dir, '07-practice.jsonl'), `${JSON.stringify(rec)}\n`);
      fs.rmSync(out, { force: true });
    },
  });
  attach(name, 'practice', job);
  res.json({ jobId: job.id });
}));

app.get('/api/stories', wrap(async (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(STORIES, 'utf8'))); } catch { res.json([]); }
}));

// ---------- целевые компании и контакты (W4, docs/specs/26-target-companies.md) ----------

const outreachJobs = {}; // contactId → jobId
const tWrap = (fn) => wrap(async (req, res) => { try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); } });

app.get('/api/targets', wrap(async (req, res) => {
  let items = [];
  try { items = (await feed.feed()).items; } catch {}
  const data = targets.list(items);
  for (const c of data.companies) for (const p of c.contacts) {
    const j = outreachJobs[p.id] && jobs.get(outreachJobs[p.id]);
    if (j) p.job = publicJob(j);
  }
  // Заявки в целевые компании — чтобы видеть, куда уже подался
  const apps = store.scan().map((n) => store.vacancyInfo(n));
  for (const c of data.companies) c.applications = apps.filter((i) => targets.companyMatches(c.name, i.company)).map((i) => ({ name: i.name, role: i.role, status: i.status }));
  res.json(data);
}));
app.post('/api/targets', tWrap(async (req, res) => res.json(targets.add(req.body))));
app.patch('/api/targets/:id', tWrap(async (req, res) => res.json(targets.update(req.params.id, req.body) || {})));
app.delete('/api/targets/:id', tWrap(async (req, res) => { targets.remove(req.params.id); res.json({ ok: true }); }));
app.put('/api/targets-prefs', tWrap(async (req, res) => res.json(targets.setPrefs(req.body))));
app.post('/api/targets/:id/contacts', tWrap(async (req, res) => res.json(targets.addContact(req.params.id, req.body))));
app.patch('/api/targets/:id/contacts/:pid', tWrap(async (req, res) => res.json(targets.updateContact(req.params.id, req.params.pid, req.body) || {})));
app.delete('/api/targets/:id/contacts/:pid', tWrap(async (req, res) => { targets.removeContact(req.params.id, req.params.pid); res.json({ ok: true }); }));

// Черновик первого сообщения: 3 предложения, без просьбы о работе (проверяется словарём), humanizer
const ASK_FOR_JOB = /\b(refer|referral|recommend me|hire me|are you hiring|job opening|open (role|position)|my (cv|resume)|attached)\b|рекоменд|порекоменд|резюме|вакансию для меня/i;
app.post('/api/targets/:id/contacts/:pid/draft', agentReady, tWrap(async (req, res) => {
  const { company, contact } = targets.contactOf(req.params.id, req.params.pid);
  if (!contact) return res.status(404).json({ error: 'нет такого контакта' });
  const cur = outreachJobs[contact.id] && jobs.get(outreachJobs[contact.id]);
  if (cur && ['running', 'queued'].includes(cur.state)) return res.status(409).json({ error: 'уже пишется' });
  let items = [];
  try { items = (await feed.feed()).items; } catch {}
  const vac = items.find((i) => targets.companyMatches(company.name, i.company));
  const dir = path.join(store.DATA, 'outreach');
  fs.mkdirSync(dir, { recursive: true });
  const outRel = `web/data/outreach/${contact.id}.json`;
  const out = path.join(ROOT, outRel);
  fs.rmSync(out, { force: true });
  const job = runJob({
    kind: 'outreach', target: company.name,
    prompt: prompts.outreach({ company: company.name, why: company.why, contact, vacancy: vac ? `${vac.title} (${vac.url})` : '', out: outRel }),
    logFile: path.join(dir, `${contact.id}.log`),
    onDone: async () => {
      let r;
      try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { throw new Error('агент не записал черновик'); }
      const msg = String(r.message || '').trim();
      if (!msg) throw new Error('пустой черновик');
      const sentences = msg.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
      const warn = [ASK_FOR_JOB.test(msg) && 'похоже на просьбу о работе — перепиши', sentences > 3 && `${sentences} предложений — по формуле не больше трёх`].filter(Boolean);
      targets.updateContact(company.id, contact.id, { draft: { text: msg, language: r.language || contact.language, at: new Date().toISOString(), warn } });
    },
  });
  outreachJobs[contact.id] = job.id;
  res.json({ jobId: job.id });
}));

// Раз в сутки: «написал» больше 7 дней назад без ответа — напоминание (C3), один раз на контакт
setInterval(() => {
  const data = targets.list();
  for (const c of data.companies) for (const p of c.contacts) {
    if (p.remind && !p.reminded) {
      events.add({ type: 'target', title: `Напомнить: ${p.name} (${c.name})`, text: 'Написал больше недели назад — можно написать ещё раз', link: '#/feed' });
      targets.updateContact(c.id, p.id, { reminded: true });
    }
  }
}, 24 * 60 * 60 * 1000);

// ---------- отказы и разбор после собеседования (W6, docs/specs/28-funnel-rejections.md) ----------

const clip = (v, n = 2000) => String(v || '').trim().slice(0, n);

// Отказ: этап, что знаю точно, моя версия, фидбек. Статус → «Отказ»
app.post('/api/vacancies/:name/rejection', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  const stage = store.FUNNEL.includes(req.body.stage) ? req.body.stage : (store.vacancyInfo(name).stage || 'applied');
  a.rejection = { stage, facts: clip(req.body.facts), version: clip(req.body.version), feedback: clip(req.body.feedback), at: new Date().toISOString() };
  if (a.status !== 'rejected') store.setStatus(a, 'rejected', { note: `отказ на этапе ${stage}` });
  store.save();
  res.json({ ok: true, rejection: a.rejection });
}));

// Разбор после собеседования — 5 вопросов воркбука
app.post('/api/vacancies/:name/debrief', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  const b = req.body || {};
  const d = { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(),
    stage: store.FUNNEL.includes(b.stage) ? b.stage : (store.vacancyInfo(name).stage || 'recruiter'),
    asked: clip(b.asked), concrete: clip(b.concrete), lost: clip(b.lost), repeated: clip(b.repeated), practice: clip(b.practice) };
  if (!d.asked && !d.lost && !d.practice) return res.status(400).json({ error: 'заполни хотя бы «что спрашивали», «где поплыл» или «что тренировать»' });
  (a.debriefs = a.debriefs || []).push(d);
  store.save();
  res.json(d);
}));

app.delete('/api/vacancies/:name/debrief/:id', wrap(async (req, res) => {
  const a = store.app(store.safeName(req.params.name));
  a.debriefs = (a.debriefs || []).filter((x) => x.id !== req.params.id);
  store.save();
  res.json({ ok: true });
}));

// ---------- вердикт рекрутера (W3, docs/specs/25-recruiter-verdict.md) ----------

// Для CV, собранных до W3, или по Master CV, если адаптации нет; новые CV получают вердикт в tailor-cv
// Ручная заявка без текста вакансии (C4): агентным шагам не с чем работать — отказ до запуска, без трат
const NO_TEXT = 'нет текста вакансии — вставь его в блоке «Матч»';
const lacksText = (name) => !store.vacancyInfo(name).hasVacancyText;

app.post('/api/vacancies/:name/verdict', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (lacksText(name)) return res.status(400).json({ error: NO_TEXT });
  const a = store.app(name);
  if (busy(a, 'verdict')) return res.status(409).json({ error: 'уже идёт' });
  if (!fs.existsSync(path.join(store.VACANCIES, `${name}.md`))) return res.status(400).json({ error: 'нет текста вакансии' });
  const dir = store.outDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '03-verdict.json');
  const before = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
  const job = runJob({
    kind: 'verdict', target: name,
    prompt: prompts.verdict({ name, hasCV: fs.existsSync(path.join(dir, 'CV.md')) }),
    logFile: path.join(dir, 'agent-verdict.log'),
    onDone: async () => {
      if (!fs.existsSync(f) || fs.statSync(f).mtimeMs === before) throw new Error('агент не записал 03-verdict.json');
      delete a.verdictAgree;
      store.save();
    },
  });
  attach(name, 'verdict', job);
  res.json({ jobId: job.id });
}));

// ---------- «Вакансия ещё живая?» (W2, docs/specs/24-vacancy-alive.md) ----------

app.get('/api/vacancies/:name/alive', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  res.json(await alive.check(name, store.vacancyInfo(name), req.query.force === '1'));
}));

// Раз в 6 часов — активные заявки (new, ready); вакансия закрылась → уведомление (C3)
async function aliveSweep() {
  for (const name of store.scan()) {
    const a = store.state.apps[name];
    if (!a || !['new', 'ready'].includes(a.status)) continue;
    try {
      const r = await alive.check(name, store.vacancyInfo(name));
      if (!r.cached && r.status === 'closed' && r.prev !== 'closed') {
        events.add({ type: 'closed', title: 'Вакансия закрылась на сайте', text: name, link: `#/v/${encodeURIComponent(name)}` });
      }
    } catch {}
  }
}
setTimeout(aliveSweep, 60 * 1000);
setInterval(aliveSweep, 6 * 60 * 60 * 1000);

// ---------- заполнение формы заявки (C11, docs/specs/22-autofill-application.md) ----------

const formRuns = new Map(); // name → child process окна браузера
const formJobs = {};        // name → { stage: 'inspect' | 'agent', jobId, error }
const FORM_FILES = ['06-form.json', '06-form-pre.json', '06-form-agent.json', '06-form-user.json', '06-form-run.json'];
const readJ = (dir, f, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };

function runNode(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('node', args, { cwd: ROOT, timeout }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

// Итоговые ответы: твоя правка > агент > подставлено приложением
function formMerged(dir) {
  const form = readJ(dir, '06-form.json');
  if (!form) return null;
  const pre = readJ(dir, '06-form-pre.json', {});
  const agent = readJ(dir, '06-form-agent.json', {}).answers || {};
  const user = readJ(dir, '06-form-user.json', {});
  const answers = {};
  for (const f of form.fields) {
    const a = { ...(pre[f.key] || {}), ...(agent[f.key] || {}) };
    if (user[f.key] != null && user[f.key] !== '') Object.assign(a, { status: 'ok', value: user[f.key], source: 'ты', answeredByUser: true });
    if (f.sensitive) Object.assign(a, { status: 'user', value: undefined });
    answers[f.key] = Object.keys(a).length ? a : { status: 'pending' };
  }
  return { ...form, answers };
}

function formState(name) {
  const dir = store.outDir(name);
  const info = store.vacancyInfo(name);
  const target = autofill.applyTarget(info);
  const merged = formMerged(dir);
  const fj = formJobs[name];
  const job = fj?.jobId ? jobs.get(fj.jobId) : null;
  const run = readJ(dir, '06-form-run.json');
  const window = formRuns.has(name);
  return {
    target, hasCVPdf: fs.existsSync(path.join(dir, 'CV.pdf')), hasLetter: !!info.letterFile,
    form: merged, stage: fj?.stage || null, error: fj?.error || null, job: job ? publicJob(job) : null,
    run: run ? { ...run, windowOpen: window } : null,
    shot: fs.existsSync(path.join(dir, '06-form-filled.png')),
  };
}

app.get('/api/vacancies/:name/form', wrap(async (req, res) => res.json(formState(store.safeName(req.params.name)))));

app.post('/api/vacancies/:name/form/start', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const dir = store.outDir(name);
  const info = store.vacancyInfo(name);
  const target = autofill.applyTarget(info);
  if (!target.url) return res.status(400).json({ error: target.reason });
  if (!fs.existsSync(path.join(dir, 'CV.pdf'))) return res.status(400).json({ error: 'сначала адаптируй CV — нужен CV.pdf' });
  if (formJobs[name] && ['inspect', 'agent'].includes(formJobs[name].stage) && !formJobs[name].error) {
    const j = formJobs[name].jobId && jobs.get(formJobs[name].jobId);
    if (!j || ['running', 'queued'].includes(j.state)) return res.status(409).json({ error: 'уже идёт' });
  }
  for (const f of FORM_FILES) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, '06-form-filled.png'), { force: true });
  formJobs[name] = { stage: 'inspect' };
  res.json({ ok: true });
  // Дальше — в фоне: разбор формы (без окна) → подстановка → агент для остального
  if (info.letterFile) await buildLetterFiles(name);
  const r = await runNode([path.join('web', 'autofill', 'form.js'), 'inspect', target.url, path.join(dir, '06-form.json')], 120000);
  const form = readJ(dir, '06-form.json');
  if (r.err || !form) { formJobs[name] = { stage: 'inspect', error: `форма не открылась: ${(r.stderr || r.err?.message || '').trim().slice(-200)}` }; return; }
  if (form.closed) { formJobs[name] = { stage: 'closed', error: 'вакансия закрыта: страница пишет «job not found» / «no longer accepting»' }; return; }
  if (!form.fields.length) { formJobs[name] = { stage: 'inspect', error: 'на странице не найдено полей формы — возможно, нужен логин или форма в другом месте' }; return; }
  const pre = autofill.preAnswers(form.fields, dir);
  fs.writeFileSync(path.join(dir, '06-form-pre.json'), JSON.stringify(pre, null, 2));
  const rest = form.fields.filter((f) => !pre[f.key]);
  if (!rest.length) { formJobs[name] = { stage: 'ready' }; return; }
  const ready = await ensureReady();
  if (!ready.ok) { formJobs[name] = { stage: 'agent', error: ready.error }; return; }
  const job = runJob({
    kind: 'formfill', target: name,
    prompt: prompts.formFill({ name, hasCV: fs.existsSync(path.join(dir, 'CV.md')), hasLetter: !!info.letterFile }),
    logFile: path.join(dir, 'agent-formfill.log'),
    onDone: async () => {
      if (!readJ(dir, '06-form-agent.json')) throw new Error('агент не записал 06-form-agent.json');
      formJobs[name] = { stage: 'ready' };
    },
  });
  formJobs[name] = { stage: 'agent', jobId: job.id };
  job.listeners.add((ev) => { if (ev.done && job.error) formJobs[name] = { stage: 'agent', jobId: job.id, error: job.error }; });
}));

// Твои ответы: на вопросы агента (сохраняются в базу) и правки значений в предпросмотре
app.post('/api/vacancies/:name/form/answers', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const dir = store.outDir(name);
  const merged = formMerged(dir);
  if (!merged) return res.status(400).json({ error: 'форма ещё не разобрана' });
  const user = readJ(dir, '06-form-user.json', {});
  const saved = [];
  for (const [key, raw] of Object.entries(req.body.answers || {})) {
    const f = merged.fields.find((x) => x.key === key);
    if (!f || f.sensitive) continue;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '' || value == null) { delete user[key]; continue; }
    user[key] = value;
    const a = merged.answers[key];
    // Ответ на вопрос «нет в базе» — в базу знаний, чтобы в следующий раз агент знал его сам
    if (a?.status === 'ask' && typeof value === 'string') {
      if (a.kind === 'experience') saved.push(`база кейсов: ${autofill.saveExperienceAnswer({ question: f.label, answer: value, vacancy: name })}`);
      else saved.push(`стандартные ответы: ${autofill.saveFactualAnswer({ question: f.label, answer: value, section: a.section })}`);
    }
    autofill.remember([{ label: f.label, value, source: 'ты' }]);
  }
  fs.writeFileSync(path.join(dir, '06-form-user.json'), JSON.stringify(user, null, 2));
  res.json({ ok: true, saved });
}));

// Открыть форму в окне браузера и заполнить. Submit не нажимается
app.post('/api/vacancies/:name/form/fill', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const dir = store.outDir(name);
  if (formRuns.has(name)) return res.status(409).json({ error: 'окно с формой уже открыто' });
  const merged = formMerged(dir);
  if (!merged) return res.status(400).json({ error: 'форма ещё не разобрана' });
  const asks = merged.fields.filter((f) => merged.answers[f.key]?.status === 'ask' && f.required);
  if (asks.length && !req.body.force) return res.status(400).json({ error: `нет ответа на ${asks.length} обязательных вопроса(ов)`, asks: asks.map((f) => f.label) });
  const answersFile = path.join(dir, '06-form-answers.json');
  fs.writeFileSync(answersFile, JSON.stringify({ fields: merged.fields, answers: merged.answers }, null, 2));
  const target = autofill.applyTarget(store.vacancyInfo(name));
  const child = spawn('node', [path.join('web', 'autofill', 'form.js'), 'fill', merged.url || target.url, answersFile,
    path.join(dir, '06-form-run.json'), path.join(dir, '06-form-filled.png')], { cwd: ROOT, stdio: 'ignore' });
  formRuns.set(name, child);
  child.on('exit', () => formRuns.delete(name));
  res.json({ ok: true });
}));

// «Я отправил»: заполненные ответы → «Мои ответы при подаче» (C6), память форм; дальше диалог отправки (M1)
app.post('/api/vacancies/:name/form/submitted', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const dir = store.outDir(name);
  const run = readJ(dir, '06-form-run.json');
  if (!run?.filled) return res.status(400).json({ error: 'форма ещё не заполнялась' });
  const merged = formMerged(dir) || { fields: [] };
  const a = store.app(name);
  a.submittedAnswers = a.submittedAnswers || [];
  const have = new Set(a.submittedAnswers.map((x) => autofill.norm(x.q)));
  let added = 0;
  for (const f of run.filled) {
    const field = merged.fields.find((x) => x.key === f.key);
    // Только ответы на вопросы: контакты из шапки CV и файлы не нужны в «Моих ответах»
    if (field?.type === 'file' || f.source === 'шапка CV' || !f.label || have.has(autofill.norm(f.label))) continue;
    const v = Array.isArray(f.value) ? f.value.join(', ') : String(f.value);
    a.submittedAnswers.push({ id: crypto.randomUUID().slice(0, 8), q: f.label.slice(0, 300), a: v.slice(0, 5000), at: new Date().toISOString(), source: 'form' });
    added += 1;
  }
  autofill.remember(run.filled.filter((f) => merged.fields.find((x) => x.key === f.key)?.type !== 'file'));
  store.save();
  res.json({ ok: true, added });
}));

// Скриншот формы перед Submit
app.get('/api/vacancies/:name/form/shot', wrap(async (req, res) => {
  const p = path.join(store.outDir(store.safeName(req.params.name)), '06-form-filled.png');
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
}));

// ---------- база кейсов (C9, docs/specs/20-case-base.md) ----------

let caseScanJob = null;

// Сводка пробелов (P1): ключевые требования вакансий, которых нет в Master CV, — по частоте
async function gapSummary() {
  const matches = await master.vacancyMatches();
  const count = new Map();
  for (const [name, m] of Object.entries(matches)) {
    const st = store.state.apps[name]?.status;
    if (['skip', 'rejected'].includes(st)) continue;
    for (const k of m.mustMiss || []) {
      const key = String(k).toLowerCase().trim();
      if (!key) continue;
      const e = count.get(key) || { keyword: k, n: 0, vacancies: [] };
      e.n += 1;
      e.vacancies.push(name);
      count.set(key, e);
    }
  }
  return { vacancies: Object.keys(matches).length, top: [...count.values()].sort((a, b) => b.n - a.n).slice(0, 20) };
}

function draftView(id) {
  const d = cases.draft(id);
  if (!d) return null;
  const j = d.jobId && jobs.get(d.jobId);
  return { ...d, job: j ? publicJob(j) : null };
}

app.get('/api/cases', wrap(async (req, res) => {
  const sug = cases.suggestions();
  const j = caseScanJob && jobs.get(caseScanJob);
  res.json({
    cards: cases.list(), letters: cases.letters(),
    drafts: cases.drafts().map((m) => draftView(m.id)),
    suggestions: sug.filter((s) => s.state === 'new'), suggestionsDone: sug.filter((s) => s.state !== 'new').length,
    gaps: await gapSummary(), newDictation: cases.newDictation(), voice: voiceStatus(),
    scanJob: j ? publicJob(j) : null,
  });
}));

app.get('/api/cases/card/:id', wrap(async (req, res) => {
  const c = cases.card(req.params.id);
  if (!c) return res.status(404).json({ error: 'нет такой карточки' });
  res.json(c);
}));

app.get('/api/cases/raw/:file', wrap(async (req, res) => {
  const r = cases.rawText(req.params.file);
  if (!r) return res.status(404).json({ error: 'нет такой надиктовки' });
  res.json(r);
}));

// Черновик надиктовки нового кейса — на сервере, чтобы диктовать в Chrome/Safari и видеть текст здесь
app.put('/api/cases/new-dictation', wrap(async (req, res) => {
  cases.setNewDictation(req.body.text);
  res.json({ ok: true });
}));

function startCaseRound(meta, round) {
  const dir = cases.draftDir(meta.id);
  const job = runJob({
    kind: round === 1 ? 'case1' : 'case2', target: meta.id,
    prompt: round === 1 ? prompts.caseRound1({ id: meta.id, target: meta.target }) : prompts.caseRound2({ id: meta.id, target: meta.target }),
    logFile: path.join(dir, `agent-round${round}.log`),
    onDone: async () => {
      const m = cases.draft(meta.id);
      if (round === 1) {
        if (!fs.existsSync(path.join(dir, 'questions.json'))) throw new Error('агент не записал вопросы (questions.json)');
        m.state = 'answers';
      } else {
        const r = m.result;
        if (!r?.card_id || !cases.exists(r.card_id)) throw new Error('агент не собрал карточку (нет result.json или файла карточки)');
        m.state = 'done';
        m.cardId = r.card_id;
      }
      const { questions, duplicateOf, summary, rawFile, draftHtml, result, dictation, ...plain } = m;
      cases.saveMeta(plain);
    },
  });
  meta.jobId = job.id;
  meta.state = round === 1 ? 'round1' : 'round2';
  cases.saveMeta(meta);
  job.listeners.add((ev) => {
    if (ev.done && job.error) {
      const m = cases.draft(meta.id);
      const { questions, duplicateOf, summary, rawFile, draftHtml, result, dictation, ...plain } = m;
      cases.saveMeta({ ...plain, state: round === 1 ? 'error1' : 'error2', error: job.error });
    }
  });
  return job;
}

app.post('/api/cases/drafts', agentReady, wrap(async (req, res) => {
  const dictation = String(req.body.dictation || '').trim();
  if (dictation.split(/\s+/).length < 20) return res.status(400).json({ error: 'надиктовка слишком короткая — хотя бы 20 слов о кейсе' });
  const target = req.body.target ? String(req.body.target) : null;
  if (target && !cases.exists(target)) return res.status(400).json({ error: 'нет такой карточки' });
  const meta = cases.createDraft({ dictation, target });
  startCaseRound(meta, 1);
  if (!target) cases.setNewDictation('');
  res.json({ id: meta.id });
}));

app.get('/api/cases/drafts/:id', wrap(async (req, res) => {
  const d = draftView(req.params.id);
  if (!d) return res.status(404).json({ error: 'нет такого черновика' });
  res.json(d);
}));

// Ответы сохраняются по мере набора (можно диктовать в другом браузере)
app.patch('/api/cases/drafts/:id', wrap(async (req, res) => {
  const d = cases.draft(req.params.id);
  if (!d) return res.status(404).json({ error: 'нет такого черновика' });
  const { questions, duplicateOf, summary, rawFile, draftHtml, result, dictation, ...plain } = d;
  if (req.body.answers && typeof req.body.answers === 'object') {
    plain.answers = Object.fromEntries(Object.entries(req.body.answers).map(([k, v]) => [String(k).slice(0, 20), String(v || '').slice(0, 5000)]));
  }
  if (req.body.target !== undefined) plain.target = req.body.target && cases.exists(req.body.target) ? req.body.target : null;
  cases.saveMeta(plain);
  res.json({ ok: true });
}));

app.post('/api/cases/drafts/:id/build', agentReady, wrap(async (req, res) => {
  const d = cases.draft(req.params.id);
  if (!d) return res.status(404).json({ error: 'нет такого черновика' });
  if (!['answers', 'error2'].includes(d.state)) return res.status(409).json({ error: 'черновик ещё не готов к сборке' });
  const { questions, duplicateOf, summary, rawFile, draftHtml, result, dictation, ...plain } = d;
  const answers = req.body.skip ? {} : (req.body.answers || plain.answers || {});
  plain.answers = answers;
  if (req.body.target !== undefined) plain.target = req.body.target && cases.exists(req.body.target) ? req.body.target : null;
  fs.writeFileSync(path.join(cases.draftDir(d.id), 'answers.json'), JSON.stringify(answers, null, 2));
  startCaseRound(plain, 2);
  res.json({ ok: true });
}));

app.delete('/api/cases/drafts/:id', wrap(async (req, res) => {
  const d = cases.draft(req.params.id);
  if (!d) return res.status(404).json({ error: 'нет такого черновика' });
  if (['round1', 'round2'].includes(d.state)) return res.status(409).json({ error: 'агент ещё работает' });
  const { questions, duplicateOf, summary, rawFile, draftHtml, result, dictation, ...plain } = d;
  cases.saveMeta({ ...plain, state: 'cancelled' });
  res.json({ ok: true });
}));

app.post('/api/cases/suggestions/:id/accept', wrap(async (req, res) => {
  try { res.json(cases.acceptSuggestion(req.params.id, req.body.card)); } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.post('/api/cases/suggestions/:id/reject', wrap(async (req, res) => {
  try { res.json(cases.rejectSuggestion(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
}));

// C8 P1 · голосовой профиль knowledge-base/voice.md: когда собран и сколько надиктовок появилось после
const VOICE = path.join(ROOT, 'knowledge-base', 'voice.md');
let voiceJob = null;
function voiceStatus() {
  const rawDir = path.join(ROOT, 'knowledge-base', 'raw');
  const all = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.md')) : [];
  const j = voiceJob && jobs.get(voiceJob);
  const base = { raw: all.length, job: j ? publicJob(j) : null };
  if (!fs.existsSync(VOICE)) return { ...base, exists: false, newRaw: all.length };
  const md = fs.readFileSync(VOICE, 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const sources = (fm.match(/^sources:\s*(.*)$/m)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { ...base, exists: true, built: fm.match(/^built:\s*(\S+)/m)?.[1] || null, words: md.split(/\s+/).length,
    newRaw: all.filter((f) => !sources.includes(f)).length };
}

app.get('/api/voice', wrap(async (req, res) => { res.json(voiceStatus()); }));
app.get('/api/voice/text', wrap(async (req, res) => {
  res.type('text/plain').send(fs.existsSync(VOICE) ? fs.readFileSync(VOICE, 'utf8') : '');
}));

app.post('/api/voice', agentReady, wrap(async (req, res) => {
  const cur = voiceJob && jobs.get(voiceJob);
  if (cur && ['running', 'queued'].includes(cur.state)) return res.status(409).json({ error: 'профиль уже собирается' });
  const rawDir = path.join(ROOT, 'knowledge-base', 'raw');
  const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.md')).sort() : [];
  if (!files.length) return res.status(400).json({ error: 'надиктовок нет' });
  const before = fs.existsSync(VOICE) ? fs.statSync(VOICE).mtimeMs : 0;
  fs.mkdirSync(cases.DRAFTS, { recursive: true });
  const job = runJob({
    kind: 'voice', target: 'voice',
    prompt: prompts.voiceProfile({ files }),
    logFile: path.join(cases.DRAFTS, '_voice-agent.log'),
    onDone: async () => {
      if (!fs.existsSync(VOICE) || fs.statSync(VOICE).mtimeMs === before) throw new Error('агент закончил, но knowledge-base/voice.md не обновился');
    },
  });
  voiceJob = job.id;
  res.json({ jobId: job.id });
}));

// Разово: найти новые факты во всех надиктовках писем
app.post('/api/cases/scan-letters', agentReady, wrap(async (req, res) => {
  const cur = caseScanJob && jobs.get(caseScanJob);
  if (cur && ['running', 'queued'].includes(cur.state)) return res.status(409).json({ error: 'поиск уже идёт' });
  const files = cases.letters().map((l) => l.file);
  if (!files.length) return res.status(400).json({ error: 'надиктовок писем нет' });
  fs.mkdirSync(cases.DRAFTS, { recursive: true });
  const outRel = `web/data/case-drafts/_scan-${Date.now()}.json`;
  const out = path.join(ROOT, outRel);
  const job = runJob({
    kind: 'casescan', target: 'cases',
    prompt: prompts.caseScan({ files, out: outRel }),
    logFile: path.join(cases.DRAFTS, '_scan-agent.log'),
    onDone: async () => {
      let r;
      try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { throw new Error('агент не записал результат поиска'); }
      const vac = Object.fromEntries(cases.letters().map((l) => [l.file, l.vacancy]));
      job.found = cases.addSuggestions((r.suggestions || []).map((x) => ({ ...x, vacancy: vac[path.basename(String(x.source || ''))] || '' })), 'scan');
    },
  });
  caseScanJob = job.id;
  res.json({ jobId: job.id });
}));

// Ссылка не открылась → пользователь вставляет текст
app.post('/api/inbox/:id/text', agentReady, wrap(async (req, res) => {
  const item = store.inbox[req.params.id];
  const text = String(req.body.text || '').trim();
  if (!item || !text) return res.status(400).json({ error: 'нет элемента или текста' });
  fs.writeFileSync(path.join(INBOX, `${item.id}.txt`), item.url ? `Ссылка: ${item.url}\n\n${text}` : text);
  item.hasText = true;
  item.preview = text.split('\n').find((l) => l.trim()).slice(0, 90);
  const job = startFit(item);
  res.json({ jobId: job.id });
}));

app.post('/api/inbox/:id/retry', agentReady, wrap(async (req, res) => {
  const item = store.inbox[req.params.id];
  if (!item) return res.status(404).json({ error: 'нет элемента' });
  res.json({ jobId: startFit(item).id });
}));

app.delete('/api/inbox/:id', wrap(async (req, res) => {
  delete store.inbox[req.params.id];
  store.save();
  res.json({ ok: true });
}));

// ---------- шаги для существующей вакансии ----------

function busy(a, kind) {
  const j = jobs.get(a.jobs?.[kind]);
  return j && (j.state === 'queued' || j.state === 'running');
}

function attach(name, kind, job) {
  const a = store.app(name);
  a.jobs = { ...(a.jobs || {}), [kind]: job.id };
  store.save();
}

function fitVacancy(name, mode = 'quick') {
  const a = store.app(name);
  if (mode === 'quick') {
    const job = runQuickFit({ target: name, existing: name, vacancy: fs.readFileSync(path.join(store.VACANCIES, `${name}.md`), 'utf8'),
      url: a.fit?.url, source: a.fit?.source,
      onResult: async (r, n, j) => { a.fit = { ...store.pickFit(r), mode: 'quick', model: j.actualModel || j.model || null }; store.save(); } });
    attach(name, 'fit', job);
    return job;
  }
  const id = crypto.randomUUID().slice(0, 8);
  const resultFile = path.join(INBOX, `${id}.result.json`);
  const job = runJob({
    kind: 'fit', target: name,
    prompt: prompts.fit({ id, existing: name }),
    logFile: path.join(INBOX, `${id}.log`),
    onDone: async () => {
      if (!fs.existsSync(resultFile)) throw new Error('агент не записал результат скоринга');
      a.fit = { ...store.pickFit(JSON.parse(fs.readFileSync(resultFile, 'utf8'))), mode: 'deep', model: job.actualModel || job.model || null };
      store.save();
    },
  });
  attach(name, 'fit', job);
  return job;
}

app.post('/api/vacancies/:name/fit', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (busy(store.app(name), 'fit')) return res.status(409).json({ error: 'уже идёт' });
  if (!fs.existsSync(path.join(store.VACANCIES, `${name}.md`))) return res.status(400).json({ error: 'нет файла вакансии' });
  res.json({ jobId: fitVacancy(name, req.body?.mode === 'deep' ? 'deep' : 'quick').id });
}));

// C4 P1: у ручной заявки появился текст вакансии — вписать его в файл (шапку front matter сохраняем) и оценить фит
app.post('/api/vacancies/:name/vacancy-text', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (busy(store.app(name), 'fit')) return res.status(409).json({ error: 'фит уже оценивается' });
  const file = path.join(store.VACANCIES, `${name}.md`);
  if (!fs.existsSync(file)) return res.status(400).json({ error: 'нет файла вакансии' });
  const text = String(req.body.text || '').trim();
  if (text.split(/\s+/).length < 50) return res.status(400).json({ error: 'текст слишком короткий — вставь вакансию целиком (хотя бы 50 слов)' });
  const md = fs.readFileSync(file, 'utf8');
  const fm = md.match(/^---\n[\s\S]*?\n---\n/)?.[0] || '';
  const info = store.vacancyInfo(name);
  fs.writeFileSync(file, `${fm}\n# ${info.role} — ${info.company}\n\n${text.slice(0, 40000)}\n`);
  res.json({ jobId: fitVacancy(name).id });
}));

app.post('/api/vacancies/:name/tailor', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (lacksText(name)) return res.status(400).json({ error: NO_TEXT });
  const a = store.app(name);
  if (busy(a, 'tailor')) return res.status(409).json({ error: 'уже идёт' });
  if (!fs.existsSync(path.join(store.VACANCIES, `${name}.md`))) return res.status(400).json({ error: 'нет файла вакансии' });
  const baseVersion = master.activeVersion();
  const job = runJob({
    kind: 'tailor', target: name,
    prompt: prompts.tailor({ name }),
    logFile: path.join(store.outDir(name), 'agent-tailor.log'),
    onDone: async () => {
      if (!fs.existsSync(path.join(store.outDir(name), 'CV.docx'))) throw new Error('агент закончил, но CV.docx не появился');
      a.baseVersion = baseVersion;
      await store.cvMetrics(name, true);
    },
  });
  attach(name, 'tailor', job);
  res.json({ jobId: job.id });
}));

// C8 P1 · прежнее письмо: перед пересборкой текущее письмо с метаданными кладётся в .letter-pending/;
// только когда агент успешно закончил, оно становится «прежним» (.letter-prev/). «Вернуть» меняет их местами.
const LETTER_SET = ['Cover Letter.md', 'letter-summary.json', '04-generated-trace.json', '04-cover-letter-trace.md'];
function snapshotLetter(dir) {
  const pend = path.join(dir, '.letter-pending');
  fs.rmSync(pend, { recursive: true, force: true });
  if (!fs.existsSync(path.join(dir, 'Cover Letter.md'))) return;
  fs.mkdirSync(pend);
  for (const f of LETTER_SET) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(pend, f));
  fs.writeFileSync(path.join(pend, 'at.txt'), new Date().toISOString());
}
function commitLetterSnapshot(dir) {
  const pend = path.join(dir, '.letter-pending');
  if (!fs.existsSync(pend)) return;
  fs.rmSync(path.join(dir, '.letter-prev'), { recursive: true, force: true });
  fs.renameSync(pend, path.join(dir, '.letter-prev'));
}
function letterPrev(name) {
  const prev = path.join(store.outDir(name), '.letter-prev');
  if (!fs.existsSync(path.join(prev, 'Cover Letter.md'))) return null;
  let mode = 'dictated';
  try { if (JSON.parse(fs.readFileSync(path.join(prev, 'letter-summary.json'), 'utf8')).mode === 'generated') mode = 'generated'; } catch {}
  const text = fs.readFileSync(path.join(prev, 'Cover Letter.md'), 'utf8');
  let at = null;
  try { at = fs.readFileSync(path.join(prev, 'at.txt'), 'utf8').trim(); } catch {}
  return { mode, at, words: text.split(/\s+/).filter(Boolean).length, preview: text.trim().slice(0, 600) };
}

app.post('/api/vacancies/:name/letter-revert', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (busy(a, 'letter')) return res.status(409).json({ error: 'письмо сейчас собирается' });
  const dir = store.outDir(name);
  const prev = path.join(dir, '.letter-prev');
  if (!fs.existsSync(path.join(prev, 'Cover Letter.md'))) return res.status(400).json({ error: 'прежнего письма нет' });
  const tmp = path.join(dir, '.letter-swap');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  for (const f of LETTER_SET) {
    if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(tmp, f));
    if (fs.existsSync(path.join(prev, f))) fs.renameSync(path.join(prev, f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(tmp, 'at.txt'), new Date().toISOString());
  fs.rmSync(prev, { recursive: true, force: true });
  fs.renameSync(tmp, prev);
  // Файлы для формы (C10) должны совпадать с вернувшимся письмом; mtime вернувшихся файлов старый — метрики считаем принудительно
  for (const f of fs.readdirSync(dir)) if (/^Cover Letter\.(pdf|docx)$|^\.cover-letter\.src$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  await store.letterMetrics(name, true);
  await buildLetterFiles(name, true);
  store.save();
  res.json({ ok: true });
}));

app.post('/api/vacancies/:name/letter', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (busy(a, 'letter')) return res.status(409).json({ error: 'уже идёт' });
  const dir = store.outDir(name);
  if (!fs.existsSync(path.join(dir, 'CV.md'))) return res.status(400).json({ error: 'сначала адаптируй CV' });
  const dictation = String(req.body.dictation ?? a.dictation ?? '').trim();
  if (dictation.split(/\s+/).length < 30) return res.status(400).json({ error: 'надиктовка слишком короткая (нужно хотя бы 30 слов)' });
  a.dictation = dictation;
  fs.writeFileSync(path.join(dir, '00-dictation.md'), dictation + '\n');
  snapshotLetter(dir);
  const job = runJob({
    kind: 'letter', target: name,
    prompt: prompts.letter({ name }),
    logFile: path.join(dir, 'agent-letter.log'),
    onDone: async () => {
      if (!fs.existsSync(path.join(dir, 'Cover Letter.md'))) throw new Error('агент закончил, но Cover Letter.md не появился');
      commitLetterSnapshot(dir);
      // Письмо снова из надиктовки — пометка «сгенерировано» (C8) от прошлого письма не должна остаться
      const summary = path.join(dir, 'letter-summary.json');
      try {
        const s = JSON.parse(fs.readFileSync(summary, 'utf8'));
        if (s.mode === 'generated') { delete s.mode; fs.writeFileSync(summary, JSON.stringify(s, null, 2)); }
      } catch {}
      collectCardSuggestions(name, 'letter');
      await store.letterMetrics(name, true);
      buildLetterFiles(name, true); // C10: PDF и DOCX готовы к скачиванию сразу
      if (a.status === 'new') store.setStatus(a, 'ready', { note: 'письмо готово' });
      store.save();
    },
  });
  attach(name, 'letter', job);
  res.json({ jobId: job.id });
}));

// ---------- структура для надиктовки письма (C7, docs/specs/18-letter-outline.md) ----------

const outlineCache = new Map();
function checkOutline(file) {
  return new Promise((resolve) => {
    execFile(path.join(ROOT, '.venv', 'bin', 'python'), ['scorer/check_outline.py', '--outline', file, '--json'],
      { cwd: ROOT, timeout: 20000 }, (err, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { resolve({ pass: false, issues: ['проверка не запустилась'] }); }
      });
  });
}

// Структура + результат проверки; галочки «надиктовал» сбрасываются, когда структура пересобрана
async function readOutline(name) {
  const f = path.join(store.outDir(name), '04-letter-outline.json');
  if (!fs.existsSync(f)) return null;
  const m = fs.statSync(f).mtimeMs;
  let c = outlineCache.get(f);
  if (!c || c.m !== m) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    c = { m, data, check: data ? await checkOutline(f) : { pass: false, issues: ['04-letter-outline.json не читается'] } };
    outlineCache.set(f, c);
  }
  const a = store.app(name);
  const done = a.outlineDone && a.outlineDone.stamp === m ? a.outlineDone.done : [];
  return { ...(c.data || {}), check: c.check, stamp: m, done };
}

app.post('/api/vacancies/:name/outline', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (busy(a, 'outline')) return res.status(409).json({ error: 'уже идёт' });
  if (!store.vacancyInfo(name).hasVacancyText) return res.status(400).json({ error: 'нет текста вакансии — вставь его в файл вакансии' });
  const dir = store.outDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '04-letter-outline.json');
  const before = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
  const job = runJob({
    kind: 'outline', target: name,
    prompt: prompts.outline({ name, hasCV: fs.existsSync(path.join(dir, 'CV.md')) }),
    logFile: path.join(dir, 'agent-outline.log'),
    onDone: async () => {
      if (!fs.existsSync(f) || fs.statSync(f).mtimeMs === before) throw new Error('агент закончил, но 04-letter-outline.json не появился');
      const r = await checkOutline(f);
      if (!r.pass) throw new Error(`структура не прошла проверку: ${r.issues.slice(0, 3).join('; ')}`);
    },
  });
  attach(name, 'outline', job);
  res.json({ jobId: job.id });
}));

// Галочка «надиктовал» у блока структуры
app.post('/api/vacancies/:name/outline/done', wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const o = await readOutline(name);
  if (!o) return res.status(404).json({ error: 'структуры нет' });
  const i = Number(req.body.block);
  if (!Number.isInteger(i) || i < 0 || i >= (o.blocks || []).length) return res.status(400).json({ error: 'нет такого блока' });
  const set = new Set(o.done);
  if (req.body.done) set.add(i); else set.delete(i);
  store.app(name).outlineDone = { stamp: o.stamp, done: [...set].sort((x, y) => x - y) };
  store.save();
  res.json({ ok: true, done: store.app(name).outlineDone.done });
}));

// ---------- письмо, сгенерированное агентом (C8, docs/specs/19-generated-letter.md) ----------

app.post('/api/vacancies/:name/letter-generate', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (busy(a, 'letter')) return res.status(409).json({ error: 'письмо уже собирается' });
  const dir = store.outDir(name);
  if (!fs.existsSync(path.join(dir, 'CV.md'))) return res.status(400).json({ error: 'сначала адаптируй CV' });
  const letterPath = path.join(dir, 'Cover Letter.md');
  // Прежнее письмо (надиктованное или сгенерированное) не теряется — C8 P1, «Вернуть прежнее»
  snapshotLetter(dir);
  const before = fs.existsSync(letterPath) ? fs.statSync(letterPath).mtimeMs : 0;
  const job = runJob({
    kind: 'lettergen', target: name,
    prompt: prompts.letterGenerate({ name, hasOutline: fs.existsSync(path.join(dir, '04-letter-outline.json')), hasVoice: fs.existsSync(VOICE) }),
    logFile: path.join(dir, 'agent-lettergen.log'),
    onDone: async () => {
      if (!fs.existsSync(letterPath) || fs.statSync(letterPath).mtimeMs === before) throw new Error('агент закончил, но Cover Letter.md не обновился');
      commitLetterSnapshot(dir);
      const summary = path.join(dir, 'letter-summary.json');
      let s = {};
      try { s = JSON.parse(fs.readFileSync(summary, 'utf8')); } catch {}
      if (s.mode !== 'generated') fs.writeFileSync(summary, JSON.stringify({ ...s, mode: 'generated' }, null, 2));
      collectCardSuggestions(name, 'lettergen');
      const m = await store.letterMetrics(name, true);
      buildLetterFiles(name, true); // C10: PDF и DOCX готовы к скачиванию сразу
      if (a.status === 'new' && m?.facts?.pass) store.setStatus(a, 'ready', { note: 'письмо сгенерировано' });
      store.save();
      if (m?.facts && !m.facts.pass) throw new Error(`письмо не прошло проверку фактов: ${m.facts.issues.slice(0, 2).join('; ')}`);
    },
  });
  // Общий слот с надиктованным письмом: два письма одновременно не собираются
  attach(name, 'letter', job);
  res.json({ jobId: job.id });
}));

// C9: факты из надиктовки, которых нет в базе, — в «Предложено добавить» на экране «База кейсов»
function collectCardSuggestions(name, origin) {
  const s = (() => { try { return JSON.parse(fs.readFileSync(path.join(store.outDir(name), 'letter-summary.json'), 'utf8')); } catch { return {}; } })();
  const items = Array.isArray(s.card_suggestions) ? s.card_suggestions : [];
  if (!items.length) return;
  // Источник по умолчанию — последняя надиктовка письма к этой вакансии
  const fallback = cases.letters().find((l) => l.vacancy === name)?.file || '';
  const n = cases.addSuggestions(items.map((x) => ({ ...x, source: x.source || fallback, vacancy: name })), origin);
  if (n) events.add({ type: 'cases', title: `База кейсов: ${n} ${n === 1 ? 'новый факт' : 'новых факта(ов)'} из надиктовки`, text: name, link: '#/cases/suggestions' });
}

// C9: на какие карточки опираются фит, CV и письмо
function cardRefs(name, info) {
  const dir = store.outDir(name);
  const ids = (list) => [...new Set((list || []).map((x) => String(x).replace(/\.md$/, '').split('/').pop()).filter((x) => cases.exists(x)))];
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return {}; } };
  const cv = read('summary.json');
  const letter = read('letter-summary.json');
  const fromFacts = (letter.facts_from || []).filter((x) => String(x).includes('knowledge-base/cards/'));
  const fitCard = info.fit?.anchor_card;
  return {
    fit: fitCard ? [{ id: fitCard, missing: !cases.exists(fitCard) }] : [],
    cv: ids(cv.cards_used).map((id) => ({ id })),
    letter: ids(letter.cards_used || fromFacts).map((id) => ({ id })),
  };
}

// Трассировка сгенерированного письма: «откуда факты»
function readGeneratedTrace(name) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(store.outDir(name), '04-generated-trace.json'), 'utf8'));
    return (t.sentences || []).filter((s) => s.tag === 'fact').map((s) => ({ text: String(s.text || ''), sources: s.sources || [] }));
  } catch { return null; }
}

// ---------- ответы на вопросы формы (S4, docs/specs/06-application-questions.md) ----------

// «Why do you want to join us? (500)» → {q, limit: 500}; лимит — число в скобках в конце строки
function parseQuestions(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(.*?)\s*\((\d{2,5})\s*(?:символ\S*|chars?|characters?|знак\S*|znak\S*)?\)\s*$/i);
    return m ? { q: m[1].trim(), limit: Number(m[2]) } : { q: l, limit: null };
  });
}

const PROFILE_ANSWERS = path.join(ROOT, 'knowledge-base', 'profile-answers.md');

app.get('/api/profile-answers', wrap(async (req, res) => {
  res.json({ text: fs.existsSync(PROFILE_ANSWERS) ? fs.readFileSync(PROFILE_ANSWERS, 'utf8') : '' });
}));

app.put('/api/profile-answers', wrap(async (req, res) => {
  const text = String(req.body.text ?? '');
  if (!/^# /m.test(text)) return res.status(400).json({ error: 'нужен заголовок «# Стандартные ответы…» и разделы «## …»' });
  fs.writeFileSync(PROFILE_ANSWERS, text.replace(/\r\n/g, '\n').trimEnd() + '\n');
  res.json({ ok: true });
}));

app.post('/api/vacancies/:name/answers', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (lacksText(name)) return res.status(400).json({ error: NO_TEXT });
  const a = store.app(name);
  if (busy(a, 'answers')) return res.status(409).json({ error: 'уже идёт' });
  if (!fs.existsSync(path.join(store.VACANCIES, `${name}.md`))) return res.status(400).json({ error: 'нет файла вакансии' });
  const raw = String(req.body.questions ?? a.formQuestions ?? '');
  const qs = parseQuestions(raw);
  if (!qs.length) return res.status(400).json({ error: 'вставь хотя бы один вопрос' });
  if (qs.length > 20) return res.status(400).json({ error: 'не больше 20 вопросов за раз' });
  a.formQuestions = raw;
  const dir = store.outDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const title = `${store.vacancyInfo(name).role}, ${store.vacancyInfo(name).company}`;
  // S4 P1: совпавшие с библиотекой вопросы отвечаются без агента; агент получает только остальные
  const hits = qs.map((q) => answerLib.match(q.q, q.limit));
  const todo = qs.filter((q, i) => !hits[i]);
  const merge = (agentAnswers = []) => {
    let k = 0;
    const questions = qs.map((q, i) => (hits[i] ? answerLib.asAnswer(q, hits[i]) : agentAnswers[k++] || { q: q.q, limit: q.limit, status: 'missing', variants: [] }));
    const data = { questions };
    fs.writeFileSync(path.join(dir, '05-answers.json'), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(dir, '05-answers.md'), answerLib.toMd(title, data));
    answerLib.markUsed(hits.filter(Boolean).map((h) => h.id));
  };
  if (!todo.length) {
    merge();
    store.save();
    return res.json({ library: qs.length, jobId: null });
  }
  fs.writeFileSync(path.join(dir, '05-questions.json'), JSON.stringify(todo, null, 2));
  const hasCV = fs.existsSync(path.join(dir, 'CV.md'));
  const job = runJob({
    kind: 'answers', target: name,
    prompt: prompts.answers({ name, hasCV }),
    logFile: path.join(dir, 'agent-answers.log'),
    onDone: async () => {
      const f = path.join(dir, '05-answers.json');
      if (!fs.existsSync(f)) throw new Error('агент закончил, но 05-answers.json не появился');
      const got = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (hits.some(Boolean)) merge(got.questions || []);
    },
  });
  attach(name, 'answers', job);
  store.save();
  res.json({ jobId: job.id, library: qs.length - todo.length });
}));

// S4 P1: один ответ заново, с комментарием («короче», «больше про LMS») — остальные ответы не трогаются
app.post('/api/vacancies/:name/answers/:qi/redo', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  const a = store.app(name);
  if (busy(a, 'answers')) return res.status(409).json({ error: 'ответы уже готовятся' });
  const dir = store.outDir(name);
  const f = path.join(dir, '05-answers.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return res.status(400).json({ error: 'ответов ещё нет' }); }
  const qi = Number(req.params.qi);
  const item = data.questions?.[qi];
  if (!item) return res.status(404).json({ error: 'нет такого вопроса' });
  const comment = String(req.body.comment || '').trim().slice(0, 500);
  if (!comment) return res.status(400).json({ error: 'напиши, что поменять' });
  const out = path.join(dir, `05-answer-redo-${qi}.json`);
  fs.rmSync(out, { force: true });
  const job = runJob({
    kind: 'answers', target: name,
    prompt: prompts.answerRedo({ name, item, comment, out: path.relative(ROOT, out), hasCV: fs.existsSync(path.join(dir, 'CV.md')) }),
    logFile: path.join(dir, 'agent-answers.log'),
    onDone: async () => {
      let r;
      try { r = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { throw new Error('агент не записал новый ответ'); }
      const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
      cur.questions[qi] = { ...cur.questions[qi], ...r, q: item.q, limit: item.limit, library: undefined, redo: comment };
      fs.writeFileSync(f, JSON.stringify(cur, null, 2));
      fs.writeFileSync(path.join(dir, '05-answers.md'), answerLib.toMd(`${store.vacancyInfo(name).role}, ${store.vacancyInfo(name).company}`, cur));
      fs.rmSync(out, { force: true });
    },
  });
  attach(name, 'answers', job);
  res.json({ jobId: job.id });
}));

// S4 P1: библиотека ответов
app.get('/api/answer-library', wrap(async (req, res) => res.json({ items: answerLib.list() })));
app.post('/api/answer-library', wrap(async (req, res) => {
  try { res.json(answerLib.add(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.patch('/api/answer-library/:id', wrap(async (req, res) => {
  const e = answerLib.update(req.params.id, req.body || {});
  if (!e) return res.status(404).json({ error: 'нет такого ответа' });
  res.json(e);
}));
app.delete('/api/answer-library/:id', wrap(async (req, res) => { answerLib.remove(req.params.id); res.json({ ok: true }); }));

app.post('/api/vacancies/:name/keywords', agentReady, wrap(async (req, res) => {
  const name = store.safeName(req.params.name);
  if (lacksText(name)) return res.status(400).json({ error: NO_TEXT });
  const a = store.app(name);
  if (busy(a, 'keywords')) return res.status(409).json({ error: 'уже идёт' });
  if (!fs.existsSync(path.join(store.VACANCIES, `${name}.md`))) return res.status(400).json({ error: 'нет файла вакансии' });
  const job = runJob({
    kind: 'keywords', target: name,
    prompt: prompts.keywords({ name }),
    logFile: path.join(store.outDir(name), 'agent-keywords.log'),
    onDone: async () => {
      if (!fs.existsSync(path.join(store.outDir(name), '01-keywords.json'))) throw new Error('агент закончил, но 01-keywords.json не появился');
    },
  });
  attach(name, 'keywords', job);
  res.json({ jobId: job.id });
}));

// ---------- Master CV ----------

const masterState = { draft: null }; // один черновик из файла за раз

// Ответы на вопросы формы + humanizer-score (кэш по mtime 05-answers.md)
const humanizeCache = new Map();
function readAnswers(name) {
  const dir = store.outDir(name);
  const f = path.join(dir, '05-answers.json');
  if (!fs.existsSync(f)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { error: '05-answers.json не читается' }; }
  const md = path.join(dir, '05-answers.md');
  let humanize = null;
  if (fs.existsSync(md)) {
    const m = fs.statSync(md).mtimeMs;
    const c = humanizeCache.get(md);
    if (c && c.m === m) humanize = c.v;
    else {
      try {
        const out = require('node:child_process').execFileSync(path.join(ROOT, '.venv', 'bin', 'python'),
          ['scorer/check_humanize.py', '--file', md, '--json'], { cwd: ROOT, timeout: 20000 });
        const j = JSON.parse(out);
        humanize = { score: j.score, pass: j.pass, max: j.max_score };
      } catch { humanize = null; }
      humanizeCache.set(md, { m, v: humanize });
    }
  }
  return { questions: data.questions || [], humanize, updated: fs.statSync(f).mtimeMs };
}

function draftInfo() {
  const d = masterState.draft;
  if (!d) return null;
  const dir = path.join(master.DRAFTS, d.id);
  const job = publicJob(jobs.get(d.jobId));
  const ready = fs.existsSync(path.join(dir, 'draft.md'));
  return { ...d, job, state: job?.state === 'error' ? 'error' : ready ? 'ready' : 'running',
    error: job?.error || null };
}

async function tailoredList() {
  const out = [];
  for (const name of store.scan()) {
    const info = store.vacancyInfo(name);
    if (!info.hasCV) continue;
    const cv = await store.cvMetrics(name);
    out.push({ name, role: info.role, company: info.company, status: info.status, builtAt: info.builtAt,
      baseVersion: info.baseVersion, stale: master.isStale(info.baseVersion),
      coverage: cv?.coverage ?? null, change: cv?.change ?? null, changeOk: cv?.changeOk ?? null,
      pages: cv?.pages ?? null, lengthOk: cv?.lengthOk ?? null, hasPdf: info.files.includes('CV.pdf'),
      exportNames: store.exportNames(name, info) });
  }
  return out.sort((a, b) => b.builtAt - a.builtAt);
}

app.get('/api/master', wrap(async (req, res) => {
  const sum = await master.summary();
  for (const v of sum.versions) v.exportName = store.masterExportName(v.version, '');
  res.json({ ...sum, draft: draftInfo(), tailored: await tailoredList() });
}));

app.get('/api/master/versions/:v', wrap(async (req, res) => {
  const n = Number(req.params.v);
  if (!master.versionNumbers().includes(n)) return res.status(404).json({ error: 'нет версии' });
  res.json({ meta: master.versionMeta(n), text: master.versionText(n), html: marked.parse(master.versionText(n)) });
}));

app.get(['/master-files/:v/:file', '/master-files/:v/:file/:label'], wrap(async (req, res) => {
  const n = Number(req.params.v);
  const file = req.params.file;
  if (!master.versionNumbers().includes(n) || file.includes('/') || file.includes('..') || file.startsWith('.')) return res.status(400).end();
  const p = path.join(master.vdir(n), file);
  if (!fs.existsSync(p)) return res.status(404).end();
  const fname = file.startsWith(master.RENDER_NAME) ? store.masterExportName(n, path.extname(file))
    : `Master CV v${n} source${path.extname(file)}`;
  sendNamed(req, res, p, fname);
}));

// Загрузка PDF/DOCX → извлечение текста → агент раскладывает в формат CV.md → черновик на ревью
app.post('/api/master/draft', agentReady, express.raw({ type: 'application/octet-stream', limit: '10mb' }), wrap(async (req, res) => {
  const cur = draftInfo();
  if (cur && cur.state === 'running') return res.status(409).json({ error: 'черновик уже готовится' });
  const original = decodeURIComponent(String(req.headers['x-filename'] || 'cv'));
  const ext = path.extname(original).toLowerCase();
  if (!['.pdf', '.docx'].includes(ext)) return res.status(400).json({ error: 'нужен PDF или DOCX' });
  if (!req.body?.length) return res.status(400).json({ error: 'пустой файл' });
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(master.DRAFTS, id);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `source${ext}`;
  fs.writeFileSync(path.join(dir, fileName), req.body);
  const check = await new Promise((resolve) => execFile(path.join(ROOT, '.venv', 'bin', 'python'),
    ['scorer/cv_text.py', '--file', path.join(dir, fileName), '--out', path.join(dir, 'text.txt'), '--json'],
    { cwd: ROOT }, (err, stdout) => { try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: 'не удалось прочитать файл' }); } }));
  if (!check.ok) { fs.rmSync(dir, { recursive: true, force: true }); return res.status(400).json({ error: check.error }); }
  const job = runJob({
    kind: 'master', target: 'master',
    prompt: prompts.masterImport({ id, fileName }),
    logFile: path.join(dir, 'agent.log'),
    onDone: async () => {
      if (!fs.existsSync(path.join(dir, 'draft.md'))) throw new Error('агент закончил, но draft.md не появился');
    },
  });
  masterState.draft = { id, jobId: job.id, original, created: Date.now(), words: check.words };
  res.json({ draft: draftInfo() });
}));

app.get('/api/master/draft', wrap(async (req, res) => {
  const d = draftInfo();
  if (!d) return res.json({ draft: null });
  const dir = path.join(master.DRAFTS, d.id);
  const text = d.state === 'ready' ? fs.readFileSync(path.join(dir, 'draft.md'), 'utf8') : '';
  const notes = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')); } catch { return null; } })();
  res.json({ draft: d, text, notes });
}));

app.delete('/api/master/draft', wrap(async (req, res) => {
  masterState.draft = null;
  res.json({ ok: true });
}));

app.post('/api/master/validate', wrap(async (req, res) => {
  res.json(await master.validate(String(req.body.text || '')));
}));

app.post('/api/master/versions', wrap(async (req, res) => {
  const text = String(req.body.text || '');
  const d = req.body.fromDraft ? draftInfo() : null;
  const sourceFile = d ? path.join(master.DRAFTS, d.id, fs.readdirSync(path.join(master.DRAFTS, d.id)).find((f) => f.startsWith('source.'))) : null;
  const r = await master.saveVersion({ text, source: d ? 'upload' : 'edit', note: String(req.body.note || ''), sourceFile });
  if (!r.ok) return res.status(400).json(r);
  if (d) {
    // исходник с оригинальным именем — для истории
    const meta = master.versionMeta(r.version);
    meta.original_file = d.original;
    delete meta.files; delete meta.hasDocx; delete meta.hasPdf; delete meta.source_file;
    fs.writeFileSync(path.join(master.vdir(r.version), 'meta.json'), JSON.stringify(meta, null, 2));
    masterState.draft = null;
  }
  res.json(r);
}));

app.post('/api/master/versions/:v/restore', wrap(async (req, res) => {
  const r = await master.restore(Number(req.params.v));
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
}));

// ---------- профиль поиска (C2, docs/specs/09-search-profile.md) ----------

const PROFILE = path.join(ROOT, 'knowledge-base', 'profile.json');
const PROFILE_PREV = path.join(ROOT, 'web', 'data', 'profile.prev.json');
const PROFILE_KEYS = ['onsite_locations', 'relocation', 'work_formats', 'languages', 'seniority_exclude', 'min_salary'];

// Эталоны проверяют сумму баллов, а жёсткие фильтры профиля меняют решение «в дайджест или в корпус».
// Поэтому после сохранения показываем и калибровку, и влияние на корпус (score_job.py impact).
const runCalibrate = () => new Promise((resolve) => {
  const PY = path.join(ROOT, '.venv', 'bin', 'python');
  execFile(PY, ['scorer/score_job.py', 'calibrate'], { cwd: ROOT, timeout: 60000 }, (err, stdout) => {
    const cal = { pass: /ВСЕ ЭТАЛОНЫ В ДИАПАЗОНЕ/.test(stdout), output: String(stdout).trim() };
    execFile(PY, ['scorer/score_job.py', 'impact', '--json'], { cwd: ROOT, timeout: 60000 }, (e2, out2) => {
      try { cal.impact = JSON.parse(out2); } catch { cal.impact = null; }
      resolve(cal);
    });
  });
});

app.get('/api/profile', wrap(async (req, res) => {
  res.json({ profile: JSON.parse(fs.readFileSync(PROFILE, 'utf8')), canRevert: fs.existsSync(PROFILE_PREV) });
}));

app.put('/api/profile', wrap(async (req, res) => {
  const cur = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
  const b = req.body || {};
  const list = (v) => [...new Set([].concat(v || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const next = { ...cur };
  if (b.onsite_locations !== undefined) next.onsite_locations = list(b.onsite_locations);
  if (b.languages !== undefined) next.languages = list(b.languages);
  if (b.seniority_exclude !== undefined) next.seniority_exclude = list(b.seniority_exclude).filter((x) => ['junior', 'mid', 'senior', 'lead', 'head'].includes(x));
  if (b.work_formats !== undefined) next.work_formats = list(b.work_formats).filter((x) => ['remote', 'hybrid', 'onsite'].includes(x));
  if (b.relocation !== undefined) {
    if (!['no', 'with_support', 'any'].includes(b.relocation)) return res.status(400).json({ error: 'relocation: no | with_support | any' });
    next.relocation = b.relocation;
  }
  // Лента: скрывать вакансии только для США (переезд или резидентство) — job-search/classify.py → us_only()
  if (b.exclude_us_only !== undefined) next.exclude_us_only = !!b.exclude_us_only;
  if (b.no_reply_days !== undefined) {
    const n = Number(b.no_reply_days);
    if (!(n >= 1 && n <= 90)) return res.status(400).json({ error: '«Без ответа через» — от 1 до 90 дней' });
    next.no_reply_days = Math.round(n);
  }
  if (b.min_salary !== undefined) {
    const amount = b.min_salary.amount === '' || b.min_salary.amount == null ? null : Number(b.min_salary.amount);
    if (amount != null && !(amount >= 0)) return res.status(400).json({ error: 'зарплата — число' });
    next.min_salary = { amount, currency: String(b.min_salary.currency || 'EUR').toUpperCase().slice(0, 3), period: b.min_salary.period === 'month' ? 'month' : 'year' };
  }
  if (!next.work_formats.length) return res.status(400).json({ error: 'оставь хотя бы один формат работы' });
  if (!next.languages.length) return res.status(400).json({ error: 'укажи хотя бы один язык' });
  fs.writeFileSync(PROFILE_PREV, JSON.stringify(cur, null, 2));
  fs.writeFileSync(PROFILE, JSON.stringify(next, null, 2) + '\n');
  const cal = await runCalibrate();
  res.json({ ok: true, profile: next, calibration: cal, canRevert: true });
}));

// ---------- W7 · деньги и «Моя неделя» (docs/specs/29-offer-numbers.md) ----------

app.get('/api/money', wrap(async (req, res) => { res.json(money.get()); }));

app.put('/api/money', wrap(async (req, res) => {
  try { res.json(money.put(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
}));

function practiceLog() {
  const out = [];
  for (const n of store.scan()) {
    try {
      for (const l of fs.readFileSync(path.join(store.outDir(n), '07-practice.jsonl'), 'utf8').split('\n').filter(Boolean)) out.push({ ...JSON.parse(l), name: n });
    } catch {}
  }
  return out;
}

// План и факт недели: хорошие ставки (фит ≥ 7, вердикт не «нет»), сообщения контактам, тренировки, пятничный обзор
function weekSummary(start = money.weekStart()) {
  const from = start.getTime();
  const to = from + 7 * 86400000;
  const inWeek = (t) => { const x = Date.parse(t); return x >= from && x < to; };
  const bets = [];
  for (const n of store.scan()) {
    const info = store.vacancyInfo(n);
    if (!info.sent?.at || !inWeek(info.sent.at)) continue;
    const good = (info.fit?.total ?? 0) >= 7 && info.verdict?.verdict !== 'no';
    bets.push({ name: n, role: info.role, company: info.company, fit: info.fit?.total ?? null, verdict: info.verdict?.verdict || null, good });
  }
  const messages = [];
  for (const c of targets.list().companies) for (const p of c.contacts) if (p.lastMsgAt && inWeek(p.lastMsgAt)) messages.push({ company: c.name, name: p.name });
  const practice = practiceLog().filter((r) => r.at && inWeek(r.at));
  const w = money.weekData();
  const key = money.weekKey(start);
  return {
    week: key, plan: w.plan, reviewedAt: w.reviews[key] || null,
    fact: { bets: bets.filter((b) => b.good).length, messages: messages.length, practice: practice.length },
    bets, messages, practice: practice.map((r) => ({ name: r.name, question: r.question, score: r.score, at: r.at })),
    sentAll: bets.length,
  };
}

app.get('/api/week', wrap(async (req, res) => {
  const cur = money.weekStart();
  const prev = new Date(cur.getTime() - 7 * 86400000);
  res.json({ current: weekSummary(cur), previous: weekSummary(prev) });
}));

app.put('/api/week', wrap(async (req, res) => {
  money.setWeek(req.body || {});
  res.json({ current: weekSummary() });
}));

// Пятница после 16:00 — одно уведомление «итог недели»
function weekNotify() {
  const now = new Date();
  if (now.getDay() !== 5 || now.getHours() < 16) return;
  const key = money.weekKey();
  if (money.weekData().notified === key) return;
  const s = weekSummary();
  money.setWeek({ notified: true });
  events.add({ type: 'week', title: 'Итог недели', text: `ставки ${s.fact.bets}/${s.plan.bets} · сообщения ${s.fact.messages}/${s.plan.messages} · тренировки ${s.fact.practice}/${s.plan.practice}`, link: '#/stats' });
}
setTimeout(weekNotify, 8000);
setInterval(weekNotify, 30 * 60 * 1000);

app.post('/api/profile/revert', wrap(async (req, res) => {
  if (!fs.existsSync(PROFILE_PREV)) return res.status(400).json({ error: 'нечего возвращать' });
  fs.copyFileSync(PROFILE_PREV, PROFILE);
  fs.rmSync(PROFILE_PREV);
  res.json({ ok: true, profile: JSON.parse(fs.readFileSync(PROFILE, 'utf8')), calibration: await runCalibrate() });
}));

// ---------- уведомления (C3, docs/specs/10-notifications.md) ----------

app.get('/api/events', wrap(async (req, res) => {
  res.json(events.list({ since: Number(req.query.since) || 0, limit: Math.min(100, Number(req.query.limit) || 40) }));
}));

app.post('/api/events/read', wrap(async (req, res) => {
  res.json({ marked: events.markRead({ ids: req.body.ids, all: !!req.body.all }) });
}));

// Без ответа: отправленная заявка, на которую не ответили за no_reply_days, сама уходит в архив («Без ответа»).
// Раз в 10 минут; одно уведомление на пачку. Ответили позже — статус меняется вручную, как обычно.
function moveNoReply() {
  const days = store.noReplyDays();
  const moved = [];
  for (const name of store.scan()) {
    const a = store.app(name);
    if (a.status !== 'sent' || !a.sent) continue;
    if (Date.now() - Date.parse(a.sent.at) < days * store.DAY) continue;
    store.setStatus(a, 'no_reply', { note: `нет ответа ${days} дн. — перенесено автоматически` });
    moved.push(name);
  }
  if (!moved.length) return;
  store.save();
  events.add({
    type: 'no_reply', title: moved.length === 1 ? 'Заявка ушла в «Без ответа»' : `${moved.length} заявки(ок) ушли в «Без ответа»`,
    text: `${moved.slice(0, 3).join('; ')}${moved.length > 3 ? '…' : ''} · ${days} дн. без ответа`,
    link: moved.length === 1 ? `#/v/${encodeURIComponent(moved[0])}` : '#/',
  });
}
setTimeout(moveNoReply, 5000);
setInterval(moveNoReply, 10 * 60 * 1000);

// ---------- статус и расход агента (S5) ----------

app.get('/api/agent/status', wrap(async (req, res) => {
  res.json({ ...(getStatus().checkedAt ? getStatus() : await checkStatus()), budget: runs.budget() });
}));

app.post('/api/agent/status', wrap(async (req, res) => {
  res.json({ ...(await checkStatus()), budget: runs.budget() });
}));

// Модель по задачам (экран «Агент»)
app.get('/api/agent/models', wrap(async (req, res) => {
  res.json({ models: readModels(), tasks: Object.fromEntries(Object.entries(TASKS).map(([k, [label, def]]) => [k, { label, default: def }])), choices: MODEL_CHOICES });
}));
app.put('/api/agent/models', wrap(async (req, res) => res.json({ models: saveModels(req.body.models) })));

app.get('/api/agent/usage', wrap(async (req, res) => {
  res.json({ status: getStatus(), ...runs.usage(), budget: runs.budget() });
}));

app.put('/api/agent/budget', wrap(async (req, res) => {
  try { res.json(runs.setBudget(req.body?.monthlyUsd)); } catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---------- задачи агента ----------

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'нет задачи' });
  res.json({ ...publicJob(job), events: job.events });
});

app.get('/api/jobs/:id/stream', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const ev of job.events) send(ev);
  if (job.state === 'done' || job.state === 'error') return res.end();
  const fn = (ev) => { send(ev); if (ev.done) res.end(); };
  job.listeners.add(fn);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { job.listeners.delete(fn); clearInterval(ping); });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`CV Checker Web → http://127.0.0.1:${PORT}`);
});
