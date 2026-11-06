// C15: моя версия CV (docs/specs/40-my-cv-version.md) — черновик загрузки, раскладка в CV.md, история версий и откат.
// Актуальная версия всегда лежит под прежними именами (CV.md, CV.docx, CV.pdf): экспорт, форма и агенты работают с ней без правок.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const SET = ['CV.md', 'CV.docx', 'CV.pdf'];
const MIN_MATCH = 0.98;
const FOREIGN = 0.4; // ниже — похоже на другой файл

const root = (name) => path.join(store.outDir(name), 'cv-versions');
const draftDir = (name) => path.join(root(name), '_draft');
const pendingDir = (name) => path.join(root(name), '_pending');
const vDir = (name, v) => path.join(root(name), `v${String(v).padStart(3, '0')}`);
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const current = (a) => a.cvVersion || 1;

// DOCX: текст cv_text.py → формат CV.md без агента. Нет заголовков разделов (файл пересохранили без стилей) → structured: false, раскладывает модель
function layout(text) {
  const out = [];
  let name = false, heads = 0;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^\[(Heading (\d)|Title|Subtitle)\]\s*(.*)$/i);
    if (!name) { out.push(`# ${h ? h[3] : line}`); name = true; continue; }
    if (!h) { out.push(line); continue; }
    if (/^subtitle/i.test(h[1])) { out.push(h[3]); continue; }
    const lvl = Number(h[2] || 1);
    heads += lvl === 1 ? 1 : 0;
    out.push('', `${'#'.repeat(lvl + 1)} ${h[3]}`);
  }
  return { md: `${out.join('\n')}\n`, structured: heads >= 3 };
}

// Сколько слов файла дошло до CV.md (мультимножество): раскладка не должна терять и придумывать текст
const bag = (s) => String(s).replace(/^\[[^\]]+\]\s*/gm, '').replace(/[#*_`•·|]+/g, ' ').toLowerCase().split(/[^\p{L}\p{N}%+$€.,/-]+/u)
  .map((w) => w.replace(/^[-.,/]+|[-.,/]+$/g, '')).filter(Boolean);
function wordMatch(md, text) {
  const want = new Map();
  const a = bag(text);
  for (const w of a) want.set(w, (want.get(w) || 0) + 1);
  const b = bag(md);
  let hit = 0;
  for (const w of b) { const n = want.get(w) || 0; if (n) { hit += 1; want.set(w, n - 1); } }
  return a.length ? Math.round((hit / Math.max(a.length, b.length)) * 1000) / 1000 : 0;
}

const draft = (name) => readJSON(path.join(draftDir(name), 'meta.json'));
const saveDraft = (name, m) => { writeJSON(path.join(draftDir(name), 'meta.json'), m); return m; };
const dropDraft = (name) => fs.rmSync(draftDir(name), { recursive: true, force: true });
function newDraft(name, original, buf) {
  dropDraft(name);
  const ext = path.extname(original).toLowerCase();
  const dir = draftDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `source${ext}`), buf);
  return saveDraft(name, { original, ext, at: new Date().toISOString(), state: 'running', via: null });
}

function metaOf(a, extra = {}) {
  return { version: current(a), author: a.cvAuthor || 'agent', at: a.cvAt || null, original: a.cvFile || null, pdfMine: !!a.cvPdfMine,
    baseVersion: a.baseVersion || 1, coverage: a.cv?.coverage ?? null, must: a.cv?.must ?? null, pages: a.cv?.pages ?? null, change: a.cv?.change ?? null, ...extra };
}
function copySet(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of SET) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
}
// Текущая версия → cv-versions/vNNN/
function archive(name, a) {
  const dir = vDir(name, current(a));
  if (fs.existsSync(path.join(dir, 'meta.json'))) return;
  const m = metaOf(a);
  if (!m.at) { try { m.at = fs.statSync(path.join(store.outDir(name), 'CV.docx')).mtime.toISOString(); } catch {} }
  copySet(store.outDir(name), dir);
  writeJSON(path.join(dir, 'meta.json'), m);
}
function setCurrent(a, patch) {
  Object.assign(a, { cvVersion: current(a) + 1, cvAt: new Date().toISOString(), cvRestoredFrom: null, ...patch });
  store.save();
}

// Черновик → актуальная версия. PDF кандидата — байт в байт; DOCX — байт в байт, его PDF уже отрендерен для проверок
function apply(name, a) {
  const d = draft(name);
  if (!d || d.state !== 'ready') throw Object.assign(new Error('нет готового черновика'), { status: 400 });
  archive(name, a);
  const src = draftDir(name), out = store.outDir(name);
  fs.copyFileSync(path.join(src, 'CV.md'), path.join(out, 'CV.md'));
  fs.copyFileSync(path.join(src, 'CV.docx'), path.join(out, 'CV.docx'));
  const pdf = d.ext === '.pdf' ? path.join(src, `source${d.ext}`) : path.join(src, 'CV.pdf');
  if (fs.existsSync(pdf)) fs.copyFileSync(pdf, path.join(out, 'CV.pdf'));
  setCurrent(a, { cvAuthor: 'me', cvFile: d.original, cvPdfMine: d.ext === '.pdf' });
  dropDraft(name);
  return d;
}

// Откат — новая версия-копия, ничего не удаляется
function restore(name, a, v) {
  const dir = vDir(name, v);
  const m = readJSON(path.join(dir, 'meta.json'));
  if (!m) throw Object.assign(new Error('нет такой версии'), { status: 404 });
  archive(name, a);
  copySet(dir, store.outDir(name));
  setCurrent(a, { cvAuthor: m.author, cvFile: m.original, cvPdfMine: !!m.pdfMine, baseVersion: m.baseVersion, cvRestoredFrom: v });
  return m;
}

function history(name, a) {
  const dir = root(name);
  const old = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^v\d{3}$/.test(f)).map((f) => readJSON(path.join(dir, f, 'meta.json'))).filter(Boolean) : [];
  return [{ ...metaOf(a), current: true, restoredFrom: a.cvRestoredFrom || null }, ...old.filter((x) => x.version !== current(a))].sort((x, y) => y.version - x.version);
}
function versionFile(name, v, file) {
  if (!SET.includes(file) || file === 'CV.md') return null;
  const p = path.join(vDir(name, v), file);
  return fs.existsSync(p) ? p : null;
}

// Повторная адаптация перезаписывает файлы на месте: снимок до запуска, версия — только после успеха, при ошибке файлы возвращаются
function holdForTailor(name, a) {
  const pend = pendingDir(name);
  if (fs.existsSync(path.join(pend, 'meta.json'))) releaseTailor(name, a, true); // прошлый запуск оборвался — снимок не терять
  if (!fs.existsSync(path.join(store.outDir(name), 'CV.md'))) return;
  copySet(store.outDir(name), pend);
  writeJSON(path.join(pend, 'meta.json'), metaOf(a));
}
function releaseTailor(name, a, ok) {
  const pend = pendingDir(name);
  const m = readJSON(path.join(pend, 'meta.json'));
  if (!m) return;
  if (ok) {
    const dir = vDir(name, m.version);
    if (fs.existsSync(dir)) fs.rmSync(pend, { recursive: true, force: true });
    else { fs.mkdirSync(root(name), { recursive: true }); fs.renameSync(pend, dir); }
    setCurrent(a, { cvAuthor: 'agent', cvFile: null, cvPdfMine: false });
    return;
  }
  copySet(pend, store.outDir(name));
  fs.rmSync(pend, { recursive: true, force: true });
}

module.exports = { MIN_MATCH, FOREIGN, draftDir, layout, wordMatch, draft, saveDraft, dropDraft, newDraft, apply, restore, history, versionFile, holdForTailor, releaseTailor, current };
