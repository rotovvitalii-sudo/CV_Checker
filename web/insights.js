// C12 · база инсайтов (docs/specs/34-insights-base.md).
// Инсайт — взгляд кандидата на профессию (после видео, конференции, книги), а не его опыт.
// knowledge-base/insights/<id>.md (front matter: значения — JSON, это валидный YAML) + INDEX.md;
// сырая надиктовка как есть — knowledge-base/raw/insights/<id>.md.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'knowledge-base', 'insights');
const RAW = path.join(ROOT, 'knowledge-base', 'raw', 'insights');
const SOURCE_TYPES = { video: 'видео', conference: 'конференция', book: 'книга', podcast: 'подкаст', article: 'статья', talk: 'разговор', own: 'своё наблюдение' };
const FIELDS = ['title', 'source', 'tags', 'created', 'updated', 'used_in', 'looks_like_case'];

const idOk = (id) => /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{2,60}$/.test(String(id || ''));
const file = (id) => path.join(DIR, `${id}.md`);
const today = () => new Date().toISOString().slice(0, 10);
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'insight';

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    try { fm[line.slice(0, i).trim()] = JSON.parse(line.slice(i + 1).trim()); } catch { fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  const body = m ? m[2] : text;
  const sec = (re) => { const s = body.split(/^## /m).find((x) => re.test(x.split('\n')[0])); return s ? s.split('\n').slice(1).join('\n').trim() : ''; };
  return { fm, essence: sec(/^Суть/), en: sec(/^For interviews/), body };
}

function read(id) {
  if (!idOk(id) || !fs.existsSync(file(id))) return null;
  const { fm, essence, en } = parse(fs.readFileSync(file(id), 'utf8'));
  return { id, ...Object.fromEntries(FIELDS.map((k) => [k, fm[k]])), tags: fm.tags || [], used_in: fm.used_in || [], source: fm.source || {},
    essence, en, raw: fs.existsSync(path.join(RAW, `${id}.md`)) ? `raw/insights/${id}.md` : null };
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').map((f) => read(f.slice(0, -3))).filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)) || b.id.localeCompare(a.id));
}

const allTags = () => [...new Set(list().flatMap((i) => i.tags))].sort();

function write(ins) {
  fs.mkdirSync(DIR, { recursive: true });
  const fm = FIELDS.filter((k) => ins[k] !== undefined).map((k) => `${k}: ${JSON.stringify(ins[k])}`).join('\n');
  fs.writeFileSync(file(ins.id), `---\n${fm}\n---\n\n## Суть\n\n${ins.essence.trim()}\n\n## For interviews (EN)\n\n${(ins.en || '').trim()}\n\n`
    + `## Исходная надиктовка\n\n${ins.raw ? `\`knowledge-base/${ins.raw}\`` : '—'}\n`);
  writeIndex();
}

function writeIndex() {
  const rows = list().map((i) => `| [${i.id}](${i.id}.md) | ${String(i.title).replace(/\|/g, '/')} | ${SOURCE_TYPES[i.source.type] || i.source.type || ''}: ${String(i.source.title || '').replace(/\|/g, '/')} | ${i.tags.join(', ')} | ${i.created} |`);
  fs.writeFileSync(path.join(DIR, 'INDEX.md'), `# Реестр инсайтов\n\nВзгляды и знания кандидата о профессии — не опыт. В CV как достижения не идут.\n\n`
    + `| id | Заголовок | Источник | Теги | Дата |\n|---|---|---|---|---|\n${rows.join('\n')}\n`);
}

function cleanSource(s) {
  const type = SOURCE_TYPES[s?.type] ? s.type : 'own';
  const url = /^https?:\/\//.test(String(s?.url || '')) ? String(s.url).trim() : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(s?.date || '')) ? s.date : today();
  return { type, title: String(s?.title || '').trim().slice(0, 200), url, date };
}
const cleanTags = (t) => [...new Set((Array.isArray(t) ? t : String(t || '').split(',')).map((x) => slugify(x)).filter((x) => x && x !== 'insight'))].slice(0, 8);

// Новый инсайт: сырая надиктовка — как есть, отдельно; карточка — то, что кандидат подтвердил после разбора
function create({ raw, source, title, essence, en, tags, slug, looks_like_case }) {
  if (!String(essence || raw || '').trim()) throw new Error('пустой инсайт');
  const src = cleanSource(source);
  let id = `${src.date}-${slugify(slug || title)}`;
  for (let n = 2; fs.existsSync(file(id)); n += 1) id = `${src.date}-${slugify(slug || title)}-${n}`;
  fs.mkdirSync(RAW, { recursive: true });
  if (String(raw || '').trim()) {
    fs.writeFileSync(path.join(RAW, `${id}.md`), `---\ntype: insight\nsource: ${JSON.stringify(src)}\ndate: ${today()}\n---\n\n${String(raw).trim()}\n`);
  }
  const ins = { id, title: String(title || '').trim() || 'Инсайт', source: src, tags: cleanTags(tags), created: today(), used_in: [],
    looks_like_case: !!looks_like_case, essence: String(essence || raw).trim(), en: String(en || '').trim(),
    raw: String(raw || '').trim() ? `raw/insights/${id}.md` : null };
  write(ins);
  return read(id);
}

function update(id, patch) {
  const cur = read(id);
  if (!cur) throw new Error('инсайт не найден');
  const next = { ...cur, updated: today() };
  if (patch.title !== undefined) next.title = String(patch.title).trim() || cur.title;
  if (patch.essence !== undefined) next.essence = String(patch.essence).trim() || cur.essence;
  if (patch.en !== undefined) next.en = String(patch.en).trim();
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.source !== undefined) next.source = cleanSource({ ...cur.source, ...patch.source });
  write(next);
  return read(id);
}

// Удаляется карточка; сырая надиктовка остаётся в raw/ (как и у кейсов — исходник не теряем)
function remove(id) {
  if (!read(id)) throw new Error('инсайт не найден');
  fs.rmSync(file(id));
  writeIndex();
}

function markUsed(ids, vacancy, where) {
  for (const id of new Set(ids || [])) {
    const cur = read(id);
    if (!cur) continue;
    if (cur.used_in.some((u) => u.vacancy === vacancy && u.where === where)) continue;
    write({ ...cur, used_in: [...cur.used_in, { vacancy, where, at: today() }] });
  }
}

// ---------- подбор под вакансию / тему: без агента ----------
// Общие слова продуктовых вакансий не считаются — иначе любой инсайт «подходит» любой роли
const STOP = new Set(('with that this from have will your about what when they their them into more than also been were which would there these those other some such only '
  + 'product products manager management team teams user users customer customers data metric metrics growth experience business strategy strategic work working '
  + 'company role roles build building drive driving lead leading ownership own owner skills years across cross functional stakeholders '
  + 'action actions find back week weeks first feature features people time make made need needs help support process new using based '
  + 'для что как это или при без над под так его она они чтобы если когда только также более через надо нужно продукт команда пользователь метрики рост').split(' '));
const words = (t) => new Set((String(t || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 7)));

// Тег инсайта совпал, если все его значимые части есть в тегах или словах вакансии (user-activation → «activation»).
// Слова совпавших тегов второй раз не считаются. Нужно: 2 тега, или тег + 2 значимых слова, или 5 слов (loose — для темы W8,
// где текста почти нет: хватает одного тега или 3 слов). До limit лучших.
function rank({ text, tags = [] }, limit = 5, { loose = false } = {}) {
  const W = words(`${text} ${tags.join(' ').replace(/-/g, ' ')}`);
  return list().map((i) => {
    const hitTags = i.tags.filter((t) => { const parts = [...words(t.replace(/-/g, ' '))]; return parts.length && parts.every((w) => W.has(w)); });
    const tagWords = words(hitTags.join(' ').replace(/-/g, ' '));
    const wordHit = [...words(`${i.title} ${i.essence} ${i.en}`)].filter((w) => W.has(w) && !tagWords.has(w)).length;
    return { i, tagHit: hitTags.length, wordHit, score: hitTags.length * 3 + wordHit };
  }).filter((x) => (loose ? x.tagHit >= 1 || x.wordHit >= 3 : x.tagHit >= 2 || (x.tagHit >= 1 && x.wordHit >= 2) || x.wordHit >= 5))
    .sort((a, b) => b.score - a.score).slice(0, limit).map((x) => ({ ...x.i, score: x.score }));
}

// Блок для промпта: только суть и формулировка, без надиктовки
const promptBlock = (list) => list.map((i) => `- [insight:${i.id}] ${i.title} (${SOURCE_TYPES[i.source.type] || ''}${i.source.title ? `: ${i.source.title}` : ''})\n  Суть: ${i.essence.replace(/\n+/g, ' ')}${i.en ? `\n  EN: ${i.en.replace(/\n+/g, ' ')}` : ''}`).join('\n');

module.exports = { DIR, RAW, SOURCE_TYPES, idOk, list, read, allTags, create, update, remove, markUsed, rank, promptBlock, cleanSource };
