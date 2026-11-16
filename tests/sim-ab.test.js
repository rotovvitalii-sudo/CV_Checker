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
// C24 · байес: P(B>A) против точной формулы (Evan Miller), prior сжимает оценку, правило остановки, оценка по правилу
const lg = (x) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let ss = 1.000000000190015; for (const k of c) ss += k / ++y; return -t + Math.log(2.5066282746310005 * ss / x); };
const lbeta = (a1, b1) => lg(a1) + lg(b1) - lg(a1 + b1);
const pBgtA = (aA, bA, aB, bB) => { let t = 0; for (let i = 0; i < aB; i++) t += Math.exp(lbeta(aA + i, bA + bB) - Math.log(bB + i) - lbeta(1 + i, bB) - lbeta(aA, bA)); return t; };
for (const [nA, xA, nB, xB] of [[1000, 40, 1000, 52], [5000, 200, 5000, 215], [800, 30, 820, 25], [3000, 90, 3000, 120]]) {
  const r = S.bayes('prop', { n: nA, x: xA }, { n: nB, x: xB }, 'up', 200000, 3);
  const exact = 1 - pBgtA(1 + xB, 1 + nB - xB, 1 + xA, 1 + nA - xA);
  check(Math.abs(r.pBetter - exact) < 0.005, `байес P(B>A) ${r.pBetter} vs ${exact}`);
}
const flat = S.bayes('prop', { n: 3000, x: 120 }, { n: 3000, x: 150 }, 'up', 20000, 1, { ci: true });
const strong = S.bayes('prop', { n: 3000, x: 120 }, { n: 3000, x: 150 }, 'up', 20000, 1, { ci: true, prior: { a: 300, b: 4700 } });
check(strong.mean < flat.mean && strong.ci[1] - strong.ci[0] < flat.ci[1] - flat.ci[0], 'сильный prior сжимает оценку и интервал');
const bsc = S.normScenario({ traffic_per_day: 6000, base_conv: 0.05, aov: 40 }, S.chooseTruth(5, 9, 'b_win'), { seed: 9 });
const bd = S.normDesign({ method: 'bayes', primary: 'conv', guards: ['rpv'], mde: 0.05, days: 28, hypothesis: 'x'.repeat(40), threshold: 0.002, rope: 0.01 }, bsc);
check(bd.method === 'bayes' && bd.prior.type === 'flat' && bd.threshold === 0.002, 'байесовский дизайн нормализуется');
const bt = S.chooseTruth(5, 9, 'b_win'); const bdays = S.generate(bsc, bt, bd, 77);
const bsim = { scenario: bsc, design: bd, truth: bt, log: { views: [] }, run: { days: bdays, until: 28, day: 28 } };
let ruleDay = null; for (let d = 1; d <= 28 && !ruleDay; d++) if (S.results(bsim, d).rule.ok.includes('ship')) ruleDay = d;
check(ruleDay && ruleDay < 28, `правило потерь срабатывает раньше бюджета: день ${ruleDay}`);
const atR = S.results(bsim, ruleDay); const byRule = S.score(bsim, { decision: 'ship', flags: ['none'], day: ruleDay, at: { rule: atR.rule } });
const before = S.score(bsim, { decision: 'ship', flags: ['none'], day: 1, at: { rule: S.results(bsim, 1).rule } });
check(byRule.correct && byRule.process === 30, `остановка по правилу без штрафа: процесс ${byRule.process}`);
check(before.process < byRule.process || S.results(bsim, 1).rule.ok.includes('ship'), 'решение до правила штрафуется');
const fsc = S.normScenario({ traffic_per_day: 6000, base_conv: 0.05, aov: 40 }, S.chooseTruth(5, 4, 'b_flat'), { seed: 4 });
const fd = S.normDesign({ method: 'bayes', primary: 'conv', guards: ['rpv'], mde: 0.05, days: 28, hypothesis: 'x'.repeat(40), threshold: 0.002, rope: 0.05 }, fsc);
const ft = S.chooseTruth(5, 4, 'b_flat');
const fsim = { scenario: fsc, design: fd, truth: ft, log: { views: [] }, run: { days: S.generate(fsc, ft, fd, 5), until: 28, day: 28 } };
const eq = S.score(fsim, { decision: 'equivalent', flags: ['none'], day: 28, at: { rule: S.results(fsim, 28).rule } });
check(eq.correct, '«разницы нет» через ROPE засчитывается при нулевом эффекте');
console.log(`sim-ab: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
