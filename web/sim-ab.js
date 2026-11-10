// C22 · Симулятор A/B-тестов (docs/specs/47-ab-simulator.md)
// Движок трафика с зерном, статистика (классическая и байесовская), ловушки, оценка решения.
// Истина (truth.json) живёт только на сервере: в публичный вид попадает после решения.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'knowledge-base', 'learning', 'sims', 'ab');
const MAX_DAYS = 56;
const AOV_SIGMA = 0.6;           // разброс чека (логнормальный), публичный параметр
const WEEKDAY = [1.0, 1.05, 1.05, 1.0, 0.95, 0.75, 0.7]; // пн…вс, тест стартует в понедельник
const WEEKDAY_AVG = WEEKDAY.reduce((a, b) => a + b, 0) / 7;

const LEVELS = {
  1: { title: 'Чистый тест', text: 'Данные честные: есть эффект, нет эффекта или вред. Задача — спроектировать и прочитать.' },
  2: { title: 'Мощность и подглядывание', text: 'Мало трафика, маленький эффект, соблазн остановить раньше.' },
  3: { title: 'Ловушки данных', text: 'Перекос разделения, эффект новизны, сегменты, день недели.' },
  4: { title: 'Компромиссы бизнеса', text: 'Главная метрика растёт, а что-то важное проседает.' },
};
const TRAPS_BY_LEVEL = { 1: ['win', 'flat', 'lose'], 2: ['underpowered', 'peeking', 'win_small'], 3: ['srm', 'novelty', 'simpson', 'weekday'], 4: ['tradeoff_rev', 'tradeoff_guard', 'win_guarded'] };
const TRAP_TEXT = {
  win: 'нет ловушки: вариант B действительно лучше', flat: 'нет ловушки: эффекта нет', lose: 'нет ловушки: вариант B хуже',
  underpowered: 'мало данных: эффект есть, но маленький, а трафика не хватает', peeking: 'подглядывание: эффекта нет, ранние дни могут показать «значимость» случайно',
  win_small: 'небольшой, но настоящий эффект', srm: 'перекос разделения (SRM): часть пользователей B теряется до учёта, B выглядит лучше без настоящего эффекта',
  novelty: 'эффект новизны: подъём в первые дни затухает почти до нуля', simpson: 'парадокс Симпсона: B хуже в каждом сегменте, но получил больше сильного сегмента',
  weekday: 'день недели: B лучше в будни и хуже в выходные, за полные недели — около нуля',
  tradeoff_rev: 'компромисс: конверсия растёт, средний чек и выручка на посетителя падают', tradeoff_guard: 'компромисс: главная метрика растёт, защитная проседает',
  win_guarded: 'нет ловушки: B лучше, защитные метрики в порядке',
};
// Что кандидат должен был заметить (флаги решения) и какие решения верны
const FLAGS = { srm: 'перекос разделения (SRM)', novelty: 'эффект новизны', segments: 'сегменты ведут себя по-разному', weekday: 'влияние дня недели',
  underpowered: 'мало данных / не хватает мощности', guardrail: 'защитная метрика просела', none: 'проблем в данных нет' };
const TRAP_FLAG = { srm: 'srm', novelty: 'novelty', simpson: 'segments', weekday: 'weekday', underpowered: 'underpowered', tradeoff_rev: 'guardrail', tradeoff_guard: 'guardrail' };
const DECISIONS = { ship: 'выкатить B', no_ship: 'не выкатывать', redo: 'доработать и перезапустить', inconclusive: 'данных недостаточно — продлить / перепроектировать' };
const INDUSTRIES = ['e-commerce', 'SaaS', 'мобильная игра', 'EdTech', 'финтех', 'маркетплейс', 'подписочный медиа-сервис', 'тревел', 'доставка еды', 'онлайн-брокер'];

const SEGMENTS = [
  { key: 'mob_new', device: 'mobile', user: 'new' }, { key: 'mob_ret', device: 'mobile', user: 'returning' },
  { key: 'desk_new', device: 'desktop', user: 'new' }, { key: 'desk_ret', device: 'desktop', user: 'returning' },
];
const SEG_LABEL = { device: { mobile: 'мобильные', desktop: 'десктоп' }, user: { new: 'новые', returning: 'вернувшиеся' } };

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const idOk = (id) => /^[a-z0-9-]{6,40}$/.test(String(id || ''));
const sdir = (id) => { if (!idOk(id)) throw err(400, 'плохой id'); return path.join(DIR, id); };
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

// ---------- случайность с зерном ----------
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let spare = null;
  const normal = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let x, y, s;
    do { x = u() * 2 - 1; y = u() * 2 - 1; s = x * x + y * y; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = y * m;
    return x * m;
  };
  const poisson = (l) => {
    if (l > 50) return Math.max(0, Math.round(l + Math.sqrt(l) * normal()));
    const L = Math.exp(-l); let k = 0, p = 1;
    do { k++; p *= u(); } while (p > L);
    return k - 1;
  };
  const binom = (n, p) => {
    if (n <= 0 || p <= 0) return 0;
    if (n < 400) { let k = 0; for (let i = 0; i < n; i++) if (u() < p) k++; return k; }
    if (n * p > 25 && n * (1 - p) > 25) return clamp(Math.round(n * p + Math.sqrt(n * p * (1 - p)) * normal()), 0, n);
    return Math.min(n, poisson(n * p));
  };
  // Гамма (Марсалья — Цанг), для бета-апостериорных
  const gamma = (k) => {
    if (k < 1) return gamma(k + 1) * Math.pow(u(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const uu = u();
      if (uu < 1 - 0.0331 * x ** 4 || Math.log(uu) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  return { u, normal, poisson, binom, gamma, beta: (a1, b1) => { const x = gamma(a1); return x / (x + gamma(b1)); } };
}

// ---------- нормальное распределение ----------
function erf(x) {
  // Абрамовиц — Стиган 7.1.26 даёт 1.5e-7; для p-value хватает, но берём точнее — ряд/цепная дробь через erfc
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807
    + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
const ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
// Обратная к нормальной (Акклэм), точность ~1e-9
function ninv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r, x;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  // одна итерация Ньютона — уточнение
  const e = ncdf(x) - p;
  return x - e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
}

// ---------- статистика ----------
// Доли: z-тест (p-value — объединённая дисперсия), 95% интервал разницы — раздельная
function propTest(nA, xA, nB, xB, alpha = 0.05) {
  const pA = nA ? xA / nA : 0, pB = nB ? xB / nB : 0, diff = pB - pA;
  const pp = (xA + xB) / Math.max(1, nA + nB);
  const sePool = Math.sqrt(pp * (1 - pp) * (1 / Math.max(1, nA) + 1 / Math.max(1, nB)));
  const se = Math.sqrt(pA * (1 - pA) / Math.max(1, nA) + pB * (1 - pB) / Math.max(1, nB));
  const z = sePool > 0 ? diff / sePool : 0;
  const zc = ninv(1 - alpha / 2);
  return { a: pA, b: pB, diff, rel: pA > 0 ? diff / pA : null, lo: diff - zc * se, hi: diff + zc * se, p: sePool > 0 ? 2 * (1 - ncdf(Math.abs(z))) : 1, z };
}
// Средние (выручка на посетителя): Уэлч; при больших n t ≈ z
function meanTest(a, b, alpha = 0.05) {
  const mA = a.n ? a.sum / a.n : 0, mB = b.n ? b.sum / b.n : 0;
  const vA = a.n > 1 ? (a.sum2 - a.n * mA * mA) / (a.n - 1) : 0, vB = b.n > 1 ? (b.sum2 - b.n * mB * mB) / (b.n - 1) : 0;
  const se = Math.sqrt(vA / Math.max(1, a.n) + vB / Math.max(1, b.n));
  const diff = mB - mA, z = se > 0 ? diff / se : 0, zc = ninv(1 - alpha / 2);
  return { a: mA, b: mB, diff, rel: mA > 0 ? diff / mA : null, lo: diff - zc * se, hi: diff + zc * se, p: se > 0 ? 2 * (1 - ncdf(Math.abs(z))) : 1, z, sdA: Math.sqrt(Math.max(0, vA)), sdB: Math.sqrt(Math.max(0, vB)) };
}
// Байес: доли — Beta(1+x, 1+n−x); средние — нормальная апостериорная. P(B лучше) с учётом направления метрики, ожидаемые потери в отн. единицах
function bayes(kind, A, B, better = 'up', draws = 20000, seed = 7) {
  const R = rng(seed);
  let win = 0, lossB = 0, lossA = 0;
  const sign = better === 'down' ? -1 : 1;
  const base = kind === 'prop' ? (A.x + 1) / (A.n + 2) : (A.n ? A.sum / A.n : 0);
  let mA, sA, mB, sB;
  if (kind === 'mean') {
    const m = (s) => (s.n ? s.sum / s.n : 0), v = (s) => (s.n > 1 ? (s.sum2 - s.n * m(s) ** 2) / (s.n - 1) : 0);
    mA = m(A); sA = Math.sqrt(v(A) / Math.max(1, A.n)); mB = m(B); sB = Math.sqrt(v(B) / Math.max(1, B.n));
  }
  for (let i = 0; i < draws; i++) {
    const a = kind === 'prop' ? R.beta(1 + A.x, 1 + A.n - A.x) : mA + sA * R.normal();
    const b = kind === 'prop' ? R.beta(1 + B.x, 1 + B.n - B.x) : mB + sB * R.normal();
    const d = sign * (b - a);
    if (d > 0) win++;
    lossB += Math.max(0, -d); lossA += Math.max(0, d);
  }
  const rel = (x) => (base > 0 ? x / draws / base : null);
  return { pBetter: win / draws, lossB: rel(lossB), lossA: rel(lossA) };
}
// Перекос разделения: хи-квадрат с 1 степенью свободы против заявленной доли
function srmTest(nA, nB, shareB) {
  const n = nA + nB;
  if (!n) return { p: 1, chi: 0 };
  const eA = n * (1 - shareB), eB = n * shareB;
  const chi = (nA - eA) ** 2 / eA + (nB - eB) ** 2 / eB;
  return { chi, p: 2 * (1 - ncdf(Math.sqrt(chi))), shareB: nB / n };
}
// Размер выборки на вариант (равные группы — по меньшей из долей)
function sampleSize({ type, base, aov, mde, alpha = 0.05, power = 0.8 }) {
  const zz = (ninv(1 - alpha / 2) + ninv(power)) ** 2;
  if (type === 'mean') {
    const m = base * aov, ex2 = base * aov * aov * Math.exp(AOV_SIGMA ** 2), v = ex2 - m * m;
    return Math.ceil(zz * 2 * v / (m * mde) ** 2);
  }
  const p1 = base, p2 = clamp(base * (1 + mde), 1e-6, 0.999999);
  return Math.ceil(zz * (p1 * (1 - p1) + p2 * (1 - p2)) / (p2 - p1) ** 2);
}

// ---------- сценарий и истина ----------
function pick(R, arr) { return arr[Math.floor(R.u() * arr.length)]; }
// Сервер выбирает ловушку и истинные эффекты; агент только пишет историю
function chooseTruth(level, seed, force = null) {
  const R = rng(seed);
  const trap = force || pick(R, TRAPS_BY_LEVEL[level] || TRAPS_BY_LEVEL[1]);
  const u = (a, b) => a + (b - a) * R.u();
  const t = { trap, lift: 0, aovLift: 0, extraLift: {}, novelty: null, weekday: null, srm: null, simpson: null };
  if (trap === 'win') t.lift = u(0.08, 0.16);
  if (trap === 'lose') t.lift = -u(0.05, 0.1);
  if (trap === 'win_small') t.lift = u(0.04, 0.06);
  if (trap === 'underpowered') t.lift = u(0.025, 0.04);
  if (trap === 'win_guarded') t.lift = u(0.07, 0.12);
  if (trap === 'novelty') t.novelty = { boost: u(0.12, 0.2), tau: u(2.5, 4), long: u(-0.005, 0.01) };
  // Будни плюс, выходные минус; за полную неделю (с весами трафика) — около нуля
  if (trap === 'weekday') { const wd = u(0.07, 0.11); t.weekday = { wd, we: -wd * (5.05 / 1.45) * u(0.9, 1.1) }; }
  if (trap === 'srm') t.srm = { seg: 'mob_new', keep: u(0.78, 0.86) };
  if (trap === 'simpson') t.simpson = { lift: -u(0.04, 0.07), desktopShareB: u(0.63, 0.68) };
  if (trap === 'tradeoff_rev') { t.lift = u(0.07, 0.12); t.aovLift = -u(0.13, 0.2); }
  if (trap === 'tradeoff_guard') t.lift = u(0.06, 0.1);
  return t;
}
// Числа сценария в разумных границах; уровень 2 «мало данных» — сервер сам режет трафик
function normScenario(raw, truth, opts = {}) {
  const s = raw || {};
  const str = (x, n = 600) => String(x || '').trim().slice(0, n);
  const extras = (Array.isArray(s.extra_metrics) ? s.extra_metrics : []).slice(0, 2).map((m, i) => ({
    key: `g${i + 1}`, name: str(m?.name, 100) || `Защитная метрика ${i + 1}`, better: m?.better === 'down' ? 'down' : 'up', base: clamp(Number(m?.base) || 0.05, 0.002, 0.8),
  }));
  const sc = {
    title: str(s.title, 120) || 'A/B-тест', industry: str(s.industry || opts.industry, 60), product: str(s.product, 400), context: str(s.context, 1500),
    problem: str(s.problem, 600), change_a: str(s.change_a, 400), change_b: str(s.change_b, 600),
    traffic: Math.round(clamp(Number(s.traffic_per_day) || 4000, 300, 200000)), base: clamp(Number(s.base_conv) || 0.04, 0.005, 0.4),
    aov: Math.round(clamp(Number(s.aov) || 50, 2, 5000) * 100) / 100, currency: str(s.currency, 6) || '$',
    metrics: [{ key: 'conv', name: str(s.conv_name, 100) || 'Конверсия', type: 'prop', better: 'up' },
      { key: 'rpv', name: str(s.rpv_name, 80) || 'Выручка на посетителя', type: 'mean', better: 'up' },
      ...extras.map((m) => ({ ...m, type: 'prop' }))],
    note: str(s.note, 400),
  };
  const keys = sc.metrics.map((m) => m.key);
  sc.primary_ok = (Array.isArray(s.primary_ok) ? s.primary_ok : ['conv']).filter((k) => keys.includes(k));
  if (!sc.primary_ok.length) sc.primary_ok = ['conv'];
  sc.guard_must = (Array.isArray(s.guard_must) ? s.guard_must : []).filter((k) => keys.includes(k));
  if (truth.trap === 'tradeoff_rev') { sc.primary_ok = ['conv']; sc.guard_must = ['rpv']; }
  if (truth.trap === 'tradeoff_guard') {
    if (!extras.length) sc.metrics.push({ key: 'g1', name: 'Возвраты / отказы от подписки', type: 'prop', better: 'down', base: 0.04 });
    const g = sc.metrics.find((m) => m.key === 'g1');
    truth.extraLift.g1 = g.better === 'down' ? 0.25 + rng(opts.seed || 1).u() * 0.15 : -(0.1 + rng(opts.seed || 1).u() * 0.08);
    sc.primary_ok = sc.primary_ok.filter((k) => k !== 'g1');
    if (!sc.primary_ok.length) sc.primary_ok = ['conv'];
    sc.guard_must = ['g1'];
  }
  // Мало данных: дневной трафик такой, что для MDE 5% нужно ≈ 8–10 недель
  if (truth.trap === 'underpowered') {
    const need = sampleSize({ type: 'prop', base: sc.base, mde: 0.05 });
    sc.traffic = Math.max(300, Math.round(2 * need / (63 * WEEKDAY_AVG)));
  }
  return sc;
}

// Ожидаемая доля сегмента и множитель конверсии (нормированы: средняя = base)
const DEV = { mobile: { share: 0.6, m: 0.7 }, desktop: { share: 0.4, m: 1.45 } };
const USR = { new: { share: 0.65, m: 0.8 }, returning: { share: 0.35, m: 1.37 } };
function segBase() {
  const cells = SEGMENTS.map((s) => ({ ...s, share: DEV[s.device].share * USR[s.user].share, m: DEV[s.device].m * USR[s.user].m }));
  const norm = cells.reduce((a, c) => a + c.share * c.m, 0);
  return cells.map((c) => ({ ...c, m: c.m / norm }));
}

// Эффект B в сегменте в день d (относительный) по главной конверсии
function liftAt(truth, seg, day) {
  if (truth.novelty) return truth.novelty.long + truth.novelty.boost * Math.exp(-day / truth.novelty.tau);
  if (truth.weekday) return day % 7 >= 5 ? truth.weekday.we : truth.weekday.wd;
  if (truth.simpson) return truth.simpson.lift;
  return truth.lift;
}

// Все дни сразу (MAX_DAYS), повторяемо по зерну. Доля B — из дизайна
function generate(sc, truth, design, seed) {
  const R = rng(seed);
  const cells = segBase();
  const shareB = design.split;
  const days = [];
  for (let d = 0; d < MAX_DAYS; d++) {
    const total = R.poisson(sc.traffic * WEEKDAY[d % 7]);
    const day = { A: {}, B: {} };
    for (const c of cells) {
      const nCell = R.binom(total, c.share);
      let sB = shareB;
      if (truth.simpson && c.device === 'desktop') sB = truth.simpson.desktopShareB;
      if (truth.simpson && c.device === 'mobile') sB = clamp((shareB - DEV.desktop.share * truth.simpson.desktopShareB) / DEV.mobile.share, 0.05, 0.95);
      let nB = R.binom(nCell, sB);
      const nA = nCell - nB;
      if (truth.srm && c.key === truth.srm.seg) nB = R.binom(nB, truth.srm.keep);
      for (const [arm, n] of [['A', nA], ['B', nB]]) {
        const lift = arm === 'B' ? liftAt(truth, c, d) : 0;
        const p = clamp(sc.base * c.m * (1 + lift), 0, 0.95);
        const conv = R.binom(n, p);
        const aov = sc.aov * (1 + (arm === 'B' ? truth.aovLift : 0));
        const mu = Math.log(aov) - AOV_SIGMA ** 2 / 2;
        let rev = 0, rev2 = 0;
        // Сумма логнормальных чеков: при больших числах — по моментам, иначе поштучно
        if (conv > 200) {
          const ex = aov, vx = aov * aov * (Math.exp(AOV_SIGMA ** 2) - 1);
          rev = Math.max(0, conv * ex + Math.sqrt(conv * vx) * R.normal());
          rev2 = conv * (vx + ex * ex) * (1 + 0.05 * R.normal());
        } else for (let i = 0; i < conv; i++) { const v = Math.exp(mu + AOV_SIGMA * R.normal()); rev += v; rev2 += v * v; }
        const extra = {};
        for (const m of sc.metrics.filter((x) => x.key.startsWith('g'))) {
          const l = arm === 'B' ? (truth.extraLift[m.key] || 0) : 0;
          extra[m.key] = R.binom(n, clamp(m.base * (1 + l), 0, 0.99));
        }
        day[arm][c.key] = { n, conv, rev: Math.round(rev * 100) / 100, rev2: Math.round(rev2 * 100) / 100, extra };
      }
    }
    days.push(day);
  }
  return days;
}

// Истинные эффекты за полные недели при честном разделении — то, по чему судим решение
function trueEffects(sc, truth) {
  const cells = segBase();
  const longDay = (d) => (truth.novelty ? 60 : d);
  let a = 0, b = 0, wsum = 0;
  for (let d = 0; d < 7; d++) for (const c of cells) {
    const w = WEEKDAY[d] * c.share;
    a += w * sc.base * c.m; b += w * sc.base * c.m * (1 + liftAt(truth, c, longDay(d))); wsum += w;
  }
  const conv = b / a - 1;
  const rpv = (1 + conv) * (1 + truth.aovLift) - 1;
  const out = { conv, rpv };
  for (const m of sc.metrics.filter((x) => x.key.startsWith('g'))) out[m.key] = truth.extraLift[m.key] || 0;
  return out;
}

// ---------- результаты на день ----------
function aggregate(days, upto, seg) {
  const acc = { A: { n: 0, conv: 0, rev: 0, rev2: 0, extra: {} }, B: { n: 0, conv: 0, rev: 0, rev2: 0, extra: {} } };
  for (let d = 0; d < upto; d++) for (const arm of ['A', 'B']) for (const [k, c] of Object.entries(days[d][arm])) {
    if (seg && !segMatch(k, seg)) continue;
    const t = acc[arm];
    t.n += c.n; t.conv += c.conv; t.rev += c.rev; t.rev2 += c.rev2;
    for (const [m, x] of Object.entries(c.extra)) t.extra[m] = (t.extra[m] || 0) + x;
  }
  return acc;
}
function segMatch(key, seg) {
  const s = SEGMENTS.find((x) => x.key === key);
  return s && (seg === s.device || seg === s.user || seg === key);
}
function metricResult(m, acc, alpha, withBayes = true) {
  const A = acc.A, B = acc.B;
  let r, bz;
  if (m.type === 'mean') {
    const sa = { n: A.n, sum: A.rev, sum2: A.rev2 }, sb = { n: B.n, sum: B.rev, sum2: B.rev2 };
    r = meanTest(sa, sb, alpha);
    if (withBayes) bz = bayes('mean', sa, sb, m.better);
  } else {
    const xa = m.key === 'conv' ? A.conv : A.extra[m.key] || 0, xb = m.key === 'conv' ? B.conv : B.extra[m.key] || 0;
    r = propTest(A.n, xa, B.n, xb, alpha);
    r.xA = xa; r.xB = xb;
    if (withBayes) bz = bayes('prop', { n: A.n, x: xa }, { n: B.n, x: xb }, m.better);
  }
  const out = { key: m.key, name: m.name, type: m.type, better: m.better };
  for (const k of ['a', 'b', 'diff', 'rel', 'lo', 'hi', 'p', 'xA', 'xB']) if (r[k] !== undefined) out[k] = r4(r[k]) ?? r[k];
  out.sig = r.p < alpha;
  if (bz) out.bayes = { pBetter: r4(bz.pBetter), lossB: r4(bz.lossB), lossA: r4(bz.lossA) };
  return out;
}
function results(sim, day, seg = null) {
  const { run, design, scenario } = sim;
  if (!run) throw err(400, 'тест не запущен');
  const upto = clamp(Math.round(day) || run.day, 1, run.until);
  const alpha = design.alpha;
  const acc = aggregate(run.days, upto, seg);
  const metrics = [design.primary, ...design.guards].map((k) => scenario.metrics.find((m) => m.key === k)).filter(Boolean)
    .map((m) => metricResult(m, acc, alpha));
  const srm = srmTest(acc.A.n, acc.B.n, design.split);
  const prim = scenario.metrics.find((m) => m.key === design.primary);
  // Накопительная история главной метрики по дням (для графика) — без байеса, чтобы быстро
  const series = [];
  for (let d = 1; d <= upto; d++) {
    const r = metricResult(prim, aggregate(run.days, d, seg), alpha, false);
    series.push({ day: d, a: r.a, b: r.b, rel: r.rel, lo: r.lo, hi: r.hi, p: r.p });
  }
  const daily = [];
  for (let d = 0; d < upto; d++) {
    const one = { A: {}, B: {} };
    for (const arm of ['A', 'B']) for (const [k, c] of Object.entries(run.days[d][arm])) if (!seg || segMatch(k, seg)) one[arm][k] = c;
    const r = metricResult(prim, aggregate([one], 1, null), alpha, false);
    daily.push({ day: d + 1, wd: d % 7, a: r.a, b: r.b, nA: aggregate([one], 1).A.n, nB: aggregate([one], 1).B.n });
  }
  return { day: upto, planned: design.days, until: run.until, seg, n: { A: acc.A.n, B: acc.B.n }, srm: { p: r4(srm.p), shareB: r4(srm.shareB), expected: design.split, flag: srm.p < 0.001 },
    metrics, series, daily };
}

// ---------- дизайн ----------
function normDesign(b, sc) {
  const keys = sc.metrics.map((m) => m.key);
  const primary = keys.includes(b?.primary) ? b.primary : 'conv';
  const guards = (Array.isArray(b?.guards) ? b.guards : []).filter((k) => keys.includes(k) && k !== primary).slice(0, 3);
  return {
    hypothesis: String(b?.hypothesis || '').trim().slice(0, 1200), primary, guards,
    mde: clamp(Number(b?.mde) || 0.05, 0.005, 1), alpha: [0.01, 0.05, 0.1].includes(Number(b?.alpha)) ? Number(b.alpha) : 0.05,
    power: [0.8, 0.9].includes(Number(b?.power)) ? Number(b.power) : 0.8, split: [0.5, 0.2, 0.1].includes(Number(b?.split)) ? Number(b.split) : 0.5,
    days: Math.round(clamp(Number(b?.days) || 14, 1, MAX_DAYS)),
  };
}
function calc(sc, design) {
  const m = sc.metrics.find((x) => x.key === design.primary);
  const base = m.type === 'mean' ? sc.base : m.key === 'conv' ? sc.base : m.base;
  const perArm = sampleSize({ type: m.type, base, aov: sc.aov, mde: design.mde, alpha: design.alpha, power: design.power });
  const daily = sc.traffic * WEEKDAY_AVG;
  const small = Math.min(design.split, 1 - design.split);
  const daysNeeded = Math.ceil(perArm / (daily * small));
  const planned = { A: Math.round(daily * (1 - design.split) * design.days), B: Math.round(daily * design.split * design.days) };
  const warn = [];
  if (daysNeeded > design.days) warn.push(`для MDE ${Math.round(design.mde * 1000) / 10}% нужно ≈ ${daysNeeded} дн. — выбрано ${design.days}`);
  if (design.days % 7) warn.push('длительность не кратна неделе — день недели может исказить результат');
  if (design.days < 7) warn.push('меньше недели — не видно недельного цикла');
  if (!design.hypothesis) warn.push('нет гипотезы');
  if (daysNeeded > MAX_DAYS) warn.push(`даже ${MAX_DAYS} дней не хватит — увеличь MDE или выбери другую метрику`);
  return { perArm, daysNeeded, weeksNeeded: Math.ceil(daysNeeded / 7), planned, dailyTraffic: Math.round(daily), warn };
}

// ---------- оценка решения ----------
function idealDecision(truth, eff, design, atDecision) {
  const t = truth.trap;
  if (t === 'srm') return { ideal: ['redo'], partial: ['no_ship', 'inconclusive'] };
  if (['simpson', 'novelty', 'weekday', 'tradeoff_rev', 'tradeoff_guard'].includes(t)) return { ideal: ['no_ship'], partial: ['inconclusive', 'redo'] };
  if (t === 'underpowered') return { ideal: ['inconclusive'], partial: ['no_ship', 'redo'] };
  const prim = eff[design.primary] ?? eff.conv;
  if (prim > 0.02) {
    const r = atDecision?.metrics?.[0];
    return r && !r.sig && atDecision.n.B < 0.9 * (atDecision.need || Infinity) ? { ideal: ['inconclusive', 'ship'], partial: [] } : { ideal: ['ship'], partial: ['inconclusive'] };
  }
  return { ideal: ['no_ship'], partial: ['inconclusive'] };
}
function score(sim, decision) {
  const { scenario: sc, truth, design, log } = sim;
  const c = calc(sc, design);
  const eff = trueEffects(sc, truth);
  const notes = [];
  // Дизайн — 30
  let dz = 0;
  if (sc.primary_ok.includes(design.primary)) dz += 8; else notes.push(`главная метрика: лучше ${sc.primary_ok.map((k) => sc.metrics.find((m) => m.key === k)?.name).join(' или ')}`);
  const needG = sc.guard_must.length ? sc.guard_must : sc.metrics.filter((m) => m.key !== design.primary).slice(0, 1).map((m) => m.key);
  if (needG.every((k) => design.guards.includes(k))) dz += 7; else notes.push(`защитные метрики: не хватило «${needG.filter((k) => !design.guards.includes(k)).map((k) => sc.metrics.find((m) => m.key === k)?.name).join('», «')}»`);
  if (c.daysNeeded <= design.days) dz += 8; else notes.push(`выборки не хватало: нужно ≈ ${c.daysNeeded} дн., запланировано ${design.days}`);
  if (design.days >= 7 && design.days % 7 === 0) dz += 4; else notes.push('длительность — не полные недели');
  if (design.hypothesis.length >= 30) dz += 3; else notes.push('гипотеза слишком короткая');
  // Процесс — 30
  let pr = 0;
  const early = decision.day < design.days && !(truth.trap === 'srm' && decision.decision === 'redo');
  if (!early) pr += 12; else notes.push(`остановка на ${decision.day}-й день из ${design.days} без поправки на подглядывание`);
  const want = TRAP_FLAG[truth.trap] || 'none';
  const flags = decision.flags || [];
  let fl = flags.includes(want) ? 12 : 0;
  if (!fl) notes.push(want === 'none' ? 'проблем в данных не было — ложная тревога' : `не замечено: ${FLAGS[want]}`);
  fl = Math.max(0, fl - 3 * flags.filter((f) => f !== want && f !== 'none').length);
  pr += fl;
  if (['simpson', 'weekday'].includes(truth.trap)) { if (log.segments || log.daily) pr += 6; else notes.push('сегменты / дни не смотрел — ловушка была там'); } else pr += 6;
  // Решение — 40
  const id = idealDecision(truth, eff, design, decision.at);
  const dc = id.ideal.includes(decision.decision) ? 40 : id.partial.includes(decision.decision) ? 20 : 0;
  if (dc < 40) notes.push(`решение: лучше «${DECISIONS[id.ideal[0]]}»`);
  return { total: dz + pr + dc, design: dz, process: pr, decision: dc, correct: dc === 40, ideal: id.ideal, caught: flags.includes(want), want, notes, effects: Object.fromEntries(Object.entries(eff).map(([k, v]) => [k, r4(v)])) };
}

// ---------- хранение ----------
function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(idOk).map((id) => {
    const s = readJ(path.join(DIR, id, 'sim.json'));
    if (!s) return null;
    const dec = readJ(path.join(DIR, id, 'decision.json'));
    return { id, title: s.scenario?.title || 'A/B-тест', level: s.level, source: s.source, industry: s.scenario?.industry || '', status: status(id, s), created: s.created,
      score: dec?.score?.total ?? null, correct: dec?.score?.correct ?? null, trap: dec ? readJ(path.join(DIR, id, 'truth.json'))?.trap : null };
  }).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}
function status(id, s = get(id)) {
  if (fs.existsSync(path.join(sdir(id), 'decision.json'))) return 'done';
  if (s.run) return 'running';
  if (s.scenario?.ready) return 'design';
  if (s.questions?.length) return 'questions';
  return 'draft';
}
function get(id) {
  const s = readJ(path.join(sdir(id), 'sim.json'));
  if (!s) throw err(404, 'нет такого теста');
  return s;
}
function save(id, s) { s.updated = now(); writeJ(path.join(sdir(id), 'sim.json'), s); return s; }
const truthOf = (id) => readJ(path.join(sdir(id), 'truth.json'));
function create({ level = 1, industry = '', source = 'app', own = null }) {
  fs.mkdirSync(DIR, { recursive: true });
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const lv = LEVELS[level] ? Number(level) : 1;
  const ind = INDUSTRIES.includes(industry) ? industry : industry === 'own' ? '' : INDUSTRIES[seed % INDUSTRIES.length];
  const s = { id, level: source === 'own' ? null : lv, source, seed, industry: ind, own, scenario: null, design: null, run: null, log: { views: [], segments: 0, daily: 0 }, created: now() };
  if (source !== 'own') writeJ(path.join(sdir(id), 'truth.json'), chooseTruth(lv, seed));
  save(id, s);
  return s;
}
function setScenario(id, raw) {
  const s = get(id);
  const truth = truthOf(id);
  s.scenario = { ...normScenario(raw, truth, { industry: s.industry, seed: s.seed }), ready: true };
  writeJ(path.join(sdir(id), 'truth.json'), truth);
  return save(id, s);
}
// Свой тест: агент вернул либо вопросы, либо сценарий с диапазоном эффекта и рисками
function setOwn(id, raw) {
  const s = get(id);
  if (!raw?.ok) { s.questions = (Array.isArray(raw?.questions) ? raw.questions : []).map((q) => String(q).slice(0, 300)).slice(0, 6); if (!s.questions.length) s.questions = ['Опиши словами, что меняется в варианте B и на какую метрику это должно повлиять.']; return save(id, s); }
  const R = rng(s.seed);
  const lo = clamp(Number(raw.effect_range?.[0]) || -0.05, -0.5, 0.5), hi = clamp(Number(raw.effect_range?.[1]) || 0.1, lo, 0.6);
  const risks = (Array.isArray(raw.risks) ? raw.risks : []).filter((r) => ['novelty', 'srm', 'simpson', 'weekday', 'tradeoff_rev', 'tradeoff_guard'].includes(r));
  const trap = risks.length && R.u() < 0.5 ? pick(R, risks) : 'own';
  const truth = trap === 'own' ? { ...chooseTruth(1, s.seed, 'flat'), trap: 'own', lift: lo + (hi - lo) * R.u() } : chooseTruth(3, s.seed, trap);
  truth.range = [r4(lo), r4(hi)];
  s.questions = [];
  s.scenario = { ...normScenario(raw, truth, { industry: raw.industry || s.own?.industry, seed: s.seed }), ready: true, rationale: String(raw.rationale || '').slice(0, 800), model_note: 'модель, не прогноз' };
  writeJ(path.join(sdir(id), 'truth.json'), truth);
  return save(id, s);
}
function setDesign(id, body) {
  const s = get(id);
  if (s.run) throw err(409, 'дизайн зафиксирован — тест уже запущен');
  if (!s.scenario?.ready) throw err(400, 'ситуация ещё не готова');
  s.design = normDesign(body, s.scenario);
  save(id, s);
  return { design: s.design, calc: calc(s.scenario, s.design) };
}
function start(id) {
  const s = get(id);
  if (s.run) throw err(409, 'тест уже запущен');
  if (!s.design) throw err(400, 'сначала дизайн');
  const truth = truthOf(id);
  s.run = { started: now(), day: 1, until: s.design.days, days: generate(s.scenario, truth, s.design, s.seed) };
  return save(id, s);
}
// Просмотр результатов — пишем подглядывания (день меньше запланированного) и сегменты
function view(id, day, seg, daily) {
  const s = get(id);
  if (fs.existsSync(path.join(sdir(id), 'decision.json'))) return results(s, day, seg);
  const r = results(s, day, seg);
  s.run.day = Math.max(s.run.day, r.day);
  if (r.day < s.design.days && !s.log.views.includes(r.day)) s.log.views.push(r.day);
  if (seg) s.log.segments++;
  if (daily) s.log.daily++;
  save(id, s);
  return r;
}
function extend(id, days = 7) {
  const s = get(id);
  if (!s.run) throw err(400, 'тест не запущен');
  if (s.run.until >= MAX_DAYS) throw err(400, `больше ${MAX_DAYS} дней тест не идёт`);
  s.run.until = Math.min(MAX_DAYS, s.run.until + days);
  s.log.extended = (s.log.extended || 0) + days;
  return save(id, s);
}
function decide(id, body) {
  const s = get(id);
  if (!s.run) throw err(400, 'тест не запущен');
  if (fs.existsSync(path.join(sdir(id), 'decision.json'))) throw err(409, 'решение уже принято');
  if (!DECISIONS[body?.decision]) throw err(400, 'выбери решение');
  const day = clamp(Math.round(Number(body.day) || s.run.day), 1, s.run.until);
  const at = results(s, day);
  const prim = s.scenario.metrics.find((m) => m.key === s.design.primary);
  at.need = calc(s.scenario, s.design).perArm;
  const dec = { decision: body.decision, flags: (Array.isArray(body.flags) ? body.flags : []).filter((f) => FLAGS[f]), reason: String(body.reason || '').trim().slice(0, 4000), day, at: { day, n: at.n, need: at.need, srm: at.srm, metrics: at.metrics }, decided: now() };
  s.truth = truthOf(id);
  dec.score = score(s, dec);
  delete s.truth;
  dec.primary = prim.name;
  writeJ(path.join(sdir(id), 'decision.json'), dec);
  return dec;
}
const setDebrief = (id, d) => writeJ(path.join(sdir(id), 'debrief.json'), d);
function normDebrief(raw) {
  const arr = (x, n) => (Array.isArray(x) ? x : []).map((v) => String(v).trim().slice(0, 400)).filter(Boolean).slice(0, n);
  return { grade: clamp(Math.round(Number(raw?.grade) || 2), 1, 4), verdict: String(raw?.verdict || '').slice(0, 500), missed: arr(raw?.missed, 5), strong: arr(raw?.strong, 5), interview: String(raw?.interview || '').slice(0, 800) };
}

// Публичный вид: истина и данные по дням не уходят, пока нет решения
function publicView(id) {
  const s = get(id);
  const dec = readJ(path.join(sdir(id), 'decision.json'));
  const out = { id, level: s.level, source: s.source, industry: s.industry, own: s.own ? { description: s.own.description, hypothesis: s.own.hypothesis, metric: s.own.metric, assets: s.own.assets || [] } : null,
    scenario: s.scenario && !fs.existsSync(path.join(sdir(id), 'decision.json')) ? (({ primary_ok, guard_must, ...rest }) => rest)(s.scenario) : s.scenario, questions: s.questions || [], design: s.design, calc: s.design && s.scenario ? calc(s.scenario, s.design) : null,
    run: s.run ? { started: s.run.started, day: s.run.day, until: s.run.until } : null, log: { peeks: s.log.views.length, segments: s.log.segments, extended: s.log.extended || 0 },
    status: status(id, s), created: s.created, decision: dec, debrief: readJ(path.join(sdir(id), 'debrief.json')) };
  if (dec) { const t = truthOf(id); out.truth = { trap: t.trap, text: TRAP_TEXT[t.trap] || 'свой тест: эффект из диапазона модели', range: t.range || null, effects: dec.score.effects }; }
  return out;
}

// Статистика: верные решения, оценки по частям, ловушки по типам
function stats() {
  const done = list().filter((x) => x.status === 'done');
  const decs = done.map((x) => ({ x, d: readJ(path.join(DIR, x.id, 'decision.json')), t: truthOf(x.id) })).filter((y) => y.d && y.t);
  const avg = (f) => (decs.length ? Math.round(decs.reduce((a, y) => a + f(y.d.score), 0) / decs.length) : null);
  const traps = {};
  for (const y of decs) {
    const k = TRAP_FLAG[y.t.trap] || 'none';
    traps[k] = traps[k] || { flag: k, title: FLAGS[k], seen: 0, caught: 0 };
    traps[k].seen++; if (y.d.score.caught) traps[k].caught++;
  }
  const byLevel = {};
  for (const y of decs) if (y.x.level) { const b = (byLevel[y.x.level] = byLevel[y.x.level] || { level: y.x.level, done: 0, correct: 0 }); b.done++; if (y.d.score.correct) b.correct++; }
  const last5 = decs.slice(0, 5), prev = decs.slice(5, 15);
  const share = (a) => (a.length ? Math.round((a.filter((y) => y.d.score.correct).length / a.length) * 100) : null);
  const weak = Object.values(traps).filter((t) => t.flag !== 'none' && t.caught < t.seen).sort((a, b) => (b.seen - b.caught) - (a.seen - a.caught))[0] || null;
  // Следующий уровень — после 3 верных на текущем
  let next = 1;
  for (const l of [1, 2, 3, 4]) if ((byLevel[l]?.correct || 0) >= 3) next = Math.min(4, l + 1);
  return { done: decs.length, correct: decs.filter((y) => y.d.score.correct).length, correctShare: share(decs), recent: share(last5), before: share(prev),
    avg: { total: avg((s) => s.total), design: avg((s) => s.design), process: avg((s) => s.process), decision: avg((s) => s.decision) },
    traps: Object.values(traps), byLevel: Object.values(byLevel), weak, next };
}

function saveAsset(id, name, buf) {
  const s = get(id);
  const ext = (String(name).toLowerCase().match(/\.(png|jpe?g|webp)$/) || [])[1];
  if (!ext) throw err(400, 'только PNG / JPG / WEBP');
  if ((s.own?.assets || []).length >= 4) throw err(400, 'не больше 4 скриншотов');
  const file = `shot-${(s.own.assets || []).length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`;
  fs.mkdirSync(path.join(sdir(id), 'assets'), { recursive: true });
  fs.writeFileSync(path.join(sdir(id), 'assets', file), buf);
  s.own.assets = [...(s.own.assets || []), { file, name: String(name).slice(0, 120) }];
  save(id, s);
  return s.own.assets;
}
const assetPath = (id, file) => { if (!/^shot-\d\.(png|jpg|webp)$/.test(file)) throw err(400, 'плохое имя'); return path.join(sdir(id), 'assets', file); };
function remove(id) { fs.rmSync(sdir(id), { recursive: true, force: true }); }

module.exports = {
  DIR, LEVELS, TRAPS_BY_LEVEL, TRAP_TEXT, FLAGS, DECISIONS, INDUSTRIES, SEGMENTS, SEG_LABEL, MAX_DAYS, WEEKDAY,
  rng, ncdf, ninv, propTest, meanTest, bayes, srmTest, sampleSize, chooseTruth, normScenario, generate, trueEffects, results, normDesign, calc, score,
  list, get, save, create, setScenario, setOwn, setDesign, start, view, extend, decide, setDebrief, normDebrief, publicView, stats, truthOf, sdir,
  saveAsset, assetPath, remove, idOk,
};
