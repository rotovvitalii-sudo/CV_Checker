// ---------- C24: симулятор воронок (docs/specs/49-bayes-funnels-practice.md) ----------
// #/learn/sim — карточка «Воронки» на экране симулятора; #/learn/sim/f/<id> — воронка: исследование лога, сборка, ответ, разбор.
// Правду сервер отдаёт только после ответа.

let fnTimer = null;
const fnUI = { id: null, q: null, res: null, explore: null, transition: 1 };
const FN_WINDOWS = [[1, '1 час'], [24, '1 день'], [72, '3 дня'], [168, '7 дней'], [336, '14 дней'], [720, '30 дней']];
const FN_PROP = { platform: 'платформа', source: 'источник', country: 'страна', version: 'версия' };

function funnelHomeHtml(m) {
  const list = m.funnels || [];
  return `<form class="card stack" id="fnNew"><h2 style="margin:0">Воронки</h2>
      <p class="muted small" style="margin:0">Лог событий продукта за 5 недель: собери воронку (шаги, порядок, окно, подсчёт, разбивка, период) и найди, где, у кого и с какого дня провал.
        Правду о провале и искажениях сервер покажет после ответа.</p>
      <div class="row"><label class="row" style="gap:6px;margin:0">Продукт <select name="industry"><option value="">любой</option>${(m.industries || []).map((i) => `<option>${esc(i)}</option>`).join('')}</select></label>
        <button type="submit" class="primary">Новая воронка</button><span class="hint" style="margin:0">Haiku пишет продукт и события ≈ $0.001; провал выбирает сервер.</span></div>
      <p class="error" id="fnNewErr"></p></form>
    ${list.length ? `<div class="table-box"><table class="apps"><thead><tr><th>Воронка</th><th>Статус</th><th>Оценка</th></tr></thead><tbody>
      ${list.map((x) => `<tr><td><a href="#/learn/sim/f/${esc(x.id)}">${esc(x.title)}</a>${x.course ? ' <span class="chip">курс</span>' : ''}<div class="muted small">${esc(x.industry || '')} · ${esc(String(x.created).slice(0, 10))}</div></td>
        <td>${{ draft: 'ситуация пишется', design: 'не начата', running: 'идёт', done: 'разобрана' }[x.status] || x.status}</td>
        <td>${x.score != null ? `<strong>${x.score}</strong>${x.correct ? ' <span class="pill good">найдено</span>' : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
function bindFunnelHome() {
  $('#fnNew')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try { const { id } = await api('/api/sim/funnel', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); location.hash = `#/learn/sim/f/${id}`; }
    catch (err) { $('#fnNewErr').textContent = err.message; btn.disabled = false; }
  });
}

async function renderFunnel(id) {
  clearTimeout(fnTimer);
  const root = $('#learnView');
  let v;
  try { v = await api(`/api/sim/funnel/${enc(id)}`); } catch (e) { root.innerHTML = `<div class="page-wrap"><a href="#/learn/sim" class="back">← Симулятор</a><p class="error">${esc(e.message)}</p></div>`; return; }
  if (location.hash !== `#/learn/sim/f/${id}`) return;
  if (fnUI.id !== id) Object.assign(fnUI, { id, q: null, res: null, explore: null, transition: 1 });
  const busy = Object.values(v.jobs || {}).some(jobBusy);
  root.innerHTML = `<div class="page-wrap"><a href="#/learn/sim" class="back">← Симулятор</a>${funnelHtml(v)}</div>`;
  bindFunnel(v);
  if (busy) fnTimer = setTimeout(() => renderFunnel(id), 3000);
}

function funnelHtml(v) {
  const sc = v.scenario;
  const head = `<section class="home-head"><div><h1>${esc(sc?.title || 'Воронка')}</h1><p class="lead">Симулятор воронок · ${esc(sc?.industry || v.industry || '')}</p></div>
      <button type="button" class="link-btn" id="fnDel">удалить</button></section>
    ${v.course ? `<p class="small" style="margin:0 0 8px"><span class="chip">задание курса</span> засчитывается первое верное решение · <a href="#/learn/c/${enc(v.course.slug)}">← к курсу</a></p>` : ''}`;
  if (!sc?.ready) {
    const j = v.jobs.scenario;
    return `${head}${jobBusy(j) ? '<div class="running"><span class="spin"></span>Пишу продукт и события…</div>' : `${j?.state === 'error' ? `<p class="error">Ошибка: ${esc(j.error)}</p>` : ''}
      <div class="row"><button type="button" class="primary small" id="fnRetry">${j?.state === 'error' ? 'Повторить' : 'Получить ситуацию'}</button></div>`}`;
  }
  return `${head}
    <section class="card stack">
      ${sc.product ? `<p style="margin:0"><strong>Продукт.</strong> ${esc(sc.product)}</p>` : ''}
      <p style="margin:0">${esc(sc.context)}</p>
      <div id="fnExplore"><p class="muted small"><span class="spin"></span>Читаю лог…</p></div>
    </section>
    ${funnelBuilderHtml(v)}
    <section class="card stack" id="fnResBox"><p class="muted small" style="margin:0">Собери воронку и нажми «Построить».</p></section>
    ${v.answer ? funnelDebriefHtml(v) : funnelAnswerHtml(v)}`;
}

function funnelBuilderHtml(v) {
  const sc = v.scenario;
  const q = fnUI.q || { steps: sc.steps.map((s) => s.key), window_h: 24, order: 'strict', count: 'users', breakdown: '', from_day: 0, to_day: 34, exclude: null };
  fnUI.q = q;
  const all = [...sc.steps, ...sc.extra];
  const opt = (arr, cur) => arr.map(([val, l]) => `<option value="${val}" ${String(val) === String(cur ?? '') ? 'selected' : ''}>${l}</option>`).join('');
  return `<section class="card stack" id="fnBuild"><h2 style="margin:0">Сборка воронки</h2>
    <div><span class="small">Шаги по порядку</span><div class="fz-steps" style="margin-top:4px">${q.steps.map((k, i) => `<span class="fz-step">${i + 1}. ${esc(k)}
        <button type="button" data-fup="${i}" title="раньше" aria-label="раньше">←</button><button type="button" data-fdel="${i}" title="убрать" aria-label="убрать">×</button></span>`).join('')}
      <select id="fnAdd" aria-label="Добавить шаг"><option value="">+ шаг</option>${all.filter((e) => !q.steps.includes(e.key)).map((e) => `<option value="${esc(e.key)}">${esc(e.key)}</option>`).join('')}</select></div></div>
    <div class="form-grid two">
      <label>Окно конверсии (от первого шага)<select id="fnWin">${opt(FN_WINDOWS, q.window_h)}</select></label>
      <label>Порядок шагов<select id="fnOrder">${opt([['strict', 'строгий — каждый следующий после предыдущего'], ['any', 'любой — все шаги в окне, порядок неважен']], q.order)}</select></label>
      <label>Считать<select id="fnCount">${opt([['users', 'уникальных пользователей'], ['events', 'события (всего)']], q.count)}</select></label>
      <label>Разбивка<select id="fnBreak">${opt([['', 'нет'], ...Object.entries(FN_PROP)], q.breakdown || '')}</select></label>
      <label>Период входа: с дня<input type="number" id="fnFrom" min="1" max="35" value="${q.from_day + 1}"></label>
      <label>по день<input type="number" id="fnTo" min="1" max="35" value="${q.to_day + 1}"></label>
      <label>Исключить<select id="fnExProp">${opt([['', 'ничего'], ...Object.entries(FN_PROP)], q.exclude?.prop || '')}</select></label>
      <label>значение<input id="fnExVal" value="${esc(q.exclude?.value || '')}" placeholder="например, direct"></label>
    </div>
    <div class="row"><button type="button" class="primary small" id="fnRun">Построить</button><span class="hint" style="margin:0">Бесплатно, считает сервер. Сборки пишутся — по ним оценка «сборки».</span></div>
    <p class="error" id="fnErr"></p></section>`;
}
function readFunnelQuery() {
  const q = fnUI.q;
  return { ...q, window_h: Number($('#fnWin').value), order: $('#fnOrder').value, count: $('#fnCount').value, breakdown: $('#fnBreak').value || null,
    from_day: Number($('#fnFrom').value) - 1, to_day: Number($('#fnTo').value) - 1,
    exclude: $('#fnExProp').value && $('#fnExVal').value.trim() ? { prop: $('#fnExProp').value, value: $('#fnExVal').value.trim() } : null };
}

function funnelResultHtml(r, title = 'Воронка', main = true) {
  const all = r.all, first = all[0]?.value || 0;
  const hours = (h) => (h == null ? '' : h < 1 ? `${Math.round(h * 60)} мин` : h < 48 ? `${Math.round(h)} ч` : `${Math.round(h / 24)} дн`);
  const tr = Math.min(fnUI.transition, all.length - 1);
  return `<h2 style="margin:0">${esc(title)}</h2>
    <p class="muted small" style="margin:0">${r.query.count === 'users' ? 'пользователи' : 'события'} · окно ${FN_WINDOWS.find(([w]) => w === r.query.window_h)?.[1] || `${r.query.window_h} ч`} · порядок ${r.query.order === 'strict' ? 'строгий' : 'любой'}
      · дни ${r.query.from_day + 1}–${r.query.to_day + 1}${r.query.exclude ? ` · без ${esc(r.query.exclude.prop)} = ${esc(r.query.exclude.value)}` : ''}</p>
    <div class="fz-bars">${all.map((s, i) => `<div class="fz-bar"><span>${i + 1}. ${esc(s.key)}</span>
      <div class="track"><div class="fill" style="width:${first ? Math.min(100, (s.value / first) * 100) : 0}%"></div></div>
      <span><strong>${num(s.value)}</strong>${i ? ` · ${pctS(s.fromPrev, 1)} от прошлого · ${pctS(s.fromStart, 1)} от первого${s.medianHours != null ? ` · медиана ${hours(s.medianHours)}` : ''}` : ''}</span></div>`).join('')}</div>
    ${r.segments.length ? `<div class="table-box"><table class="apps small"><thead><tr><th>${esc(FN_PROP[r.query.breakdown] || r.query.breakdown)}</th><th>${esc(all[0].key)}</th>${all.slice(1).map((s) => `<th>→ ${esc(s.key)}</th>`).join('')}</tr></thead><tbody>
      ${r.segments.map((g) => `<tr><td>${esc(g.value)}</td><td>${num(g.steps[0].value)}</td>${g.steps.slice(1).map((s) => `<td>${pctS(s.fromPrev, 1)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
    ${all.length > 1 && main ? `<div class="row small" style="gap:6px">Динамика по дням входа: переход <select id="fnTr">${all.slice(1).map((s, i) => `<option value="${i + 1}" ${tr === i + 1 ? 'selected' : ''}>${esc(all[i].key)} → ${esc(s.key)}</option>`).join('')}</select></div>
      ${funnelTrend(r, tr)}` : ''}`;
}
// Конверсия выбранного перехода по дням входа: все и сегменты (скользящее среднее за 3 дня)
function funnelTrend(r, tr) {
  const groups = Object.entries(r.trend || {});
  if (!groups.length) return '';
  const W = 640, H = 180, L = 40, R = 10, T = 12, B2 = 24;
  const lines = groups.map(([g, arr]) => {
    const pts = arr.map((x, i) => {
      const win = arr.slice(Math.max(0, i - 1), i + 2);
      const den = win.reduce((a, y) => a + y.n[tr - 1], 0), nom = win.reduce((a, y) => a + y.n[tr], 0);
      return { day: x.day, y: den >= 15 ? nom / den : null };
    }).filter((p) => p.y != null);
    return { g, pts };
  }).filter((l) => l.pts.length > 1);
  if (!lines.length) return '';
  const ymax = Math.max(0.05, ...lines.flatMap((l) => l.pts.map((p) => p.y)));
  const X = (d) => L + (d / (r.days - 1)) * (W - L - R), Y = (y) => T + (1 - y / ymax) * (H - T - B2);
  const cls = ['sim-line', 'fn-l1', 'fn-l2', 'fn-l3', 'fn-l4', 'fn-l5'];
  return `<figure class="sim-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Конверсия перехода по дням">
      ${lines.map((l, i) => `<polyline points="${l.pts.map((p) => `${X(p.day)},${Y(p.y)}`).join(' ')}" class="${cls[i] || 'fn-l5'}"/>`).join('')}
      <text x="${L - 6}" y="${Y(ymax) + 4}" text-anchor="end" class="sim-ax">${pctS(ymax, 0)}</text><text x="${L - 6}" y="${Y(0) + 4}" text-anchor="end" class="sim-ax">0</text>
      <text x="${L}" y="${H - 6}" class="sim-ax">день 1</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="sim-ax">день ${r.days}</text></svg>
    <figcaption class="small">${lines.map((l, i) => `<span class="fn-key ${cls[i] || 'fn-l5'}">■</span> ${esc(l.g === 'all' ? 'все' : l.g)}`).join(' · ')}</figcaption></figure>`;
}

function funnelAnswerHtml(v) {
  const sc = v.scenario;
  const opt = (arr) => arr.map(([val, l]) => `<option value="${esc(val)}">${esc(l)}</option>`).join('');
  return `<form class="card stack" id="fnAnswer"><h2 style="margin:0">Ответ</h2>
    <div class="form-grid two">
      <label>Где главный провал — переход в шаг<select name="step">${opt(sc.steps.slice(1).map((s, i) => [s.key, `${sc.steps[i].key} → ${s.key}`]))}</select></label>
      <label>С какого дня<input type="number" name="from_day" min="1" max="35" placeholder="1–35"></label>
      <label>У кого — свойство<select name="segProp">${opt(Object.entries(FN_PROP))}</select></label>
      <label>значение<input name="segVal" list="fnVals" placeholder="например, Android"><datalist id="fnVals"></datalist></label>
      <label>Вероятная причина<select name="cause">${opt(Object.entries(v.causes))}</select></label>
    </div>
    <div><span class="small">Что исказило данные</span><div class="row" style="flex-wrap:wrap;gap:4px 14px">${Object.entries(v.flags).map(([k, l]) => `<label class="sim-opt"><input type="checkbox" name="flags" value="${k}"> ${esc(l)}</label>`).join('')}</div></div>
    <div><span class="small">Как нашёл и почему так думаешь</span><div class="dict"><textarea name="text" id="fnText" rows="4" placeholder="Какие сборки и разбивки посмотрел, что увидел"></textarea>
      <button type="button" class="mic" id="fnMic" title="Диктовка голосом" aria-label="Диктовка голосом">🎤</button></div><div class="hint" id="fnMicHint"></div></div>
    <label>Что проверил бы A/B-тестом<textarea name="abtest" rows="2" placeholder="Изменение, метрика, сегмент"></textarea></label>
    <div class="row"><button type="submit" class="primary">Ответить</button><span class="hint" style="margin:0">После ответа — правда, воронка «как надо было» и разбор (Haiku ≈ $0.01).</span></div>
    <p class="error" id="fnAnsErr"></p></form>`;
}

function funnelDebriefHtml(v) {
  const a = v.answer, sc = a.score, t = v.truth, db = v.debrief, j = v.jobs.debrief;
  return `<section class="card stack sim-debrief">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2 style="margin:0">Разбор</h2>
      <span class="pill ${sc.correct ? 'good' : 'warn'}">${sc.total}/100 · ${sc.correct ? 'провал найден' : 'провал не найден'}</span></div>
    <div class="banner ${sc.correct ? 'good' : 'warn'}"><p style="margin:0"><strong>Что было:</strong> ${esc(t.text.main)}. <strong>Искажение:</strong> ${esc(t.text.distract)}.</p></div>
    <p class="small" style="margin:0">Ты ответил: переход в «${esc(a.step)}», ${esc(a.segment.prop)} = ${esc(a.segment.value)}, с ${a.from_day}-го дня, причина — ${esc(v.causes[a.cause])}.</p>
    <div class="sim-kpis"><div><span class="muted small">находки</span><strong>${sc.findings}/60</strong></div><div><span class="muted small">сборка</span><strong>${sc.build}/25</strong></div><div><span class="muted small">искажения</span><strong>${sc.distort}/15</strong></div></div>
    ${sc.notes.length ? `<ul class="tight small">${sc.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div><button type="button" class="small" id="fnIdeal">Показать воронку «как надо было»</button></div><div id="fnIdealBox"></div>
    <h3 style="margin:6px 0 0">Ход анализа глазами наставника</h3>
    ${jobBusy(j) ? '<div class="running"><span class="spin"></span>Haiku разбирает анализ…</div>'
      : db ? `<p style="margin:0"><strong>${db.grade}/4.</strong> ${esc(db.verdict)}</p>
        ${db.missed.length ? `<p class="small" style="margin:0"><strong>Упущено:</strong></p><ul class="tight small">${db.missed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${db.strong.length ? `<p class="small" style="margin:0"><strong>Как действовал бы сильный аналитик:</strong></p><ul class="tight small">${db.strong.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${db.interview ? `<p class="small" style="margin:0"><strong>Как рассказать на интервью:</strong></p><blockquote class="small sim-quote">${esc(db.interview)}</blockquote>` : ''}`
      : `${j?.state === 'error' ? `<p class="error small">Ошибка: ${esc(j.error)}</p>` : ''}<div class="row"><button type="button" class="small" id="fnDebrief">${j?.state === 'error' ? 'Повторить разбор' : 'Разобрать анализ'} (≈ $0.01)</button></div>`}
    <div class="row"><a class="btn small" href="#/learn/sim">К симулятору</a>${v.course ? `<a class="small" href="#/learn/c/${enc(v.course.slug)}">к курсу</a>` : ''}</div>
  </section>`;
}

async function loadFunnelExplore(v) {
  const box = $('#fnExplore');
  if (!box) return;
  try {
    const x = fnUI.explore || (fnUI.explore = await api(`/api/sim/funnel/${enc(v.id)}/explore`));
    box.innerHTML = `<div class="table-box"><table class="apps small"><thead><tr><th>Событие</th><th>Что это</th><th>Пользователей</th><th>Событий</th></tr></thead><tbody>
      ${x.dictionary.map((e) => `<tr><td><code>${esc(e.key)}</code></td><td>${esc(e.name)}${e.desc ? `<div class="muted">${esc(e.desc)}</div>` : ''}</td><td>${num(e.users)}</td><td>${num(e.events)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small" style="margin:0">${num(x.users)} пользователей за ${x.days} дней. Свойства: ${Object.entries(x.values).map(([k, vals]) => `${esc(FN_PROP[k])} — ${vals.slice(0, 8).map(esc).join(', ')}`).join('; ')}.</p>
      <details><summary class="small">Пример сырого лога · ${x.sample.length} строк</summary><div class="table-box"><table class="apps fz-log"><thead><tr><th>время</th><th>user</th><th>event</th><th>platform</th><th>source</th><th>country</th><th>version</th></tr></thead><tbody>
        ${x.sample.map((r) => `<tr><td>${esc(r.time)}</td><td>${esc(r.user)}</td><td>${esc(r.event)}</td><td>${esc(r.platform)}</td><td>${esc(r.source)}</td><td>${esc(r.country)}</td><td>${esc(r.version)}</td></tr>`).join('')}</tbody></table></div></details>`;
    const dl = $('#fnVals');
    const fill = () => { const p = document.querySelector('#fnAnswer [name=segProp]')?.value; if (dl && p) dl.innerHTML = (x.values[p] || []).map((val) => `<option value="${esc(val)}">`).join(''); };
    fill();
    document.querySelector('#fnAnswer [name=segProp]')?.addEventListener('change', fill);
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function runFunnelQuery(v) {
  const box = $('#fnResBox');
  try {
    fnUI.q = readFunnelQuery();
    box.innerHTML = '<p class="muted small"><span class="spin"></span>Считаю…</p>';
    fnUI.res = await api(`/api/sim/funnel/${enc(v.id)}/query`, { method: 'POST', body: fnUI.q });
    showFunnelResult();
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
function showFunnelResult() {
  const box = $('#fnResBox');
  if (!box || !fnUI.res) return;
  box.innerHTML = funnelResultHtml(fnUI.res);
  $('#fnTr')?.addEventListener('change', (e) => { fnUI.transition = Number(e.target.value); showFunnelResult(); });
}

function bindFunnel(v) {
  $('#fnDel')?.addEventListener('click', async () => {
    if (!confirm('Удалить воронку вместе с разбором?')) return;
    await api(`/api/sim/funnel/${enc(v.id)}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    simMeta = null; location.hash = '#/learn/sim';
  });
  $('#fnRetry')?.addEventListener('click', async (e) => { e.target.disabled = true; try { await api(`/api/sim/funnel/${enc(v.id)}/scenario`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); } renderFunnel(v.id); });
  if (!v.scenario?.ready) return;
  loadFunnelExplore(v);
  const bindBuilder = () => {
    document.querySelectorAll('[data-fdel]').forEach((b) => b.addEventListener('click', () => { fnUI.q = readFunnelQuery(); fnUI.q.steps.splice(Number(b.dataset.fdel), 1); $('#fnBuild').outerHTML = funnelBuilderHtml(v); bindBuilder(); }));
    document.querySelectorAll('[data-fup]').forEach((b) => b.addEventListener('click', () => { fnUI.q = readFunnelQuery(); const i = Number(b.dataset.fup), s = fnUI.q.steps; if (i > 0) [s[i - 1], s[i]] = [s[i], s[i - 1]]; $('#fnBuild').outerHTML = funnelBuilderHtml(v); bindBuilder(); }));
    $('#fnAdd')?.addEventListener('change', (e) => { if (!e.target.value) return; fnUI.q = readFunnelQuery(); fnUI.q.steps.push(e.target.value); $('#fnBuild').outerHTML = funnelBuilderHtml(v); bindBuilder(); });
    $('#fnRun')?.addEventListener('click', () => runFunnelQuery(v));
  };
  bindBuilder();
  if (fnUI.res) showFunnelResult(); else runFunnelQuery(v);
  const f = $('#fnAnswer');
  if (f) {
    setupMic($('#fnText'), () => {}, { btn: $('#fnMic'), hint: $('#fnMicHint'), link: `${location.origin}/#/learn/sim/f/${v.id}` });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { step: f.step.value, from_day: Number(f.from_day.value), segment: { prop: f.segProp.value, value: f.segVal.value.trim() }, cause: f.cause.value,
        flags: [...f.querySelectorAll('[name=flags]:checked')].map((x) => x.value), text: f.text.value, abtest: f.abtest.value };
      if (!body.from_day || !body.segment.value) { $('#fnAnsErr').textContent = 'укажи день и значение сегмента'; return; }
      f.querySelector('[type=submit]').disabled = true;
      try { await api(`/api/sim/funnel/${enc(v.id)}/answer`, { method: 'POST', body }); simMeta = null; renderFunnel(v.id); }
      catch (err) { $('#fnAnsErr').textContent = err.message; f.querySelector('[type=submit]').disabled = false; }
    });
  }
  $('#fnIdeal')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api(`/api/sim/funnel/${enc(v.id)}/ideal`); $('#fnIdealBox').innerHTML = `<div class="card stack" style="margin-top:8px">${funnelResultHtml(r, 'Как надо было собрать', false)}</div>`; }
    catch (err) { alert(err.message); }
  });
  $('#fnDebrief')?.addEventListener('click', async (e) => { e.target.disabled = true; try { await api(`/api/sim/funnel/${enc(v.id)}/debrief`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); } renderFunnel(v.id); });
}
