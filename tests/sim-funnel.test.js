// C24: подсчёт воронки против независимого перебора + свойства движка воронок. Запуск: node tests/sim-funnel.test.js
const F = require('../web/sim-funnel');
let ok = 0, fail = 0;
const check = (c, m) => { if (c) ok++; else { fail++; console.log('FAIL', m); } };
const raw = { title: 't', events: [{ key: 'signup' }, { key: 'kyc_done' }, { key: 'deposit' }, { key: 'trade' }], extra_events: [{ key: 'app_open' }],
  sources: ['organic', 'paid_search', 'referral'], countries: ['PL', 'DE', 'ES'], versions: ['4.8', '4.9', '5.0'], step_conv: [0.6, 0.45, 0.7], daily_users: 400, money_step: 2 };
const sc = F.normScenario(raw);
// Эталон: для каждого пользователя — жадный строгий проход по времени, без общих функций движка
function brute(L, steps, W, order) {
  const idx = steps.map((k) => L.names.indexOf(k)), n = steps.map(() => 0);
  const by = new Map(); for (const e of L.events) { if (!by.has(e[0])) by.set(e[0], []); by.get(e[0]).push(e); }
  for (const [, evs] of by) {
    evs.sort((a, b) => a[2] - b[2]);
    const s0 = evs.find((e) => e[1] === idx[0]); if (!s0) continue;
    const end = s0[2] + W * 60; let t = s0[2], reached = 1;
    for (let i = 1; i < idx.length; i++) {
      const e = order === 'strict' ? evs.find((x) => x[1] === idx[i] && x[2] >= t && x[2] <= end) : evs.find((x) => x[1] === idx[i] && x[2] >= s0[2] && x[2] <= end);
      if (!e) break; reached++; if (order === 'strict') t = e[2];
    }
    for (let i = 0; i < reached; i++) n[i]++;
  }
  return n;
}
for (const [main, dis] of [['release', 'slow'], ['payment', 'optional'], ['tracking', 'dup'], ['channel', 'none']]) {
  const t = F.chooseTruth(sc, 21, { main, distract: dis });
  const L = F.generate(sc, t, 21);
  const by = new Map(); for (const e of L.events) { if (!by.has(e[0])) by.set(e[0], []); by.get(e[0]).push(e); }
  for (const [W, order] of [[24, 'strict'], [168, 'any']]) {
    const q = { steps: sc.steps.map((s) => s.key), window_h: W, order, count: 'users' };
    const idx = q.steps.map((k) => L.names.indexOf(k)), n = q.steps.map(() => 0);
    for (const u of L.users) { const w = F.walk(by.get(u[0]) || [], idx, q); if (w) w.reached.forEach((_, i) => n[i]++); }
    const b = brute(L, q.steps, W, order);
    check(JSON.stringify(n) === JSON.stringify(b), `${main}/${dis} ${W}ч ${order}: ${n} vs ${b}`);
  }
  const L2 = F.generate(sc, t, 21);
  check(JSON.stringify(L.events.slice(0, 50)) === JSON.stringify(L2.events.slice(0, 50)), `${main}: одно зерно — один лог`);
  check(t.text.main && t.text.distract && sc.steps[t.step], `${main}: правда описана`);
}
// Медленный шаг: окно 7 дней видит заметно больше, чем 1 день
{
  const t = F.chooseTruth(sc, 5, { main: 'release', distract: 'slow' }); const L = F.generate(sc, t, 5);
  const steps = sc.steps.map((s) => s.key);
  const a = brute(L, steps, 24, 'strict'), b = brute(L, steps, 168, 'strict');
  check(b[t.slow] > a[t.slow] * 3, `медленный шаг: окно 7 дн ${b[t.slow]} против 1 дн ${a[t.slow]}`);
}
// Дубли: событий на шаге больше, чем пользователей
{
  const t = F.chooseTruth(sc, 6, { main: 'payment', distract: 'dup' }); const L = F.generate(sc, t, 6);
  const ix = L.names.indexOf(sc.steps[t.dup].key);
  const evs = L.events.filter((e) => e[1] === ix).length, users = new Set(L.events.filter((e) => e[1] === ix).map((e) => e[0])).size;
  check(evs > users * 1.1, `дубли: событий ${evs} > пользователей ${users}`);
}
// Оценка: верный ответ и полная сборка — 100
{
  const t = F.chooseTruth(sc, 8, { main: 'payment', distract: 'none' });
  const sim = { scenario: sc, queries: [{ ...F.idealQuery(sc, t), breakdown: t.segment.prop }] };
  const r = F.score(sim, t, { step: sc.steps[t.step].key, segment: t.segment, from_day: t.from_day + 1, cause: t.main, flags: ['none'] });
  check(r.total === 100 && r.correct, `идеальный ответ: ${r.total}`);
  const wrong = F.score({ scenario: sc, queries: [] }, t, { step: sc.steps[1].key, segment: { prop: 'platform', value: 'iOS' }, from_day: 1, cause: 'ux', flags: [] });
  check(!wrong.correct && wrong.total < 30, `неверный ответ: ${wrong.total}`);
}
console.log(`sim-funnel: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
