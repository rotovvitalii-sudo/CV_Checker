// C13: ответы кандидата (тренажёр, «Мои ответы при подаче», форма на сайте, надиктовка «почему мы») → факты для базы кейсов.
// Здесь всё без агента: фильтр, сырой текст в knowledge-base/raw/, близкие карточки для промпта, проверка ответа модели, состояние разбора.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cases = require('./cases');
const { DATA } = require('./store');

const STATE = path.join(DATA, 'answer-facts.json');
const MIN_WORDS = 40;
// Фактические вопросы — их место в «Стандартных ответах» (profile-answers.md), а не в базе кейсов
const FACTUAL_Q = /salary|compensation|\bpay\b|\brate\b|notice|start date|when can you start|availab|visa|sponsor|work (permit|authori)|right to work|authori[sz]ed|relocat|linkedin|portfolio|github|website|phone|e-?mail|address|located|based in|where are you based|time ?zone|зарплат|вилк|срок выхода|виз[ауы]|релокац|переезд/i;
const ORIGINS = { practice: 'тренажёр', submitted: 'мой ответ при подаче', form: 'форма на сайте', whyus: 'почему мы', mycv: 'мои правки адаптированного CV', myletter: 'моё сопроводительное письмо' };

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const norm = (s) => String(s || '').toLowerCase().replace(/[«»"“”'’`]/g, '').replace(/\s+/g, ' ').trim();
const eligible = (question, answer) => words(answer) >= MIN_WORDS && !FACTUAL_Q.test(String(question || ''));
const key = (vacancy, question, answer) => crypto.createHash('sha1').update(`${vacancy}|${norm(question)}|${norm(answer)}`).digest('hex').slice(0, 12);

const readAll = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
function set(k, patch) {
  const all = readAll();
  all[k] = { ...(all[k] || {}), ...patch };
  fs.writeFileSync(STATE, JSON.stringify(all, null, 2));
  return all[k];
}
// Для интерфейса — без текста ответа
function get(k) {
  const r = readAll()[k];
  if (!r) return null;
  const { answer, ...pub } = r;
  return { ...pub, key: k };
}
const record = (k) => readAll()[k] || null;

// Сырой ответ — дословно в knowledge-base/raw/: источник предложений и материал для голосового профиля
function saveRaw({ question, answer, vacancy, origin }) {
  const d = new Date().toISOString().slice(0, 10);
  const mycv = origin === 'mycv', mine = origin === 'myletter';
  const slug = norm(mycv || mine ? vacancy : question).replace(/[^a-z0-9а-я]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'answer';
  const stem = `${d}-${mycv ? 'cv-edit' : mine ? 'letter-mine' : 'answer'}-${slug}`;
  let file = `${stem}.md`;
  for (let i = 2; fs.existsSync(path.join(cases.RAW, file)); i++) file = `${stem}-${i}.md`;
  fs.mkdirSync(cases.RAW, { recursive: true });
  fs.writeFileSync(path.join(cases.RAW, file), `---\ndate: ${d}\ntopic: ответ (${ORIGINS[origin] || origin}) — ${vacancy}\n`
    + `vacancy: vacancies/${vacancy}.md\ntype: ${mycv ? 'cv-edit' : mine ? 'letter' : 'answer'}\norigin: ${origin}\n---\n\nВопрос: ${question}\n\n${answer}\n`);
  return file;
}

// 2–3 карточки, ближе всего к ответу по словам: их текст идёт в промпт, чтобы модель видела, что уже есть в базе
const STOP = new Set('that this with from have were they what when which there their about would your into more also been than then them some just very really because which while where after before over only other these those такой этот было были чтобы когда который которые потому также очень там здесь если меня мной было этом'.split(' '));
const tokens = (s) => new Set(norm(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
function closest(question, answer, n = 3) {
  const want = tokens(`${question} ${answer}`);
  return cases.list().map((c) => {
    let text = '';
    try { text = fs.readFileSync(path.join(cases.CARDS, `${c.id}.md`), 'utf8'); } catch {}
    // Совпадения делим на корень из размера карточки (иначе выигрывают самые длинные), слова из id карточки весят втрое
    const own = tokens(text);
    let hit = 0;
    for (const w of own) if (want.has(w)) hit += 1;
    let idHit = 0;
    for (const w of tokens(c.id.replace(/-/g, ' '))) if (want.has(w)) idHit += 1;
    return { id: c.id, text, score: hit / Math.sqrt(own.size || 1) + idHit };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, n).map(({ id, text }) => ({ id, text: text.slice(0, 5000) }));
}

// Цитата — дословно из ответа (части через «…» ищутся по отдельности), каждое число факта — в цитате, карточка существует
const nums = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));
function check(r, answer) {
  const a = norm(answer);
  const dropped = [];
  const facts = [];
  for (const f of Array.isArray(r?.facts) ? r.facts.slice(0, 8) : []) {
    const fact = String(f?.fact || '').trim();
    const quote = String(f?.quote || '').trim();
    if (!fact) continue;
    const parts = quote.split(/\s*(?:…|\.\.\.)\s*/).map(norm).filter(Boolean);
    if (!parts.length || !parts.every((p) => a.includes(p))) { dropped.push(`нет дословной цитаты: ${fact}`); continue; }
    const qn = new Set(nums(quote));
    if (nums(fact).some((x) => !qn.has(x))) { dropped.push(`число не из цитаты: ${fact}`); continue; }
    const card = f.card ? String(f.card).replace(/\.md$/, '').split('/').pop() : null;
    facts.push({ fact: fact.slice(0, 300), quote: quote.slice(0, 400), card: card && cases.exists(card) ? card : null,
      conflict: f.conflict && card && cases.exists(card) ? String(f.conflict).slice(0, 200) : null });
  }
  const s = r?.story;
  const dup = s?.card ? String(s.card).replace(/\.md$/, '').split('/').pop() : null;
  const story = s && (s.is_new || dup) ? { is_new: !!s.is_new, title: String(s.title || '').slice(0, 120), why: String(s.why || '').slice(0, 200),
    card: dup && cases.exists(dup) ? dup : null } : null;
  return { facts, story, dropped };
}

module.exports = { eligible, key, set, get, record, saveRaw, closest, check, words, ORIGINS, MIN_WORDS, FACTUAL_Q };
