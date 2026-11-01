// W9 · разбор компании (docs/specs/35-company-research.md).
// Сам разбор — общий на компанию: knowledge-base/companies/<slug>.json (агент, скил company-research), срок — profile.json →
// company_research_days (30). «Что сказать» под опыт кандидата — на вакансию: output/<…>/09-company.json (один ход Haiku).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'knowledge-base', 'companies');
const DAYS = 30;
const SAY_FILE = '09-company.json';

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,59}$/.test(String(s || ''));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\.(com|io|ai|co|vc|org|net|app|dev)\b/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'company';
const file = (slug) => path.join(DIR, `${slug}.json`);

function validDays() {
  const n = Number(readJSON(path.join(ROOT, 'knowledge-base', 'profile.json'), {}).company_research_days);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : DAYS;
}

// Домен — из ссылки вакансии, если это сайт самой компании (не доска вакансий)
const BOARDS = /(linkedin|greenhouse|lever|ashbyhq|workable|smartrecruiters|recruitee|personio|himalayas|remoteok|remotive|dou\.ua|djinni|pracuj|indeed|glassdoor|wellfound|angel\.co|workday|bamboohr|teamtailor|jobs\.|careers\.)/i;
function domainFrom(url) {
  try { const h = new URL(url).hostname.replace(/^www\./, ''); return BOARDS.test(h) ? '' : h; } catch { return ''; }
}

function read(slug) {
  if (!slugOk(slug)) return null;
  const r = readJSON(file(slug));
  if (!r) return null;
  const ageDays = Math.floor((Date.now() - Date.parse(r.checked || r.at || 0)) / 864e5);
  return { ...r, ageDays, fresh: ageDays <= validDays(), validDays: validDays() };
}

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
const STRENGTH = { high: 3, medium: 2, low: 1 };

// Чистка ответа агента: цитаты ≤ 15 слов, 4–7 ценностей (сильные первыми), отзывы в ценности не идут
function normResearch(r, { slug, company, domain }) {
  const values = (Array.isArray(r.values) ? r.values : []).map((v) => ({
    name: String(v.name || '').trim().slice(0, 80), their_words: (v.their_words || []).map(String).slice(0, 6),
    meaning: String(v.meaning || '').trim().slice(0, 400), strength: STRENGTH[v.strength] ? v.strength : 'low',
    evidence: (Array.isArray(v.evidence) ? v.evidence : []).filter((e) => /^https?:\/\//.test(String(e?.url || '')))
      .filter((e) => !/review|glassdoor|blind|indeed/i.test(`${e.where} ${e.url}`))
      .map((e) => ({ url: String(e.url), where: String(e.where || '').slice(0, 40),
        quote: words(e.quote).length > 15 ? `${words(e.quote).slice(0, 15).join(' ')}…` : String(e.quote || '').trim() })).slice(0, 5),
  })).filter((v) => v.name && v.evidence.length);
  // Сила — по правилу скила, не на слово агента: ≥ 3 разных страницы, или 2 из них страница ценностей / культуры → сильный;
  // 2 → средний; 1 → слабый. Агент может поставить ниже, но не выше
  for (const v of values) {
    v.sources_count = new Set(v.evidence.map((e) => e.url.replace(/[#?].*$/, ''))).size;
    const rule = v.sources_count >= 3 || (v.sources_count === 2 && v.evidence.some((e) => /value|culture|principle|handbook/i.test(e.where))) ? 'high'
      : v.sources_count === 2 ? 'medium' : 'low';
    if (STRENGTH[rule] < STRENGTH[v.strength]) v.strength = rule;
  }
  values.sort((a, b) => STRENGTH[b.strength] - STRENGTH[a.strength] || b.sources_count - a.sources_count);
  const sn = r.snapshot || {};
  return {
    slug, company: r.company || company, domain: r.domain || domain || '', at: new Date().toISOString().slice(0, 10),
    confidence: STRENGTH[r.confidence] ? r.confidence : 'low',
    snapshot: { what: String(sn.what || ''), product: String(sn.product || ''), customers: String(sn.customers || ''), stage: String(sn.stage || ''),
      market: String(sn.market || ''), news: (Array.isArray(sn.news) ? sn.news : []).filter((n) => n?.title).slice(0, 5) },
    values: values.slice(0, 7),
    vocabulary: [...new Set((r.vocabulary || []).map(String))].slice(0, 15),
    avoid: (Array.isArray(r.avoid) ? r.avoid : []).filter((a) => a?.what).slice(0, 5),
    ask: (r.ask || []).map(String).slice(0, 4),
    sources: (Array.isArray(r.sources) ? r.sources : []).filter((s) => /^https?:\/\//.test(String(s?.url || ''))).slice(0, 30),
    notes: String(r.notes || ''),
  };
}

// Ссылки доказательств открываются? 10 с на ссылку, по 6 за раз. Не открылась — помечаем, ценность остаётся при других доказательствах
async function checkLinks(r) {
  const urls = [...new Set(r.values.flatMap((v) => v.evidence.map((e) => e.url)))];
  const ok = {};
  for (let i = 0; i < urls.length; i += 6) {
    await Promise.all(urls.slice(i, i + 6).map(async (u) => {
      try {
        const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
        ok[u] = res.status < 400 || [401, 403, 429].includes(res.status); // закрыто от ботов ≠ нет страницы
      } catch { ok[u] = false; }
    }));
  }
  for (const v of r.values) {
    for (const e of v.evidence) e.ok = ok[e.url] !== false;
    v.unverified = !v.evidence.some((e) => e.ok);
  }
  r.links = { total: urls.length, ok: Object.values(ok).filter(Boolean).length };
  r.checked = new Date().toISOString();
  return r;
}

function save(r) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(r.slug), `${JSON.stringify(r, null, 2)}\n`);
}

// ---------- «что сказать» — на вакансию ----------
const sayFile = (dir) => path.join(dir, SAY_FILE);
const readSay = (dir) => readJSON(sayFile(dir));

// Числа фразы должны быть в CV (как в V1)
const missingNumbers = (text, cv) => [...new Set(String(text).match(/\d+(?:[.,]\d+)?/g) || [])]
  .filter((n) => !new RegExp(`(?<![\\d.,])${n.replace(/[.,]/g, '[.,]')}(?![\\d])`).test(cv));

function normSay(r, research, cvText, cardIds) {
  const names = new Set(research.values.map((v) => v.name));
  const items = (Array.isArray(r.say) ? r.say : []).filter((s) => names.has(s.value)).map((s) => {
    const card = cardIds.includes(s.card) ? s.card : null;
    const phrase = String(s.phrase_en || '').trim();
    const miss = missingNumbers(phrase, cvText);
    return { value: s.value, card, story: String(s.story || '').slice(0, 120), angle: String(s.angle || '').trim(),
      phrase_en: phrase, gap: card ? '' : String(s.gap || 'нет кейса — надиктуй, если делал').trim(),
      issues: miss.length ? [`чисел нет в CV: ${miss.join(', ')}`] : [] };
  });
  // Сильные ценности без строки — честный пробел
  for (const v of research.values.filter((x) => x.strength !== 'low')) {
    if (!items.some((i) => i.value === v.name)) items.push({ value: v.name, card: null, story: '', angle: '', phrase_en: '', gap: 'агент не нашёл подходящей истории', issues: [] });
  }
  // Топ-3: сильные, затем средние (значения уже отсортированы по силе); слабые — только если больше нечего
  const ok = research.values.filter((v) => !v.unverified);
  const top = ok.filter((v) => v.strength !== 'low').slice(0, 3);
  const mustMention = (top.length ? top : ok.slice(0, 2)).map((v) => v.name);
  return { slug: research.slug, at: new Date().toISOString(), researchAt: research.at, mustMention, say: items, why_company: String(r.why_company || '').trim() };
}

// Топ-3 ценности + их слова — в промпты письма, отклика, подготовки к интервью и тренажёра
function forPrompt(dir) {
  const s = readSay(dir);
  const r = s && read(s.slug);
  if (!r) return null;
  const top = s.mustMention.map((n) => r.values.find((v) => v.name === n)).filter(Boolean);
  return { company: r.company, top: top.map((v) => ({ name: v.name, their_words: v.their_words, meaning: v.meaning,
    say: s.say.find((x) => x.value === v.name) || null })), vocabulary: r.vocabulary.slice(0, 10), avoid: r.avoid.map((a) => a.what) };
}

// Для страницы заявки: разбор + «что сказать» + свежесть
function view(dir, slug) {
  const s = readSay(dir);
  const r = read(s?.slug || slug);
  return r ? { research: r, say: s && s.slug === r.slug ? s : null, stale: !!(s && s.researchAt !== r.at) } : null;
}

module.exports = { DIR, SAY_FILE, slugify, slugOk, domainFrom, read, normResearch, checkLinks, save, readSay, sayFile, normSay, forPrompt, view, validDays, missingNumbers };
