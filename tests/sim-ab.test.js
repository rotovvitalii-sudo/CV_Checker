// C22: статистика движка против эталона (tests/sim_ab_fixtures.py, stdlib NormalDist) + свойства движка.
// Запуск: node tests/sim-ab.test.js
const S = require('../web/sim-ab');
const fx = require('./fixtures/sim_ab.json');
let fail = 0, ok = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const check = (cond, msg) => { if (cond) ok++; else { fail++; console.log('FAIL', msg); } };

for (const f of fx.prop) {
  const r = S.propTest(...f.in);
  check(Math.abs(r.p - f.p) < 1e-6, `p-value ${f.in} ${r.p} vs ${f.p}`);
  check(near(r.lo, f.lo, 1e-6) && near(r.hi, f.hi, 1e-6), `CI ${f.in}`);
}
for (const f of fx.size) { const n = S.sampleSize(f.in); check(Math.abs(n - f.n) <= 1, `sample size ${JSON.stringify(f.in)} ${n} vs ${f.n}`); }
for (const f of fx.srm) { const r = S.srmTest(...f.in); check(Math.abs(r.p - f.p) < 1e-6, `SRM ${f.in} ${r.p} vs ${f.p}`); }

// Свойства движка: одно зерно — одни данные; A/A без смещения; SRM и Симпсон воспроизводятся
const mk = (trap, seed, extra = {}) => {
  const t = S.chooseTruth(3, seed, trap);
  const sc = S.normScenario({ traffic_per_day: 6000, base_conv: 0.05, aov: 40, extra_metrics: [{ name: 'Refunds', better: 'down', base: 0.03 }] }, t, { seed });
  const d = S.normDesign({ primary: 'conv', guards: ['rpv', 'g1'], mde: 0.05, days: 28, hypothesis: 'x'.repeat(40), ...extra }, sc);
  return { sc, t, d, days: S.generate(sc, t, d, seed * 31) };
};
const a = mk('flat', 5), b = mk('flat', 5);
check(JSON.stringify(a.days) === JSON.stringify(b.days), 'одно зерно — одни данные');
const res = (x, day = 28, seg = null) => S.results({ scenario: x.sc, design: x.d, run: { days: x.days, until: 28, day } }, day, seg);
let srmFlag = 0, simpsonFlip = 0;
for (let i = 1; i <= 20; i++) {
  if (res(mk('srm', i)).srm.flag) srmFlag++;
  const s = mk('simpson', i), all = res(s).metrics[0].rel, mob = res(s, 28, 'mobile').metrics[0].rel, desk = res(s, 28, 'desktop').metrics[0].rel;
  if (all > 0 && mob < 0 && desk < 0) simpsonFlip++;
}
check(srmFlag >= 19, `SRM ловится проверкой: ${srmFlag}/20`);
check(simpsonFlip >= 15, `Симпсон: в целом плюс, в сегментах минус: ${simpsonFlip}/20`);
// Истина не уходит в публичный вид до решения — проверка на диске
check(!('trap' in (S.normScenario({}, S.chooseTruth(1, 1)) || {})), 'сценарий без ловушки');
// Оценка: ранняя остановка штрафуется
const x = mk('win', 3);
const sim = { scenario: x.sc, design: x.d, truth: x.t, log: { views: [], segments: 0 }, run: { days: x.days } };
const at = res(x, 28); at.need = S.calc(x.sc, x.d).perArm;
const late = S.score(sim, { decision: 'ship', flags: ['none'], day: 28, at });
const early = S.score(sim, { decision: 'ship', flags: ['none'], day: 5, at });
check(late.process - early.process === 12, `ранняя остановка −12: ${late.process} / ${early.process}`);
console.log(`sim-ab: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
