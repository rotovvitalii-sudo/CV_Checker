// Журнал запусков агента и сводка расхода (S5, docs/specs/07-agent-status.md).
// Стоимость — `total_cost_usd` из ответа claude -p. На подписке это условная оценка по ценам API,
// а не счёт: показываем её для сравнения задач между собой.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUNS = path.join(ROOT, 'web', 'data', 'runs.jsonl');
const OUTPUT = path.join(ROOT, 'output');
const INBOX = path.join(ROOT, 'web', 'data', 'inbox');
const DRAFTS = path.join(ROOT, 'web', 'data', 'master-draft');

function append(run) {
  fs.mkdirSync(path.dirname(RUNS), { recursive: true });
  fs.appendFileSync(RUNS, JSON.stringify(run) + '\n');
}

function all() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Итоговая строка stream-json из лога агента: {"type":"result", duration_ms, total_cost_usd, …}
function parseLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  const head = text.match(/^# (\w+) · (\S+)/);
  let result = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"type":"result"')) continue;
    try { result = JSON.parse(line); } catch { /* обрезанная строка */ }
  }
  if (!head || !result) return null;
  const started = Date.parse(head[2]);
  return {
    at: new Date(started + (result.duration_ms || 0)).toISOString(),
    kind: head[1], durationMs: result.duration_ms ?? null, costUsd: result.total_cost_usd ?? null,
    turns: result.num_turns ?? null, ok: !result.is_error, error: result.is_error ? String(result.result || '').slice(0, 200) : null,
  };
}

// Один раз при первом запуске: восстановить историю из логов, которые уже лежат на диске.
// Лог перезаписывается при повторном запуске той же задачи, поэтому история неполная.
// Переоценка существующей вакансии не пишет vacancy_file — ищем заявку по компании («… - Initech»)
function byCompany(company) {
  const dir = path.join(ROOT, 'vacancies');
  if (!fs.existsSync(dir)) return null;
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9а-я]+/g, ' ').trim();
  const c = norm(company);
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    .filter((n) => norm(n.split(' - ').slice(-1)[0]) === c);
  return hits.length === 1 ? hits[0] : null;
}

function backfill() {
  if (fs.existsSync(RUNS)) return 0;
  const found = [];
  const add = (file, target) => {
    try {
      const r = parseLog(file);
      if (r) found.push({ ...r, target, backfilled: true });
    } catch { /* нечитаемый лог пропускаем */ }
  };
  if (fs.existsSync(OUTPUT)) {
    for (const d of fs.readdirSync(OUTPUT)) {
      const dir = path.join(OUTPUT, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (/^agent-\w+\.log$/.test(f)) add(path.join(dir, f), d);
    }
  }
  if (fs.existsSync(INBOX)) {
    for (const f of fs.readdirSync(INBOX)) {
      if (!f.endsWith('.log')) continue;
      const id = f.slice(0, -4);
      let target = id;
      try {
        const res = JSON.parse(fs.readFileSync(path.join(INBOX, `${id}.result.json`), 'utf8'));
        if (res.vacancy_file) target = path.basename(res.vacancy_file, '.md');
        else if (res.company) target = byCompany(res.company) || `${res.title} - ${res.company}`;
      } catch { /* результата нет — оставляем id */ }
      add(path.join(INBOX, f), target);
    }
  }
  if (fs.existsSync(DRAFTS)) {
    for (const d of fs.readdirSync(DRAFTS)) {
      const f = path.join(DRAFTS, d, 'agent.log');
      if (fs.existsSync(f)) add(f, 'master');
    }
  }
  found.sort((a, b) => a.at.localeCompare(b.at));
  fs.mkdirSync(path.dirname(RUNS), { recursive: true });
  fs.writeFileSync(RUNS, found.map((r) => JSON.stringify(r)).join('\n') + (found.length ? '\n' : ''));
  return found.length;
}

function sum(runs) {
  return {
    runs: runs.length,
    durationMs: runs.reduce((s, r) => s + (r.durationMs || 0), 0),
    costUsd: runs.reduce((s, r) => s + (r.costUsd || 0), 0),
    failed: runs.filter((r) => !r.ok).length,
  };
}

function usage() {
  const runs = all();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const month = runs.filter((r) => r.at >= monthStart);
  const byKind = {};
  for (const r of month) (byKind[r.kind] = byKind[r.kind] || []).push(r);

  // Средняя заявка: вакансии, у которых есть успешная сборка CV, — все их запуски вместе
  const byTarget = {};
  for (const r of runs) if (r.target && r.target !== 'master') (byTarget[r.target] = byTarget[r.target] || []).push(r);
  const apps = Object.values(byTarget).filter((rs) => rs.some((r) => r.kind === 'tailor' && r.ok)).map(sum);
  const avg = (k) => (apps.length ? apps.reduce((s, a) => s + a[k], 0) / apps.length : null);

  return {
    since: runs[0]?.at || null,
    backfilled: runs.filter((r) => r.backfilled).length,
    month: { from: monthStart, ...sum(month), byKind: Object.fromEntries(Object.entries(byKind).map(([k, rs]) => [k, sum(rs)])) },
    perApplication: { count: apps.length, costUsd: avg('costUsd'), durationMs: avg('durationMs'), runs: avg('runs') },
    last: runs.slice(-20).reverse(),
  };
}

// S5 P1 · мягкий месячный бюджет: ничего не блокирует, только предупреждает при 80% и 100%
const BUDGET = path.join(ROOT, 'web', 'data', 'budget.json');
function readBudget() { try { return JSON.parse(fs.readFileSync(BUDGET, 'utf8')); } catch { return { monthlyUsd: null, notified: {} }; } }
function setBudget(v) {
  const b = readBudget();
  const n = v === '' || v == null ? null : Number(v);
  if (n != null && !(n > 0)) throw new Error('бюджет — положительное число или пусто');
  b.monthlyUsd = n;
  fs.writeFileSync(BUDGET, JSON.stringify(b, null, 2));
  return budget();
}
function budget() {
  const b = readBudget();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const spent = sum(all().filter((r) => r.at >= monthStart)).costUsd;
  if (!b.monthlyUsd) return { limit: null, spent };
  const pct = spent / b.monthlyUsd;
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; // локальный месяц, не UTC
  return { limit: b.monthlyUsd, spent, pct, state: pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : 'ok', month };
}
// Порог, о котором ещё не предупреждали в этом месяце (одно уведомление на 80% и одно на 100%)
function budgetCrossed() {
  const s = budget();
  if (!s.limit || s.state === 'ok') return null;
  const b = readBudget();
  const key = `${s.month}:${s.state}`;
  if ((b.notified || {})[key]) return null;
  b.notified = { ...(b.notified || {}), [key]: new Date().toISOString() };
  fs.writeFileSync(BUDGET, JSON.stringify(b, null, 2));
  return s;
}

const forTarget = (name) => sum(all().filter((r) => r.target === name));

module.exports = { append, all, backfill, usage, forTarget, budget, setBudget, budgetCrossed, RUNS };
