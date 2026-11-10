// ---------- C22: симулятор A/B-тестов (docs/specs/47-ab-simulator.md) ----------
// #/learn/sim — список, статистика, новый тест; #/learn/sim/own — свой тест; #/learn/sim/<id> — тест.
// Истину сервер отдаёт только после решения; здесь — дизайн, запуск, результаты по дням, решение, разбор.

let simMeta = null;
let simTimer = null;
let simCalcTimer = null;
const simUI = { id: null, day: 1, seg: '', daily: false, res: null };

const SIM_SEGS = [['', 'все'], ['mobile', 'мобильные'], ['desktop', 'десктоп'], ['new', 'новые'], ['returning', 'вернувшиеся']];
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const pctS = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const signPct = (x, d = 1) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const num = (x) => (x == null ? '—' : Number(x).toLocaleString('ru-RU'));

async function loadSim(sub) {
  clearTimeout(simTimer);
  const root = $('#learnView');
  const rest = sub.replace(/^sim\/?/, '');
  if (!simMeta) { try { simMeta = await api('/api/sim/ab'); } catch (e) { root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`; return; } }
  if (rest === 'own') return renderSimOwn();
  if (rest) return renderSim(rest);
  return renderSimHome();
}

function simTabs(active) {
  const d = learnData;
  const tabs = [['', `Курсы${d ? ` · ${d.courses.length}` : ''}`], ['topics', `Все темы${d ? ` · ${d.topics.length}` : ''}`], ['sim', 'Симулятор']];
  return `<div class="seg" role="group" aria-label="Раздел обучения">${tabs.map(([k, l]) => `<button type="button" data-ltab="${k}" aria-pressed="${active === k}">${l}</button>`).join('')}</div>`;
}
function bindTabs() {
  document.querySelectorAll('[data-ltab]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.ltab ? `#/learn/${b.dataset.ltab}` : '#/learn'; }));
}

// ---------- список ----------
async function renderSimHome() {
  const root = $('#learnView');
  try { simMeta = await api('/api/sim/ab'); } catch (e) { root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`; return; }
  if (!learnData) { try { learnData = await api('/api/learn'); } catch { /* вкладки без счётчиков */ } }
  const m = simMeta, st = m.stats;
  root.innerHTML = `<div class="page-wrap">
    <section class="home-head"><div><h1>Обучение</h1>
      <p class="lead">Симулятор A/B-тестов: ситуация → дизайн → синтетический трафик → решение → разбор. Правда об эффекте раскрывается только после твоего решения.</p></div>
      <a class="btn" href="#/learn/sim/own">+ Свой тест</a></section>
    <section class="stack">${simTabs('sim')}
      <form class="card stack" id="simNew">
        <h2 style="margin:0">Новый тест</h2>
        <div class="sim-levels">${Object.entries(m.levels).map(([k, l]) => `<label class="sim-level"><input type="radio" name="level" value="${k}" ${Number(k) === st.next ? 'checked' : ''}>
          <span><strong>${k}. ${esc(l.title)}</strong>${Number(k) === st.next ? ' <span class="chip">рекомендую</span>' : ''}<span class="muted small">${esc(l.text)}</span></span></label>`).join('')}</div>
        <div class="row"><label class="row" style="gap:6px;margin:0">Продукт <select name="industry"><option value="">любой</option>${m.industries.map((i) => `<option>${esc(i)}</option>`).join('')}</select></label>
          <button type="submit" class="primary">Получить ситуацию</button><span class="hint" style="margin:0">Haiku пишет историю ≈ $0.01, ~15 с; эффект и ловушку выбирает сервер.</span></div>
        <p class="error" id="simNewErr"></p>
      </form>
      ${simStatsHtml(m)}
      ${simListHtml(m)}
    </section></div>`;
  bindTabs();
  $('#simNew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { id } = await api('/api/sim/ab', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      location.hash = `#/learn/sim/${id}`;
    } catch (err) { $('#simNewErr').textContent = err.message; btn.disabled = false; }
  });
}

function simStatsHtml(m) {
  const s = m.stats;
  if (!s.done) return '';
  const trend = s.before != null && s.recent != null ? ` · последние 5: ${s.recent}% (до этого ${s.before}%)` : '';
  return `<section class="card stack"><h2 style="margin:0">Прогресс</h2>
    <div class="sim-kpis">
      <div><span class="muted small">тестов</span><strong>${s.done}</strong></div>
      <div><span class="muted small">верных решений</span><strong>${s.correctShare}%</strong></div>
      <div><span class="muted small">средняя оценка</span><strong>${s.avg.total}</strong></div>
      <div><span class="muted small">дизайн · процесс · решение</span><strong>${s.avg.design}/30 · ${s.avg.process}/30 · ${s.avg.decision}/40</strong></div>
    </div>
    ${trend ? `<p class="muted small" style="margin:0">${trend.slice(3)}</p>` : ''}
    ${s.traps.length ? `<table class="apps small"><thead><tr><th>Что надо было заметить</th><th>Встречалось</th><th>Поймано</th></tr></thead><tbody>
      ${s.traps.map((t) => `<tr><td>${esc(t.title)}</td><td>${t.seen}</td><td>${t.caught}${t.caught < t.seen ? ' <span class="warn-text">·</span>' : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    ${s.weak ? `<p class="small" style="margin:0">Слабое место: <strong>${esc(s.weak.title)}</strong> (пропущено ${s.weak.seen - s.weak.caught} из ${s.weak.seen}).
      ${m.lesson ? `Повтори урок <a href="#/learn/topics">${esc(m.lesson.title)}</a>.` : ''}</p>` : ''}</section>`;
}

function simListHtml(m) {
  if (!m.list.length) return '<div class="table-box empty-box">Тестов пока нет. Начни с уровня 1: чистый тест без ловушек.</div>';
  const stLabel = { draft: 'ситуация пишется', questions: 'нужны ответы', design: 'дизайн', running: 'идёт', done: 'разобран' };
  return `<div class="table-box"><table class="apps"><thead><tr><th>Тест</th><th>Уровень</th><th>Статус</th><th>Оценка</th></tr></thead><tbody>
    ${m.list.map((x) => `<tr class="clickable" data-sim="${esc(x.id)}"><td><a href="#/learn/sim/${esc(x.id)}">${esc(x.title)}</a><div class="muted small">${esc(x.industry || (x.source === 'own' ? 'свой тест' : ''))} · ${esc(String(x.created).slice(0, 10))}</div></td>
      <td>${x.level ? `${x.level}` : '<span class="chip">свой</span>'}</td><td>${stLabel[x.status] || x.status}</td>
      <td>${x.score != null ? `<strong>${x.score}</strong>${x.correct ? ' <span class="pill good">верно</span>' : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- свой тест ----------
function renderSimOwn() {
  $('#learnView').innerHTML = `<div class="page-wrap"><a href="#/learn/sim" class="back">← Симулятор</a>
    <h1>Свой тест</h1>
    <p class="lead">Опиши тест словами, напиши гипотезу или приложи скриншоты A и B. Sonnet предложит правдоподобные исходные цифры и диапазон эффекта — дальше тот же цикл. Это модель, не прогноз.</p>
    <form class="card stack" id="simOwn">
      <label>Что тестируем<textarea name="description" rows="5" placeholder="Онбординг мобильного приложения: в B убрали шаг выбора интересов, сразу показываем ленту…"></textarea></label>
      <label>Гипотеза <span class="muted small">необязательно</span><textarea name="hypothesis" rows="2" placeholder="Если убрать шаг выбора интересов, то активация D1 вырастет, потому что…"></textarea></label>
      <div class="form-grid two">
        <label>Метрика <span class="muted small">необязательно</span><input name="metric" placeholder="активация D1"></label>
        <label>Отрасль <span class="muted small">необязательно</span><input name="industry" placeholder="мобильное приложение"></label>
      </div>
      <label>Скриншоты A и B <span class="muted small">PNG / JPG, до 4</span><input type="file" name="shots" accept="image/png,image/jpeg,image/webp" multiple></label>
      <div class="row"><button type="submit" class="primary">Разобрать тест</button><span class="hint" style="margin:0">Sonnet читает текст и картинки ≈ $0.05–0.1, ~1 мин.</span></div>
      <p class="error" id="simOwnErr"></p>
    </form></div>`;
  $('#simOwn').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]');
    const files = [...f.shots.files].slice(0, 4);
    btn.disabled = true;
    try {
      const { id } = await api('/api/sim/ab/own', { method: 'POST', body: { description: f.description.value, hypothesis: f.hypothesis.value, metric: f.metric.value, industry: f.industry.value } });
      for (const file of files) {
        const r = await fetch(`/api/sim/ab/${id}/assets?name=${enc(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        if (!r.ok) throw new Error(`${file.name}: ${(await r.json().catch(() => ({}))).error || r.status}`);
      }
      await api(`/api/sim/ab/${id}/own-run`, { method: 'POST', body: {} });
      location.hash = `#/learn/sim/${id}`;
    } catch (err) { $('#simOwnErr').textContent = err.message; btn.disabled = false; }
  });
}

// ---------- тест ----------
async function renderSim(id, quiet = false) {
  clearTimeout(simTimer);
  const root = $('#learnView');
  let v;
  try { v = await api(`/api/sim/ab/${enc(id)}`); } catch (e) { root.innerHTML = `<div class="page-wrap"><a href="#/learn/sim" class="back">← Симулятор</a><p class="error">${esc(e.message)}</p></div>`; return; }
  if (location.hash !== `#/learn/sim/${id}`) return;
  if (simUI.id !== id) Object.assign(simUI, { id, day: v.run?.day || 1, seg: '', daily: false, res: null });
  const busy = Object.values(v.jobs || {}).some(jobBusy);
  if (quiet && busy) { simTimer = setTimeout(() => renderSim(id, true), 3000); return; }
  root.innerHTML = `<div class="page-wrap"><a href="#/learn/sim" class="back">← Симулятор</a>${simHtml(v)}</div>`;
  bindSim(v);
  if (busy) simTimer = setTimeout(() => renderSim(id, true), 3000);
  if (v.run) loadSimResults(v);
}

function simJobBox(j, label) {
  if (!j) return '';
  if (jobBusy(j)) return `<div class="running"><span class="spin"></span>${label}</div>`;
  if (j.state === 'error') return `<p class="error">Ошибка: ${esc(j.error)}</p>`;
  return '';
}

function simHtml(v) {
  const sc = v.scenario;
  const head = `<section class="home-head"><div><h1>${esc(sc?.title || (v.source === 'own' ? 'Свой тест' : 'A/B-тест'))}</h1>
      <p class="lead">${v.level ? `Уровень ${v.level} · ` : 'Свой тест · '}${esc(sc?.industry || v.industry || '')}</p></div>
      <button type="button" class="link-btn" id="simDel">удалить</button></section>`;
  if (!sc?.ready) {
    const j = v.jobs.scenario || v.jobs.own;
    let body = simJobBox(j, v.source === 'own' ? 'Sonnet разбирает твой тест…' : 'Пишу ситуацию…');
    if (v.questions.length && !jobBusy(j)) body += `<section class="card stack"><h2 style="margin:0">Не хватает данных</h2>
      <p class="muted small" style="margin:0">Симуляция не стартует на догадке. Ответь — и разберу ещё раз.</p>
      <ol class="small">${v.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>
      <textarea id="simAns" rows="4" placeholder="Ответы"></textarea><div class="row"><button type="button" class="primary small" id="simAnsGo">Разобрать ещё раз</button></div></section>`;
    if (!jobBusy(j) && !v.questions.length) body += `<div class="row"><button type="button" class="primary small" id="simRetry">${j?.state === 'error' ? 'Повторить' : v.source === 'own' ? 'Разобрать тест' : 'Получить ситуацию'}</button></div>`;
    if (v.own) body += simOwnInputHtml(v);
    return head + body;
  }
  return head + simScenarioHtml(v) + (v.run ? simRunHtml(v) : simDesignHtml(v)) + (v.decision ? simDebriefHtml(v) : '');
}

function simOwnInputHtml(v) {
  return `<details class="card"><summary class="small">Твоё описание${v.own.assets.length ? ` и скриншоты · ${v.own.assets.length}` : ''}</summary>
    <p class="small" style="white-space:pre-wrap">${esc(v.own.description)}</p>${v.own.hypothesis ? `<p class="small"><strong>Гипотеза:</strong> ${esc(v.own.hypothesis)}</p>` : ''}
    <div class="sim-shots">${v.own.assets.map((a) => `<a href="/api/sim/ab/${enc(v.id)}/assets/${enc(a.file)}" target="_blank"><img src="/api/sim/ab/${enc(v.id)}/assets/${enc(a.file)}" alt="${esc(a.name)}"></a>`).join('')}</div></details>`;
}

function simScenarioHtml(v) {
  const sc = v.scenario;
  return `<section class="card stack">
    ${sc.product ? `<p style="margin:0"><strong>Продукт.</strong> ${esc(sc.product)}</p>` : ''}
    <p style="margin:0">${esc(sc.context)}</p>
    ${sc.problem ? `<p style="margin:0"><strong>Проблема.</strong> ${esc(sc.problem)}</p>` : ''}
    <div class="sim-ab"><div><span class="chip">A · сейчас</span><p class="small" style="margin:4px 0 0">${esc(sc.change_a)}</p></div>
      <div><span class="chip">B · изменение</span><p class="small" style="margin:4px 0 0">${esc(sc.change_b)}</p></div></div>
    <div class="sim-kpis">
      <div><span class="muted small">трафик в день</span><strong>${num(sc.traffic)}</strong></div>
      <div><span class="muted small">${esc(sc.metrics[0].name)}</span><strong>${pctS(sc.base)}</strong></div>
      <div><span class="muted small">средний чек</span><strong>${esc(sc.currency)}${num(sc.aov)}</strong></div>
      ${sc.metrics.filter((m) => m.key.startsWith('g')).map((m) => `<div><span class="muted small">${esc(m.name)} ${m.better === 'down' ? '↓ лучше' : '↑ лучше'}</span><strong>${pctS(m.base)}</strong></div>`).join('')}
    </div>
    ${sc.rationale ? `<p class="muted small" style="margin:0"><strong>Откуда цифры:</strong> ${esc(sc.rationale)} · <em>${esc(sc.model_note || '')}</em></p>` : ''}
    ${v.own ? simOwnInputHtml(v) : ''}
    <p class="muted small" style="margin:0">Сегменты: устройство (мобильные / десктоп) и новые / вернувшиеся. Тест стартует в понедельник.</p>
  </section>`;
}

// ---------- дизайн ----------
function simDesignHtml(v) {
  const sc = v.scenario, d = v.design || { hypothesis: '', primary: 'conv', guards: [], mde: 0.05, alpha: 0.05, power: 0.8, split: 0.5, days: 14 };
  const opt = (arr, cur) => arr.map(([val, l]) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${l}</option>`).join('');
  return `<form class="card stack" id="simDesign"><h2 style="margin:0">Дизайн теста</h2>
    <label>Гипотеза<textarea name="hypothesis" rows="3" placeholder="Если …, то … вырастет на …, потому что …">${esc(d.hypothesis)}</textarea></label>
    <div class="form-grid two">
      <label>Главная метрика<select name="primary">${opt(sc.metrics.map((m) => [m.key, m.name]), d.primary)}</select></label>
      <div><span class="small">Защитные метрики</span><div class="row" style="flex-wrap:wrap;gap:4px 14px">${sc.metrics.map((m) => `<label class="sim-opt"><input type="checkbox" name="guards" value="${m.key}" ${d.guards.includes(m.key) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('')}</div></div>
      <label>Минимальный эффект (MDE), % отн.<input type="number" name="mde" min="0.5" max="100" step="0.5" value="${Math.round(d.mde * 1000) / 10}"></label>
      <label>Длительность, дней<input type="number" name="days" min="1" max="56" value="${d.days}"></label>
      <label>α (уровень значимости)<select name="alpha">${opt([[0.01, '0.01'], [0.05, '0.05'], [0.1, '0.10']], d.alpha)}</select></label>
      <label>Мощность<select name="power">${opt([[0.8, '80%'], [0.9, '90%']], d.power)}</select></label>
      <label>Разделение A / B<select name="split">${opt([[0.5, '50 / 50'], [0.2, '80 / 20'], [0.1, '90 / 10']], d.split)}</select></label>
    </div>
    <div id="simCalc" class="sim-calc"></div>
    <div class="row"><button type="submit" class="primary">Запустить тест</button><span class="hint" style="margin:0">Дизайн фиксируется. Дни генерируются сразу — листаешь мгновенно; просмотр до конца плана считается подглядыванием.</span></div>
    <p class="error" id="simDesignErr"></p></form>`;
}
function readDesign(f) {
  return { hypothesis: f.hypothesis.value, primary: f.primary.value, guards: [...f.querySelectorAll('[name=guards]:checked')].map((x) => x.value).filter((k) => k !== f.primary.value),
    mde: Number(f.mde.value) / 100, days: Number(f.days.value), alpha: Number(f.alpha.value), power: Number(f.power.value), split: Number(f.split.value) };
}
async function simCalc(v) {
  const f = $('#simDesign');
  if (!f) return;
  try {
    const { calc } = await api(`/api/sim/ab/${enc(v.id)}/calc`, { method: 'POST', body: readDesign(f) });
    $('#simCalc').innerHTML = `<p class="small" style="margin:0">Нужно <strong>${num(calc.perArm)}</strong> на вариант → ≈ <strong>${calc.daysNeeded} дн.</strong> (${calc.weeksNeeded} нед.) при ${num(calc.dailyTraffic)} в день.
      По плану: A ${num(calc.planned.A)}, B ${num(calc.planned.B)}.</p>
      ${calc.warn.map((w) => `<p class="warn-text small" style="margin:0">${esc(w)}</p>`).join('')}`;
  } catch (e) { $('#simCalc').innerHTML = `<p class="error small">${esc(e.message)}</p>`; }
}

// ---------- запуск и результаты ----------
function simRunHtml(v) {
  const d = v.design, sc = v.scenario;
  const m = (k) => sc.metrics.find((x) => x.key === k)?.name || k;
  return `<section class="card stack">
    <details><summary class="small">Дизайн: ${esc(m(d.primary))} · MDE ${signPct(d.mde)} · α ${d.alpha} · ${Math.round(d.power * 100)}% · ${Math.round((1 - d.split) * 100)}/${Math.round(d.split * 100)} · ${d.days} дн.</summary>
      <p class="small" style="margin:6px 0 0">${esc(d.hypothesis || '—')}</p><p class="muted small" style="margin:4px 0 0">Защитные: ${d.guards.map((k) => esc(m(k))).join(', ') || 'нет'} · нужно ≈ ${v.calc.daysNeeded} дн.</p></details>
    <div class="row sim-days">
      <button type="button" class="small" id="simPrev">←</button>
      <strong id="simDayLbl"></strong>
      <button type="button" class="small" id="simNext">следующий день →</button>
      <button type="button" class="small" id="simEnd">до конца</button>
      ${!v.decision && v.run.until < 56 ? '<button type="button" class="small ghost" id="simExt">продлить на неделю</button>' : ''}
      <span class="muted small" id="simPeeks"></span>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><div class="seg small" role="group" aria-label="Сегмент">${SIM_SEGS.map(([k, l]) => `<button type="button" data-seg="${k}" aria-pressed="${simUI.seg === k}">${l}</button>`).join('')}</div>
      <label class="sim-opt"><input type="checkbox" id="simDaily" ${simUI.daily ? 'checked' : ''}> по дням</label></div>
    <div id="simRes"><div class="muted small"><span class="spin"></span>Считаю…</div></div>
  </section>
  ${v.decision ? '' : simDecideHtml(v)}`;
}

async function loadSimResults(v, day = simUI.day) {
  const box = $('#simRes');
  if (!box) return;
  try {
    const r = await api(`/api/sim/ab/${enc(v.id)}/results?day=${day}&seg=${simUI.seg}${simUI.daily ? '&daily=1' : ''}`);
    simUI.day = r.day; simUI.res = r;
    $('#simDayLbl').textContent = `день ${r.day} из ${r.planned}${r.until > r.planned ? ` (+${r.until - r.planned})` : ''} · ${WD[(r.day - 1) % 7]}`;
    $('#simPrev').disabled = r.day <= 1;
    $('#simNext').disabled = r.day >= r.until;
    $('#simEnd').disabled = r.day >= r.until;
    const peeks = v.decision ? '' : (r.day < r.planned ? 'смотришь до конца плана — это подглядывание' : '');
    $('#simPeeks').textContent = peeks;
    box.innerHTML = simResultsHtml(v, r);
    const dd = $('#simDecDay');
    if (dd) dd.textContent = r.day;
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function simResultsHtml(v, r) {
  const cur = v.scenario.currency;
  const val = (m, x) => (m.type === 'mean' ? `${esc(cur)}${(x ?? 0).toFixed(3)}` : pctS(x));
  const tone = (m) => { if (!m.sig) return ''; const good = (m.rel > 0) === (m.better !== 'down'); return good ? 'good-text' : 'bad-text'; };
  return `<p class="small" style="margin:0">Пользователей: A ${num(r.n.A)} · B ${num(r.n.B)}${r.seg ? ` · сегмент: ${esc(SIM_SEGS.find(([k]) => k === r.seg)?.[1])}` : ''}.
      Разделение: B ${pctS(r.srm.shareB, 1)} при плане ${pctS(r.srm.expected, 0)}, SRM p = ${r.srm.p}${r.srm.flag ? ' <span class="pill warn">перекос</span>' : ''}.</p>
    <div class="table-box"><table class="apps small sim-table"><thead><tr><th>Метрика</th><th>A</th><th>B</th><th>Разница</th><th>95% интервал</th><th>p-value</th><th>P(B лучше)</th><th>Потери, если B</th></tr></thead><tbody>
      ${r.metrics.map((m, i) => `<tr><td>${i ? '' : '<strong>'}${esc(m.name)}${i ? '' : '</strong>'}${m.better === 'down' ? ' <span class="muted">↓</span>' : ''}</td>
        <td>${val(m, m.a)}</td><td>${val(m, m.b)}</td><td class="${tone(m)}">${signPct(m.rel, 2)}</td>
        <td class="muted">${m.a ? `${signPct(m.lo / m.a, 1)} … ${signPct(m.hi / m.a, 1)}` : '—'}</td>
        <td>${m.p < 0.001 ? '<0.001' : m.p.toFixed(3)}</td><td>${m.bayes ? pctS(m.bayes.pBetter, 1) : '—'}</td><td class="muted">${m.bayes ? pctS(m.bayes.lossB, 2) : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    ${simChart(r)}
    ${simUI.daily ? `<div class="table-box"><table class="apps small"><thead><tr><th>День</th><th></th><th>A</th><th>B</th><th>${esc(r.metrics[0].name)} A</th><th>B</th><th>Разница</th></tr></thead><tbody>
      ${r.daily.map((x) => `<tr><td>${x.day}</td><td class="muted">${WD[x.wd]}</td><td>${num(x.nA)}</td><td>${num(x.nB)}</td><td>${r.metrics[0].type === 'mean' ? x.a.toFixed(3) : pctS(x.a)}</td><td>${r.metrics[0].type === 'mean' ? x.b.toFixed(3) : pctS(x.b)}</td>
        <td>${x.a ? signPct(x.b / x.a - 1, 1) : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// Накопительная относительная разница главной метрики с 95% интервалом и p-value по дням
function simChart(r) {
  const s = r.series.filter((x) => x.a);
  if (s.length < 2) return '';
  const W = 640, H = 190, L = 44, R = 10, T = 12, B = 24;
  const rel = s.map((x) => ({ d: x.day, m: x.rel, lo: x.lo / x.a, hi: x.hi / x.a, p: x.p }));
  let ymin = Math.min(0, ...rel.map((x) => x.lo)), ymax = Math.max(0, ...rel.map((x) => x.hi));
  const pad = (ymax - ymin) * 0.08 || 0.01; ymin -= pad; ymax += pad;
  const X = (d) => L + ((d - 1) / Math.max(1, r.until - 1)) * (W - L - R), Y = (y) => T + (1 - (y - ymin) / (ymax - ymin)) * (H - T - B);
  const band = `${rel.map((x) => `${X(x.d)},${Y(x.hi)}`).join(' ')} ${rel.slice().reverse().map((x) => `${X(x.d)},${Y(x.lo)}`).join(' ')}`;
  const ticks = [ymin, 0, ymax].filter((y, i, arr) => i === 1 || Math.abs(Y(y) - Y(0)) > 14).map((y) => `<text x="${L - 6}" y="${Y(y) + 4}" text-anchor="end" class="sim-ax">${signPct(y, 0)}</text>`).join('');
  const plan = r.planned <= r.until ? `<line x1="${X(r.planned)}" x2="${X(r.planned)}" y1="${T}" y2="${H - B}" class="sim-plan"/><text x="${X(r.planned) - 4}" y="${T + 10}" text-anchor="end" class="sim-ax">план</text>` : '';
  const sig = rel.filter((x) => x.p < 0.05).map((x) => `<circle cx="${X(x.d)}" cy="${Y(x.m)}" r="3" class="sim-sig"/>`).join('');
  return `<figure class="sim-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Накопительная разница главной метрики по дням">
      <polygon points="${band}" class="sim-band"/><line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" class="sim-zero"/>${plan}
      <polyline points="${rel.map((x) => `${X(x.d)},${Y(x.m)}`).join(' ')}" class="sim-line"/>${sig}${ticks}
      <text x="${L}" y="${H - 6}" class="sim-ax">день 1</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="sim-ax">день ${r.until}</text></svg>
    <figcaption class="muted small">Накопительная разница B к A по главной метрике и 95% интервал. Точки — дни, когда p &lt; 0.05.</figcaption></figure>`;
}

function simDecideHtml(v) {
  const m = simMeta;
  return `<form class="card stack" id="simDecide"><h2 style="margin:0">Решение</h2>
    <div class="row" style="flex-wrap:wrap;gap:6px 16px">${Object.entries(m.decisions).map(([k, l]) => `<label class="sim-opt"><input type="radio" name="decision" value="${k}"> ${esc(l)}</label>`).join('')}</div>
    <div><span class="small">Что заметил в данных</span><div class="row" style="flex-wrap:wrap;gap:4px 14px">${Object.entries(m.flags).map(([k, l]) => `<label class="sim-opt"><input type="checkbox" name="flags" value="${k}"> ${esc(l)}</label>`).join('')}</div></div>
    <div><span class="small">Обоснование — как для CPO</span><div class="dict"><textarea name="reason" id="simReason" rows="5" placeholder="Что показали данные, насколько им верить, какой риск, что делаем дальше"></textarea>
      <button type="button" class="mic" id="simMic" title="Диктовка голосом" aria-label="Диктовка голосом">🎤</button></div><div class="hint" id="simMicHint"></div></div>
    <div class="row"><button type="submit" class="primary">Принять решение на день <span id="simDecDay">${simUI.day}</span></button>
      <span class="hint" style="margin:0">Решение по данным на выбранный день. Потом — правда и разбор (Haiku ≈ $0.01).</span></div>
    <p class="error" id="simDecErr"></p></form>`;
}

// ---------- разбор ----------
function simDebriefHtml(v) {
  const dec = v.decision, sc = dec.score, t = v.truth;
  const m = (k) => v.scenario.metrics.find((x) => x.key === k)?.name || k;
  const db = v.debrief, j = v.jobs.debrief;
  const obs = Object.fromEntries((dec.at.metrics || []).map((x) => [x.key, x.rel]));
  return `<section class="card stack sim-debrief">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2 style="margin:0">Разбор</h2>
      <span class="pill ${sc.correct ? 'good' : sc.decision ? 'warn' : 'bad'}">${sc.total}/100 · ${sc.correct ? 'решение верное' : sc.decision ? 'решение частично верное' : 'решение неверное'}</span></div>
    <div class="banner ${sc.correct ? 'good' : 'warn'}"><p style="margin:0"><strong>Что было на самом деле:</strong> ${esc(t.text)}.${t.range ? ` Модель брала эффект из диапазона ${signPct(t.range[0])} … ${signPct(t.range[1])}.` : ''}</p></div>
    <p class="small" style="margin:0">Ты решил: <strong>${esc(simMeta.decisions[dec.decision])}</strong> на день ${dec.day} из ${v.design.days}${dec.flags.length ? `; заметил: ${dec.flags.map((f) => esc(simMeta.flags[f])).join(', ')}` : ''}.
      Лучше: <strong>${sc.ideal.map((k) => esc(simMeta.decisions[k])).join(' или ')}</strong>.</p>
    <div class="table-box"><table class="apps small"><thead><tr><th>Метрика</th><th>Истинный эффект</th><th>Ты видел</th></tr></thead><tbody>
      ${Object.entries(t.effects).map(([k, x]) => `<tr><td>${esc(m(k))}</td><td><strong>${signPct(x, 1)}</strong></td><td class="muted">${obs[k] != null ? signPct(obs[k], 1) : 'не смотрел'}</td></tr>`).join('')}</tbody></table></div>
    <div class="sim-kpis"><div><span class="muted small">дизайн</span><strong>${sc.design}/30</strong></div><div><span class="muted small">процесс</span><strong>${sc.process}/30</strong></div><div><span class="muted small">решение</span><strong>${sc.decision}/40</strong></div></div>
    ${sc.notes.length ? `<ul class="tight small">${sc.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="small good-text" style="margin:0">Замечаний к дизайну и процессу нет.</p>'}
    ${dec.reason ? `<details><summary class="small">Твоё обоснование</summary><p class="small" style="white-space:pre-wrap">${esc(dec.reason)}</p></details>` : ''}
    <h3 style="margin:6px 0 0">Обоснование глазами наставника</h3>
    ${jobBusy(j) ? '<div class="running"><span class="spin"></span>Haiku разбирает обоснование…</div>'
      : db ? `<p style="margin:0"><strong>${db.grade}/4.</strong> ${esc(db.verdict)}</p>
        ${db.missed.length ? `<p class="small" style="margin:0"><strong>Упущено:</strong></p><ul class="tight small">${db.missed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${db.strong.length ? `<p class="small" style="margin:0"><strong>На что опирался бы сильный кандидат:</strong></p><ul class="tight small">${db.strong.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${db.interview ? `<p class="small" style="margin:0"><strong>Как сказать на интервью:</strong></p><blockquote class="small sim-quote">${esc(db.interview)}</blockquote>` : ''}`
      : `${j?.state === 'error' ? `<p class="error small">Ошибка: ${esc(j.error)}</p>` : ''}<div class="row"><button type="button" class="small" id="simDebrief">${j?.state === 'error' ? 'Повторить разбор' : 'Разобрать обоснование'} (≈ $0.01)</button></div>`}
    <div class="row"><a class="btn small" href="#/learn/sim">Следующий тест</a>${simMeta.lesson ? `<a class="small" href="#/learn/topics">урок: ${esc(simMeta.lesson.title)}</a>` : ''}</div>
  </section>`;
}

// ---------- события ----------
function bindSim(v) {
  $('#simDel')?.addEventListener('click', async () => {
    if (!confirm('Удалить тест вместе с разбором?')) return;
    await api(`/api/sim/ab/${enc(v.id)}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    simMeta = null;
    location.hash = '#/learn/sim';
  });
  $('#simRetry')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api(`/api/sim/ab/${enc(v.id)}/${v.source === 'own' ? 'own-run' : 'scenario'}`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); }
    renderSim(v.id);
  });
  $('#simAnsGo')?.addEventListener('click', async (e) => {
    const t = $('#simAns').value.trim();
    if (!t) return;
    e.target.disabled = true;
    try { await api(`/api/sim/ab/${enc(v.id)}/own-run`, { method: 'POST', body: { answers: t } }); } catch (err) { alert(err.message); }
    renderSim(v.id);
  });
  const f = $('#simDesign');
  if (f) {
    const recalc = () => { clearTimeout(simCalcTimer); simCalcTimer = setTimeout(() => simCalc(v), 250); };
    f.addEventListener('input', recalc);
    f.addEventListener('change', recalc);
    simCalc(v);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = readDesign(f);
      if (!d.hypothesis.trim() && !confirm('Без гипотезы? Это минус к оценке дизайна.')) return;
      f.querySelector('[type=submit]').disabled = true;
      try { await api(`/api/sim/ab/${enc(v.id)}/start`, { method: 'POST', body: { design: d } }); simUI.day = 1; renderSim(v.id); }
      catch (err) { $('#simDesignErr').textContent = err.message; f.querySelector('[type=submit]').disabled = false; }
    });
  }
  if (v.run) {
    const go = (day) => loadSimResults(v, day);
    $('#simPrev').addEventListener('click', () => go(simUI.day - 1));
    $('#simNext').addEventListener('click', () => go(simUI.day + 1));
    $('#simEnd').addEventListener('click', () => go(v.run.until));
    $('#simExt')?.addEventListener('click', async () => {
      if (!confirm('Продлить тест на 7 дней? Решение можно будет принять по новым данным.')) return;
      try { const nv = await api(`/api/sim/ab/${enc(v.id)}/extend`, { method: 'POST', body: {} }); simUI.day = nv.run.until; renderSim(v.id); } catch (err) { alert(err.message); }
    });
    document.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => {
      simUI.seg = b.dataset.seg;
      document.querySelectorAll('[data-seg]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      go(simUI.day);
    }));
    $('#simDaily').addEventListener('change', (e) => { simUI.daily = e.target.checked; go(simUI.day); });
  }
  const df = $('#simDecide');
  if (df) {
    setupMic($('#simReason'), () => {}, { btn: $('#simMic'), hint: $('#simMicHint'), link: `${location.origin}/#/learn/sim/${v.id}` });
    df.addEventListener('submit', async (e) => {
      e.preventDefault();
      const decision = df.querySelector('[name=decision]:checked')?.value;
      if (!decision) { $('#simDecErr').textContent = 'выбери решение'; return; }
      const flags = [...df.querySelectorAll('[name=flags]:checked')].map((x) => x.value);
      const reason = df.reason.value.trim();
      if (simUI.day < v.design.days && !confirm(`Решение на день ${simUI.day} из ${v.design.days} — это ранняя остановка. Принять?`)) return;
      df.querySelector('[type=submit]').disabled = true;
      try { await api(`/api/sim/ab/${enc(v.id)}/decide`, { method: 'POST', body: { decision, flags, reason, day: simUI.day } }); simMeta = null; simMeta = await api('/api/sim/ab'); renderSim(v.id); }
      catch (err) { $('#simDecErr').textContent = err.message; df.querySelector('[type=submit]').disabled = false; }
    });
  }
  $('#simDebrief')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api(`/api/sim/ab/${enc(v.id)}/debrief`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); }
    renderSim(v.id);
  });
}
