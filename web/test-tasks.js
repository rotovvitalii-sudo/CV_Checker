// C14: тестовые задания (docs/specs/39-test-tasks.md) — хранение test-tasks/<slug>/, импорт папки прошлого тестового,
// библиотека повторно используемых кусков, плейбук, проверка плана. Разбор и план делает агент; здесь всё без агента.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('./agent');

const DIR = path.join(ROOT, 'test-tasks');
const LIBRARY = path.join(DIR, 'LIBRARY.json');
const LIBRARY_MD = path.join(DIR, 'LIBRARY.md');
const PLAYBOOK = path.join(DIR, 'PLAYBOOK.md');
const TYPES = { 'business-case': 'бизнес-кейс', data: 'анализ данных', product: 'продуктовый разбор', strategy: 'стратегия',
  process: 'дизайн процесса', other: 'другое' };
const ASSET_TYPES = { 'agent-rules': 'правила для агента', script: 'скрипт', template: 'шаблон', checklist: 'чеклист', model: 'модель / расчёт', defense: 'защита и вопросы' };
const RESULTS = ['pending', 'passed', 'failed', 'no_reply'];
const STAGE_STATUS = ['todo', 'doing', 'done'];
// При импорте не копируются никогда; большие файлы — тоже
const SKIP_NAMES = new Set(['.venv', 'venv', 'env', 'node_modules', '.git', '__pycache__', '.DS_Store', '.ipynb_checkpoints', '.pytest_cache', '.mypy_cache',
  '.next', '.turbo', '.vercel', '.cache', '.parcel-cache', 'coverage', '.mcp.json']);
// Секреты (.env, .env.local …) не копируются никогда; .env.example — можно
const SECRET = /^\.env(\..+)?$/;
const skipName = (n) => SKIP_NAMES.has(n) || (SECRET.test(n) && !/\.(example|sample|template)$/.test(n));
const MAX_FILE = 25 * 1024 * 1024;

const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID().slice(0, 8);
const safeSlug = (s) => {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(s || ''))) throw Object.assign(new Error('bad name'), { status: 400 });
  return s;
};
const taskDir = (slug) => path.join(DIR, safeSlug(slug));
const metaFile = (slug) => path.join(taskDir(slug), 'meta.json');

function slugify(s) {
  const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g' };
  const base = String(s || '').toLowerCase().replace(/[а-яёіїєґ]/g, (c) => tr[c] ?? '')
    .normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return base || `test-${newId()}`;
}
function freeSlug(s) {
  let slug = slugify(s);
  for (let i = 2; fs.existsSync(path.join(DIR, slug)); i++) slug = `${slugify(s)}-${i}`;
  return slug;
}

// Безопасный путь внутри задания (для файлов библиотеки и предпросмотра)
function inside(base, rel) {
  const p = path.resolve(base, String(rel || ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('путь вне папки задания');
  return p;
}

// ---------- плейбук ----------

const PLAYBOOK_SEED = `# Плейбук тестовых

Как я делаю тестовые задания вместе с агентом. Дополняется после разбора каждого задания — только через «Добавить» в приложении
(экран «Тестовые» → «Плейбук») или правкой руками.

## Правила работы с агентом
- Выводы, диагноз и приоритеты — мои. Агент готовит данные, считает то, что попросили, проверяет логику и прямо говорит об ошибках.
- Перед нетривиальным расчётом агент кратко описывает метод и ждёт «ок».
- У каждой цифры — одна строка «откуда она» (скрипт → таблица → лист рабочего файла).
- Допущения — в \`notes/assumptions.md\` с обоснованием, неясности в данных — в \`notes/questions_to_company.md\`.
- Исходные файлы задания — только для чтения.

## Этапы

## Перед сдачей

## Защита

## Ловушки
`;
const SECTIONS = ['Правила работы с агентом', 'Этапы', 'Перед сдачей', 'Защита', 'Ловушки'];
function ensureBase() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(PLAYBOOK)) fs.writeFileSync(PLAYBOOK, PLAYBOOK_SEED);
  if (!fs.existsSync(LIBRARY)) { writeJSON(LIBRARY, { items: [] }); writeLibraryMd(); }
}
const playbook = () => { ensureBase(); return readText(PLAYBOOK); };
function savePlaybook(text) {
  ensureBase();
  fs.writeFileSync(PLAYBOOK, String(text || '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
}
// Правило в раздел плейбука (раздела нет — добавляется в конец)
function addRule(rule, section, ref) {
  const sec = SECTIONS.includes(section) ? section : 'Ловушки';
  const line = `- ${String(rule).trim()}${ref ? ` _(${ref})_` : ''}`;
  let md = playbook();
  const re = new RegExp(`^## ${sec}[ \\t]*$`, 'm');
  const m = md.match(re);
  if (!m) md = `${md.replace(/\n*$/, '\n')}\n## ${sec}\n${line}\n`;
  else {
    const start = m.index + m[0].length;
    const next = md.slice(start).search(/^## /m);
    const end = next < 0 ? md.length : start + next;
    const block = md.slice(start, end).replace(/\n*$/, '');
    md = `${md.slice(0, start)}${block}\n${line}\n${next < 0 ? '' : '\n'}${md.slice(end)}`;
  }
  savePlaybook(md);
}
// Раздел плейбука одним куском (для CLAUDE.md рабочей папки)
function playbookSection(sec) {
  const md = playbook();
  const m = md.match(new RegExp(`^## ${sec}[ \\t]*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}

// ---------- задания ----------

function meta(slug) {
  const m = readJSON(metaFile(slug), null);
  if (!m) throw Object.assign(new Error('нет такого тестового'), { status: 404 });
  return m;
}
function saveMeta(slug, m) { writeJSON(metaFile(slug), { ...m, updated: now() }); }
const plan = (slug) => readJSON(path.join(taskDir(slug), 'plan.json'), null);
const debrief = (slug) => readJSON(path.join(taskDir(slug), 'debrief.json'), null);
function progress(p) {
  const st = p?.stages || [];
  return { done: st.filter((x) => x.status === 'done').length, doing: st.filter((x) => x.status === 'doing').length, total: st.length };
}
function state(m, p) {
  if (m.result && m.result !== 'pending') return m.result;
  if (m.submittedAt) return 'submitted';
  if (m.imported && !p) return 'archive';
  if (!p) return 'new';
  return progress(p).done || progress(p).doing ? 'doing' : 'planned';
}

function summary(slug) {
  const m = meta(slug);
  const p = plan(slug);
  return { slug, company: m.company, role: m.role, type: m.type || null, vacancy: m.vacancy || null, due: m.due || null,
    received: m.received || null, submittedAt: m.submittedAt || null, result: m.result || 'pending', hours: m.hours ?? null,
    imported: !!m.imported, state: state(m, p), progress: progress(p), debriefed: fs.existsSync(path.join(taskDir(slug), 'debrief.md')),
    created: m.created };
}
function list() {
  ensureBase();
  return fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(DIR, d.name, 'meta.json')))
    .map((d) => { try { return summary(d.name); } catch { return null; } }).filter(Boolean)
    // Сначала то, что в работе (не импортировано и не сдано), потом по дате получения
    .sort((a, b) => Number(!a.imported && !a.submittedAt ? 0 : 1) - Number(!b.imported && !b.submittedAt ? 0 : 1)
      || String(b.received || b.created).localeCompare(String(a.received || a.created)));
}
const forVacancy = (name) => list().filter((t) => t.vacancy === name);

// Рабочая папка нового задания — CLAUDE.md с автоблоком: ссылки на задание, план, плейбук и библиотеку + правила из плейбука.
// Свой текст кандидат пишет вне блока — он сохраняется при пересборке.
const AUTO_A = '<!-- cvc:auto — блок пересобирается приложением, правь ниже -->';
const AUTO_B = '<!-- /cvc:auto -->';
function writeWorkClaude(slug) {
  const m = meta(slug);
  const p = plan(slug);
  const file = path.join(taskDir(slug), 'work', 'CLAUDE.md');
  const rules = playbookSection('Правила работы с агентом');
  const block = `${AUTO_A}
# Тестовое: ${m.role || ''}${m.company ? ` — ${m.company}` : ''}

Это рабочая папка тестового в CV Checker (C14). Работаем по скилу \`test-task\`.
- Задание: \`../task.md\`, файлы задания — \`../brief/\` (только чтение).
- План по этапам: \`../plan.md\` (статусы этапов — в \`../plan.json\`, поле \`status\`: todo → doing → done).
- Плейбук — как я делаю тестовые: \`../../PLAYBOOK.md\`. Библиотека готовых кусков: \`../../LIBRARY.md\`.
${m.due ? `- Срок сдачи: ${m.due}.\n` : ''}
## Правила работы
${rules || '- (в плейбуке пока нет правил работы с агентом)'}
${p?.stages?.length ? `\n## Этапы\n${p.stages.map((s, i) => `${i + 1}. ${s.title}${s.hours ? ` (~${s.hours} ч)` : ''} — ${s.result}`).join('\n')}\n` : ''}${AUTO_B}`;
  const cur = readText(file);
  const rest = cur.includes(AUTO_B) ? cur.slice(cur.indexOf(AUTO_B) + AUTO_B.length) : cur ? `\n\n${cur}` : '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${block}${rest}`);
}

function create({ company, role, vacancy, due, text, hours }) {
  ensureBase();
  if (!String(text || '').trim()) throw Object.assign(new Error('вставь текст задания'), { status: 400 });
  const slug = freeSlug(`${company || ''} ${role || 'test'}`);
  const dir = path.join(DIR, slug);
  for (const d of ['brief', 'work']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `${String(text).trim()}\n`);
  writeJSON(path.join(dir, 'meta.json'), { company: company || '', role: role || '', vacancy: vacancy || null, due: due || null,
    budgetHours: Number(hours) > 0 ? Number(hours) : null, received: now().slice(0, 10), result: 'pending', created: now(), updated: now() });
  writeWorkClaude(slug);
  return slug;
}

function update(slug, b) {
  const m = meta(slug);
  for (const k of ['company', 'role', 'due', 'received', 'feedback']) if (b[k] !== undefined) m[k] = String(b[k] || '').trim() || null;
  if (b.vacancy !== undefined) m.vacancy = b.vacancy || null;
  if (b.type !== undefined && (TYPES[b.type] || !b.type)) m.type = b.type || null;
  if (b.hours !== undefined) m.hours = Number(b.hours) > 0 ? Number(b.hours) : null;
  if (b.budgetHours !== undefined) m.budgetHours = Number(b.budgetHours) > 0 ? Number(b.budgetHours) : null;
  if (b.result !== undefined && RESULTS.includes(b.result)) { m.result = b.result; m.resultAt = b.result === 'pending' ? null : now(); }
  if (b.submitted !== undefined) m.submittedAt = b.submitted ? (m.submittedAt || now()) : null;
  if (b.task !== undefined) fs.writeFileSync(path.join(taskDir(slug), 'task.md'), `${String(b.task).trim()}\n`);
  saveMeta(slug, m);
  return m;
}

function setStage(slug, id, status) {
  const file = path.join(taskDir(slug), 'plan.json');
  const p = readJSON(file, null);
  const s = p?.stages?.find((x) => x.id === id);
  if (!s || !STAGE_STATUS.includes(status)) throw Object.assign(new Error('нет такого этапа'), { status: 400 });
  s.status = status;
  s[`${status}At`] = now();
  writeJSON(file, p);
  return p;
}

// ---------- импорт папки прошлого тестового ----------

function dirSize(p) {
  let size = 0, files = 0, skipped = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (skipName(e.name)) { skipped++; continue; }
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(f);
      else { const s = fs.statSync(f).size; if (s > MAX_FILE) { skipped++; continue; } size += s; files++; }
    }
  };
  walk(p);
  return { size, files, skipped };
}
// Верхний уровень папки: что копируется по умолчанию. Папка, повторяющая корень (копия для загрузки на диск), — снята.
function scan(src) {
  const root = path.resolve(String(src || '').replace(/^~(?=\/|$)/, require('node:os').homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw Object.assign(new Error('папка не найдена'), { status: 400 });
  if (root === ROOT || root.startsWith(DIR) || ROOT.startsWith(root + path.sep)) throw Object.assign(new Error('это папка CV Checker'), { status: 400 });
  const top = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !e.isSymbolicLink());
  const names = new Set(top.map((e) => e.name));
  const entries = top.map((e) => {
    const p = path.join(root, e.name);
    if (skipName(e.name)) return { name: e.name, dir: e.isDirectory(), size: null, files: null, include: false, reason: SECRET.test(e.name) || e.name === '.mcp.json' ? 'секреты, не копируется' : 'служебное, не копируется' };
    if (!e.isDirectory()) {
      const size = fs.statSync(p).size;
      return { name: e.name, dir: false, size, files: 1, include: size <= MAX_FILE, reason: size > MAX_FILE ? 'больше 25 МБ' : '' };
    }
    const st = dirSize(p);
    // Копия корня: внутри одна папка, в которой ≥ 70% имён корня
    const kids = fs.readdirSync(p).filter((x) => x !== '.DS_Store');
    const inner = kids.length === 1 && fs.statSync(path.join(p, kids[0])).isDirectory() ? fs.readdirSync(path.join(p, kids[0])) : kids;
    const overlap = inner.filter((x) => names.has(x)).length;
    const copy = inner.length >= 3 && overlap / inner.length >= 0.7;
    return { name: e.name, dir: true, size: st.size, files: st.files, include: !copy, reason: copy ? 'похоже на копию всей папки' : st.skipped ? `без ${st.skipped} служебных / больших` : '' };
  }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { root, entries, size: entries.filter((x) => x.include).reduce((s, x) => s + (x.size || 0), 0) };
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skipName(e.name) || e.isSymbolicLink()) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else if (fs.statSync(a).size <= MAX_FILE) fs.copyFileSync(a, b);
  }
}

// Текст задания: раздел «Задание / Task / Assignment» из CLAUDE.md или README.md папки
function guessTask(root) {
  for (const f of ['CLAUDE.md', 'README.md', 'TASK.md', 'task.md']) {
    const md = readText(path.join(root, f));
    if (!md) continue;
    const m = md.match(/^(#{2,3}) [^\n]*(Задание|Задача|Task|Assignment|Brief)[^\n]*\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/im);
    if (m && m[3].trim().length > 80) return { text: `${m[0].trim()}\n`, from: f };
  }
  return { text: '', from: null };
}

function importFolder({ src, skip = null, company, role, vacancy, received, result, hours }) {
  ensureBase();
  const sc = scan(src);
  const take = new Set(sc.entries.filter((x) => (Array.isArray(skip) ? !skip.includes(x.name) : x.include) && !skipName(x.name)).map((x) => x.name));
  const slug = freeSlug(`${company || path.basename(sc.root)} ${role || ''}`);
  const dir = path.join(DIR, slug);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(dir, 'brief'), { recursive: true });
  for (const name of take) {
    const a = path.join(sc.root, name), b = path.join(work, name);
    if (fs.statSync(a).isDirectory()) copyTree(a, b); else { fs.mkdirSync(work, { recursive: true }); fs.copyFileSync(a, b); }
  }
  const g = guessTask(sc.root);
  fs.writeFileSync(path.join(dir, 'task.md'), g.text || '');
  writeJSON(path.join(dir, 'meta.json'), { company: company || path.basename(sc.root), role: role || '', vacancy: vacancy || null, due: null,
    received: received || null, result: RESULTS.includes(result) ? result : 'pending', hours: Number(hours) > 0 ? Number(hours) : null,
    imported: true, source: sc.root, taskFrom: g.from, copied: [...take], created: now(), updated: now() });
  return { slug, taskFrom: g.from, size: dirSize(work).size };
}

// Файлы рабочей папки (для экрана задания): путь и размер, без служебного
function files(slug, sub = 'work', limit = 400) {
  const base = path.join(taskDir(slug), sub);
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipName(e.name) || e.name.startsWith('_') && sub === 'brief') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (out.length < limit) out.push({ path: path.relative(base, f), size: fs.statSync(f).size });
    }
  };
  walk(base);
  return out;
}
const TEXT_EXT = /\.(md|txt|py|js|ts|json|csv|tsv|sql|ya?ml|toml|html|css|sh|r|ipynb)$/i;
function preview(slug, rel) {
  const p = inside(path.join(taskDir(slug), 'work'), rel);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw Object.assign(new Error('нет файла'), { status: 404 });
  if (!TEXT_EXT.test(p)) return { binary: true, size: fs.statSync(p).size };
  const t = fs.readFileSync(p, 'utf8');
  return { text: t.slice(0, 200000), truncated: t.length > 200000 };
}
function saveBrief(slug, name, buf) {
  const clean = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  if (!clean || clean.startsWith('.') || clean.startsWith('_')) throw Object.assign(new Error('плохое имя файла'), { status: 400 });
  const p = path.join(taskDir(slug), 'brief', clean);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return clean;
}

// ---------- библиотека ----------

const library = () => { ensureBase(); return readJSON(LIBRARY, { items: [] }); };
function writeLibraryMd() {
  const lib = readJSON(LIBRARY, { items: [] });
  const byType = Object.keys(ASSET_TYPES).map((t) => [t, lib.items.filter((x) => x.type === t)]).filter(([, xs]) => xs.length);
  const md = `# Библиотека тестовых

Готовые куски из прошлых тестовых — брать, а не писать с нуля. Путь — от папки \`test-tasks/\`.
Файл собирается приложением из LIBRARY.json, руками не править.

${byType.map(([t, xs]) => `## ${ASSET_TYPES[t]}\n${xs.map((x) => `- **${x.id}** · ${x.title} — \`${x.from}/work/${x.path}\`
  - что: ${x.what}${x.inputs ? `\n  - на входе: ${x.inputs}` : ''}${x.adapt ? `\n  - поменять под новое: ${x.adapt}` : ''}
  - из задания: ${x.from} (${x.outcome || 'результат неизвестен'})`).join('\n')}`).join('\n\n') || '_пусто — разбери прошлое тестовое_'}
`;
  fs.writeFileSync(LIBRARY_MD, md);
}
function normAsset(x, from) {
  const clip = (s, n) => String(s || '').trim().slice(0, n);
  return { title: clip(x.title, 120), type: ASSET_TYPES[x.type] ? x.type : 'template', path: clip(x.path, 300).replace(/^(\.\/)?\/*(work\/)?/, ''),
    from, what: clip(x.what, 500), inputs: clip(x.inputs, 300), adapt: clip(x.adapt, 500) };
}
function assetExists(a) {
  try { return fs.existsSync(inside(path.join(taskDir(a.from), 'work'), a.path)); } catch { return false; }
}
function addAsset(x, from) {
  const lib = library();
  const a = normAsset(x, from);
  if (!a.title || !a.path) throw Object.assign(new Error('нужны название и путь'), { status: 400 });
  if (!assetExists(a)) throw Object.assign(new Error(`файла нет: ${a.from}/work/${a.path}`), { status: 400 });
  if (lib.items.some((y) => y.from === a.from && y.path === a.path)) throw Object.assign(new Error('этот файл уже в библиотеке'), { status: 409 });
  const m = meta(from);
  const item = { id: `${slugify(a.title).slice(0, 32)}-${newId().slice(0, 4)}`, ...a, outcome: { passed: 'прошёл', failed: 'не прошёл', no_reply: 'нет ответа' }[m.result] || 'ждёт ответа', added: now() };
  lib.items.push(item);
  writeJSON(LIBRARY, lib);
  writeLibraryMd();
  return item;
}
function patchAsset(id, b) {
  const lib = library();
  const it = lib.items.find((x) => x.id === id);
  if (!it) throw Object.assign(new Error('нет такого куска'), { status: 404 });
  for (const k of ['title', 'what', 'inputs', 'adapt']) if (b[k] !== undefined) it[k] = String(b[k] || '').trim().slice(0, 500);
  if (b.type && ASSET_TYPES[b.type]) it.type = b.type;
  writeJSON(LIBRARY, lib);
  writeLibraryMd();
  return it;
}
function removeAsset(id) {
  const lib = library();
  lib.items = lib.items.filter((x) => x.id !== id);
  writeJSON(LIBRARY, lib);
  writeLibraryMd();
}
// Результат задания поменялся → поменять пометку у его кусков
function refreshOutcome(slug) {
  const lib = library();
  const r = { passed: 'прошёл', failed: 'не прошёл', no_reply: 'нет ответа' }[meta(slug).result] || 'ждёт ответа';
  let changed = false;
  for (const x of lib.items) if (x.from === slug && x.outcome !== r) { x.outcome = r; changed = true; }
  if (changed) { writeJSON(LIBRARY, lib); writeLibraryMd(); }
}
// «Скопировать в задание»: файл куска → work/<тот же относительный путь> нового задания; отметка в plan.json
function copyAsset(id, to) {
  const it = library().items.find((x) => x.id === id);
  if (!it) throw Object.assign(new Error('нет такого куска'), { status: 404 });
  if (it.from === to) throw Object.assign(new Error('это то же задание'), { status: 400 });
  const src = inside(path.join(taskDir(it.from), 'work'), it.path);
  const dst = inside(path.join(taskDir(to), 'work'), it.path);
  if (fs.existsSync(dst)) throw Object.assign(new Error(`в задании уже есть ${it.path}`), { status: 409 });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.statSync(src).isDirectory()) copyTree(src, dst); else fs.copyFileSync(src, dst);
  const pf = path.join(taskDir(to), 'plan.json');
  const p = readJSON(pf, null);
  if (p) { p.copied = [...new Set([...(p.copied || []), id])]; writeJSON(pf, p); }
  return { path: it.path };
}

// ---------- разбор (результат агента) ----------

// debrief.json агента → кандидаты в библиотеку (только существующие файлы) и в плейбук; ожидают «Добавить»
function acceptDebrief(slug) {
  const d = readJSON(path.join(taskDir(slug), 'debrief.json'), null);
  if (!d) throw new Error('агент не записал debrief.json');
  if (!fs.existsSync(path.join(taskDir(slug), 'debrief.md'))) throw new Error('агент не записал debrief.md');
  const dropped = [];
  const lib = (Array.isArray(d.library) ? d.library : []).map((x) => ({ id: newId(), ...normAsset(x, slug), state: 'new' }))
    .filter((a) => { const ok = a.title && a.path && assetExists(a); if (!ok) dropped.push(a.path || a.title); return ok; });
  const rules = (Array.isArray(d.playbook) ? d.playbook : []).map((x) => ({ id: newId(), rule: String(x.rule || '').trim().slice(0, 400),
    section: SECTIONS.includes(x.section) ? x.section : 'Ловушки', ref: String(x.ref || '').trim().slice(0, 200), state: 'new' })).filter((x) => x.rule);
  const out = { ...d, library: lib, playbook: rules, dropped, at: now() };
  writeJSON(path.join(taskDir(slug), 'debrief.json'), out);
  const m = meta(slug);
  if (TYPES[d.type] && !m.type) m.type = d.type;
  if (!m.hours && Number(d.hours) > 0) m.hours = Number(d.hours);
  saveMeta(slug, m);
  return out;
}
// Кандидат из разбора: add | skip
function resolveCandidate(slug, kind, id, action, patch = {}) {
  const file = path.join(taskDir(slug), 'debrief.json');
  const d = readJSON(file, null);
  const arr = kind === 'library' ? d?.library : d?.playbook;
  const c = arr?.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('нет такого предложения'), { status: 404 });
  if (action === 'add') {
    if (kind === 'library') c.libId = addAsset({ ...c, ...patch }, slug).id;
    else addRule(patch.rule || c.rule, patch.section || c.section, `${slug}${c.ref ? `: ${c.ref}` : ''}`);
  }
  c.state = action === 'add' ? 'added' : 'skipped';
  writeJSON(file, d);
  return c;
}

// ---------- план ----------

// Похожие разобранные задания: тот же тип + общие слова задания
function similar(slug, n = 2) {
  const words = (t) => new Set(String(t).toLowerCase().match(/[a-zа-яё]{5,}/g) || []);
  const me = words(readText(path.join(taskDir(slug), 'task.md')));
  const type = meta(slug).type;
  return list().filter((t) => t.slug !== slug && t.debriefed).map((t) => {
    const w = words(readText(path.join(taskDir(t.slug), 'task.md')));
    const common = [...me].filter((x) => w.has(x)).length;
    return { ...t, score: common / Math.sqrt((w.size || 1) * (me.size || 1)) + (type && t.type === type ? 0.5 : 0) + (t.result === 'passed' ? 0.2 : 0) };
  }).sort((a, b) => b.score - a.score).slice(0, n);
}

function normPlan(r) {
  const clip = (s, n) => String(s || '').trim().slice(0, n);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const u = r.understanding || {};
  return {
    type: TYPES[r.type] ? r.type : 'other', new_type: !!r.new_type,
    understanding: { evaluates: arr(u.evaluates).map((x) => clip(x, 300)).filter(Boolean), deliverables: arr(u.deliverables).map((x) => clip(x, 300)).filter(Boolean),
      format: clip(u.format, 300), budget_hours: Number(u.budget_hours) > 0 ? Number(u.budget_hours) : null, deadline: clip(u.deadline, 100) },
    stages: arr(r.stages).map((s) => ({ id: newId(), title: clip(s.title, 160), goal: clip(s.goal, 400), result: clip(s.result, 400),
      hours: Number(s.hours) > 0 ? Math.round(Number(s.hours) * 10) / 10 : null, me: clip(s.me, 400), agent: clip(s.agent, 400),
      assets: arr(s.assets).map(String), checkpoint: clip(s.checkpoint, 300), status: 'todo' })).filter((s) => s.title),
    questions: arr(r.questions).map((q) => ({ q: clip(q.q, 400), why: clip(q.why, 300) })).filter((q) => q.q),
    risks: arr(r.risks).map((x) => clip(typeof x === 'string' ? x : x.risk || x.text, 400)).filter(Boolean),
  };
}
function checkPlan(p, budget) {
  const ids = new Set(library().items.map((x) => x.id));
  const issues = [];
  if (p.stages.length < 4 || p.stages.length > 8) issues.push(`этапов ${p.stages.length}, нужно 4–8`);
  for (const s of p.stages) {
    if (!s.result) issues.push(`этап «${s.title}»: нет результата`);
    const bad = s.assets.filter((id) => !ids.has(id));
    if (bad.length) issues.push(`этап «${s.title}»: нет таких кусков в библиотеке — ${bad.join(', ')}`);
  }
  if (p.questions.length > 3) issues.push(`вопросов компании ${p.questions.length}, не больше 3`);
  const total = p.stages.reduce((s, x) => s + (x.hours || 0), 0);
  const b = budget || p.understanding.budget_hours;
  if (b && total > b * 1.3) issues.push(`этапы на ${total} ч, а бюджет задания ${b} ч (не больше ×1.3)`);
  return { pass: !issues.length, issues, totalHours: total };
}
function planMd(slug, p) {
  const m = meta(slug);
  const lib = Object.fromEntries(library().items.map((x) => [x.id, x]));
  const u = p.understanding;
  return `# План: ${m.role || ''}${m.company ? ` — ${m.company}` : ''}

_Составлен ${p.at?.slice(0, 10) || ''} (${p.model || 'агент'}). Тип: ${TYPES[p.type] || p.type}${p.new_type ? ' — новый тип задания, библиотека почти не помогает' : ''}.
Статусы этапов — в plan.json (\`todo\` → \`doing\` → \`done\`)._

## Что оценивают
${u.evaluates.map((x) => `- ${x}`).join('\n') || '- —'}

## Что сдавать
${u.deliverables.map((x) => `- ${x}`).join('\n') || '- —'}
${u.format ? `\nФормат: ${u.format}` : ''}${u.budget_hours ? `\nБюджет времени: ${u.budget_hours} ч` : ''}${u.deadline ? `\nСрок: ${u.deadline}` : ''}

## Этапы
${p.stages.map((s, i) => `### ${i + 1}. ${s.title}${s.hours ? ` · ~${s.hours} ч` : ''}
- Цель: ${s.goal}
- Результат: ${s.result}
- Решаю я: ${s.me || '—'}
- Делает агент: ${s.agent || '—'}
${s.assets.length ? `- Из библиотеки: ${s.assets.map((id) => (lib[id] ? `${id} (\`${lib[id].from}/work/${lib[id].path}\`)` : id)).join(', ')}\n` : ''}- Проверка: ${s.checkpoint || '—'}`).join('\n\n')}

## Вопросы компании до старта
${p.questions.map((q) => `- ${q.q} — ${q.why}`).join('\n') || '- не нужны'}

## Риски и ловушки
${p.risks.map((x) => `- ${x}`).join('\n') || '- —'}
`;
}
function savePlan(slug, p) {
  const old = plan(slug);
  // Перепланирование: статус этапа с тем же названием сохраняется
  if (old) for (const s of p.stages) { const o = old.stages.find((x) => x.title === s.title); if (o) { s.status = o.status; s.id = o.id; } }
  if (old?.copied) p.copied = old.copied;
  writeJSON(path.join(taskDir(slug), 'plan.json'), p);
  fs.writeFileSync(path.join(taskDir(slug), 'plan.md'), planMd(slug, p));
  const m = meta(slug);
  if (!m.type) { m.type = p.type; saveMeta(slug, m); }
  writeWorkClaude(slug);
}

module.exports = {
  DIR, TYPES, ASSET_TYPES, RESULTS, STAGE_STATUS, SECTIONS, safeSlug, taskDir, readText, meta, plan, debrief, summary, list, forVacancy,
  create, update, setStage, scan, importFolder, files, preview, saveBrief, playbook, savePlaybook, addRule, library, addAsset, patchAsset,
  removeAsset, refreshOutcome, copyAsset, acceptDebrief, resolveCandidate, similar, normPlan, checkPlan, savePlan, writeWorkClaude, ensureBase,
};
