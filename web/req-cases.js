// C20: требование → кейс (docs/specs/45-requirement-cases.md). Здесь всё без агента: строки требований из текста вакансии,
// хранение кейсов по вакансии (output/<…>/11-req-cases.json), общая библиотека (knowledge-base/req-cases.json),
// проверка ответов модели (матч и «Предложить кейс»), поиск «уже писал похожее».
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cases = require('./cases');

const FILE = '11-req-cases.json';
const LIBRARY = path.join(cases.KB, 'req-cases.json');
const READY = 70; // «готово» — матч не ниже
const BUCKETS = ['minimum', 'desired', 'wishlist', 'other'];
const PARTS = { relevance: 40, evidence: 25, ownership: 20, scale: 15 };

const newId = () => crypto.randomUUID().slice(0, 8);
const clip = (s, n) => String(s || '').trim().slice(0, n);
const norm = (s) => String(s || '').toLowerCase().replace(/[«»"“”'’`]/g, '').replace(/\s+/g, ' ').trim();
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const file = (dir) => path.join(dir, FILE);
const read = (dir) => readJSON(file(dir), null);
function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir), `${JSON.stringify(data, null, 2)}\n`);
}

// ---------- строки требований ----------
// Заголовки разделов «что ждут» (EN / RU / PL / DE); «будет плюсом» — желательно
const REQ_HEAD = /(requirements?|qualifications?|what you('|’)?ll (need|bring)|what (you|we)('|’)?re looking for|what we('|’)?re looking for|what we look for|you (have|bring|are|might be)|about you|who you are|your profile|your (skills|experience)|must[- ]haves?|skills|experience|требовани|ожидаем|мы ждём|мы ждем|что нужно|о тебе|о вас|wymagania|oczekujemy|czego oczekujemy|twój profil|anforderungen|dein profil|ihr profil|was du mitbringst)/i;
const NICE_HEAD = /(nice[- ]to[- ]have|bonus|plus|preferred|would be (great|a plus)|it('|’)?s a plus|будет плюсом|плюсом|желательно|mile widziane|dodatkowym atutem|wünschenswert|von vorteil)/i;
const BULLET = /^\s*(?:[-*•·▪◦–—]|\d+[.)])\s+(.+)$/;

// Текст вакансии без нашего разбора сверху: только раздел «Текст вакансии», если он есть
function vacancyBody(md) {
  const raw = String(md || '');
  const at = raw.search(/^## Текст вакансии/m);
  return at >= 0 ? raw.slice(at).replace(/^## Текст вакансии.*$/m, '') : raw.replace(/^---\n[\s\S]*?\n---\n/, '');
}

// Пункты списков под заголовками требований. Заголовок — короткая строка без маркера списка (≤ 80 символов)
function extractLines(md) {
  const out = [];
  let mode = null; // null — не в разделе требований; 'req' / 'nice'
  for (const line of vacancyBody(md).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const b = t.match(BULLET);
    if (b) {
      if (mode) {
        const req = b[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
        if (req.length >= 6) out.push({ req: req.slice(0, 400), head: mode });
      }
      continue;
    }
    const plain = t.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    if (plain.length <= 80) {
      // «Требования: …» в одной строке с текстом — это не заголовок списка
      mode = NICE_HEAD.test(plain) ? 'nice' : REQ_HEAD.test(plain) ? 'req' : null;
    } else if (!/:\s*$/.test(plain)) {
      mode = null;
    }
  }
  return dedupe(out.length >= 2 ? out : extractFlat(md));
}
// Повторы (та же строка в двух разделах) — один раз
function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => { const k = norm(x.req); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}

// Текст со страниц карьеры часто приходит одной строкой: пункты через « - », заголовки внутри текста.
// Ищем начало раздела требований, режем до бенефитов / «о компании» и делим на пункты или предложения
const FLAT_START = /(what you('|’)?ll (need|bring)|what (we('|’)?re|we are) looking for|what we look for|who you are|about you|your profile|you (will )?(have|bring)\b|must[- ]have[^:]{0,30}:|requirements?\s*:|qualifications?\s*:|требования\s*:|wymagania\s*:|anforderungen\s*:)/i;
const FLAT_STOP = /(why join|why you('|’)?ll love|what we offer|we offer|our benefits|benefits\s*:|perks|compensation|salary range|about us\b|about the company|equal opportunit|how to apply|мы предлагаем|условия\s*:|oferujemy|wir bieten)/i;
function extractFlat(md) {
  const t = vacancyBody(md).replace(/\s+/g, ' ');
  const m = t.match(FLAT_START);
  if (!m) return [];
  let seg = t.slice(m.index + m[0].length);
  const stop = seg.search(FLAT_STOP);
  if (stop > 0) seg = seg.slice(0, stop);
  seg = seg.slice(0, 5000);
  const pieces = / [-•·▪] /.test(seg) ? seg.split(/ [-•·▪] /) : seg.split(/(?<=[.;])\s+(?=[A-ZА-ЯЁŁŚŻ])/);
  const out = [];
  let mode = NICE_HEAD.test(m[0]) ? 'nice' : 'req';
  for (let p of pieces) {
    p = p.trim();
    // «Strong signals we look for: …» / «Nice to have: …» — подзаголовок в начале куска меняет корзину
    const head = p.match(/^([^:.]{2,60}):\s*(.*)$/);
    // Обычный пункт с двоеточием («Confidence with data: …») — не заголовок, остаётся целиком
    if (head && (NICE_HEAD.test(head[1]) || /signals|bonus/i.test(head[1]))) { mode = 'nice'; p = head[2].trim(); }
    else if (head && (REQ_HEAD.test(head[1]) || /must/i.test(head[1])) && !head[2].trim().match(/^[a-z]/)) { mode = 'req'; p = head[2].trim(); }
    // Хвост куска с заголовком следующего раздела («… processes. Strong signals we look for:»)
    const tail = p.match(/^(.*[.!?])\s+([^.]{2,60}):\s*$/);
    let next = mode;
    if (tail) {
      p = tail[1];
      if (NICE_HEAD.test(tail[2]) || /signals|bonus|plus/i.test(tail[2])) next = 'nice';
    }
    p = p.replace(/:\s*$/, '').trim();
    if (p.length >= 15 && p.length <= 400) out.push({ req: p, head: mode });
    mode = next;
  }
  return out;
}

// Корзина строки: ключ корзины фита (kw — «a|b|c») встречается в строке; иначе по заголовку раздела
function kwHit(kw, text) {
  const t = norm(text);
  return String(kw || '').split('|').map((x) => norm(x)).filter((x) => x.length >= 2).some((x) => t.includes(x));
}
// Раздел «будет плюсом» в тексте главнее фита: такая строка — желательно или вишлист, но не минимум
function bucketOf(line, buckets) {
  const fromFit = ['minimum', 'desired', 'wishlist'].find((b) => (buckets?.[b] || []).some((x) => kwHit(x.kw, line.req) || norm(x.req) === norm(line.req)));
  if (line.head === 'nice') return fromFit === 'wishlist' ? 'wishlist' : 'desired';
  return fromFit || 'minimum';
}

// Начальный список: дословные строки вакансии; нет списков — корзины фита (минимум → желательно → вишлист)
function initial(md, fit) {
  const buckets = fit?.buckets || null;
  const lines = extractLines(md);
  let items;
  let source;
  if (lines.length >= 2) {
    source = 'text';
    items = lines.map((l) => ({ req: l.req, bucket: bucketOf(l, buckets) }));
  } else if (buckets) {
    source = 'buckets';
    items = ['minimum', 'desired', 'wishlist'].flatMap((b) => (buckets[b] || []).map((x) => ({ req: clip(x.req, 400), bucket: b })));
  } else {
    source = 'empty';
    items = [];
  }
  // Минимум первым, вишлист в конце
  const order = { minimum: 0, desired: 1, other: 2, wishlist: 3 };
  items.sort((a, b) => order[a.bucket] - order[b.bucket]);
  return { at: new Date().toISOString(), source, items: items.map((x) => newItem(x)) };
}

function newItem({ req, bucket = 'other', manual = false }) {
  return { id: newId(), req: clip(req, 400), bucket: BUCKETS.includes(bucket) ? bucket : 'other', manual, edited: false, hidden: false,
    text: '', card: null, attempts: [], match: null, suggest: null, saved: null, factsKey: null };
}

// Последняя оценка; «требование изменилось» / «текст изменился» — если оценивали другое
function lastScore(it) {
  const a = it.attempts[it.attempts.length - 1];
  if (!a) return null;
  return { ...a, stale: norm(a.text) !== norm(it.text) ? 'text' : norm(a.req) !== norm(it.req) ? 'req' : null };
}

// ---------- проверка ответов модели ----------
const num = (x, max) => Math.max(0, Math.min(max, Math.round(Number(x) || 0)));
function checkMatch(r) {
  const p = r?.parts || {};
  const parts = Object.fromEntries(Object.entries(PARTS).map(([k, max]) => [k, num(p[k], max)]));
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => clip(x, 240)).filter(Boolean).slice(0, 5);
  return { score: Object.values(parts).reduce((s, x) => s + x, 0), parts, hit: list(r?.hit), missing: list(r?.missing),
    gap: parts.relevance < 15, verdict: clip(r?.verdict, 300) };
}

// Числа черновика должны быть в тексте карточки (как в C13: «12%» ≠ «15%»)
const nums = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));
function cardText(id) { try { return fs.readFileSync(path.join(cases.CARDS, `${id}.md`), 'utf8'); } catch { return ''; } }
function checkSuggest(r) {
  const options = [];
  const dropped = [];
  for (const o of Array.isArray(r?.options) ? r.options.slice(0, 2) : []) {
    const card = String(o?.card || '').replace(/\.md$/, '').split('/').pop();
    if (!card || !cases.exists(card)) { dropped.push(`нет такой карточки: ${card || '—'}`); continue; }
    let draft = clip(o.draft, 1500);
    let draftNote = '';
    if (draft) {
      const have = new Set(nums(cardText(card)));
      const bad = [...new Set(nums(draft).filter((x) => !have.has(x)))];
      if (bad.length) { draftNote = `черновик убран: чисел ${bad.join(', ')} нет в карточке`; draft = ''; }
    }
    options.push({ card, why: clip(o.why, 400), covers: clip(o.covers, 400), not_covers: clip(o.not_covers, 400), draft, draftNote });
  }
  return { options, none: !options.length, hint: clip(r?.hint, 300), dropped, at: new Date().toISOString() };
}

// ---------- библиотека (общая, knowledge-base/req-cases.json) ----------
const library = () => readJSON(LIBRARY, []);
function saveLibrary(list) {
  fs.mkdirSync(path.dirname(LIBRARY), { recursive: true });
  fs.writeFileSync(LIBRARY, `${JSON.stringify(list, null, 2)}\n`);
}
// Одна запись на строку вакансии: повторное сохранение обновляет её
function toLibrary(vacancy, it) {
  const list = library();
  const last = lastScore(it);
  const rec = { id: `${vacancy}#${it.id}`, req: it.req, bucket: it.bucket, text: it.text.trim(), score: last && !last.stale ? last.score : null,
    card: it.card || null, vacancy, at: new Date().toISOString() };
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec);
  saveLibrary(list);
  return rec;
}
function removeFromLibrary(id) {
  const list = library();
  const next = list.filter((x) => x.id !== id);
  if (next.length !== list.length) saveLibrary(next);
  return list.length - next.length;
}

// «Уже писал похожее»: записи других вакансий, где слова требования совпадают (доля от меньшего набора)
const STOP = new Set('with have that this from will your their they into more than other able ability strong experience опыт опыта умение знание'.split(' '));
const tokens = (s) => new Set(norm(s).split(/[^a-zа-яё0-9+#]+/).filter((w) => (w.length >= 3 || /^[a-z]{2}$/.test(w)) && !STOP.has(w)));
function similar(req, vacancy, lib = library(), n = 2) {
  const want = stems(req);
  if (!want.size) return [];
  return lib.filter((x) => x.vacancy !== vacancy && x.text).map((x) => {
    const own = stems(x.req);
    let hit = 0;
    for (const w of own) if (want.has(w)) hit += 1;
    return { ...x, sim: hit / Math.max(1, Math.min(own.size, want.size)), hit };
  }).filter((x) => x.sim >= 0.3 && (x.hit >= 2 || x.sim >= 0.5)).sort((a, b) => b.sim - a.sim || (b.score || 0) - (a.score || 0)).slice(0, n)
    .map(({ id, req, text, score, card, vacancy, sim }) => ({ id, req, text, score, card, vacancy, sim: Math.round(sim * 100) / 100 }));
}

// Вид для интерфейса: оценка, «готово», подсказки из библиотеки
function view(dir, vacancy) {
  const data = read(dir);
  if (!data) return null;
  const lib = library();
  const items = data.items.map((it) => {
    const last = lastScore(it);
    return { ...it, last, ready: !!(last && !last.stale && last.score >= READY), similar: it.text.trim() ? [] : similar(it.req, vacancy, lib) };
  });
  const shown = items.filter((x) => !x.hidden);
  const counted = shown.filter((x) => x.bucket !== 'wishlist');
  return { at: data.at, source: data.source, items, ready: counted.filter((x) => x.ready).length, total: counted.length, threshold: READY };
}

// ---------- карточки под требование ----------
// Требование обычно по-английски, карточка — по-русски с полем keywords_en. Сравниваем по основам слов (первые 6 букв),
// «A/B» → «abtest»; ключи, роли и id карточки весят втрое, тело — с поправкой на длину
const stem = (w) => w.slice(0, 6);
const STOP_EN = new Set('and the for with you your our will are have has who what that this from into able ability using use experience strong including such other more than within across product products build building built hands work worked company team years year'.split(' '));
function stems(s) {
  const t = String(s || '').toLowerCase().replace(/a\/b/g, ' abtest ').replace(/[«»"“”'’`]/g, '');
  return new Set(t.split(/[^a-zа-яё0-9]+/).filter((w) => w.length >= 3 && !STOP_EN.has(w)).map(stem));
}
function rankCards(req, extra = '', n = 5) {
  const want = stems(`${req} ${extra}`);
  return cases.list().map((c) => {
    const text = cardText(c.id);
    const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    const head = stems(`${c.id.replace(/-/g, ' ')} ${(fm.match(/^(keywords_en|role_fit|product):.*$/gm) || []).join(' ')}`);
    const body = stems(text);
    let h = 0, b = 0;
    for (const w of want) { if (head.has(w)) h += 1; if (body.has(w)) b += 1; }
    return { id: c.id, text, score: h * 3 + b / Math.sqrt(Math.max(1, body.size / 100)) };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, n).map(({ id, text, score }) => ({ id, text: text.slice(0, 4000), score: Math.round(score * 10) / 10 }));
}

module.exports = { FILE, LIBRARY, READY, BUCKETS, PARTS, read, save, initial, newItem, extractLines, vacancyBody, lastScore,
  checkMatch, checkSuggest, rankCards, library, toLibrary, removeFromLibrary, similar, view, words, clip };
