// База кейсов (C9, docs/specs/20-case-base.md): карточки knowledge-base/cards/, надиктовки писем,
// черновики новых кейсов (раунды агента case-interview), предложения фактов из надиктовок, сводка пробелов.
// Карточки пишет только агент по скилу case-interview; без агента сервер лишь дописывает подтверждённый
// факт в раздел «Дополнения из надиктовок».
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { marked } = require('marked');
const { ROOT } = require('./agent');
const { DATA } = require('./store');

const KB = path.join(ROOT, 'knowledge-base');
const CARDS = path.join(KB, 'cards');
const RAW = path.join(KB, 'raw');
const DRAFTS = path.join(DATA, 'case-drafts');
const SUGGESTIONS = path.join(DATA, 'case-suggestions.json');
const NEW_DRAFT = path.join(DRAFTS, '_new.txt');
const ADDITIONS = '## Дополнения из надиктовок';

const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const today = () => new Date().toISOString().slice(0, 10);
const safeId = (id) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(id || ''))) throw new Error('bad name');
  return id;
};

// Простой фронтматтер карточки: «key: value», списки «[a, b]» и «- item»
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = {};
  if (!m) return { fm, body: md };
  let key = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) { (fm[key] = Array.isArray(fm[key]) ? fm[key] : []).push(item[1].trim()); continue; }
    const kv = line.match(/^([\w-]+):\s*(.*?)(\s+#.*)?$/);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    fm[key] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean) : v;
  }
  return { fm, body: md.slice(m[0].length) };
}

function indexIds() {
  const p = path.join(CARDS, 'INDEX.md');
  if (!fs.existsSync(p)) return new Set();
  return new Set([...fs.readFileSync(p, 'utf8').matchAll(/\|\s*\[([\w-]+)\]\(/g)].map((m) => m[1]));
}

function list() {
  const inIndex = indexIds();
  const cards = fs.readdirSync(CARDS).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').map((f) => {
    const id = f.slice(0, -3);
    const { fm, body } = frontmatter(fs.readFileSync(path.join(CARDS, f), 'utf8'));
    return {
      id, company: fm.company || '', role: fm.role || '', period: fm.period || '', status: fm.status || '',
      roleFit: Array.isArray(fm.role_fit) ? fm.role_fit : [], updated: fm.updated || '', type: fm.type || '',
      product: fm.product || '', inIndex: inIndex.has(id),
      gaps: (body.match(/\[НЕТ ДАННЫХ\]/g) || []).length,
      additions: body.includes(ADDITIONS) ? (body.split(ADDITIONS)[1].split(/\n## /)[0].match(/^- /gm) || []).length : 0,
    };
  });
  return cards.sort((a, b) => a.company.localeCompare(b.company) || a.id.localeCompare(b.id));
}

const cardPath = (id) => path.join(CARDS, `${safeId(id)}.md`);
const exists = (id) => { try { return fs.existsSync(cardPath(id)); } catch { return false; } };

function card(id) {
  const p = cardPath(id);
  if (!fs.existsSync(p)) return null;
  const md = fs.readFileSync(p, 'utf8');
  const { fm, body } = frontmatter(md);
  const sources = (Array.isArray(fm.sources) ? fm.sources : []).map((s) => {
    const file = path.basename(s);
    return { file, exists: fs.existsSync(path.join(RAW, file)) };
  });
  return { id, fm, html: marked.parse(body), sources };
}

function rawText(file) {
  if (!/^[\w.-]+\.md$/.test(file)) throw new Error('bad name');
  const p = path.join(RAW, file);
  if (!fs.existsSync(p)) return null;
  const { fm, body } = frontmatter(fs.readFileSync(p, 'utf8'));
  return { file, fm, text: body.trim() };
}

// Надиктовки сопроводительных писем: образец голоса для C8 и источник новых фактов
function letters() {
  if (!fs.existsSync(RAW)) return [];
  return fs.readdirSync(RAW).filter((f) => /letter/i.test(f) && f.endsWith('.md')).map((f) => {
    const { fm, body } = frontmatter(fs.readFileSync(path.join(RAW, f), 'utf8'));
    const vac = String(fm.vacancy || '').replace(/^vacancies\//, '').replace(/\.md$/, '');
    return {
      file: f, date: fm.date || f.slice(0, 10), topic: fm.topic || '',
      vacancy: vac && fs.existsSync(path.join(ROOT, 'vacancies', `${vac}.md`)) ? vac : '',
      words: body.trim().split(/\s+/).filter(Boolean).length,
    };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
}

// ---------- черновики новых кейсов ----------

function newDictation() { try { return fs.readFileSync(NEW_DRAFT, 'utf8'); } catch { return ''; } }
function setNewDictation(text) {
  fs.mkdirSync(DRAFTS, { recursive: true });
  fs.writeFileSync(NEW_DRAFT, String(text || '').slice(0, 30000));
}

const draftDir = (id) => path.join(DRAFTS, safeId(id));

function createDraft({ dictation, target }) {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = draftDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dictation.txt'), dictation);
  const meta = { id, created: Date.now(), state: 'round1', target: target || null, answers: {} };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function saveMeta(meta) {
  fs.writeFileSync(path.join(draftDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

function draft(id) {
  const dir = draftDir(id);
  const meta = readJSON(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  const q = readJSON(path.join(dir, 'questions.json'), null);
  const draftMd = fs.existsSync(path.join(dir, 'draft.md')) ? fs.readFileSync(path.join(dir, 'draft.md'), 'utf8') : '';
  const result = readJSON(path.join(dir, 'result.json'), null);
  let dictation = '';
  try { dictation = fs.readFileSync(path.join(dir, 'dictation.txt'), 'utf8'); } catch {}
  return { ...meta, dictation, questions: q?.questions || [], duplicateOf: q?.duplicate_of || null, summary: q?.summary || '',
    rawFile: q?.raw_file || '', draftHtml: draftMd ? marked.parse(draftMd.replace(/^---\n[\s\S]*?\n---\n/, '')) : '', result };
}

function drafts() {
  if (!fs.existsSync(DRAFTS)) return [];
  return fs.readdirSync(DRAFTS).filter((d) => !d.startsWith('_') && fs.statSync(path.join(DRAFTS, d)).isDirectory())
    .map((d) => readJSON(path.join(DRAFTS, d, 'meta.json'), null)).filter(Boolean)
    .filter((m) => m.state !== 'done' && m.state !== 'cancelled')
    .sort((a, b) => b.created - a.created);
}

// ---------- предложения фактов из надиктовок ----------

function suggestions() { return readJSON(SUGGESTIONS, []); }
function saveSuggestions(list) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SUGGESTIONS, JSON.stringify(list, null, 2));
}

const factKey = (s) => String(s || '').toLowerCase().replace(/[^a-zа-я0-9]+/g, ' ').trim();

// Новые предложения без дублей (по тексту факта и источнику); card — существующая карточка или null
function addSuggestions(items, origin) {
  const list = suggestions();
  const seen = new Set(list.map((s) => `${factKey(s.fact)}|${s.source}`));
  let added = 0;
  for (const it of items || []) {
    const fact = String(it.fact || '').trim().slice(0, 300);
    if (!fact) continue;
    const source = path.basename(String(it.source || ''));
    const key = `${factKey(fact)}|${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cardId = it.card && exists(String(it.card).replace(/\.md$/, '').split('/').pop()) ? String(it.card).replace(/\.md$/, '').split('/').pop() : null;
    list.push({ id: crypto.randomUUID().slice(0, 8), fact, quote: String(it.quote || '').trim().slice(0, 400), card: cardId,
      source, origin, vacancy: it.vacancy || '', state: 'new', at: new Date().toISOString() });
    added += 1;
  }
  if (added) saveSuggestions(list);
  return added;
}

// «Добавить в карточку»: факт → раздел «Дополнения из надиктовок», надиктовка → sources, updated
function acceptSuggestion(id, cardId) {
  const list = suggestions();
  const s = list.find((x) => x.id === id);
  if (!s || s.state !== 'new') throw new Error('предложение уже разобрано');
  const target = cardId || s.card;
  if (!target || !exists(target)) throw new Error('выбери карточку');
  const p = cardPath(target);
  let md = fs.readFileSync(p, 'utf8');
  const line = `- ${s.fact}${s.source ? ` — источник: raw/${s.source}` : ''} (добавлено ${today()})`;
  if (md.includes(ADDITIONS)) {
    const [head, tail] = md.split(ADDITIONS);
    const next = tail.search(/\n## /);
    md = next === -1 ? `${md.trimEnd()}\n${line}\n` : `${head}${ADDITIONS}${tail.slice(0, next).trimEnd()}\n${line}\n${tail.slice(next)}`;
  } else {
    const block = `${ADDITIONS}\nФакты из надиктовок писем, подтверждённые кандидатом в приложении (C9).\n\n${line}\n\n`;
    const gaps = md.search(/^## Пробелы/m);
    md = gaps === -1 ? `${md.trimEnd()}\n\n${block}` : `${md.slice(0, gaps)}${block}${md.slice(gaps)}`;
  }
  // фронтматтер: источник и дата обновления
  md = md.replace(/^(---\n[\s\S]*?)\nupdated:.*$/m, `$1\nupdated: ${today()}`);
  const fmBlock = (md.match(/^---\n[\s\S]*?\n---\n/) || [''])[0];
  if (s.source && !fmBlock.includes(`raw/${s.source}`)) {
    md = md.replace(/^(sources:\n(?:[ \t]+-.*\n)*)/m, `$1  - raw/${s.source}\n`);
  }
  fs.writeFileSync(p, md);
  s.state = 'added';
  s.card = target;
  s.decided = new Date().toISOString();
  saveSuggestions(list);
  return s;
}

function rejectSuggestion(id) {
  const list = suggestions();
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error('нет предложения');
  s.state = 'rejected';
  s.decided = new Date().toISOString();
  saveSuggestions(list);
  return s;
}

module.exports = {
  list, card, rawText, letters, exists, frontmatter,
  newDictation, setNewDictation, createDraft, draft, drafts, saveMeta, draftDir,
  suggestions, addSuggestions, acceptSuggestion, rejectSuggestion, KB, CARDS, RAW, DRAFTS,
};
