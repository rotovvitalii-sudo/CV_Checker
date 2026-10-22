// Запуск агента Claude Code в фоне: `claude -p` в корне проекта, наши скилы, подписка пользователя.
// Каждая задача — отдельный процесс; одновременно не больше MAX_PARALLEL, остальные ждут в очереди.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runs = require('./runs');
const events = require('./events');

// Текст уведомления о завершении задачи (C3)
const JOB_TITLES = {
  fit: ['Фит оценён', 'Оценка фита не удалась'], tailor: ['CV готово', 'Адаптация CV не удалась'],
  letter: ['Письмо готово', 'Письмо не собралось'], keywords: ['Ключевые слова готовы', 'Ключевые слова не извлечены'],
  answers: ['Ответы для формы готовы', 'Ответы для формы не собрались'], master: ['Черновик Master CV готов', 'Импорт Master CV не удался'],
  edtech: ['База EdTech расширена', 'Расширение базы EdTech не удалось'],
  outline: ['Структура письма готова', 'Структура письма не собралась'],
  lettergen: ['Письмо сгенерировано', 'Письмо не сгенерировалось'],
  case1: ['Агент разобрал кейс — есть вопросы', 'Разбор кейса не удался'],
  case2: ['Карточка кейса готова', 'Карточка кейса не собралась'],
  casescan: ['Новые факты из надиктовок найдены', 'Поиск фактов в надиктовках не удался'],
  formfill: ['Ответы для формы на сайте готовы', 'Ответы для формы не собрались'],
  verdict: ['Вердикт рекрутера готов', 'Вердикт рекрутера не получен'],
  outreach: ['Черновик сообщения готов', 'Черновик сообщения не получился'],
  interview: ['Подготовка к собеседованию готова', 'Подготовка к собеседованию не собралась'],
  practice: ['Оценка ответа готова', 'Оценка ответа не получилась'],
  voice: ['Голосовой профиль обновлён', 'Голосовой профиль не собрался'],
};
function jobLink(job) {
  const t = job.vacancy || job.target;
  if (job.kind === 'master') return '#/master';
  if (job.kind === 'edtech') return '#/feed';
  if (job.kind === 'case1' || job.kind === 'case2') return `#/cases/draft/${job.target}`;
  if (job.kind === 'casescan') return '#/cases/suggestions';
  if (job.kind === 'voice') return '#/cases/letters';
  if (job.kind === 'outreach') return '#/feed';
  return t && !/^[0-9a-f]{8}$/.test(t) ? `#/v/${encodeURIComponent(t)}` : '#/';
}

const ROOT = path.resolve(__dirname, '..');
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 20 * 60 * 1000;

const ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill',
  'Bash(node:*)', 'Bash(.venv/bin/python:*)', 'Bash(ls:*)', 'Bash(soffice:*)',
  'Bash(mkdir:*)', 'Bash(cp:*)',
].join(',');

const jobs = new Map();   // id → job
const queue = [];
let running = 0;

function rel(p) {
  if (!p) return '';
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}

// Строка stream-json → короткая человеческая строка для ленты в интерфейсе
function describe(msg) {
  const out = [];
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const c of msg.message.content) {
      if (c.type === 'text' && c.text.trim()) {
        out.push({ kind: 'text', text: c.text.trim().slice(0, 400) });
      } else if (c.type === 'tool_use') {
        const i = c.input || {};
        const map = {
          Read: () => `читает ${rel(i.file_path)}`,
          Write: () => `пишет ${rel(i.file_path)}`,
          Edit: () => `правит ${rel(i.file_path)}`,
          Glob: () => `ищет файлы ${i.pattern}`,
          Grep: () => `ищет «${i.pattern}»`,
          WebFetch: () => `открывает ${i.url}`,
          Skill: () => `скил ${i.skill || i.command || ''}`,
          Bash: () => `запускает ${String(i.command || '').replace(ROOT + '/', '').slice(0, 160)}`,
        };
        out.push({ kind: 'tool', text: (map[c.name] || (() => c.name))() });
      }
    }
  } else if (msg.type === 'result') {
    const cost = msg.total_cost_usd != null ? ` · $${msg.total_cost_usd.toFixed(2)}` : '';
    out.push({ kind: 'result', text: `${msg.is_error ? 'ошибка' : 'готово'} за ${Math.round((msg.duration_ms || 0) / 1000)} с${cost}` });
  }
  return out;
}

function emit(job, ev) {
  ev.t = Date.now();
  job.events.push(ev);
  if (job.events.length > 400) job.events.shift();
  for (const fn of job.listeners) fn(ev);
}

// ---------- модель по задачам (экран «Агент») ----------
// По умолчанию CLI берёт Opus — самую дорогую модель. Замер 2026-10-20 на фите: Opus $0,76, Sonnet $0,40 с теми же
// баллами, Haiku 4.5 $0,19, но завышает «задачу» и пропускает карточку. Поэтому Sonnet — везде, где важны баллы и
// тексты; Haiku — только где результат проверяет скрипт (база компаний) или ты (факты из надиктовок).
// Haiku 5.5 CLI пока не знает (unrecognized_model), алиас 'haiku' = Haiku 4.5. 'default' — модель CLI по умолчанию.
const MODELS_FILE = path.join(ROOT, 'web', 'data', 'agent-models.json');
const MODEL_CHOICES = ['haiku', 'sonnet', 'opus', 'default'];
const TASKS = {
  fit: ['Оценка фита', 'sonnet'], keywords: ['Ключевые слова вакансии', 'sonnet'], formfill: ['Ответы для формы на сайте', 'sonnet'],
  casescan: ['Поиск фактов в надиктовках', 'haiku'], edtech: ['Расширение базы компаний', 'haiku'],
  tailor: ['Адаптация CV', 'sonnet'], letter: ['Письмо из надиктовки', 'sonnet'], lettergen: ['Сгенерированное письмо', 'sonnet'],
  outline: ['Структура письма', 'sonnet'], answers: ['Ответы на вопросы формы', 'sonnet'], verdict: ['Вердикт рекрутера', 'sonnet'], outreach: ['Первое сообщение контакту', 'sonnet'], interview: ['Подготовка к собеседованию', 'sonnet'], practice: ['Тренажёр собеседования', 'sonnet'],
  voice: ['Голосовой профиль', 'sonnet'], case1: ['Новый кейс: вопросы', 'sonnet'], case2: ['Новый кейс: карточка', 'sonnet'], master: ['Импорт Master CV', 'sonnet'],
};
function readModels() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch {}
  return Object.fromEntries(Object.entries(TASKS).map(([k, [, def]]) => [k, MODEL_CHOICES.includes(saved[k]) ? saved[k] : def]));
}
function saveModels(next) {
  const cur = readModels();
  for (const [k, v] of Object.entries(next || {})) if (TASKS[k] && MODEL_CHOICES.includes(v)) cur[k] = v;
  fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
  fs.writeFileSync(MODELS_FILE, JSON.stringify(cur, null, 2));
  return cur;
}
const modelFor = (kind) => readModels()[kind] || 'default';

// kind: fit | tailor | letter; target: имя вакансии или id входящей; onDone(job) — после выхода процесса
function runJob({ kind, target, prompt, logFile, onDone }) {
  const id = crypto.randomUUID().slice(0, 8);
  const job = {
    id, kind, target, state: 'queued', created: Date.now(), started: null, finished: null,
    error: null, finalText: '', events: [], listeners: new Set(), prompt, logFile, onDone,
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) start(queue.shift());
}

function start(job) {
  running++;
  job.state = 'running';
  job.started = Date.now();
  emit(job, { kind: 'state', text: 'агент запущен' });
  fs.mkdirSync(path.dirname(job.logFile), { recursive: true });
  const log = fs.createWriteStream(job.logFile, { flags: 'w' });
  log.write(`# ${job.kind} · ${new Date().toISOString()}\n# PROMPT\n${job.prompt}\n# STREAM\n`);

  job.model = modelFor(job.kind);
  log.write(`# MODEL ${job.model}\n`);
  const child = spawn('claude', [
    '-p', '--output-format', 'stream-json', '--verbose',
    ...(job.model !== 'default' ? ['--model', job.model] : []),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED_TOOLS,
    '--disallowedTools', 'AskUserQuestion,Agent',
  ], { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  job.pid = child.pid;
  child.stdin.end(job.prompt);

  const timer = setTimeout(() => {
    job.error = 'таймаут 20 минут';
    child.kill('SIGTERM');
  }, TIMEOUT_MS);

  let buf = '';
  child.stdout.on('data', (d) => {
    log.write(d);
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // Фактическая модель — из системного сообщения CLI (проверка, что --model сработал)
      if (msg.type === 'system' && msg.model) job.actualModel = msg.model;
      if (msg.type === 'result') {
        job.finalText = msg.result || '';
        job.cost = msg.total_cost_usd;
        job.turns = msg.num_turns;
        if (msg.is_error) job.error = job.error || (msg.result || msg.subtype || 'ошибка агента');
      }
      for (const ev of describe(msg)) emit(job, ev);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; log.write(`[stderr] ${d}`); });

  const finish = async (code, err) => {
    clearTimeout(timer);
    log.end();
    if (err) job.error = `не удалось запустить claude: ${err.message}`;
    else if (code !== 0 && !job.error) job.error = (stderr.trim().split('\n').pop() || `код выхода ${code}`).slice(0, 300);
    if (job.error && /authenticat|not logged in|login|OAuth/i.test(job.error)) {
      job.error = 'Claude Code CLI не залогинен. В Терминале выполни `claude auth login` и нажми «Повторить».';
    }
    try {
      if (!job.error && job.onDone) await job.onDone(job);
    } catch (e) {
      job.error = `разбор результата: ${e.message}`;
    }
    job.state = job.error ? 'error' : 'done';
    job.finished = Date.now();
    try {
      runs.append({
        at: new Date(job.finished).toISOString(), kind: job.kind, target: job.vacancy || job.target,
        durationMs: job.finished - job.started, costUsd: job.cost ?? null, turns: job.turns ?? null,
        model: job.actualModel || job.model || null,
        ok: !job.error, error: job.error ? String(job.error).slice(0, 200) : null,
      });
    } catch { /* журнал не должен ронять задачу */ }
    try {
      const b = runs.budgetCrossed();
      if (b) events.add({ type: 'budget', title: b.state === 'over' ? 'Месячный бюджет агента исчерпан' : 'Потрачено 80% месячного бюджета агента',
        text: `$${b.spent.toFixed(2)} из $${b.limit} — условно, по ценам API`, link: '#/agent' });
    } catch { /* бюджет не должен ронять задачу */ }
    try {
      const [okTitle, errTitle] = JOB_TITLES[job.kind] || ['Задача агента завершена', 'Задача агента упала'];
      const who = job.vacancy || (/^[0-9a-f]{8}$/.test(job.target) ? 'новая вакансия' : job.target);
      events.add({
        type: job.error ? 'job_error' : 'job_done', title: job.error ? errTitle : okTitle,
        text: [who, job.error ? String(job.error).slice(0, 140) : ''].filter(Boolean).join(' · '), link: jobLink(job),
      });
    } catch { /* уведомление не должно ронять задачу */ }
    emit(job, { kind: 'state', text: job.error ? `ошибка: ${job.error}` : 'завершено', done: true });
    running--;
    pump();
  };
  child.on('error', (e) => finish(null, e));
  child.on('close', (code) => { if (job.state === 'running') finish(code); });
}

function publicJob(job) {
  if (!job) return null;
  const { id, kind, target, state, created, started, finished, error, cost } = job;
  return { id, kind, target, state, created, started, finished, error, cost,
    last: job.events.filter((e) => e.kind !== 'state').slice(-1)[0]?.text || '' };
}

// ---------- статус CLI (S5) ----------
// `claude auth status` не вызывает модель и лимит подписки не тратит (~0,5 с).

const STATUS_TTL = 60 * 1000;
let status = { state: 'unknown', checkedAt: null };
let checking = null;

function runCli(args, timeout) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: ROOT, env: process.env });
    let out = '';
    let done = false;
    const end = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { child.kill('SIGKILL'); end({ timeout: true }); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => end({ err }));
    child.on('close', (code) => end({ code, out }));
  });
}

async function checkStatus() {
  if (checking) return checking;
  checking = (async () => {
    const [auth, ver] = await Promise.all([runCli(['auth', 'status'], 8000), status.version ? null : runCli(['--version'], 8000)]);
    const next = { checkedAt: new Date().toISOString(), version: status.version || (ver?.out || '').trim().split(' ')[0] || null };
    if (auth.err?.code === 'ENOENT') Object.assign(next, { state: 'missing', error: 'команда claude не найдена в PATH' });
    else if (auth.timeout) Object.assign(next, { state: 'unknown', error: 'CLI не ответил за 8 с' });
    else {
      let j = null;
      try { j = JSON.parse(auth.out.slice(auth.out.indexOf('{'))); } catch { /* не JSON */ }
      if (!j) Object.assign(next, { state: 'unknown', error: (auth.out || '').trim().slice(0, 200) || `код ${auth.code}` });
      else Object.assign(next, {
        state: j.loggedIn ? 'ok' : 'logged_out', authMethod: j.authMethod || null,
        subscription: j.subscriptionType || null, error: j.loggedIn ? null : 'CLI не залогинен',
      });
    }
    status = next;
    checking = null;
    return status;
  })();
  return checking;
}

// Перед запуском задачи: свежий статус (не старше минуты)
async function ensureReady() {
  const fresh = status.checkedAt && Date.now() - Date.parse(status.checkedAt) < STATUS_TTL;
  const s = fresh ? status : await checkStatus();
  if (s.state === 'logged_out') return { ok: false, error: 'Агент не залогинен. В Терминале выполни `claude auth login` и попробуй снова.' };
  if (s.state === 'missing') return { ok: false, error: 'Команда claude не найдена. Установи Claude Code CLI и перезапусти приложение.' };
  return { ok: true };
}

const getStatus = () => status;

module.exports = { runJob, jobs, publicJob, ROOT, checkStatus, ensureReady, getStatus, readModels, saveModels, TASKS, MODEL_CHOICES };
