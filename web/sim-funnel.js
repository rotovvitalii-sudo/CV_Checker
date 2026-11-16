// C24 · Симулятор воронок (docs/specs/49-bayes-funnels-practice.md)
// Синтетический лог событий продукта с зерном; кандидат собирает воронку (шаги, порядок, окно, подсчёт, разбивка, период, фильтр)
// и находит провал. Правда (truth.json) — только на сервере, клиенту уходит после ответа.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rng } = require('./sim-ab');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'knowledge-base', 'learning', 'sims', 'funnel');
const DAYS = 35;
const MAIN = ['release', 'channel', 'payment', 'tracking'];
const DISTRACT = ['slow', 'optional', 'dup', 'bots', 'none'];
const CAUSES = {
  release: 'баг в новой версии приложения', channel: 'нецелевой трафик из нового канала', payment: 'сбой оплаты / провайдера в стране',
  tracking: 'событие перестало отправляться (трекинг)', seasonality: 'сезонность / естественные колебания', ux: 'изменение интерфейса для всех',
};
const FLAGS = { window: 'медленный шаг — узкое окно занижает', order: 'необязательный шаг / другой порядок — строгий порядок занижает',
  dup: 'событие отправляется дважды — подсчёт событий завышает', bots: 'боты на входе — занижают конверсию первого шага', none: 'искажений нет' };
const DISTRACT_FLAG = { slow: 'window', optional: 'order', dup: 'dup', bots: 'bots', none: 'none' };
const PROPS = ['platform', 'source', 'country', 'version'];
const PLATFORMS = ['iOS', 'Android', 'Web'];

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const idOk = (id) => /^[a-z0-9-]{6,40}$/.test(String(id || ''));
const sdir = (id) => { if (!idOk(id)) throw err(400, 'плохой id'); return path.join(DIR, id); };
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const key = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const pick = (R, arr) => arr[Math.floor(R.u() * arr.length)];

// ---------- сценарий ----------
function normScenario(raw, opts = {}) {
  const s = raw || {};
  const str = (x, n = 600) => String(x || '').trim().slice(0, n);
  const seen = new Set();
  const ev = (e) => { const k = key(e?.key || e?.name); if (!k || seen.has(k)) return null; seen.add(k); return { key: k, name: str(e.name || k, 80), desc: str(e.desc, 200) }; };
  const steps = (Array.isArray(s.events) ? s.events : []).map(ev).filter(Boolean).slice(0, 6);
  if (steps.length < 4) throw new Error(`воронка: нужно 4–6 шагов, пришло ${steps.length}`);
  const extra = (Array.isArray(s.extra_events) ? s.extra_events : []).map(ev).filter(Boolean).slice(0, 2);
  const list = (x, def, n) => { const a = (Array.isArray(x) ? x : []).map((v) => key(v)).filter(Boolean); return [...new Set(a.length >= 2 ? a : def)].slice(0, n); };
  const conv = (Array.isArray(s.step_conv) ? s.step_conv : []).map(Number);
  const k = steps.length;
  const sc = {
    title: str(s.title, 120) || 'Воронка продукта', industry: str(s.industry || opts.industry, 60), product: str(s.product, 400), context: str(s.context, 1500),
    steps, extra,
    sources: list(s.sources, ['organic', 'paid_search', 'referral'], 4), countries: list(s.countries, ['pl', 'de', 'es'], 4).map((c) => c.toUpperCase().slice(0, 3)),
    versions: (Array.isArray(s.versions) ? s.versions : ['4.8', '4.9', '5.0']).map((v) => str(v, 10)).filter(Boolean).slice(0, 3),
    conv: Array.from({ length: k - 1 }, (_, i) => clamp(conv[i] || [0.55, 0.45, 0.4, 0.35, 0.5][i] || 0.4, 0.08, 0.92)),
    daily: Math.round(clamp(Number(s.daily_users) || 600, 200, 900)),
    money_step: Number.isInteger(Number(s.money_step)) && Number(s.money_step) > 0 && Number(s.money_step) < k ? Number(s.money_step) : null,
  };
  if (sc.versions.length < 2) sc.versions = ['4.9', '5.0'];
  return sc;
}

// Сервер выбирает главный провал и одну ловушку-искажение
function chooseTruth(sc, seed, force = {}) {
  const R = rng(seed + 11);
  const k = sc.steps.length;
  const mains = MAIN.filter((m) => m !== 'payment' || sc.money_step);
  const main = mains.includes(force.main) ? force.main : pick(R, mains);
  const D = 13 + Math.floor(R.u() * 10); // день начала провала
  const mid = 1 + Math.floor(R.u() * (k - 2)); // переход в шаг 1..k-2
  const t = { main, from_day: D };
  if (main === 'release') Object.assign(t, { step: mid, segment: { prop: 'version', value: sc.versions[sc.versions.length - 1] }, alt: { prop: 'platform', value: 'Android' }, factor: 0.35 });
  if (main === 'channel') Object.assign(t, { step: 1, segment: { prop: 'source', value: 'paid_social_new' }, factor: 0.3, volume: 0.6 });
  if (main === 'payment') Object.assign(t, { step: sc.money_step, segment: { prop: 'country', value: pick(R, sc.countries) }, factor: 0.3 });
  if (main === 'tracking') Object.assign(t, { step: mid, segment: { prop: 'platform', value: 'iOS' }, factor: 0 });
  const others = DISTRACT.filter((d) => !(d === 'bots' && main === 'channel'));
  const distract = others.includes(force.distract) ? force.distract : pick(R, others);
  t.distract = distract;
  const cand = Array.from({ length: k - 1 }, (_, i) => i + 1).filter((i) => i !== t.step);
  if (distract === 'slow') t.slow = pick(R, cand);
  if (distract === 'optional') t.optional = pick(R, cand.filter((i) => i < k - 1).length ? cand.filter((i) => i < k - 1) : cand);
  if (distract === 'dup') t.dup = pick(R, cand);
  if (distract === 'bots') t.bots = { source: 'direct', share: 0.3 };
  t.text = truthText(sc, t);
  return t;
}
function truthText(sc, t) {
  const st = (i) => `«${sc.steps[i - 1].key} → ${sc.steps[i].key}»`;
  const seg = `${t.segment.prop} = ${t.segment.value}`;
  const mains = {
    release: () => `с ${t.from_day + 1}-го дня у пользователей новой версии ${t.segment.value} (Android) конверсия ${st(t.step)} упала примерно втрое — баг в релизе`,
    channel: () => `с ${t.from_day + 1}-го дня пошёл трафик из нового канала ${t.segment.value}: много пользователей, почти не проходят ${st(t.step)} — нецелевой трафик`,
    payment: () => `с ${t.from_day + 1}-го дня в стране ${t.segment.value} конверсия ${st(t.step)} упала примерно втрое — сбой оплаты`,
    tracking: () => `с ${t.from_day + 1}-го дня на iOS перестало отправляться событие ${sc.steps[t.step].key}: пользователи идут дальше, но в строгой воронке «теряются» на ${st(t.step)} — это трекинг, а не поведение`,
  };
  const dists = {
    slow: () => `шаг ${st(t.slow)} медленный (медиана ~4 дня) — окно меньше недели занижает его конверсию`,
    optional: () => `шаг ${sc.steps[t.optional].key} необязательный: часть пользователей его пропускает или делает после следующего — строгий порядок занижает`,
    dup: () => `событие ${sc.steps[t.dup].key} на Web отправляется дважды — подсчёт событий вместо пользователей завышает этот шаг`,
    bots: () => 'около 30% входов — боты из source = direct (только первое событие, много раз) — занижают конверсию первого шага',
    none: () => 'искажений в данных нет',
  };
  const main = mains[t.main](), dis = dists[t.distract]();
  return { main, distract: dis, segment: seg };
}

// ---------- генерация лога ----------
// Пользователи: [id, day, platform, source, country, version]; события: [user, eventIndex, minute]
function generate(sc, t, seed) {
  const R = rng(seed);
  const all = [...sc.steps.map((s) => s.key), ...sc.extra.map((e) => e.key)];
  const users = [], events = [];
  const k = sc.steps.length;
  const share = (arr, w) => { const x = R.u() * w.reduce((a, b) => a + b, 0); let c = 0; for (let i = 0; i < arr.length; i++) { c += w[i]; if (x < c) return arr[i]; } return arr[arr.length - 1]; };
  const delay = (i) => { const med = t.slow === i ? 96 * 60 : (20 + 60 * i * R.u()) ; return Math.max(1, Math.round(med * Math.exp(0.8 * R.normal()))); };
  const lastV = sc.versions[sc.versions.length - 1];
  for (let d = 0; d < DAYS; d++) {
    const wd = [1, 1.02, 1.03, 1, 0.97, 0.8, 0.78][d % 7];
    let n = R.poisson(sc.daily * wd);
    const extraPaid = t.main === 'channel' && d >= t.from_day ? R.poisson(sc.daily * t.volume * wd) : 0;
    for (let j = 0; j < n + extraPaid; j++) {
      const id = users.length;
      const platform = share(PLATFORMS, [0.45, 0.35, 0.2]);
      const source = j >= n ? t.segment.value : share(sc.sources, sc.sources.map((_, i) => 1 / (i + 1)));
      const country = share(sc.countries, sc.countries.map((_, i) => 1 / (i + 1.3)));
      // Версия: на Web — web; у приложений новая версия появляется с дня D (release) или постепенно
      let version = 'web';
      if (platform !== 'Web') {
        const newShare = t.main === 'release' ? (d >= t.from_day ? (platform === 'Android' ? 0.75 : 0) : 0) : clamp((d - 10) / 30, 0, 0.5);
        version = R.u() < newShare ? lastV : sc.versions[Math.max(0, sc.versions.length - 2 - (R.u() < 0.3 ? 1 : 0))] || sc.versions[0];
      }
      users.push([id, d, platform, source, country, version]);
      let tm = d * 1440 + Math.floor(R.u() * 1440);
      events.push([id, 0, tm]);
      for (let i = 1; i < k; i++) {
        let p = sc.conv[i - 1];
        const inSeg = t.main !== 'tracking' && d >= t.from_day && i === t.step && (
          (t.main === 'release' && version === lastV) || (t.main === 'channel' && source === t.segment.value) || (t.main === 'payment' && country === t.segment.value));
        if (inSeg) p *= t.factor;
        if (t.main === 'channel' && i === 1 && source === t.segment.value && d >= t.from_day) p = sc.conv[0] * t.factor;
        if (R.u() >= p) break;
        tm += delay(i);
        const missing = t.main === 'tracking' && i === t.step && platform === 'iOS' && d >= t.from_day;
        if (t.optional === i && R.u() < 0.35) continue; // пропустил необязательный шаг
        if (!missing) {
          // Необязательный шаг иногда делают после следующего: время сдвигается вперёд
          const late = t.optional === i && R.u() < 0.3 ? tm + delay(i + 1) + 30 : tm;
          events.push([id, i, late]);
          if (t.dup === i && platform === 'Web') events.push([id, i, late + 1]);
        }
      }
      for (let x = 0; x < sc.extra.length; x++) { const c = Math.floor(R.u() * 3); for (let y = 0; y < c; y++) events.push([id, k + x, d * 1440 + Math.floor(R.u() * 2880)]); }
    }
    // Боты: только первое событие, по несколько раз
    if (t.bots) {
      const nb = R.poisson(sc.daily * t.bots.share * wd);
      for (let j = 0; j < nb; j++) {
        const id = users.length;
        users.push([id, d, 'Web', t.bots.source, sc.countries[0], 'web']);
        const c = 1 + Math.floor(R.u() * 4);
        for (let y = 0; y < c; y++) events.push([id, 0, d * 1440 + Math.floor(R.u() * 1440)]);
      }
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  return { names: all, users, events };
}
const cache = new Map();
function logOf(id) {
  if (cache.has(id)) return cache.get(id);
  const s = get(id);
  const L = generate(s.scenario, truthOf(id), s.seed);
  // Индекс событий по пользователю
  const byUser = new Map();
  for (const e of L.events) { if (!byUser.has(e[0])) byUser.set(e[0], []); byUser.get(e[0]).push(e); }
  L.byUser = byUser;
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  cache.set(id, L);
  return L;
}

// ---------- воронка ----------
function normQuery(q, sc) {
  const all = [...sc.steps.map((s) => s.key), ...sc.extra.map((e) => e.key)];
  const steps = (Array.isArray(q?.steps) ? q.steps : []).map(String).filter((x) => all.includes(x)).slice(0, 8);
  if (steps.length < 2) throw err(400, 'выбери хотя бы 2 шага');
  const ex = q?.exclude && PROPS.includes(q.exclude.prop) && q.exclude.value ? { prop: q.exclude.prop, value: String(q.exclude.value) } : null;
  return { steps, window_h: clamp(Math.round(Number(q?.window_h) || 24), 1, 24 * 30), order: q?.order === 'any' ? 'any' : 'strict', count: q?.count === 'events' ? 'events' : 'users',
    breakdown: PROPS.includes(q?.breakdown) ? q.breakdown : null, from_day: clamp(Math.round(Number(q?.from_day) || 0), 0, DAYS - 1),
    to_day: clamp(Math.round(Number(q?.to_day ?? DAYS - 1)), 0, DAYS - 1), exclude: ex, trend: q?.trend !== false };
}
const PROP_IDX = { platform: 2, source: 3, country: 4, version: 5 };
// Один пользователь: до какого шага дошёл, время до шагов, сколько событий шагов в окне
function walk(evs, idx, q) {
  const firsts = evs.filter((e) => e[1] === idx[0]);
  if (!firsts.length) return null;
  const t0 = firsts[0][2];
  const end = t0 + q.window_h * 60;
  const reached = [t0];
  if (q.order === 'strict') {
    let tp = t0;
    for (let i = 1; i < idx.length; i++) {
      const e = evs.find((x) => x[1] === idx[i] && x[2] >= tp && x[2] <= end);
      if (!e) break;
      reached.push(e[2]); tp = e[2];
    }
  } else {
    for (let i = 1; i < idx.length; i++) {
      const e = evs.find((x) => x[1] === idx[i] && x[2] >= t0 && x[2] <= end);
      if (!e) break;
      reached.push(e[2]);
    }
  }
  const counts = idx.map((ix, i) => (i < reached.length ? evs.filter((x) => x[1] === ix && x[2] >= t0 && x[2] <= end).length : 0));
  return { t0, reached, counts };
}
function funnel(id, raw) {
  const s = get(id);
  const q = normQuery(raw, s.scenario);
  const L = logOf(id);
  const idx = q.steps.map((k2) => L.names.indexOf(k2));
  const groups = new Map();
  const trend = new Map(); // день входа → [число на каждом шаге]
  const add = (g, w) => {
    if (!groups.has(g)) groups.set(g, { n: idx.map(() => 0), ev: idx.map(() => 0), time: idx.map(() => []) });
    const G = groups.get(g);
    w.reached.forEach((tm, i) => { G.n[i]++; G.time[i].push((tm - w.t0) / 60); });
    w.counts.forEach((c, i) => { G.ev[i] += c; });
  };
  for (const u of L.users) {
    if (q.exclude && String(u[PROP_IDX[q.exclude.prop]]) === q.exclude.value) continue;
    const evs = L.byUser.get(u[0]) || [];
    const w = walk(evs, idx, q);
    if (!w) continue;
    const day = Math.floor(w.t0 / 1440);
    if (day < q.from_day || day > q.to_day) continue;
    add('all', w);
    if (q.breakdown) add(String(u[PROP_IDX[q.breakdown]]), w);
    if (q.trend) {
      const tk = `${q.breakdown ? u[PROP_IDX[q.breakdown]] : 'all'}|${day}`;
      if (!trend.has(tk)) trend.set(tk, idx.map(() => 0));
      w.reached.forEach((_, i) => { trend.get(tk)[i]++; });
    }
  }
  const med = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return r3(b[Math.floor(b.length / 2)]); };
  const out = (G) => q.steps.map((k2, i) => {
    const v = q.count === 'events' ? G.ev[i] : G.n[i];
    const prev = i ? (q.count === 'events' ? G.ev[i - 1] : G.n[i - 1]) : v;
    const first = q.count === 'events' ? G.ev[0] : G.n[0];
    return { key: k2, value: v, fromPrev: prev ? r3(v / prev) : null, fromStart: first ? r3(v / first) : null, medianHours: i ? med(G.time[i]) : null };
  });
  const segs = [...groups.entries()].filter(([g]) => g !== 'all').sort((a, b) => b[1].n[0] - a[1].n[0]).slice(0, 8).map(([g, G]) => ({ value: g, steps: out(G) }));
  const series = {};
  for (const [tk, arr] of trend) { const [g, d] = tk.split('|'); (series[g] = series[g] || []).push({ day: Number(d), n: arr }); }
  for (const g of Object.keys(series)) series[g].sort((a, b) => a.day - b.day);
  const keep = new Set(['all', ...segs.slice(0, 5).map((x) => x.value)]);
  // В журнал — сборка (для оценки): шаги, окно, порядок, подсчёт, разбивка, фильтр
  if (!readJ(path.join(sdir(id), 'answer.json'))) {
    s.queries = [...(s.queries || []), { ...q, trend: undefined, at: now() }].slice(-60);
    save(id, s);
  }
  return { query: q, all: out(groups.get('all') || { n: idx.map(() => 0), ev: idx.map(() => 0), time: idx.map(() => []) }), segments: segs,
    trend: Object.fromEntries(Object.entries(series).filter(([g]) => keep.has(g))), days: DAYS };
}

// Словарь событий и пример лога — для исследования
function explore(id) {
  const s = get(id);
  const L = logOf(id);
  const counts = L.names.map(() => 0), usersWith = L.names.map(() => new Set());
  for (const e of L.events) { counts[e[1]]++; usersWith[e[1]].add(e[0]); }
  const R = rng(s.seed + 5);
  const sample = [];
  for (let i = 0; i < 6; i++) {
    const u = L.users[Math.floor(R.u() * L.users.length)];
    for (const e of (L.byUser.get(u[0]) || []).slice(0, 6)) sample.push({ time: minuteLabel(e[2]), user: `u${u[0]}`, event: L.names[e[1]], platform: u[2], source: u[3], country: u[4], version: u[5] });
  }
  const values = Object.fromEntries(PROPS.map((p) => [p, [...new Set(L.users.map((u) => String(u[PROP_IDX[p]])))].slice(0, 12)]));
  return { dictionary: L.names.map((n, i) => ({ key: n, name: [...s.scenario.steps, ...s.scenario.extra].find((x) => x.key === n)?.name || n,
    desc: [...s.scenario.steps, ...s.scenario.extra].find((x) => x.key === n)?.desc || '', events: counts[i], users: usersWith[i].size })),
    sample: sample.slice(0, 30), values, users: L.users.length, days: DAYS };
}
const minuteLabel = (m) => { const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return `день ${d + 1} ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };

// ---------- ответ и оценка ----------
function score(sim, t, a) {
  const sc = sim.scenario;
  const notes = [];
  const want = sc.steps[t.step].key;
  let fz = 0;
  if (a.step === want) fz += 15; else notes.push(`шаг провала — переход в «${want}»`);
  const segOk = a.segment?.prop === t.segment.prop && String(a.segment?.value) === String(t.segment.value);
  const segAlt = t.alt && a.segment?.prop === t.alt.prop && String(a.segment?.value) === String(t.alt.value);
  if (segOk) fz += 15; else if (segAlt) { fz += 8; notes.push(`сегмент точнее: ${t.segment.prop} = ${t.segment.value}`); } else notes.push(`сегмент — ${t.segment.prop} = ${t.segment.value}`);
  const dd = Math.abs((Number(a.from_day) || 0) - (t.from_day + 1));
  if (dd <= 2) fz += 15; else if (dd <= 5) { fz += 8; notes.push(`дата начала — ${t.from_day + 1}-й день`); } else notes.push(`дата начала — ${t.from_day + 1}-й день`);
  if (a.cause === t.main) fz += 15; else notes.push(`причина — ${CAUSES[t.main]}`);
  // Сборка: лучшая из запросов
  const qs = sim.queries || [];
  const canon = sc.steps.map((x) => x.key);
  const buildOf = (q) => {
    let b = 0;
    const inOrder = canon.filter((x) => q.steps.includes(x)).every((x, i, arr) => !i || q.steps.indexOf(x) > q.steps.indexOf(arr[i - 1]));
    if (canon.filter((x) => x !== canon[t.optional]).every((x) => q.steps.includes(x)) && inOrder) b += 10;
    if (q.window_h >= (t.slow ? 24 * 7 : 24)) b += 5;
    if (q.count === 'users') b += 5;
    return b;
  };
  let bz = qs.length ? Math.max(...qs.map(buildOf)) : 0;
  if (qs.some((q) => q.breakdown === t.segment.prop || (t.alt && q.breakdown === t.alt.prop))) bz += 5; else notes.push(`не разбивал по ${t.segment.prop} — провал виден именно там`);
  if (bz < 20) notes.push('сборка: все шаги по порядку, окно не уже нужного, считать пользователей');
  // Искажение
  const wantF = DISTRACT_FLAG[t.distract];
  const flags = a.flags || [];
  let dz = flags.includes(wantF) ? 15 : 0;
  if (!dz) notes.push(wantF === 'none' ? 'искажений не было — ложная тревога' : `не замечено: ${FLAGS[wantF]}`);
  dz = Math.max(0, dz - 3 * flags.filter((f) => f !== wantF && f !== 'none').length);
  const total = fz + bz + dz;
  return { total, findings: fz, build: bz, distort: dz, correct: a.step === want && (segOk || segAlt) && a.cause === t.main && dd <= 5, notes };
}
function answer(id, body) {
  const s = get(id);
  if (readJ(path.join(sdir(id), 'answer.json'))) throw err(409, 'ответ уже дан');
  const sc = s.scenario;
  const a = { step: sc.steps.map((x) => x.key).includes(body?.step) ? body.step : null,
    segment: PROPS.includes(body?.segment?.prop) ? { prop: body.segment.prop, value: String(body.segment.value || '').slice(0, 60) } : null,
    from_day: clamp(Math.round(Number(body?.from_day) || 0), 0, DAYS), cause: CAUSES[body?.cause] ? body.cause : null,
    flags: (Array.isArray(body?.flags) ? body.flags : []).filter((f) => FLAGS[f]), text: String(body?.text || '').trim().slice(0, 3000),
    abtest: String(body?.abtest || '').trim().slice(0, 1500), at: now() };
  if (!a.step || !a.segment || !a.cause) throw err(400, 'укажи шаг, сегмент и причину');
  const t = truthOf(id);
  a.score = score(s, t, a);
  writeJ(path.join(sdir(id), 'answer.json'), a);
  return a;
}
// «Как надо было»: воронка правильной сборкой с разбивкой по сегменту провала
function idealQuery(sc, t) {
  return { steps: sc.steps.map((x) => x.key).filter((_, i) => i !== t.optional), window_h: t.slow ? 24 * 7 : 72, order: t.optional ? 'any' : 'strict', count: 'users',
    breakdown: t.segment.prop, from_day: 0, to_day: DAYS - 1, exclude: t.bots ? { prop: 'source', value: t.bots.source } : null, trend: true };
}

// ---------- хранение ----------
function get(id) { const s = readJ(path.join(sdir(id), 'sim.json')); if (!s) throw err(404, 'нет такой воронки'); return s; }
function save(id, s) { s.updated = now(); writeJ(path.join(sdir(id), 'sim.json'), s); return s; }
const truthOf = (id) => readJ(path.join(sdir(id), 'truth.json'));
function create({ industry = '', course = null, preset = {} } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const id = `${new Date().toISOString().slice(0, 10)}-f${crypto.randomUUID().slice(0, 5)}`;
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const s = { id, seed, industry: String(industry || '').slice(0, 60), course, preset: { main: preset.main || null, distract: preset.distract || null }, scenario: null, queries: [], created: now() };
  return save(id, s);
}
function setScenario(id, raw) {
  const s = get(id);
  s.scenario = { ...normScenario(raw, { industry: s.industry }), ready: true };
  writeJ(path.join(sdir(id), 'truth.json'), chooseTruth(s.scenario, s.seed, s.preset || {}));
  cache.delete(id);
  return save(id, s);
}
function status(id, s = get(id)) {
  if (fs.existsSync(path.join(sdir(id), 'answer.json'))) return 'done';
  if (s.scenario?.ready) return (s.queries || []).length ? 'running' : 'design';
  return 'draft';
}
function publicView(id) {
  const s = get(id);
  const a = readJ(path.join(sdir(id), 'answer.json'));
  const out = { id, industry: s.industry, scenario: s.scenario, status: status(id, s), created: s.created, course: s.course || null, queries: (s.queries || []).slice(-10),
    answer: a, debrief: readJ(path.join(sdir(id), 'debrief.json')), causes: CAUSES, flags: FLAGS, props: PROPS };
  if (a) {
    const t = truthOf(id);
    out.truth = { main: t.main, step: s.scenario.steps[t.step].key, segment: t.segment, from_day: t.from_day + 1, distract: t.distract, text: t.text, ideal: idealQuery(s.scenario, t) };
  }
  return out;
}
function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(idOk).map((id) => {
    const s = readJ(path.join(DIR, id, 'sim.json'));
    if (!s) return null;
    const a = readJ(path.join(DIR, id, 'answer.json'));
    return { id, title: s.scenario?.title || 'Воронка', industry: s.scenario?.industry || s.industry, status: status(id, s), created: s.created,
      score: a?.score?.total ?? null, correct: a?.score?.correct ?? null, course: s.course || null };
  }).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}
const setDebrief = (id, d) => writeJ(path.join(sdir(id), 'debrief.json'), d);
function remove(id) { cache.delete(id); fs.rmSync(sdir(id), { recursive: true, force: true }); }

module.exports = { DIR, DAYS, MAIN, DISTRACT, CAUSES, FLAGS, PROPS, normScenario, chooseTruth, generate, walk, normQuery, funnel, explore, answer, score, idealQuery,
  get, save, create, setScenario, status, publicView, list, truthOf, setDebrief, remove, sdir, idOk, logOf };
