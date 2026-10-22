// W7 · Три цифры для оффера и «Моя неделя» (docs/specs/29-offer-numbers.md).
// Цель и якорь — в knowledge-base/profile.json → money (их видят агенты форм); граница — только web/data/limit.json,
// её не читает ни один агент и она никуда не подставляется. Якорь сам пишется в «Стандартные ответы» → Salary expectations.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./agent');
const { DATA } = require('./store');

const PROFILE = path.join(ROOT, 'knowledge-base', 'profile.json');
const ANSWERS = path.join(ROOT, 'knowledge-base', 'profile-answers.md');
const LIMIT = path.join(DATA, 'limit.json');
const WEEK = path.join(DATA, 'week.json');

const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[\s,]/g, '')));
const fmt = (n) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');

// По умолчанию (решение владельца, 2026-10-21): B2B net в USD в месяц
const DEFAULTS = { currency: 'USD', period: 'month', form: 'B2B net' };

function anchorLine(m) {
  if (m.anchorFrom == null || m.anchorTo == null) return '';
  return `${fmt(m.anchorFrom)}–${fmt(m.anchorTo)} ${m.currency} ${m.form.includes('net') ? 'net' : 'gross'} / ${m.period}, ${m.form.replace(/\s*(net|gross)/i, '')}`;
}

function get() {
  const p = readJ(PROFILE, {});
  const m = { ...DEFAULTS, ...(p.money || {}) };
  const warnings = [];
  if (m.target != null && m.anchorFrom != null && m.anchorFrom < m.target) warnings.push('Нижняя граница якоря ниже цели — ты сам делаешь себе скидку. По воркбуку диапазон начинается с цели.');
  if (m.anchorFrom != null && m.anchorTo != null && m.anchorTo < m.anchorFrom) warnings.push('Верх якоря меньше низа.');
  const limit = readJ(LIMIT, {}).limit ?? null;
  if (limit != null && m.target != null && limit > m.target) warnings.push('Граница выше цели — проверь цифры.');
  return { money: m, anchor: anchorLine(m), limit, warnings };
}

// Раздел «Salary expectations» стандартных ответов = якорь (его подставляют формы C11 и ответы S4)
function writeAnchor(line) {
  if (!line) return;
  let md = fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8') : '# Стандартные ответы для форм заявок\n';
  const re = /(^## Salary expectations[^\n]*\n)([\s\S]*?)(?=\n## |\s*$)/m;
  if (re.test(md)) md = md.replace(re, `$1${line}\n`);
  else md = `${md.trimEnd()}\n\n## Salary expectations / зарплатные ожидания\n${line}\n`;
  fs.writeFileSync(ANSWERS, md);
}

function put(b) {
  const p = readJ(PROFILE, {});
  const cur = { ...DEFAULTS, ...(p.money || {}) };
  const next = { ...cur };
  for (const k of ['target', 'anchorFrom', 'anchorTo']) if (b[k] !== undefined) {
    const v = num(b[k]);
    if (v != null && !(v > 0)) throw new Error('суммы — положительные числа');
    next[k] = v;
  }
  for (const k of ['sources', 'alternative', 'currency', 'period', 'form']) if (typeof b[k] === 'string') next[k] = b[k].trim().slice(0, 300);
  next.currency = (next.currency || 'USD').toUpperCase().slice(0, 3);
  if (!['month', 'year', 'hour'].includes(next.period)) next.period = 'month';
  if (b.packages && typeof b.packages === 'object') next.packages = b.packages;   // P1: два пакета (MESO)
  if (b.phrase && typeof b.phrase === 'object') next.phrase = b.phrase;           // P1: фраза для рекрутера
  p.money = next;
  fs.writeFileSync(PROFILE, `${JSON.stringify(p, null, 2)}\n`);
  if (b.limit !== undefined) fs.writeFileSync(LIMIT, JSON.stringify({ limit: num(b.limit) }, null, 2));
  writeAnchor(anchorLine(next));
  return get();
}

// Названная в форме сумма vs якорь: числа из ответа на вопрос о зарплате (4000, 4 000, 4k, 4,500)
const SALARY_Q = /salary|compensation|expectation|pay|rate|зарплат|оплат|вилк|wynagrodzen/i;
function namedAmounts(text) {
  return (String(text).match(/\d[\d\s,.]*\s*k?\b/gi) || []).map((s) => {
    const k = /k\s*$/i.test(s);
    const n = Number(s.replace(/k/i, '').replace(/[\s,]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
    return k ? n * 1000 : n;
  }).filter((n) => n >= 100);
}

// Валюта и период из ответа: «60000» без пометок, но больше полугодового якоря — это год; другая валюта или gross
// при net-якоре не сравниваются — пометка «проверь сам» (kind: 'check'), а не расхождение (kind: 'off')
const CURRENCIES = [['USD', /\$|usd|dollar/i], ['EUR', /€|eur/i], ['PLN', /pln|zł|zl\b|złot/i], ['GBP', /£|gbp/i], ['UAH', /uah|грн|₴/i]];
const YEAR_RE = /year|annual|annum|\/\s*y(r)?\b|yearly|rok|rocz|в год|годов/i;
const MONTH_RE = /month|monthly|\/\s*mo\b|mies|в мес|месяц/i;
const HOUR_RE = /hour|hourly|\/\s*h\b|godz|в час/i;

function mismatch(submitted, m = get().money) {
  if (m.anchorFrom == null) return null;
  const top = m.anchorTo || m.anchorFrom;
  const anchor = anchorLine(m);
  let check = null;
  for (const s of submitted || []) {
    if (!SALARY_Q.test(s.q)) continue;
    if (!/\d/.test(s.a)) continue;
    let nums = namedAmounts(s.a);
    const text = `${s.q} ${s.a}`;
    const cur = CURRENCIES.find(([, re]) => re.test(s.a))?.[0];
    const gross = /gross|brutto|брутто/i.test(s.a) && /net/i.test(m.form);
    if ((cur && cur !== m.currency) || gross || HOUR_RE.test(s.a)) {
      check = check || { kind: 'check', q: s.q, a: s.a, anchor,
        why: cur && cur !== m.currency ? `другая валюта (${cur})` : gross ? 'gross, а якорь net' : 'почасовая ставка' };
      continue;
    }
    if (!nums.length) continue;
    const yearly = YEAR_RE.test(text) || (!MONTH_RE.test(text) && m.period === 'month' && Math.min(...nums) > top * 6);
    if (yearly && m.period === 'month') nums = nums.map((n) => n / 12);
    const low = Math.min(...nums);
    if (low < m.anchorFrom * 0.97 || Math.max(...nums) > top * 1.15) {
      return { kind: 'off', q: s.q, a: s.a, low: Math.round(low), yearly, anchor };
    }
  }
  return check;
}

// ---------- «Моя неделя»: действия, а не офферы ----------
function weekStart(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // понедельник
  return x;
}
// Ключ недели — локальная дата понедельника (toISOString сдвинул бы на воскресенье в UTC)
const weekKey = (d = weekStart()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function weekData() { return readJ(WEEK, { plan: { bets: 5, messages: 2, practice: 3 }, reviews: {} }); }
function setWeek(b) {
  const w = weekData();
  if (b.plan) for (const k of ['bets', 'messages', 'practice']) if (b.plan[k] !== undefined) w.plan[k] = Math.max(0, Math.min(50, Number(b.plan[k]) || 0));
  if (b.reviewed) w.reviews[weekKey()] = new Date().toISOString();
  if (b.notified) w.notified = weekKey();
  fs.writeFileSync(WEEK, JSON.stringify(w, null, 2));
  return w;
}

module.exports = { get, put, anchorLine, mismatch, weekStart, weekKey, weekData, setWeek };
