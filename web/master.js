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
const MAX_PROFILES = 10;
const STARTER = [
  { title: 'Product Lead', terms: ['product lead', 'lead product manager', 'head of product'] },
  { title: 'Senior Product Manager', terms: ['senior product manager', 'senior pm'] },
  { title: 'Product Owner', terms: ['product owner'] },
  { title: 'Growth Product Manager', terms: ['growth product manager', 'growth pm', 'growth product'] },
  { title: 'Product Marketing Manager', terms: ['product marketing manager', 'product marketing', 'pmm'] },
  { title: 'AI Product Manager', terms: ['ai product manager', 'ai pm', 'ai product'] },
];

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

function allVersions() {
  if (!fs.existsSync(VERSIONS)) return [];
  return fs.readdirSync(VERSIONS).map((d) => /^v(\d{3})$/.exec(d)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

// C18: версии профиля. Нумерация общая, поэтому a.baseVersion по-прежнему однозначно указывает на текст
function versionNumbers(profile) {
  const nums = allVersions();
  return profile ? nums.filter((n) => versionProfile(n) === profile) : nums;
}

// ---------- профили (C18) ----------

const reg = () => readJSON(ACTIVE) || {};
const writeReg = (r) => fs.writeFileSync(ACTIVE, JSON.stringify(r, null, 2));
const defaultId = () => reg().default || null;
const profiles = () => reg().profiles || [];
const liveProfiles = () => profiles().filter((p) => !p.archived);
const profileById = (id) => profiles().find((p) => p.id === id) || null;

function versionProfile(n) {
  return readJSON(path.join(vdir(n), 'meta.json'))?.profile || defaultId();
}

const profileOf = (n) => (n ? profileById(versionProfile(n)) : null);

function activeVersion(profile) {
  const r = reg();
  if (r.profiles) {
    const p = r.profiles.find((x) => x.id === (profile || r.default));
    return p?.version ?? null;
  }
  const nums = allVersions();
  return r.version && nums.includes(r.version) ? r.version : nums[nums.length - 1] || null;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function createProfile({ title, terms }) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: 'нужно название профиля' };
  if (t.length > 60) return { ok: false, error: 'название длиннее 60 символов' };
  if (liveProfiles().length >= MAX_PROFILES) return { ok: false, error: `не больше ${MAX_PROFILES} профилей: архивируй ненужный` };
  const r = reg();
  if (r.profiles.some((p) => p.title.toLowerCase() === t.toLowerCase())) return { ok: false, error: 'такой профиль уже есть' };
  const base = slug(t) || 'profile';
  let id = base;
  for (let i = 2; r.profiles.some((p) => p.id === id); i++) id = `${base}-${i}`;
  const p = { id, title: t, terms: cleanTerms(terms, t), version: null, archived: false };
  r.profiles.push(p);
  writeReg(r);
  return { ok: true, profile: p };
}

function cleanTerms(terms, title) {
  const list = (Array.isArray(terms) ? terms : String(terms || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return list.length ? [...new Set(list)] : [String(title).toLowerCase()];
}

function updateProfile(id, body) {
  const r = reg();
  const p = r.profiles.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'нет такого профиля' };
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 60) return { ok: false, error: 'нужно название до 60 символов' };
    if (r.profiles.some((x) => x !== p && x.title.toLowerCase() === t.toLowerCase())) return { ok: false, error: 'такой профиль уже есть' };
    p.title = t;
  }
  if (body.terms !== undefined) p.terms = cleanTerms(body.terms, p.title);
  if (body.archived !== undefined) {
    if (body.archived && r.default === id) return { ok: false, error: 'основной профиль нельзя архивировать: сначала сделай основным другой' };
    if (!body.archived && p.archived && r.profiles.filter((x) => !x.archived).length >= MAX_PROFILES) return { ok: false, error: `не больше ${MAX_PROFILES} профилей` };
    p.archived = !!body.archived;
  }
  if (body.default) {
    if (!p.version) return { ok: false, error: 'основным может быть только заполненный профиль' };
    if (p.archived) return { ok: false, error: 'сначала верни профиль из архива' };
    r.default = id;
    r.version = p.version;
    syncBase(p.version);
  }
  writeReg(r);
  clearPicks();
  return { ok: true, profile: p };
}

// base-cv.md и master-cv.md — копии основного профиля: их читают скилы и скрипты конвейера
function syncBase(n) {
  const text = versionText(n);
  fs.writeFileSync(BASE_CV, text);
  rebuildMasterMd(n, text, readJSON(path.join(vdir(n), 'meta.json')));
}

// Миграция: всё существующее — основной профиль, остальные стартовые — пустые. Повторный запуск ничего не меняет.
function migrate() {
  const r = reg();
  if (r.profiles) return;
  const act = activeVersion();
  if (!act) return;
  const head = versionText(act).split('\n').slice(1).find((l) => l.trim()) || '';
  const title = head.split('|')[0].trim() || 'Основной';
  const seed = STARTER.find((s) => s.title.toLowerCase() === title.toLowerCase());
  const main = { id: slug(title) || 'main', title, terms: seed ? seed.terms : [title.toLowerCase()], version: act, archived: false };
  const rest = STARTER.filter((s) => s !== seed).map((s) => ({ id: slug(s.title), title: s.title, terms: s.terms, version: null, archived: false }));
  for (const n of allVersions()) {
    const f = path.join(vdir(n), 'meta.json');
    const meta = readJSON(f) || { version: n };
    if (!meta.profile) fs.writeFileSync(f, JSON.stringify({ ...meta, profile: main.id }, null, 2));
  }
  writeReg({ version: act, default: main.id, profiles: [main, ...rest] });
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
  if (allVersions().length) return migrate();
  if (!fs.existsSync(BASE_CV)) return;
  const dir = vdir(1);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(BASE_CV, path.join(dir, 'base-cv.md'));
  if (fs.existsSync(ORIGINAL_PDF)) fs.copyFileSync(ORIGINAL_PDF, path.join(dir, 'source.pdf'));
  const meta = { version: 1, created: new Date(fs.statSync(BASE_CV).mtimeMs).toISOString(), source: 'initial',
    note: 'Исходная версия (base-cv.md до появления версий)', original_file: 'Master_CV.pdf', change_vs_prev: null };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(ACTIVE, JSON.stringify({ version: 1 }, null, 2));
  migrate();
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

// С каким профилем сверять роли: с основным, а для самого основного — с первым заполненным другим
function rolesReference(profile) {
  const ref = profile === defaultId() ? liveProfiles().find((p) => p.id !== profile && p.version) : profileById(defaultId());
  return ref?.version && ref.id !== profile ? ref : null;
}

async function validate(text, profile) {
  const pid = profile || defaultId();
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
  // Master сверяется с карточками: число, которого нет ни в одной, стоит подтвердить или добавить кейсом
  const ref = rolesReference(pid);
  const ev = errors.length ? null : await pyJSON(['scorer/check_evidence.py', '--cv', path.join(dir, 'base-cv.md'),
    ...(ref ? ['--roles-from', path.join(vdir(ref.version), 'base-cv.md')] : []), '--json']);
  const rolesDiffer = ev?.roles && !ev.roles.pass ? { profile: ref.title, missing: ev.roles.missing, extra: ev.roles.extra, languages: !ev.roles.languages_ok, order: !ev.roles.order_ok } : null;
  if (rolesDiffer) warnings.push(`Компании, должности, даты или языки отличаются от профиля ${ref.title}. Факты должны совпадать во всех профилях.`);
  if (ev?.numbers.unknown.length) warnings.push(`Чисел нет в карточках: ${ev.numbers.unknown.join(', ')}. Проверь их или добавь кейсом.`);
  if (ev && !ev.style_ok) warnings.push(`Подача: ${[ev.duties.length ? 'больше одного буллета-обязанности в роли' : '', ev.claims.length ? `общие слова — ${ev.claims.join(', ')}` : '', ev.voice.length ? `местоимения — ${ev.voice.join(', ')}` : ''].filter(Boolean).join('; ')}.`);
  const act = activeVersion(pid);
  const diff = act ? await diffChange(path.join(vdir(act), 'base-cv.md'), path.join(dir, 'base-cv.md')) : null;
  return { ok: !errors.length, errors, warnings, rolesDiffer, pages: rendered?.pages ?? null, bottomFree: rendered?.bottomFree ?? null,
    words: text.split(/\s+/).filter(Boolean).length, change: diff?.change ?? null, sections: diff?.sections || null };
}

// ---------- сохранение ----------

async function saveVersion({ text, source, note, sourceFile, restoredFrom, profile, confirmRoles }) {
  const pid = profile || defaultId();
  if (pid && !profileById(pid)) return { ok: false, errors: ['нет такого профиля'] };
  const v = await validate(text, pid);
  if (!v.ok) return { ok: false, ...v };
  if (v.rolesDiffer && !confirmRoles) return { ...v, ok: false, needRolesConfirm: true, error: 'Факты расходятся с другим профилем', errors: ['Факты расходятся с другим профилем: подтверди или исправь.'] };
  const prev = activeVersion(pid);
  const n = (allVersions().slice(-1)[0] || 0) + 1;
  const dir = vdir(n);
  fs.mkdirSync(dir, { recursive: true });
  const clean = text.replace(/\r\n/g, '\n').trimEnd() + '\n';
  fs.writeFileSync(path.join(dir, 'base-cv.md'), clean);
  if (sourceFile && fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(dir, `source${path.extname(sourceFile).toLowerCase()}`));
  const meta = {
    version: n, profile: pid, created: new Date().toISOString(), source, note: note || '',
    original_file: sourceFile ? path.basename(sourceFile) : null, restored_from: restoredFrom || null,
    change_vs_prev: prev ? (await diffChange(path.join(vdir(prev), 'base-cv.md'), path.join(dir, 'base-cv.md')))?.change ?? null : null,
    prev_version: prev,
  };
  const r = await render(dir);
  Object.assign(meta, { pages: r.pages ?? null, bottom_free_mm: r.bottomFree ?? null });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const r2 = reg();
  if (r2.profiles) {
    r2.profiles.find((p) => p.id === pid).version = n;
    if (pid === r2.default) r2.version = n;
    writeReg(r2);
  } else writeReg({ version: n });
  if (!r2.profiles || pid === r2.default) {
    fs.copyFileSync(path.join(dir, 'base-cv.md'), BASE_CV);
    rebuildMasterMd(n, clean, meta);
  }
  clearPicks();
  return { ok: true, version: n, meta, warnings: v.warnings };
}

async function restore(n) {
  if (!allVersions().includes(n)) throw new Error('нет такой версии');
  return saveVersion({ text: versionText(n), source: 'restore', note: `Возврат к v${n}`, restoredFrom: n, profile: versionProfile(n), confirmRoles: true });
}

// ---------- матч с вакансиями ----------

const matchCache = new Map(); // `${version}:${stamp}` → {name: result}
const pickCache = new Map();  // `${версии профилей}:${stamp}` → рейтинг профилей по вакансиям

function clearPicks() {
  matchCache.clear();
  pickCache.clear();
}

function vacanciesStamp() {
  const dir = path.join(ROOT, 'vacancies');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

// Рейтинг профилей по всем вакансиям (scorer/pick_master.py)
async function picks() {
  const key = `${JSON.stringify(liveProfiles().map((p) => [p.id, p.version, p.terms]))}:${defaultId()}:${keywordsStamp()}:${vacanciesStamp()}`;
  if (!pickCache.has(key)) {
    pickCache.clear();
    pickCache.set(key, pyJSON(['scorer/pick_master.py', '--json']).then((r) => r || {}));
  }
  return pickCache.get(key);
}

// Какой профиль берём: явно переданный, ручной выбор заявки, рекомендация, основной
const usable = (id) => { const p = profileById(id); return p && p.version && !p.archived ? p : null; };

async function pickFor(name, choice) {
  const all = await picks();
  const r = all[name] || { pick: defaultId(), by: 'default', reason: 'вакансия ещё не оценена', scored: false, provisional: false, ranking: [] };
  const mine = choice?.by === 'me' ? usable(choice.profile) : null;
  const rec = usable(r.pick) || usable(defaultId());
  const cur = mine || rec;
  return { recommended: rec?.id || null, recommendedTitle: rec?.title || '', current: cur?.id || null, currentTitle: cur?.title || '',
    version: cur?.version ?? null, manual: !!mine, by: r.by, reason: r.reason, scored: r.scored, provisional: r.provisional,
    ranking: r.ranking.map(({ profile, title, version, score, must }) => ({ profile, title, version, score, must })),
    options: liveProfiles().filter((p) => p.version).map((p) => ({ id: p.id, title: p.title, version: p.version })) };
}

function baseFor(version) {
  return `knowledge-base/master-cv/versions/v${String(version).padStart(3, '0')}/base-cv.md`;
}

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

// Матч каждой вакансии с профилем, который для неё выбран, и дельта к прошлой версии этого профиля
async function vacancyMatches(choiceOf = () => null) {
  const all = await picks();
  const prevOf = new Map();
  for (const p of liveProfiles()) {
    if (!p.version) continue;
    const prev = versionNumbers(p.id).filter((x) => x < p.version).slice(-1)[0] || null;
    prevOf.set(p.id, { prev, old: prev ? await matchesFor(prev) : {} });
  }
  const out = {};
  for (const [name, r] of Object.entries(all)) {
    if (!r.ranking.length) continue;
    const mine = choiceOf(name);
    const row = (mine?.by === 'me' && r.ranking.find((x) => x.profile === mine.profile)) || r.ranking.find((x) => x.profile === r.pick) || r.ranking[0];
    const { prev, old } = prevOf.get(row.profile) || { prev: null, old: {} };
    const o = old[name];
    out[name] = {
      version: row.version, profile: row.profile, profileTitle: row.title, prevVersion: prev, score: row.score,
      must: row.must, mustMiss: row.mustMiss, mustHit: row.mustHit,
      delta: o ? Math.round((row.score - o.score) * 1000) / 1000 : null,
    };
  }
  return out;
}

async function avgMatch(n) {
  const vals = Object.values(await matchesFor(n)).map((r) => r.score);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

async function profilesSummary() {
  const out = [];
  for (const p of profiles()) {
    const meta = p.version ? readJSON(path.join(vdir(p.version), 'meta.json')) : null;
    out.push({ ...p, isDefault: p.id === defaultId(), created: meta?.created || null, avgMatch: p.version ? await avgMatch(p.version) : null });
  }
  return { profiles: out, default: defaultId(), max: MAX_PROFILES };
}

async function summary(profile) {
  const pid = usableId(profile);
  const nums = versionNumbers(pid);
  const act = activeVersion(pid);
  const versions = [];
  for (const n of nums.slice().reverse()) {
    const meta = versionMeta(n);
    meta.avgMatch = await avgMatch(n);
    meta.active = n === act;
    versions.push(meta);
  }
  return { active: act, versions, profile: pid, ...(await profilesSummary()) };
}

const usableId = (id) => (profileById(id) ? id : defaultId());

// Устарело ли CV, собранное из версии n: текст той базы отличается от актуальной
// (копия через «Сделать актуальной» — не устаревание)
function isStale(n) {
  const act = n ? activeVersion(versionProfile(n)) : null;
  if (!n || !act || n === act) return false;
  try { return versionText(n).trim() !== versionText(act).trim(); } catch { return true; }
}

module.exports = {
  init, isStale, activeVersion, versionNumbers, picks, pickFor, baseFor, profileOf, profileById, createProfile, updateProfile, profilesSummary, versionText, versionMeta, vdir, validate, saveVersion, restore,
  vacancyMatches, summary, DRAFTS, RENDER_NAME,
};
