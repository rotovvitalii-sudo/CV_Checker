// Master CV: версии, сохранение, проверка, матч с вакансиями.
// Версии лежат в knowledge-base/master-cv/versions/vNNN/. Актуальная версия копируется в
// knowledge-base/base-cv.md — поэтому скилы и скрипты конвейера работают без изменений.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ROOT } = require('./agent');

const KB = path.join(ROOT, 'knowledge-base');
const MASTER = path.join(KB, 'master-cv');
const VERSIONS = path.join(MASTER, 'versions');
const ACTIVE = path.join(MASTER, 'active.json');
const BASE_CV = path.join(KB, 'base-cv.md');
const MASTER_MD = path.join(KB, 'master-cv.md');
const ORIGINAL_PDF = path.join(ROOT, 'Master_CV.pdf');
const DRAFTS = path.join(ROOT, 'web', 'data', 'master-draft');
const OUTPUT = path.join(ROOT, 'output');
const PY = path.join(ROOT, '.venv', 'bin', 'python');
const BUILD_DOCX = path.join(ROOT, '.claude', 'skills', 'tailor-cv', 'scripts', 'build_docx.js');
const RENDER_NAME = 'Master CV';

const vdir = (n) => path.join(VERSIONS, `v${String(n).padStart(3, '0')}`);
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const today = () => new Date().toISOString().slice(0, 10);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, timeout: 180000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), err });
    });
  });
}
const pyJSON = async (args) => { const r = await run(PY, args); try { return JSON.parse(r.stdout); } catch { return null; } };

const serial = require('./serial');

// ---------- версии ----------

function versionNumbers() {
  if (!fs.existsSync(VERSIONS)) return [];
  return fs.readdirSync(VERSIONS).map((d) => /^v(\d{3})$/.exec(d)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

function activeVersion() {
  const a = readJSON(ACTIVE);
  const nums = versionNumbers();
  return a?.version && nums.includes(a.version) ? a.version : nums[nums.length - 1] || null;
}

function versionText(n) {
  return fs.readFileSync(path.join(vdir(n), 'base-cv.md'), 'utf8');
}

function versionMeta(n) {
  const dir = vdir(n);
  const meta = readJSON(path.join(dir, 'meta.json')) || { version: n };
  const files = fs.readdirSync(dir);
  meta.files = files.filter((f) => f !== 'meta.json');
  meta.hasDocx = files.includes(`${RENDER_NAME}.docx`);
  meta.hasPdf = files.includes(`${RENDER_NAME}.pdf`);
  meta.source_file = files.find((f) => f.startsWith('source.')) || null;
  return meta;
}

// Рендер версии: CV.md → .docx (build_docx.js) → .pdf и страницы (check_cv.py)
async function render(dir, mdFile = 'base-cv.md') {
  return serial(async () => {
    const docx = path.join(dir, `${RENDER_NAME}.docx`);
    const b = await run('node', [BUILD_DOCX, path.join(dir, mdFile), docx]);
    if (!b.ok) return { ok: false, error: (b.stderr || b.err?.message || 'build_docx упал').trim().split('\n').slice(-3).join(' ') };
    const kw = path.join(dir, '.empty-keywords.json');
    fs.writeFileSync(kw, '{"must":[],"nice":[]}');
    const cv = await pyJSON(['scorer/check_cv.py', '--docx', docx, '--keywords', kw, '--json']);
    fs.rmSync(kw, { force: true });
    if (!cv) return { ok: false, error: 'check_cv.py не смог прочитать .docx' };
    return { ok: true, pages: cv.pdf_pages, bottomFree: cv.bottom_free_mm, lengthOk: cv.length_ok, words: cv.words,
      headings: cv.headings, parseOk: cv.parse_ok };
  });
}

async function diffChange(baseFile, cvFile) {
  const r = await pyJSON(['scorer/check_diff.py', '--base', baseFile, '--cv', cvFile, '--json']);
  return r ? { change: r.change, sections: r.sections } : null;
}

// master-cv.md: фронтматтер + текст версии; «Открытые вопросы» (их ведёт case-interview) не трогаем
function rebuildMasterMd(n, text, meta) {
  const old = fs.existsSync(MASTER_MD) ? fs.readFileSync(MASTER_MD, 'utf8') : '';
  const m = old.match(/\n---\s*\n+## Открытые вопросы[\s\S]*$/);
  const tail = m ? m[0] : '\n---\n\n## Открытые вопросы к мастер-CV\n<!-- Заполняется скилом-интервьюером, когда находит расхождения или пробелы -->\n';
  const fm = [
    '---', 'type: master-cv',
    `source: knowledge-base/master-cv/versions/v${String(n).padStart(3, '0')} (${meta.source})`,
    `version: ${n}`, `updated: ${meta.created.slice(0, 10)}`,
    'note: Текст актуальной версии Master CV. Источник истины по фактам и датам. Правится через веб-приложение (экран Master CV); история — knowledge-base/master-cv/versions/.',
    '---', '',
  ].join('\n');
  fs.writeFileSync(MASTER_MD, fm + text.trim() + '\n' + tail.replace(/^\n?/, '\n'));
}

// Первая версия — текущий base-cv.md как есть, исходник — Master_CV.pdf. master-cv.md не трогаем.
async function init() {
  if (versionNumbers().length) return;
  if (!fs.existsSync(BASE_CV)) return;
  const dir = vdir(1);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(BASE_CV, path.join(dir, 'base-cv.md'));
  if (fs.existsSync(ORIGINAL_PDF)) fs.copyFileSync(ORIGINAL_PDF, path.join(dir, 'source.pdf'));
  const meta = { version: 1, created: new Date(fs.statSync(BASE_CV).mtimeMs).toISOString(), source: 'initial',
    note: 'Исходная версия (base-cv.md до появления версий)', original_file: 'Master_CV.pdf', change_vs_prev: null };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(ACTIVE, JSON.stringify({ version: 1 }, null, 2));
  render(dir).then((r) => {
    Object.assign(meta, { pages: r.pages ?? null, bottom_free_mm: r.bottomFree ?? null });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  });
}

// ---------- проверка черновика ----------

function structure(text) {
  const errors = [];
  const lines = text.split('\n');
  const first = lines.find((l) => l.trim());
  if (!first || !/^# \S/.test(first)) errors.push('Первая строка должна быть именем: «# ALEX MORGAN».');
  if ((text.match(/^# /gm) || []).length > 1) errors.push('Заголовок «# » (имя) должен быть ровно один.');
  const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  for (const need of ['experience', 'education']) {
    if (!sections.some((s) => s.includes(need))) errors.push(`Нет секции «## ${need[0].toUpperCase() + need.slice(1)}».`);
  }
  if (!/^### .+ — .+$/m.test(text)) errors.push('В Experience нет мест работы в формате «### Компания — Должность».');
  if (/<[a-z][\s\S]*>|^\|.*\|$/im.test(text)) errors.push('Таблицы и HTML не поддерживаются — только формат CV.md.');
  return { errors, sections };
}

async function validate(text) {
  const { errors } = structure(text);
  const warnings = [];
  const dir = path.join(DRAFTS, '_validate');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'base-cv.md'), text);
  let rendered = null;
  if (!errors.length) {
    rendered = await render(dir);
    if (!rendered.ok) errors.push(`Не собирается в .docx: ${rendered.error}`);
    else if (rendered.pages > 1) warnings.push(`По рендеру ${rendered.pages} страницы. Сохранить можно, но конвейер будет резать адаптированные CV до одной.`);
    else if (rendered.bottomFree != null && rendered.bottomFree < 12) warnings.push(`Запас снизу ${rendered.bottomFree} мм (нужно ≥ 12) — у рекрутера может уехать на вторую страницу.`);
  }
  const act = activeVersion();
  const diff = act ? await diffChange(path.join(vdir(act), 'base-cv.md'), path.join(dir, 'base-cv.md')) : null;
  return { ok: !errors.length, errors, warnings, pages: rendered?.pages ?? null, bottomFree: rendered?.bottomFree ?? null,
    words: text.split(/\s+/).filter(Boolean).length, change: diff?.change ?? null, sections: diff?.sections || null };
}

// ---------- сохранение ----------

async function saveVersion({ text, source, note, sourceFile, restoredFrom }) {
  const v = await validate(text);
  if (!v.ok) return { ok: false, ...v };
  const prev = activeVersion();
  const n = (versionNumbers().slice(-1)[0] || 0) + 1;
  const dir = vdir(n);
  fs.mkdirSync(dir, { recursive: true });
  const clean = text.replace(/\r\n/g, '\n').trimEnd() + '\n';
  fs.writeFileSync(path.join(dir, 'base-cv.md'), clean);
  if (sourceFile && fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(dir, `source${path.extname(sourceFile).toLowerCase()}`));
  const meta = {
    version: n, created: new Date().toISOString(), source, note: note || '',
    original_file: sourceFile ? path.basename(sourceFile) : null, restored_from: restoredFrom || null,
    change_vs_prev: prev ? (await diffChange(path.join(vdir(prev), 'base-cv.md'), path.join(dir, 'base-cv.md')))?.change ?? null : null,
    prev_version: prev,
  };
  const r = await render(dir);
  Object.assign(meta, { pages: r.pages ?? null, bottom_free_mm: r.bottomFree ?? null });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  fs.copyFileSync(path.join(dir, 'base-cv.md'), BASE_CV);
  rebuildMasterMd(n, clean, meta);
  fs.writeFileSync(ACTIVE, JSON.stringify({ version: n }, null, 2));
  matchCache.clear();
  return { ok: true, version: n, meta, warnings: v.warnings };
}

async function restore(n) {
  if (!versionNumbers().includes(n)) throw new Error('нет такой версии');
  return saveVersion({ text: versionText(n), source: 'restore', note: `Возврат к v${n}`, restoredFrom: n });
}

// ---------- матч с вакансиями ----------

const matchCache = new Map(); // `${version}:${stamp}` → {name: result}

function keywordsStamp() {
  if (!fs.existsSync(OUTPUT)) return 0;
  let s = 0;
  for (const d of fs.readdirSync(OUTPUT)) {
    const p = path.join(OUTPUT, d, '01-keywords.json');
    if (fs.existsSync(p)) s += fs.statSync(p).mtimeMs;
  }
  return s;
}

async function matchesFor(n) {
  if (!n) return {};
  const key = `${n}:${keywordsStamp()}`;
  if (!matchCache.has(key)) {
    matchCache.set(key, pyJSON(['scorer/check_master.py', '--cv', path.join(vdir(n), 'base-cv.md'), '--json']).then((r) => r || {}));
  }
  return matchCache.get(key);
}

// Матч каждой вакансии с актуальной версией и дельта к предыдущей
async function vacancyMatches() {
  const act = activeVersion();
  const prev = versionNumbers().filter((x) => x < act).slice(-1)[0] || null;
  const [cur, old] = await Promise.all([matchesFor(act), prev ? matchesFor(prev) : {}]);
  const out = {};
  for (const [name, r] of Object.entries(cur)) {
    const o = old[name];
    out[name] = {
      version: act, prevVersion: prev, score: r.score,
      must: `${r.must.hit.length}/${r.must.hit.length + r.must.miss.length}`,
      mustMiss: r.must.miss,
      mustHit: r.must.hit,
      delta: o ? Math.round((r.score - o.score) * 1000) / 1000 : null,
    };
  }
  return out;
}

async function summary() {
  const nums = versionNumbers();
  const act = activeVersion();
  const versions = [];
  for (const n of nums.slice().reverse()) {
    const meta = versionMeta(n);
    const m = await matchesFor(n);
    const vals = Object.values(m).map((r) => r.score);
    meta.avgMatch = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    meta.active = n === act;
    versions.push(meta);
  }
  return { active: act, versions };
}

// Устарело ли CV, собранное из версии n: текст той базы отличается от актуальной
// (копия через «Сделать актуальной» — не устаревание)
function isStale(n) {
  const act = activeVersion();
  if (!n || !act || n === act) return false;
  try { return versionText(n).trim() !== versionText(act).trim(); } catch { return true; }
}

module.exports = {
  init, isStale, activeVersion, versionNumbers, versionText, versionMeta, vdir, validate, saveVersion, restore,
  vacancyMatches, summary, DRAFTS, RENDER_NAME,
};
