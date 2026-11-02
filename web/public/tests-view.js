// ---------- тестовые (C14, docs/specs/39-test-tasks.md) ----------
// #/tests — задания; #/tests/library — библиотека; #/tests/playbook — плейбук;
// #/tests/new — новое тестовое; #/tests/import — прошлое из папки; #/tests/t/<slug> — задание.

let testsData = null;
let testTimer = null;
let testSig = '';
let libQuery = '';
let libType = '';

const TEST_STATE = {
  new: ['neutral', 'нет плана'], planned: ['info', 'план готов'], doing: ['warn', 'в работе'], submitted: ['info', 'сдано, ждёт ответа'],
  archive: ['neutral', 'прошлое'], passed: ['good', 'прошёл'], failed: ['bad', 'не прошёл'], no_reply: ['neutral', 'нет ответа'],
};
const TEST_RESULT = [['pending', 'ждёт ответа'], ['passed', 'прошёл'], ['failed', 'не прошёл'], ['no_reply', 'нет ответа']];
const STAGE_ST = [['todo', 'не начат'], ['doing', 'в работе'], ['done', 'готов']];
const testPill = (st) => { const [tone, l] = TEST_STATE[st] || ['neutral', st]; return `<span class="pill ${tone}">${l}</span>`; };
const kb = (n) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const testName = (t) => `${t.company || '—'}${t.role ? ` — ${t.role}` : ''}`;
const testCmd = (slug) => `Делаем тестовое ${slug} (test-tasks/${slug}) — скил test-task, продолжи с текущего этапа.`;

async function loadTests(r) {
  clearTimeout(testTimer);
  const sub = r.sub || '';
  const root = $('#testsView');
  if (sub.startsWith('t/')) return renderTest(sub.slice(2));
  if (sub === 'new') return renderTestNew(r.params.vacancy || '');
  if (sub === 'import') return renderTestImport();
  if (!testsData) root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Читаю тестовые…</div></div>';
  try {
    testsData = await api('/api/tests');
    if (sub === 'library') testsData.lib = await api('/api/tests/library');
    if (sub === 'playbook') testsData.pb = await api('/api/tests/playbook');
  } catch (e) { root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`; return; }
  const d = testsData;
  const tabs = [['', `Задания · ${d.items.length}`], ['library', `Библиотека · ${d.libraryCount}`], ['playbook', `Плейбук${d.pending ? ` · ждут ${d.pending}` : ''}`]];
  const body = sub === 'library' ? testLibraryHtml(d.lib) : sub === 'playbook' ? testPlaybookHtml(d.pb) : testListHtml(d);
  root.innerHTML = `<div class="page-wrap">
    <section class="home-head">
      <div><h1>Тестовые</h1>
        <p class="lead">Прошлые задания, готовые куски из них и план нового. Само тестовое делается в чате Claude Code в папке проекта — скил <code>test-task</code>.</p></div>
      <div class="row"><a class="btn" href="#/tests/import">Добавить прошлое</a><a class="btn primary" href="#/tests/new">+ Новое тестовое</a></div>
    </section>
    <section class="stack">
      <div class="seg" role="group" aria-label="Раздел тестовых">
        ${tabs.map(([k, l]) => `<button type="button" data-ttab="${k}" aria-pressed="${sub === k}">${l}</button>`).join('')}
      </div>
      <div id="testsBody">${body}</div>
    </section></div>`;
  root.querySelectorAll('[data-ttab]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.ttab ? `#/tests/${b.dataset.ttab}` : '#/tests'; }));
  if (sub === 'library') bindTestLibrary(d.lib);
  if (sub === 'playbook') bindTestPlaybook(d.pb);
}

function testListHtml(d) {
  if (!d.items.length) {
    return `<div class="table-box empty-box">Тестовых пока нет. Начни с «Добавить прошлое»: укажи папку прошлого тестового, приложение скопирует её
      (без <code>.venv</code> и служебного), а «Разобрать» вытащит этапы, развилки и куски для библиотеки.</div>`;
  }
  return `<div class="sug-list">${d.items.map((t) => {
    const p = t.progress;
    const busy = [t.jobs.debrief, t.jobs.plan].some(jobBusy);
    return `<a class="ncard test-row" href="#/tests/t/${enc(t.slug)}">
      <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">
        <strong>${esc(testName(t))}</strong>
        <span class="row" style="gap:6px">${t.type ? `<span class="chip">${esc(d.types[t.type] || t.type)}</span>` : ''}${testPill(t.state)}</span></div>
      <p class="muted small" style="margin:4px 0 0">
        ${p.total ? `этапов готово ${p.done} из ${p.total}` : t.imported ? 'импортировано' : 'плана нет'}
        ${t.due && !t.submittedAt ? ` · срок <strong>${esc(t.due)}</strong>` : ''}
        ${t.received ? ` · получено ${esc(t.received)}` : ''}${t.hours ? ` · ${t.hours} ч` : ''}
        ${t.debriefed ? ' · разобрано' : t.imported ? ' · <span class="warn-text">не разобрано</span>' : ''}
        ${t.vacancy ? ` · заявка: ${esc(t.vacancy)}` : ''}${busy ? ' · <span class="spin"></span>агент работает' : ''}</p>
    </a>`;
  }).join('')}</div>`;
}

// ---------- новое тестовое ----------

async function renderTestNew(vacancy) {
  let vac = [];
  try { vac = (await api('/api/vacancies')).items.map((x) => x.name); } catch {}
  $('#testsView').innerHTML = `<div class="page-wrap"><a href="#/tests" class="back">← Тестовые</a>
    <h1>Новое тестовое</h1>
    <p class="lead">Вставь текст задания и приложи файлы (данные, бриф). Дальше — «Составить план»: Opus разобьёт работу на этапы
      с опорой на твои прошлые тестовые и библиотеку.</p>
    <form class="card stack" id="testNewForm">
      <div class="form-grid two">
        <label>Компания<input name="company" required autocomplete="off"></label>
        <label>Роль<input name="role" autocomplete="off"></label>
        <label>Заявка<select name="vacancy"><option value="">— без заявки —</option>
          ${vac.map((n) => `<option ${n === vacancy ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label>Срок сдачи<input type="date" name="due"></label>
        <label>Готов потратить, часов<input type="number" name="hours" min="1" max="80" step="0.5" placeholder="например, 4"></label>
      </div>
      <label>Текст задания<textarea name="text" rows="14" required placeholder="Вставь задание целиком, как прислали"></textarea></label>
      <label>Файлы задания <span class="muted small">PDF, DOCX, XLSX, CSV, MD — до 30 МБ каждый</span><input type="file" name="files" multiple></label>
      <div class="row"><button type="submit" class="primary">Создать</button><span class="hint" style="margin:0" id="testNewHint"></span></div>
      <p class="error" id="testNewErr"></p>
    </form></div>`;
  $('#testNewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { slug } = await api('/api/tests', { method: 'POST', body: Object.fromEntries([...f.entries()].filter(([k]) => k !== 'files')) });
      const files = [...e.target.files.files];
      for (const [i, file] of files.entries()) {
        $('#testNewHint').textContent = `загружаю файл ${i + 1} из ${files.length}…`;
        await uploadTestFile(slug, file);
      }
      testsData = null;
      location.hash = `#/tests/t/${enc(slug)}`;
    } catch (err) { $('#testNewErr').textContent = err.message; btn.disabled = false; }
  });
}

async function uploadTestFile(slug, file) {
  const res = await fetch(`/api/tests/${enc(slug)}/files`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${file.name}: ${data.error || `HTTP ${res.status}`}`);
}

// ---------- импорт прошлого ----------

async function renderTestImport() {
  let vac = [];
  try { vac = (await api('/api/vacancies')).items.map((x) => x.name); } catch {}
  $('#testsView').innerHTML = `<div class="page-wrap"><a href="#/tests" class="back">← Тестовые</a>
    <h1>Прошлое тестовое</h1>
    <p class="lead">Папка копируется в <code>test-tasks/</code> целиком, кроме <code>.venv</code>, <code>node_modules</code>, <code>.git</code>, кэша и файлов больше 25 МБ.
      Исходную папку потом можно удалить — библиотека от неё не зависит.</p>
    <form class="card stack" id="testScanForm">
      <label>Путь к папке<input name="src" placeholder="~/Projects/test-task" required autocomplete="off"></label>
      <div class="row"><button type="submit">Показать, что скопируется</button></div>
      <p class="error" id="testScanErr"></p>
    </form>
    <div id="testScanOut"></div></div>`;
  $('#testScanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#testScanErr').textContent = '';
    let sc;
    try { sc = await api('/api/tests/scan', { method: 'POST', body: { src: e.target.src.value.trim() } }); } catch (err) { $('#testScanErr').textContent = err.message; return; }
    const base = sc.root.split('/').pop();
    $('#testScanOut').innerHTML = `<form class="card stack" id="testImportForm">
      <h3 style="margin:0">${esc(sc.root)}</h3>
      <ul class="tight test-tree">${sc.entries.map((x) => `<li><label class="row" style="gap:8px">
        <input type="checkbox" name="take" value="${esc(x.name)}" ${x.include ? 'checked' : ''} ${/не копируется/.test(x.reason) ? 'disabled' : ''}>
        <span>${x.dir ? '📁 ' : ''}${esc(x.name)}</span><span class="muted small">${kb(x.size)}${x.files > 1 ? ` · ${x.files} файлов` : ''}${x.reason ? ` · ${esc(x.reason)}` : ''}</span></label></li>`).join('')}</ul>
      <p class="muted small" style="margin:0" id="testImportSize"></p>
      <div class="form-grid two">
        <label>Компания<input name="company" value="${esc(base)}" required></label>
        <label>Роль<input name="role"></label>
        <label>Заявка<select name="vacancy"><option value="">— без заявки —</option>${vac.map((n) => `<option ${n.toLowerCase().includes(base.toLowerCase()) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label>Получено<input type="date" name="received"></label>
        <label>Результат<select name="result">${TEST_RESULT.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label>Потрачено, часов<input type="number" name="hours" min="0" step="0.5"></label>
      </div>
      <div class="row"><button type="submit" class="primary">Импортировать</button></div>
      <p class="error" id="testImportErr"></p>
    </form>`;
    const sizes = Object.fromEntries(sc.entries.map((x) => [x.name, x.size || 0]));
    const upd = () => { $('#testImportSize').textContent = `Скопируется ≈ ${kb([...document.querySelectorAll('[name=take]:checked')].reduce((s, c) => s + sizes[c.value], 0))}`; };
    document.querySelectorAll('[name=take]').forEach((c) => c.addEventListener('change', upd));
    upd();
    $('#testImportForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const skip = sc.entries.filter((x) => !f.getAll('take').includes(x.name)).map((x) => x.name);
      const btn = ev.target.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Копирую…';
      try {
        const r = await api('/api/tests/import', { method: 'POST', body: { src: sc.root, skip, company: f.get('company'), role: f.get('role'),
          vacancy: f.get('vacancy'), received: f.get('received'), result: f.get('result'), hours: f.get('hours') } });
        testsData = null;
        location.hash = `#/tests/t/${enc(r.slug)}`;
      } catch (err) { $('#testImportErr').textContent = err.message; btn.disabled = false; btn.textContent = 'Импортировать'; }
    });
  });
}

// ---------- задание ----------

async function renderTest(slug, quiet = false) {
  clearTimeout(testTimer);
  const root = $('#testsView');
  let d;
  try { d = await api(`/api/tests/${enc(slug)}`); } catch (e) {
    root.innerHTML = `<div class="page-wrap"><a href="#/tests" class="back">← Тестовые</a><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  const sig = JSON.stringify([d.plan?.at, d.plan?.stages?.map((s) => s.status), d.plan?.copied, d.jobs.debrief?.state, d.jobs.plan?.state, d.debrief?.at, d.work.length]);
  const busy = jobBusy(d.jobs.debrief) || jobBusy(d.jobs.plan);
  if (!(quiet && sig === testSig)) {
    testSig = sig;
    root.innerHTML = `<div class="page-wrap"><a href="#/tests" class="back">← Тестовые</a>${testPageHtml(d)}</div>`;
    bindTest(d);
  }
  if (location.hash !== `#/tests/t/${enc(slug)}`) return;
  // Агент работает или идёт работа в чате (скил отмечает этапы в plan.json) — подтягиваем изменения
  if (busy || (d.plan && !d.meta.submittedAt)) testTimer = setTimeout(() => { if (location.hash === `#/tests/t/${enc(slug)}`) renderTest(slug, true); }, busy ? 3000 : 6000);
}

function testJobBox(j, label) {
  if (!j || (!jobBusy(j) && j.state !== 'error')) return '';
  return `<div class="running">${jobBusy(j) ? `<span class="spin"></span>${label}` : `<span class="error">Ошибка: ${esc(j.error)}</span>`}</div>${jobBusy(j) ? `<div class="feed" data-feed="${j.id}"></div>` : ''}`;
}

function testPageHtml(d) {
  const m = d.meta;
  const s = d.summary;
  const t = d.types;
  const p = d.plan;
  const pend = (arr) => (arr || []).filter((x) => x.state === 'new');
  return `<section class="home-head">
      <div><h1>${esc(testName(m))}</h1>
        <p class="lead">${testPill(s.state)} ${m.type ? `<span class="chip">${esc(t[m.type] || m.type)}</span>` : ''}
          ${m.vacancy ? ` заявка <a href="#/v/${enc(m.vacancy)}">${esc(m.vacancy)}</a>` : ''}
          ${m.imported && m.source ? ` <span class="muted small">· из ${esc(m.source)}</span>` : ''}</p></div>
      <div class="row">
        ${!m.imported ? '<button type="button" id="tCmd">Скопировать команду для чата</button>' : ''}
        <button type="button" id="tReveal">Открыть папку</button></div>
    </section>

    <section class="card stack" id="tMeta">
      <div class="form-grid two">
        <label>Компания<input data-tm="company" value="${esc(m.company || '')}"></label>
        <label>Роль<input data-tm="role" value="${esc(m.role || '')}"></label>
        <label>Тип<select data-tm="type"><option value="">—</option>${Object.entries(t).map(([k, l]) => `<option value="${k}" ${m.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${m.imported ? `<label>Получено<input type="date" data-tm="received" value="${esc(m.received || '')}"></label>` : `<label>Срок сдачи<input type="date" data-tm="due" value="${esc(m.due || '')}"></label>`}
        <label>Потрачено, часов<input type="number" min="0" step="0.5" data-tm="hours" value="${m.hours ?? ''}"></label>
        <label>Результат<select data-tm="result">${TEST_RESULT.map(([k, l]) => `<option value="${k}" ${(m.result || 'pending') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label>Фидбек компании<textarea data-tm="feedback" rows="2" placeholder="что сказали — учитывается в разборе">${esc(m.feedback || '')}</textarea></label>
      <div class="row">
        ${m.imported ? '' : m.submittedAt ? `<span class="muted small">Сдано ${fmtDay(m.submittedAt)}</span> <button type="button" class="link-btn inline" id="tUnsubmit">отменить</button>`
          : '<button type="button" class="primary" id="tSubmit">Сдал</button>'}
        <span class="muted small" id="tMetaSaved"></span></div>
    </section>

    ${!m.imported ? testPlanHtml(d) : ''}

    <section class="card stack">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">Разбор</h2>
        <button type="button" class="${d.debriefHtml ? '' : 'primary'}" id="tDebrief" ${jobBusy(d.jobs.debrief) ? 'disabled' : ''}>${d.debriefHtml ? 'Разобрать заново' : 'Разобрать'} <span class="muted small">Sonnet ≈ $0.5–1, 3–5 мин</span></button></div>
      ${testJobBox(d.jobs.debrief, 'Агент читает папку задания…')}
      ${d.debriefHtml ? `<details ${pend(d.debrief?.library).length + pend(d.debrief?.playbook).length ? '' : 'open'}><summary><strong>debrief.md</strong></summary><div class="md case-md">${d.debriefHtml}</div></details>`
        : !jobBusy(d.jobs.debrief) ? `<p class="muted small" style="margin:0">${m.imported ? 'Агент прочтёт задание и рабочую папку: этапы, развилки, что сработало, куски для библиотеки и правила для плейбука. В библиотеку и плейбук попадёт только то, что ты добавишь.'
          : 'Разбирай после сдачи, а лучше — когда придёт результат и фидбек.'}</p>` : ''}
      ${testCandidatesHtml(d)}
    </section>

    <section class="card stack">
      <h2 style="margin:0">Задание</h2>
      ${d.task.trim() ? `<div class="md case-md" id="tTaskView">${d.taskHtml}</div>` : '<p class="warn-text small" style="margin:0">Текста задания нет — вставь его, без него план не составить, а разбор будет хуже.</p>'}
      <details ${d.task.trim() ? '' : 'open'}><summary class="small">Править текст задания</summary>
        <textarea id="tTask" rows="12">${esc(d.task)}</textarea>
        <div class="row"><button type="button" class="small" id="tTaskSave">Сохранить</button>${m.taskFrom ? `<span class="muted small">найдено в ${esc(m.taskFrom)} — проверь</span>` : ''}</div></details>
      ${!m.imported ? `<div><h3 class="st-h">Файлы задания</h3>
        ${d.brief.length ? `<ul class="tight small">${d.brief.map((f) => `<li>${esc(f.path)} <span class="muted">${kb(f.size)}</span> <button type="button" class="link-btn inline" data-brdel="${esc(f.path)}">убрать</button></li>`).join('')}</ul>` : '<p class="muted small" style="margin:0">нет</p>'}
        <label class="small">Добавить файлы <input type="file" id="tBrief" multiple></label></div>` : ''}
    </section>

    <section class="card stack">
      <details><summary><strong>Рабочая папка</strong> <span class="muted small">${d.work.length}${d.work.length >= 300 ? '+' : ''} файлов · ${esc(d.dir)}/work</span></summary>
        <ul class="tight small test-files">${d.work.map((f) => `<li><button type="button" class="link-btn inline" data-wprev="${esc(f.path)}">${esc(f.path)}</button> <span class="muted">${kb(f.size)}</span></li>`).join('')}</ul>
        <pre class="voice-text hidden" id="tPrev"></pre></details>
    </section>
    <p class="row small"><button type="button" class="link-btn inline" id="tDelete">Удалить тестовое</button></p>`;
}

function testPlanHtml(d) {
  const p = d.plan;
  const busy = jobBusy(d.jobs.plan);
  const btn = `<button type="button" class="${p ? '' : 'primary'}" id="tPlan" ${busy || !d.task.trim() ? 'disabled' : ''}>${p ? 'Составить заново' : 'Составить план'} <span class="muted small">Opus ≈ $0.2–0.4, ~1 мин</span></button>`;
  const head = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2 style="margin:0">План</h2>${btn}</div>${testJobBox(d.jobs.plan, 'Opus составляет план…')}`;
  if (!p) {
    return `<section class="card stack">${head}${busy ? '' : `<p class="muted small" style="margin:0">Что оценивают и что сдавать, 4–8 этапов (что решаешь ты, что делает агент, какие куски брать из библиотеки),
      до 3 вопросов компании и ловушки из прошлых разборов. Потом открой чат Claude Code в папке проекта и вставь команду — скил пойдёт по плану.</p>`}</section>`;
  }
  const u = p.understanding;
  const copied = new Set(p.copied || []);
  const total = p.stages.reduce((s, x) => s + (x.hours || 0), 0);
  const done = p.stages.filter((x) => x.status === 'done').length;
  return `<section class="card stack">${head}
    <p class="muted small" style="margin:0">${esc(p.model || '')} · ${fmtDay(p.at)} · этапов готово ${done} из ${p.stages.length} · ~${total} ч${u.budget_hours ? ` при бюджете ${u.budget_hours} ч` : ''}
      ${p.new_type ? ' · <span class="warn-text">новый тип задания — библиотека почти не помогает</span>' : ''}
      ${p.check && !p.check.pass ? ` · <span class="warn-text" title="${esc(p.check.issues.join('; '))}">проверка не прошла: ${esc(p.check.issues[0])}</span>` : ''}</p>
    <div class="brief-grid">
      <div><h3 class="st-h">Что оценивают</h3><ul class="tight small">${u.evaluates.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>—</li>'}</ul></div>
      <div><h3 class="st-h">Что сдавать</h3><ul class="tight small">${u.deliverables.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>—</li>'}</ul>
        ${u.format ? `<p class="small muted" style="margin:4px 0 0">${esc(u.format)}</p>` : ''}</div>
    </div>
    <ol class="test-stages">${p.stages.map((s) => `<li class="test-stage ${s.status}">
      <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>${esc(s.title)}${s.hours ? ` <span class="muted small">~${s.hours} ч</span>` : ''}</strong>
        <select class="small" data-stage-id="${esc(s.id)}" aria-label="Статус этапа">${STAGE_ST.map(([k, l]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <p class="small" style="margin:4px 0">${esc(s.goal)}</p>
      <p class="small" style="margin:0"><span class="muted">Результат:</span> ${esc(s.result)}</p>
      ${s.me ? `<p class="small" style="margin:0"><span class="muted">Решаешь ты:</span> ${esc(s.me)}</p>` : ''}
      ${s.agent ? `<p class="small" style="margin:0"><span class="muted">Делает агент:</span> ${esc(s.agent)}</p>` : ''}
      ${s.assets.length ? `<p class="small" style="margin:0"><span class="muted">Из библиотеки:</span> ${s.assets.map((id) => {
        const a = d.assets[id];
        return a ? `<span class="chip ${copied.has(id) ? 'good' : ''}" title="${esc(a.what)}">${esc(a.title)}${copied.has(id) ? ' ✓' : ''}</span>${copied.has(id) ? '' : ` <button type="button" class="link-btn inline" data-acopy="${esc(id)}">скопировать</button>`}` : '';
      }).join(' ')}</p>` : ''}
      ${s.checkpoint ? `<p class="small muted" style="margin:0">Проверка: ${esc(s.checkpoint)}</p>` : ''}
    </li>`).join('')}</ol>
    ${p.questions.length ? `<div><h3 class="st-h">Вопросы компании до старта</h3><ul class="tight small">${p.questions.map((q) => `<li>${esc(q.q)} <span class="muted">— ${esc(q.why)}</span></li>`).join('')}</ul></div>` : ''}
    ${p.risks.length ? `<div><h3 class="st-h">Риски и ловушки</h3><ul class="tight small">${p.risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <p class="muted small" style="margin:0">Чат: открой Claude Code в папке CV Checker и вставь команду (кнопка вверху) — скил <code>test-task</code> прочтёт план и библиотеку и будет отмечать этапы здесь.</p>
  </section>`;
}

function testCandidatesHtml(d) {
  const lib = (d.debrief?.library || []).filter((x) => x.state === 'new');
  const rules = (d.debrief?.playbook || []).filter((x) => x.state === 'new');
  const added = [...(d.debrief?.library || []), ...(d.debrief?.playbook || [])].filter((x) => x.state === 'added').length;
  if (!lib.length && !rules.length) return added ? `<p class="muted small" style="margin:0">Из разбора добавлено: ${added}.</p>` : '';
  const at = d.assetTypes;
  return `${lib.length ? `<div><h3 class="st-h">В библиотеку · ${lib.length}</h3><div class="sug-list">${lib.map((x) => `<article class="ncard sug" data-cand="library" data-cid="${esc(x.id)}">
      <p class="sug-fact"><strong>${esc(x.title)}</strong> <span class="chip">${esc(at[x.type] || x.type)}</span></p>
      <p class="small mono" style="margin:0">${esc(x.path)}</p>
      <p class="small" style="margin:0">${esc(x.what)}</p>
      ${x.inputs ? `<p class="small muted" style="margin:0">На входе: ${esc(x.inputs)}</p>` : ''}
      ${x.adapt ? `<p class="small muted" style="margin:0">Поменять под новое: ${esc(x.adapt)}</p>` : ''}
      <div class="row sug-actions"><button type="button" class="primary small" data-cact="add">Добавить</button><button type="button" class="small" data-cact="skip">Пропустить</button>
        <button type="button" class="link-btn inline small" data-cprev="${esc(x.path)}">посмотреть файл</button></div>
      <p class="error" data-cerr></p></article>`).join('')}</div></div>` : ''}
    ${rules.length ? `<div><h3 class="st-h">В плейбук · ${rules.length}</h3><div class="sug-list">${rules.map((x) => `<article class="ncard sug" data-cand="playbook" data-cid="${esc(x.id)}">
      <p class="sug-fact"><strong>${esc(x.rule)}</strong></p>
      <p class="small muted" style="margin:0">раздел «${esc(x.section)}»${x.ref ? ` · ${esc(x.ref)}` : ''}</p>
      <div class="row sug-actions"><button type="button" class="primary small" data-cact="add">Добавить</button><button type="button" class="small" data-cact="skip">Пропустить</button></div>
      <p class="error" data-cerr></p></article>`).join('')}</div></div>` : ''}`;
}

function bindTest(d) {
  const slug = d.slug;
  const reload = () => renderTest(slug);
  const patch = async (body) => {
    try { await api(`/api/tests/${enc(slug)}`, { method: 'PATCH', body }); $('#tMetaSaved').textContent = 'сохранено'; setTimeout(() => { const x = $('#tMetaSaved'); if (x) x.textContent = ''; }, 1500); }
    catch (e) { alert(e.message); }
  };
  document.querySelectorAll('[data-tm]').forEach((el) => el.addEventListener('change', async () => {
    await patch({ [el.dataset.tm]: el.value });
    if (['result', 'type'].includes(el.dataset.tm)) reload();
  }));
  $('#tSubmit')?.addEventListener('click', async () => { await patch({ submitted: true }); reload(); });
  $('#tUnsubmit')?.addEventListener('click', async () => { await patch({ submitted: false }); reload(); });
  $('#tCmd')?.addEventListener('click', async (e) => {
    e.target.textContent = (await copyText(testCmd(slug))) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { e.target.textContent = 'Скопировать команду для чата'; }, 1800);
  });
  $('#tReveal')?.addEventListener('click', () => api(`/api/tests/${enc(slug)}/reveal`, { method: 'POST', body: { sub: 'work' } }).catch((e) => alert(e.message)));
  $('#tTaskSave')?.addEventListener('click', async () => { await patch({ task: $('#tTask').value }); reload(); });
  $('#tBrief')?.addEventListener('change', async (e) => {
    try { for (const f of e.target.files) await uploadTestFile(slug, f); } catch (err) { alert(err.message); }
    reload();
  });
  document.querySelectorAll('[data-brdel]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/tests/${enc(slug)}/files/${enc(b.dataset.brdel)}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    reload();
  }));
  document.querySelectorAll('[data-stage-id]').forEach((s) => s.addEventListener('change', async () => {
    try { await api(`/api/tests/${enc(slug)}/stages/${enc(s.dataset.stageId)}`, { method: 'PATCH', body: { status: s.value } }); } catch (e) { alert(e.message); }
    reload();
  }));
  document.querySelectorAll('[data-acopy]').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api(`/api/tests/library/${enc(b.dataset.acopy)}/copy`, { method: 'POST', body: { to: slug } }); b.replaceWith(`→ work/${r.path}`); }
    catch (e) { alert(e.message); }
  }));
  $('#tPlan')?.addEventListener('click', async (e) => {
    if (d.plan && !confirm('Составить план заново? Статусы этапов с теми же названиями сохранятся. Opus ≈ $0.2–0.4.')) return;
    e.target.disabled = true;
    try { await api(`/api/tests/${enc(slug)}/plan`, { method: 'POST' }); } catch (err) { alert(err.message); }
    reload();
  });
  $('#tDebrief')?.addEventListener('click', async (e) => {
    if (!confirm(`${d.debriefHtml ? 'Разобрать заново? Прошлый разбор заменится (вернётся, если агент упадёт). ' : ''}Агент прочитает папку задания, Sonnet ≈ $0.5–1, 3–5 минут.`)) return;
    e.target.disabled = true;
    try { await api(`/api/tests/${enc(slug)}/debrief`, { method: 'POST' }); } catch (err) { alert(err.message); }
    reload();
  });
  document.querySelectorAll('[data-cand] [data-cact]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('[data-cand]');
    try {
      await api(`/api/tests/${enc(slug)}/candidates/${card.dataset.cand}/${enc(card.dataset.cid)}`, { method: 'POST', body: { action: b.dataset.cact } });
      card.remove();
      testsData = null;
    } catch (e) { card.querySelector('[data-cerr]').textContent = e.message; }
  }));
  const prev = async (rel) => {
    const box = $('#tPrev');
    box.closest('details').open = true;
    box.classList.remove('hidden');
    try {
      const r = await api(`/api/tests/${enc(slug)}/preview?path=${enc(rel)}`);
      box.textContent = r.binary ? `${rel} — не текстовый файл (${kb(r.size)}), открой папку` : `${rel}\n\n${r.text}${r.truncated ? '\n…' : ''}`;
    } catch (e) { box.textContent = e.message; }
    box.scrollIntoView({ block: 'nearest' });
  };
  document.querySelectorAll('[data-wprev], [data-cprev]').forEach((b) => b.addEventListener('click', () => prev(b.dataset.wprev || b.dataset.cprev)));
  $('#tDelete')?.addEventListener('click', async () => {
    if (!confirm('Удалить тестовое вместе с рабочей папкой? Это не отменить.')) return;
    try { await api(`/api/tests/${enc(slug)}`, { method: 'DELETE' }); testsData = null; location.hash = '#/tests'; } catch (e) { alert(e.message); }
  });
  for (const j of [d.jobs.debrief, d.jobs.plan]) if (jobBusy(j)) attachFeed(j);
}

// ---------- библиотека ----------

function testLibraryHtml(lib) {
  const at = lib.assetTypes;
  const q = libQuery.toLowerCase();
  const items = lib.items.filter((x) => (!libType || x.type === libType) && (!q || [x.title, x.what, x.adapt, x.path, x.fromName].join(' ').toLowerCase().includes(q)));
  if (!lib.items.length) return '<div class="table-box empty-box">Библиотека пуста. Она пополняется из разбора прошлых тестовых: «Разобрать» → «Добавить» у предложенных кусков.</div>';
  return `<div class="row filters" style="gap:8px;flex-wrap:wrap">
      <input type="search" id="libQ" placeholder="поиск" value="${esc(libQuery)}" aria-label="Поиск по библиотеке">
      <select id="libT" aria-label="Тип"><option value="">все типы</option>${Object.entries(at).map(([k, l]) => `<option value="${k}" ${libType === k ? 'selected' : ''}>${l} · ${lib.items.filter((x) => x.type === k).length}</option>`).join('')}</select></div>
    <p class="muted small" style="margin:0">Агент в чате видит этот список в <code>test-tasks/LIBRARY.md</code> и копирует куски в новое задание сам; здесь — то же руками.</p>
    <div class="sug-list">${items.map((x) => `<article class="ncard sug" data-lib="${esc(x.id)}">
      <p class="sug-fact"><strong>${esc(x.title)}</strong> <span class="chip">${esc(at[x.type] || x.type)}</span> <span class="muted small">${esc(x.id)}</span></p>
      <p class="small" style="margin:0">${esc(x.what)}</p>
      ${x.inputs ? `<p class="small muted" style="margin:0">На входе: ${esc(x.inputs)}</p>` : ''}
      ${x.adapt ? `<p class="small muted" style="margin:0">Поменять под новое: ${esc(x.adapt)}</p>` : ''}
      <p class="small muted" style="margin:0"><a href="#/tests/t/${enc(x.from)}">${esc(x.fromName)}</a> (${esc(x.outcome)}) · <span class="mono">${esc(x.path)}</span></p>
      <div class="row sug-actions">
        <button type="button" class="small" data-lprev>Посмотреть</button>
        ${lib.active.length ? `<select class="small" data-lto aria-label="В какое задание">${lib.active.map((t) => `<option value="${esc(t.slug)}">${esc(t.name)}</option>`).join('')}</select>
          <button type="button" class="small" data-lcopy>Скопировать в задание</button>` : ''}
        <button type="button" class="link-btn inline small" data-ledit>править</button>
        <button type="button" class="link-btn inline small" data-ldel>убрать</button></div>
      <p class="small" data-lmsg></p>
      <pre class="voice-text hidden" data-lout></pre>
    </article>`).join('') || '<p class="muted">ничего не нашлось</p>'}</div>`;
}

function bindTestLibrary(lib) {
  const redraw = () => { $('#testsBody').innerHTML = testLibraryHtml(lib); bindTestLibrary(lib); };
  $('#libQ')?.addEventListener('input', (e) => { libQuery = e.target.value; const pos = e.target.selectionStart; redraw(); const i = $('#libQ'); i.focus(); i.setSelectionRange(pos, pos); });
  $('#libT')?.addEventListener('change', (e) => { libType = e.target.value; redraw(); });
  document.querySelectorAll('[data-lib]').forEach((card) => {
    const it = lib.items.find((x) => x.id === card.dataset.lib);
    const out = card.querySelector('[data-lout]');
    const msg = card.querySelector('[data-lmsg]');
    card.querySelector('[data-lprev]').addEventListener('click', async () => {
      if (!out.classList.contains('hidden')) { out.classList.add('hidden'); return; }
      try {
        const r = await api(`/api/tests/${enc(it.from)}/preview?path=${enc(it.path)}`);
        out.textContent = r.binary ? `не текстовый файл (${kb(r.size)})` : r.text + (r.truncated ? '\n…' : '');
      } catch (e) { out.textContent = e.message; }
      out.classList.remove('hidden');
    });
    card.querySelector('[data-lcopy]')?.addEventListener('click', async () => {
      const to = card.querySelector('[data-lto]').value;
      try { const r = await api(`/api/tests/library/${enc(it.id)}/copy`, { method: 'POST', body: { to } }); msg.className = 'small good-text'; msg.textContent = `скопировано в test-tasks/${to}/work/${r.path}`; }
      catch (e) { msg.className = 'small error'; msg.textContent = e.message; }
    });
    card.querySelector('[data-ledit]').addEventListener('click', async () => {
      const what = prompt('Что делает', it.what);
      if (what == null) return;
      const adapt = prompt('Что поменять под новое задание', it.adapt);
      if (adapt == null) return;
      try { Object.assign(it, await api(`/api/tests/library/${enc(it.id)}`, { method: 'PATCH', body: { what, adapt } })); redraw(); } catch (e) { alert(e.message); }
    });
    card.querySelector('[data-ldel]').addEventListener('click', async () => {
      if (!confirm(`Убрать «${it.title}» из библиотеки? Файл в папке задания останется.`)) return;
      await api(`/api/tests/library/${enc(it.id)}`, { method: 'DELETE' });
      lib.items = lib.items.filter((x) => x !== it);
      testsData.libraryCount = lib.items.length;
      redraw();
    });
  });
}

// ---------- плейбук ----------

function testPlaybookHtml(pb) {
  return `${pb.pending.length ? `<div><h3 class="st-h">Ждут решения · ${pb.pending.length}</h3><div class="sug-list">${pb.pending.map((x) => `<article class="ncard sug" data-pbs="${esc(x.id)}" data-slug="${esc(x.slug)}">
      <p class="sug-fact"><strong>${esc(x.rule)}</strong></p>
      <p class="small muted" style="margin:0"><a href="#/tests/t/${enc(x.slug)}">${esc(x.from)}</a>${x.ref ? ` · ${esc(x.ref)}` : ''}</p>
      <div class="row sug-actions"><select class="small" data-pbsec aria-label="Раздел">${pb.sections.map((s) => `<option ${s === x.section ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <button type="button" class="primary small" data-pbact="add">Добавить</button><button type="button" class="small" data-pbact="skip">Пропустить</button></div>
      <p class="error" data-cerr></p></article>`).join('')}</div></div>` : ''}
    <section class="card stack">
      <div class="row" style="justify-content:space-between"><span class="muted small">test-tasks/PLAYBOOK.md — агент в чате читает его перед каждым тестовым</span>
        <button type="button" class="small" id="pbEdit">Править</button></div>
      <div class="md case-md" id="pbView">${pb.html}</div>
      <div class="hidden stack" id="pbForm"><textarea id="pbText" rows="22" class="mono-ta">${esc(pb.md)}</textarea>
        <div class="row"><button type="button" class="primary small" id="pbSave">Сохранить</button><button type="button" class="small" id="pbCancel">Отмена</button></div></div>
    </section>`;
}

function bindTestPlaybook(pb) {
  const toggle = (edit) => { $('#pbView').classList.toggle('hidden', edit); $('#pbForm').classList.toggle('hidden', !edit); $('#pbEdit').classList.toggle('hidden', edit); };
  $('#pbEdit').addEventListener('click', () => toggle(true));
  $('#pbCancel').addEventListener('click', () => toggle(false));
  $('#pbSave').addEventListener('click', async () => {
    try { await api('/api/tests/playbook', { method: 'PUT', body: { md: $('#pbText').value } }); loadTests(currentRoute()); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-pbs] [data-pbact]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('[data-pbs]');
    try {
      await api(`/api/tests/${enc(card.dataset.slug)}/candidates/playbook/${enc(card.dataset.pbs)}`, { method: 'POST',
        body: { action: b.dataset.pbact, patch: { section: card.querySelector('[data-pbsec]').value } } });
      loadTests(currentRoute());
    } catch (e) { card.querySelector('[data-cerr]').textContent = e.message; }
  }));
}

// Блок на странице заявки (процесс найма): тестовое по этой заявке
function testTasksLine(d) {
  const ts = d.testTasks || [];
  if (!ts.length) return `<p class="small muted" style="margin:8px 0 0">Прислали тестовое? <a href="#/tests/new?vacancy=${enc(d.name)}">Добавить тестовое</a> — план по этапам и библиотека прошлых заданий.</p>`;
  return ts.map((t) => `<p class="small" style="margin:8px 0 0"><strong>Тестовое:</strong> <a href="#/tests/t/${enc(t.slug)}">${esc(testName(t))}</a> ${testPill(t.state)}
    ${t.progress.total ? ` · этап ${Math.min(t.progress.done + 1, t.progress.total)} из ${t.progress.total}` : ''}${t.due && !t.submittedAt ? ` · срок ${esc(t.due)}` : ''}</p>`).join('');
}
