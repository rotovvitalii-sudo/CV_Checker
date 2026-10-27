// CV Checker Web — фронтенд без сборки.
const STATUS_LABELS = {
  new: 'Новая', ready: 'Пакет готов', sent: 'Отправлено', replied: 'Ответили', interview: 'Интервью', offer: 'Оффер',
  rejected: 'Отказ', skip: 'Не подаюсь', no_reply: 'Без ответа',
};
const STEP_LABELS = { fit: 'оценка фита', fitquick: 'быстрый фит', tailor: 'адаптация CV', letter: 'сопроводительное', keywords: 'ключевые слова', master: 'импорт Master CV', answers: 'ответы на вопросы формы', edtech: 'расширение базы компаний', outline: 'структура письма', lettergen: 'генерация письма', formfill: 'ответы для формы', verdict: 'вердикт рекрутера', interview: 'подготовка к собеседованию', practice: 'оценка ответа', outreach: 'черновик сообщения', case1: 'разбор кейса', case2: 'карточка кейса', casescan: 'поиск фактов' };
const SCORE_LABELS = { task_fit: ['Задача', 4], domain: ['Домен', 2], role_type: ['Роль', 2], logistics: ['Логистика', 2] };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

let items = [];
let inbox = [];
let selected = null;
let detail = null;
const streams = new Map(); // jobId → EventSource
const feeds = new Map();   // jobId → [events]


async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), data);
  return data;
}

function scoreClass(t) {
  if (t == null) return '';
  return t >= 7 ? 'hi' : t >= 5 ? 'mid' : 'lo';
}
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
// Для долей изменений: правка в пару слов — это не «0%»
const pctFine = (x) => (x == null ? '—' : x > 0 && x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`);
const delta = (x) => (x == null || Math.round(x * 100) === 0 ? '' : `${x > 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`);
let masterVersion = null;
const runningJobs = (it) => Object.values(it.jobs || {}).filter((j) => j.state === 'running' || j.state === 'queued');

// ---------- маршруты: #/ — заявки, #/v/<имя> — вакансия, #/master — Master CV ----------

let homeTab = 'active';     // active | sent | archive
let focusAfterOpen = null;  // 'letter' — после открытия вакансии прокрутить к надиктовке
try { homeTab = localStorage.getItem('cvc-home-tab') || 'active'; } catch {}

function currentRoute() {
  const full = location.hash || '#/';
  const [h, qs] = full.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  const r = routeOf(h || '#/');
  r.params = params;
  return r;
}

function routeOf(h) {
  if (h.startsWith('#/v/')) return { view: 'vacancy', name: decodeURIComponent(h.slice(4)) };
  if (h.startsWith('#/master')) return { view: 'master' };
  if (h.startsWith('#/agent')) return { view: 'agent' };
  if (h.startsWith('#/profile')) return { view: 'profile' };
  if (h.startsWith('#/stats')) { homeView = 'stats'; return { view: 'home' }; }   // ссылка из уведомления «итог недели»
  if (h.startsWith('#/feed')) return { view: 'feed' };
  if (h.startsWith('#/cases')) return { view: 'cases', sub: decodeURIComponent(h.slice(8)).replace(/^\//, '') };
  return { view: 'home' };
}

function route() {
  const r = currentRoute();
  $('#homeView').classList.toggle('hidden', r.view !== 'home');
  $('#vacView').classList.toggle('hidden', r.view !== 'vacancy');
  $('#masterView').classList.toggle('hidden', r.view !== 'master');
  $('#agentView').classList.toggle('hidden', r.view !== 'agent');
  $('#profileView').classList.toggle('hidden', r.view !== 'profile');
  $('#feedView').classList.toggle('hidden', r.view !== 'feed');
  $('#casesView').classList.toggle('hidden', r.view !== 'cases');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === (r.view === 'vacancy' ? 'home' : r.view);
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (r.view === 'home' || r.view === 'feed') readFilters(r.view);
  if (r.view === 'home') { selected = null; loadList(); }
  else if (r.view === 'vacancy') select(r.name);
  else if (r.view === 'master') loadMaster();
  else if (r.view === 'agent') loadAgentPage();
  else if (r.view === 'profile') loadProfile();
  else if (r.view === 'feed') loadFeed();
  else if (r.view === 'cases') loadCases(r);
}
window.addEventListener('hashchange', route);
const openVacancy = (name) => { location.hash = `#/v/${enc(name)}`; };

// ---------- данные ----------

async function loadList() {
  const data = await api('/api/vacancies');
  items = data.items;
  inbox = data.inbox;
  masterVersion = data.masterVersion;
  if (currentRoute().view !== 'home') return;
  // Пока печатаешь в поиске, опрос обновляет только список — поле не перерисовывается
  if (document.activeElement?.id === 'fq-home') renderAllBody();
  else renderHome();
}

const ACTIVE = ['new', 'ready'];
const SENT = ['sent', 'replied', 'interview', 'offer'];
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE = ['rejected', 'skip', 'no_reply'];
const FIT_THRESHOLD = 7;

// Где заявка сейчас и что с ней делать — выводится из того, что уже есть в данных
function stageOf(i) {
  if (i.status === 'sent' && i.sent) {
    return { key: 'sent', chip: 'Отправлено', tone: 'info', table: `Отправлено · ${fmtDay(i.sent.at)}`, done: 4, text: '', action: 'open' };
  }
  const run = runningJobs(i)[0];
  const failed = Object.values(i.jobs || {}).find((j) => j.state === 'error');
  const fit = i.fit?.total;
  const low = fit != null && fit < FIT_THRESHOLD;
  // Шаги идут по порядку: фит → CV → письмо → отправка; дальний пройденный шаг закрашивает все до него
  const done = SENT.includes(i.status) ? 4 : i.letterFile ? 3 : i.hasCV ? 2 : fit != null ? 1 : 0;
  if (run) {
    const label = { tailor: 'CV в работе', letter: 'Письмо в работе', fit: 'Оценка фита', fitquick: 'Быстрый фит', keywords: 'Ключевые слова', outline: 'Структура письма', lettergen: 'Письмо в работе' }[run.kind] || 'В работе';
    return { key: 'agent', chip: 'Агент работает', tone: 'neutral', table: label, done, partial: true,
      text: `${STEP_LABELS[run.kind] || run.kind}: ${run.last || 'запускаю агента…'}`, action: 'log' };
  }
  if (failed) {
    return { key: 'error', chip: 'Ошибка', tone: 'bad', table: 'Ошибка агента', done,
      text: `${STEP_LABELS[failed.kind] || failed.kind}: ${failed.error || 'агент не справился'}`, action: 'open' };
  }
  if (i.hasCV && i.letterFile) {
    if (low) return { key: 'decide', chip: 'Решить', tone: 'warn', table: 'Ниже порога', done,
      text: `Пакет готов, но фит ${fit}/10 — ниже порога. Отправлять?`, action: 'decide' };
    return { key: 'ready', chip: 'Готово', tone: 'good', table: 'Готово к отправке', done,
      text: 'Пакет собран. Проверь CV и письмо глазами и отправь.', action: 'send' };
  }
  if (i.hasCV) {
    return { key: 'you', chip: 'Нужен ты', tone: 'info', table: 'Ждёт письмо', done,
      text: i.dictation ? 'CV готово, надиктовка есть. Осталось собрать письмо.' : 'CV готово. Для письма нужна твоя надиктовка — пару минут голосом, по-русски.',
      action: 'letter' };
  }
  if (low) return { key: 'decide', chip: 'Решить', tone: 'warn', table: 'Ниже порога', done,
    text: `Фит ${fit}/10 — ниже порога. Адаптировать CV или убрать в архив?`, action: 'decide' };
  return { key: 'new', chip: 'Новая', tone: 'neutral', table: 'Новая', done,
    text: fit == null ? 'Фит ещё не оценён. Открой вакансию и оцени.' : `Фит ${fit}/10. Следующий шаг — адаптировать CV под вакансию.`,
    action: 'tailor' };
}

const STAGE_ORDER = { ready: 1, you: 2, decide: 3, error: 4, agent: 5, new: 6, sent: 7 };
const plural = (n, f) => f[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2];
const mono = (v, cls = '') => `<strong class="mono ${cls}">${v}</strong>`;
const ICON = {
  mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path></svg>',
  warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>',
};

// ---------- главный экран ----------

function renderHome() {
  const active = items.filter((i) => ACTIVE.includes(i.status));
  const stages = new Map(items.map((i) => [i.name, stageOf(i)]));
  const ready = active.filter((i) => stages.get(i.name).key === 'ready').length;
  const waiting = active.filter((i) => ['you', 'decide'].includes(stages.get(i.name).key)).length;
  const pending = inbox.filter((it) => it.state !== 'done');

  const sub = [
    `${active.length} в работе`,
    ready ? `${ready} ${plural(ready, ['готова', 'готовы', 'готовы'])} к отправке` : '',
    waiting ? `${waiting} ${plural(waiting, ['ждёт', 'ждут', 'ждут'])} твоего решения` : '',
    pending.length ? `${pending.length} ${plural(pending.length, ['новая оценивается', 'новых оцениваются', 'новых оцениваются'])}` : '',
  ].filter(Boolean).join(' · ');

  const cards = active.slice().sort((a, b) => STAGE_ORDER[stages.get(a.name).key] - STAGE_ORDER[stages.get(b.name).key]
    || (b.fit?.total ?? -1) - (a.fit?.total ?? -1));

  $('#homeView').innerHTML = `<div class="page-wrap">
    <section class="home-head">
      <div>
        <h1>Заявки</h1>
        <p class="lead">${sub || 'Пока пусто — добавь первую вакансию.'}</p>
      </div>
      <form class="quick" id="quickForm">
        <label for="quick">Быстро добавить вакансию</label>
        <div class="quick-row">
          <input id="quick" type="text" placeholder="Ссылка или текст вакансии" autocomplete="off">
          <button type="submit" class="btn dark">Оценить фит</button>
        </div>
        <p class="error" id="quickErr"></p>
      </form>
    </section>

    <section id="masterBanner"></section>

    ${cards.length || pending.length ? `<section aria-labelledby="next" class="stack">
      <h2 id="next">Что сделать дальше</h2>
      <div class="cards">${pending.map(inboxCard).join('')}${cards.map((i) => nextCard(i, stages.get(i.name))).join('')}</div>
    </section>` : ''}

    <section aria-labelledby="all" class="stack">
      <div class="all-head">
        <h2 id="all">Все заявки</h2>
        <div class="row">
          ${homeView === 'table' ? `<div class="seg" role="group" aria-label="Фильтр">
            ${[['active', 'Активные', ACTIVE], ['sent', 'Отправленные', SENT], ['archive', 'Архив', ARCHIVE]].map(([k, l, st]) =>
              `<button type="button" data-tab="${k}" aria-pressed="${homeTab === k}">${l} · ${items.filter((i) => st.includes(i.status)).length}</button>`).join('')}
          </div>` : ''}
          <div class="seg" role="group" aria-label="Вид">
            <button type="button" data-hview="table" aria-pressed="${homeView === 'table'}">Таблица</button>
            <button type="button" data-hview="board" aria-pressed="${homeView === 'board'}">Доска</button>
            <button type="button" data-hview="stats" aria-pressed="${homeView === 'stats'}">Статистика</button>
          </div>
        </div>
      </div>
      ${homeView === 'stats' ? statsPeriodBar()
        : filterBar('home', homeFilterGroups(), homeVisible().length, items.length)}
      <div id="allBody">${homeView === 'board' ? boardView(stages) : homeView === 'stats' ? statsView() : allTable(stages)}</div>
    </section>
  </div>`;
  bindHome();
  loadMasterBanner();
}

function progress(st) {
  const segs = [0, 1, 2, 3].map((n) => {
    if (n < st.done) return '<span class="on"></span>';
    if (n === st.done && st.partial) return '<span class="part"></span>';
    return '<span></span>';
  }).join('');
  return `<div class="steps" aria-label="Шаг ${Math.min(st.done + 1, 4)} из 4: фит, CV, письмо, отправка">${segs}</div>`;
}

function nextCard(i, st) {
  const fit = i.fit?.total;
  const metrics = [
    `<span>Фит ${mono(fit != null ? `${fit}/10` : '—', fit != null && fit < FIT_THRESHOLD ? 'warn' : '')}</span>`,
    i.hasCV ? `<span>CV ${mono(pct(i.cv?.coverage))}</span>` : i.master ? `<span>База ${mono(pct(i.master.score))}</span>` : '',
    i.letter?.share != null ? `<span>Письмо ${mono(pct(i.letter.share))} твоих слов</span>`
      : i.cv?.recruiter != null ? `<span>Рекрутер ${mono(`${i.cv.recruiter}/5`)}</span>` : '',
    i.submittedAnswers?.length ? `<span>Ответы ${mono(i.submittedAnswers.length)}</span>` : '',
  ].join('');
  const n = esc(i.name);
  const actions = {
    send: `<div class="stack-btns"><button type="button" class="btn primary block" data-open="${n}">Проверить и отправить</button>
      <button type="button" class="btn ghost block" data-send="${n}">Уже отправил — отметить</button></div>`,
    letter: `<button type="button" class="btn primary block" data-open="${n}" data-focus="letter">${ICON.mic}Надиктовать письмо</button>`,
    decide: `<div class="two"><button type="button" class="btn ghost" data-open="${n}">Открыть</button>
      <button type="button" class="btn ghost muted-btn" data-archive="${n}">В архив</button></div>`,
    log: `<button type="button" class="btn ghost block" data-open="${n}">Смотреть лог агента</button>`,
    open: `<button type="button" class="btn ghost block" data-open="${n}">Открыть</button>`,
    tailor: `<button type="button" class="btn primary block" data-open="${n}">${fit == null ? 'Открыть и оценить' : 'Адаптировать CV'}</button>`,
  }[st.action];
  return `<article class="ncard clickable" data-card="${n}">
    <div class="ncard-head">
      <div><div class="company">${esc(i.company)}</div><h3><a href="#/v/${enc(i.name)}" class="card-link">${esc(i.role)}</a></h3></div>
      <span class="pill ${st.tone}">${st.chip}</span>
    </div>
    ${progress(st)}
    <p class="ncard-text">${esc(st.text)}</p>
    <div class="metrics">${metrics}</div>
    <div class="ncard-foot">${actions}</div>
  </article>`;
}

// Вакансии, которые ещё оцениваются агентом или ждут текста
function inboxCard(it) {
  const title = esc(it.preview || it.url || 'Новая вакансия');
  let chip, tone, body;
  if (it.state === 'running') {
    chip = 'Агент работает'; tone = 'neutral';
    body = `<p class="ncard-text">Оцениваю фит: ${esc(it.job?.last || 'запускаю агента…')}</p>`;
  } else if (it.state === 'needs_text') {
    chip = 'Нужен ты'; tone = 'info';
    body = `<p class="ncard-text">${esc(it.reason || 'Ссылку открыть не удалось.')} Вставь текст вакансии.</p>
      <label class="sr-only" for="t-${it.id}">Текст вакансии</label>
      <textarea id="t-${it.id}" rows="4" data-text="${it.id}" placeholder="Текст вакансии"></textarea>
      <div class="two"><button type="button" class="btn primary" data-act="text" data-id="${it.id}">Оценить фит</button>
      <button type="button" class="btn ghost" data-act="drop" data-id="${it.id}">Убрать</button></div>`;
  } else {
    chip = 'Ошибка'; tone = 'bad';
    body = `<p class="ncard-text">${esc(it.reason || it.job?.error || 'Агент не справился.')}</p>
      <div class="two"><button type="button" class="btn ghost" data-act="retry" data-id="${it.id}">Повторить</button>
      <button type="button" class="btn ghost" data-act="drop" data-id="${it.id}">Убрать</button></div>`;
  }
  return `<article class="ncard">
    <div class="ncard-head"><div><div class="company">${it.url ? esc(new URL(it.url).hostname) : 'новая вакансия'}</div><h3>${title}</h3></div>
      <span class="pill ${tone}">${chip}</span></div>
    ${progress({ done: 0, partial: it.state === 'running' })}
    ${body}
  </article>`;
}

function allTable(stages) {
  const st = { active: ACTIVE, sent: SENT, archive: ARCHIVE }[homeTab];
  const rows = homeVisible().filter((i) => st.includes(i.status));
  if (!rows.length) return filtersActive('home') ? emptyFiltered('home') : '<div class="table-box empty-box">Здесь пока ничего нет.</div>';
  const body = rows.map((i) => {
    const s = stages.get(i.name);
    const fit = i.fit?.total;
    const run = runningJobs(i)[0];
    const cv = i.hasCV ? (i.cv?.coverage != null ? pct(i.cv.coverage) : 'готово')
      : run?.kind === 'tailor' ? '<span class="muted">собирается…</span>'
        : i.master ? `<span class="muted" title="Матч с Master CV v${i.master.version}">база ${pct(i.master.score)}</span>` : '<span class="muted">—</span>';
    const letter = i.letter?.share != null ? pct(i.letter.share)
      : i.letterFile ? 'готово'
        : i.hasCV ? `<span class="muted">${i.dictation ? 'есть надиктовка' : 'нет надиктовки'}</span>` : '<span class="muted">—</span>';
    const status = ACTIVE.includes(i.status) || ['followup', 'sent'].includes(s.key) ? `<span class="pill ${s.tone}">${s.table}</span>`
      : `<span class="pill ${statusTone(i.status)}">${STATUS_LABELS[i.status]}${i.sent ? ` · ${fmtDay(i.sent.at)}` : ''}</span>`;
    const where = [i.company, i.fit?.location, answersCount(i)].filter(Boolean).map(esc).join(' · ')
      + (i.salaryMismatch ? (i.salaryMismatch.kind === 'check' ? ` · <span class="muted" title="${esc(salaryWarn(i))}">вилка: проверь</span>`
        : ` · <span class="warn-text" title="${esc(salaryWarn(i))}">⚠ вилка</span>`) : '');
    return `<tr>
      <td><a href="#/v/${enc(i.name)}" class="row-link">${esc(i.role)}</a><div class="muted small">${where}</div></td>
      <td class="mono ${fit != null && fit < FIT_THRESHOLD ? 'warn' : ''}">${fit != null ? `${fit}/10` : '<span class="muted">—</span>'}</td>
      <td class="mono">${cv}</td>
      <td class="mono">${letter}</td>
      <td>${status}</td>
      <td class="muted">${i.created ? new Date(i.created).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') : '—'}</td>
    </tr>`;
  }).join('');
  return `<div class="table-box"><table class="apps">
    <thead><tr><th>Вакансия</th><th>Фит</th><th>CV · ключи</th><th>Письмо</th><th>Статус</th><th>Добавлена</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// Плашка «Master CV обновлена»: только если есть CV, собранные из устаревшей базы
async function loadMasterBanner() {
  let m;
  try { m = await api('/api/master'); } catch { return; }
  const box = $('#masterBanner');
  if (!box) return;
  const stale = m.tailored.filter((t) => t.stale);
  if (!stale.length) { box.innerHTML = ''; box.className = ''; return; }
  const act = m.versions.find((v) => v.active);
  const date = act ? new Date(act.created).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
  box.className = 'banner warn';
  box.innerHTML = `${ICON.warn}<p>Master CV обновлена ${date} до <strong>v${String(m.active).padStart(3, '0')}</strong>.
    ${stale.length} ${plural(stale.length, ['адаптированное CV собрано', 'адаптированных CV собраны', 'адаптированных CV собраны'])} из старой версии — их можно пересобрать на новой базе.</p>
    <a href="#/master">Посмотреть</a>`;
}

function bindHome() {
  const root = $('#homeView');
  root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    focusAfterOpen = b.dataset.focus || null;
    openVacancy(b.dataset.open);
  }));
  root.querySelectorAll('[data-archive]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/vacancies/${enc(b.dataset.archive)}`, { method: 'PATCH', body: { status: 'skip' } }); } catch (e) { alert(e.message); }
    loadList();
  }));
  root.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => pendingAction(el)));
  root.querySelectorAll('.ncard[data-card]').forEach((c) => makeCardClickable(c, c.dataset.card));
  const byName = (n) => items.find((i) => i.name === n);
  root.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', () => openSentDialog(byName(b.dataset.send))));
  root.querySelectorAll('[data-hview]').forEach((b) => b.addEventListener('click', () => {
    homeView = b.dataset.hview;
    try { localStorage.setItem('cvc-home-view', homeView); } catch {}
    renderHome();
  }));
  if (homeView === 'board') bindBoard();
  if (homeView === 'stats') { loadWeek(); bindStatsPeriod(); }
  if (homeView !== 'stats') bindFilters('home', renderAllBody);
  bindEmptyReset();
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    homeTab = b.dataset.tab;
    try { localStorage.setItem('cvc-home-tab', homeTab); } catch {}
    renderHome();
  }));
  $('#quickForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#quick').value.trim();
    if (!v) return;
    const body = /^https?:\/\/\S+$/.test(v) ? { url: v } : { text: v };
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('/api/vacancies', { method: 'POST', body });
      $('#quick').value = '';
      loadList();
    } catch (err) { $('#quickErr').textContent = err.message; btn.disabled = false; }
  });
}

async function pendingAction(el) {
  const id = el.dataset.id;
  try {
    if (el.dataset.act === 'text') {
      const text = $(`[data-text="${id}"]`).value.trim();
      if (!text) return;
      await api(`/api/inbox/${id}/text`, { method: 'POST', body: { text } });
    } else if (el.dataset.act === 'retry') await api(`/api/inbox/${id}/retry`, { method: 'POST' });
    else if (el.dataset.act === 'drop') await api(`/api/inbox/${id}`, { method: 'DELETE' });
  } catch (e) { alert(e.message); }
  loadList();
}

// ---------- карточка ----------

async function select(name) {
  selected = name;
  await loadDetail();
  if (focusAfterOpen === 'letter' && $('#dictation')) {
    $('#dictation').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#dictation').focus({ preventScroll: true });
  }
  if (focusAfterOpen === 'submitted' && $('#submittedCard')) {
    $('#submittedCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#subQ')?.focus({ preventScroll: true });
  }
  focusAfterOpen = null;
}

async function loadDetail({ fromServer = false } = {}) {
  if (!selected) return;
  const keepDict = !fromServer && $('#dictation') && detail?.name === selected ? $('#dictation').value : null;
  // Недописанная пара «вопрос — ответ» (C6) переживает перерисовку карточки
  const keepSub = detail?.name === selected && $('#subQ') ? [$('#subQ').value, $('#subA').value] : null;
  if (detail?.name !== selected) subEdit = null; // правка пары не переносится на другую заявку
  if (detail?.name !== selected) $('#detail').innerHTML = '<div class="empty"><span class="spin"></span>Считаю метрики пакета…</div>';
  const want = selected;
  try {
    const d = await api(`/api/vacancies/${enc(want)}`);
    if (want !== selected) return; // пока грузилось, выбрали другую вакансию
    detail = d;
  } catch {
    detail = null;
    $('#detail').innerHTML = '<div class="empty">Вакансия не найдена.</div>';
    return;
  }
  if (keepDict !== null) detail.dictation = keepDict;
  renderDetail();
  if (keepSub && $('#subQ')) [$('#subQ').value, $('#subA').value] = keepSub;
}

function jobBlock(job) {
  if (!job) return '';
  const active = job.state === 'running' || job.state === 'queued';
  if (!active && job.state !== 'error') return '';
  const head = active
    ? `<div class="running"><span class="spin"></span>${job.state === 'queued' ? 'в очереди' : `идёт: ${STEP_LABELS[job.kind]}`} <span class="muted" data-elapsed="${job.started || job.created}"></span></div>`
    : `<p class="error">Ошибка: ${esc(job.error)}</p>`;
  return `${head}<div class="feed" data-feed="${job.id}"></div>`;
}

function renderDetail() {
  const d = detail;
  const el = $('#detail');
  const fit = d.fit;
  const jFit = d.jobs.fit, jTailor = d.jobs.tailor, jLetter = d.jobs.letter, jKw = d.jobs.keywords;
  const kwBusy = jKw && ['running', 'queued'].includes(jKw.state);
  const tailorBusy = jTailor && ['running', 'queued'].includes(jTailor.state);
  const letterBusy = jLetter && ['running', 'queued'].includes(jLetter.state);
  const fitBusy = jFit && ['running', 'queued'].includes(jFit.state);

  el.innerHTML = `
    <div class="head">
      <div class="score big ${scoreClass(fit?.total)}">${fit?.total ?? '—'}<small>${fit?.total != null ? '/10' : ''}</small></div>
      <div class="grow">
        <h1>${esc(d.role)}</h1>
        <div class="company">${esc(d.company)}</div>
        ${d.brief ? conditionsLine(d.brief) : ''}
        <div class="alive-line small" id="aliveLine"></div>
      </div>
      <div class="tools">
        <select id="status" aria-label="Статус">${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${k === d.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
        ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener"><button>Открыть на сайте ↗</button></a>` : ''}
        ${d.hasVacancy ? `<button data-doc="__vacancy__">Текст</button>` : ''}
        <button id="reveal">Папка</button>
      </div>
    </div>

    ${stepper(d)}
    ${briefBlock(d)}
    ${sendBlock(d)}
    ${processBlock(d)}
    ${offerBlock(d)}
    ${interviewBlock(d)}
    ${agentUsageLine(d)}

    <div class="card">
      <h2><span class="n">1</span>Матч
        <span class="right">${d.hasVacancy && d.hasVacancyText ? `<button class="small" id="fitBtn" ${fitBusy ? 'disabled' : ''} title="Быстрый фит: один ход модели, ≈ $0.003">${fit ? 'Переоценить' : 'Оценить фит'}</button>
          ${fit ? `<button class="small" id="fitDeepBtn" ${fitBusy ? 'disabled' : ''} title="Агент читает скил, бриф и карточки сам — точнее, ≈ $0.3">Подробно (≈ $0.3)</button>` : ''}` : ''}</span></h2>
      ${fit?.mode ? `<p class="${fit.mode === 'quick' && [5, 6].includes(fit.total) ? 'warn-text' : 'muted'} small" style="margin:-6px 0 8px">${fit.mode === 'quick'
        ? ([5, 6].includes(fit.total) ? `Быстрый фит ${fit.total}/10 — на границе: быстрый иногда ставит на балл ниже, чем подробный. Если вакансия интересна — нажми «Подробно».`
          : `Быстрый фит · ${esc(modelShort(fit.model))} · один ход. Для перспективной вакансии — «Подробно».`)
        : `Подробный фит агентом · ${esc(modelShort(fit.model))}.`}</p>` : ''}
      ${fitBusy || jFit?.state === 'error' ? jobBlock(jFit) : ''}
      ${d.hasVacancy && !d.hasVacancyText && !fitBusy ? `<div class="vac-text-box">
        <p class="muted small" style="margin:0 0 6px">Заявка добавлена без текста вакансии. Вставь его — быстрый фит оценит вакансию и ключи (≈ $0.003, полминуты), дальше доступны CV, письмо и подготовка.</p>
        <label class="sr-only" for="vacText">Текст вакансии</label>
        <textarea id="vacText" rows="8" placeholder="Скопируй текст вакансии целиком со страницы"></textarea>
        <div class="row" style="margin-top:8px"><button type="button" class="primary small" id="vacTextBtn">Сохранить и оценить фит</button>
          <span class="hint" style="margin:0" id="vacTextHint"></span></div></div>` : ''}
      ${fit?.scores ? fitBody(fit) : fit ? `<p class="muted">Балл ${fit.total}/10 из файла вакансии, без разбивки. Нажми «Переоценить», чтобы увидеть детали.</p>` : '<p class="muted">Фит ещё не оценён.</p>'}
      ${masterBlock(d, kwBusy, jKw)}
    </div>

    <div class="card">
      <h2><span class="n">2</span>CV под вакансию
        <span class="right">${d.hasCV ? `
          ${d.files.includes('CV.pdf') ? `<a href="/files/${enc(d.name)}/CV.pdf?download=1" title="${esc(d.exportNames.cvPdf)}"><button class="small primary">PDF</button></a>` : ''}
          <a href="/files/${enc(d.name)}/CV.docx?download=1" title="${esc(d.exportNames.cvDocx)}"><button class="small ${d.files.includes('CV.pdf') ? '' : 'primary'}">DOCX</button></a>
          ${d.files.includes('CV.pdf') ? `<a href="/files/${enc(d.name)}/CV.pdf/${enc(d.exportNames.cvPdf)}" target="_blank" rel="noopener"><button class="small">Открыть PDF</button></a>` : ''}
          ${d.files.includes('report.md') ? `<button class="small" data-doc="report.md">Отчёт</button>` : ''}
          ${d.files.includes('02-match-report.md') ? `<button class="small" data-doc="02-match-report.md">Совпадения</button>` : ''}` : ''}
        </span></h2>
      ${tailorBusy || jTailor?.state === 'error' ? jobBlock(jTailor) : ''}
      ${d.hasCV ? `<div class="row" style="margin-bottom:10px"><span class="chip ${d.cvStale ? 'warn' : ''}">собрано из Master v${d.baseVersion}${d.cvStale ? `, актуальна v${d.masterVersion} — можно пересобрать` : ''}</span>
        ${d.builtAt ? `<span class="muted">${new Date(d.builtAt).toLocaleDateString('ru-RU')}</span>` : ''}</div>` : ''}
      ${d.hasCV && d.cv ? cvBody(d.cv) : ''}
      ${verdictBlock(d)}
      ${d.hasCV ? exportNameRow(d) : ''}
      ${!tailorBusy ? `<div class="row" style="margin-top:${d.hasCV ? 12 : 0}px">
        <button id="tailorBtn" class="${d.hasCV ? '' : 'primary'}" ${d.hasVacancy && d.hasVacancyText ? '' : 'disabled'}>${d.hasCV ? 'Пересобрать CV' : 'Адаптировать CV'}</button>
        <span class="hint" style="margin:0">${d.hasVacancyText ? 'Агент tailor-cv: требования → карточки → CV.docx → чекер. Обычно 5–15 минут.' : 'Сначала вставь текст вакансии в блоке «Матч».'}</span></div>` : ''}
    </div>

    <div class="card">
      <h2><span class="n">3</span>Сопроводительное письмо</h2>
      ${letterBusy || jLetter?.state === 'error' ? jobBlock(jLetter) : ''}
      ${d.letterText ? letterBody(d) : ''}
      ${outlineBlock(d, d.jobs.outline)}
      <div class="${d.letterText ? 'hint' : ''}" style="margin:${d.letterText ? '14px 0 6px' : '0 0 6px'}">${d.letterText ? 'Надиктовка (можно поправить и пересобрать):' : 'Надиктуй по-русски, что хочешь сказать: почему эта компания, какую историю рассказать, чем закрыть риски. Агент переведёт и выстроит, ≥80% слов останутся твоими.'}</div>
      <div class="dict">
        <textarea id="dictation" placeholder="Нажми 🎤 и говори, или вставь текст…">${esc(d.dictation)}</textarea>
        <button class="mic" id="mic" title="Диктовка голосом" aria-label="Диктовка голосом">🎤</button>
      </div>
      <div class="hint" id="micHint"></div>
      <div class="row" style="margin-top:10px">
        <button id="letterBtn" class="${d.letterText ? '' : 'primary'}" ${!d.hasCV || letterBusy ? 'disabled' : ''}>${d.letterText ? 'Пересобрать из надиктовки' : 'Сделать письмо из надиктовки'}</button>
        <button id="letterGenBtn" ${!d.hasCV || letterBusy ? 'disabled' : ''} title="Без надиктовки: факты из базы со ссылками, голос — по твоим прошлым надиктовкам">${d.letter?.mode === 'generated' ? 'Сгенерировать заново' : 'Сгенерировать письмо'}</button>
        <span class="hint" style="margin:0" id="dictCount"></span>
        ${d.hasCV ? `<span class="hint" style="margin:0">Сгенерировать — агент пишет сам по структуре и кейсам, ≈ $0.8–2, 1–6 минут.
          Голос — ${d.hasVoice ? 'по <a href="#/cases/letters">голосовому профилю</a>' : 'по всем надиктовкам (<a href="#/cases/letters">собери голосовой профиль</a> — будет дешевле)'}.</span>` : ''}
        ${!d.hasCV ? '<span class="hint" style="margin:0">Сначала адаптируй CV.</span>' : ''}
      </div>
    </div>

    <div class="card" id="formCard"><h2><span class="n">↗</span>Подать на сайте</h2><p class="muted small">Загружаю…</p></div>
    ${d.hasVacancy && d.hasVacancyText ? answersBlock(d, d.jobs.answers) : ''}
    ${submittedBlock(d)}`;

  bindDetail();
  bindAnswers(d);
  bindSubmitted(d);
  loadFormCard(d);
  loadAlive(d);
  bindOutline(d);
  if (d.letterText) bindLetterExport(d);
  for (const j of [jFit, jTailor, jLetter, jKw, d.jobs.answers, d.jobs.outline, d.jobs.verdict, d.jobs.interview]) if (j) attachFeed(j);
  bindVerdict(d);
}

// Матч вакансии с актуальным Master CV (покрытие ключевых слов, scorer/check_master.py)
function masterBlock(d, kwBusy, jKw) {
  const m = d.master;
  if (kwBusy || jKw?.state === 'error') return `<div class="sub"><strong>Матч с Master CV</strong>${jobBlock(jKw)}</div>`;
  if (!m) {
    return `<div class="sub row"><strong>Матч с Master CV</strong>
      <span class="muted">не посчитан — у вакансии нет ключевых слов.</span>
      ${d.hasVacancy && d.hasVacancyText ? '<button class="small" id="kwBtn">Извлечь ключи</button>' : ''}</div>`;
  }
  const cls = m.score >= 0.75 ? 'good' : m.score >= 0.5 ? 'warn' : 'bad';
  return `<div class="sub">
    <div class="row"><strong>Матч с Master CV v${m.version}</strong>
      <span class="chip ${cls}">${pct(m.score)}</span><span class="muted">must ${m.must}</span>
      ${m.delta != null ? `<span class="muted">${delta(m.delta) || '±0%'} к v${m.prevVersion}</span>` : ''}
      ${d.cv?.coverage != null ? `<span class="muted">· адаптированное CV: ${pct(d.cv.coverage)}</span>` : ''}</div>
    ${m.mustMiss.length ? `<div class="row" style="margin-top:6px"><span class="muted">Нет в Master (must):</span>${m.mustMiss.map((k) => `<span class="chip">${esc(k.split('|')[0])}</span>`).join(' ')}</div>` : ''}
  </div>`;
}

// claude-haiku-5-5 → Haiku 5.5
const modelShort = (m) => { const x = String(m || '').match(/(haiku|sonnet|opus|fable)-(\d+)-(\d+)/i); return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : (m || 'модель'); };

function fitBody(f) {
  const bars = Object.entries(SCORE_LABELS).map(([k, [lbl, max]]) => {
    const v = f.scores[k] ?? 0;
    return `<div class="bar"><div class="lbl"><span>${lbl}</span><span>${v}/${max}</span></div>
      <div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div></div>`;
  }).join('');
  const flags = [
    ...(f.hard_filters || []).map((h) => `<span class="chip bad">⛔ ${esc(h)}</span>`),
    ...(f.flags || []).map((h) => `<span class="chip warn">${esc(h)}</span>`),
  ].join(' ');
  // Задача, «почему», кейс и пробелы показаны в блоке «Коротко» — здесь только баллы
  return `<div class="bars">${bars}</div>
    ${flags ? `<div class="row" style="margin-bottom:10px">${flags}</div>` : ''}`;
}

function tile(k, v, s, cls) {
  return `<div class="tile ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s muted">${s}</div>` : ''}</div>`;
}

function cvBody(cv) {
  const cov = cv.coverage;
  const pagesOk = cv.lengthOk;
  return `<div class="tiles">
      ${tile('Покрытие ключевых слов', pct(cov), `must ${cv.must ?? '—'} · nice ${cv.nice ?? '—'} · цель 60–70%`, cov == null ? '' : cov >= 0.6 ? 'good' : 'warn')}
      ${tile('Изменение от базы', pct(cv.change), 'от своей версии Master, порог 30%', cv.changeOk == null ? '' : cv.changeOk ? 'good' : 'bad')}
      ${tile('Страницы', cv.pages ?? '—', cv.bottomFree != null ? `запас ${cv.bottomFree} мм · ${cv.words} слов` : '', pagesOk == null ? '' : pagesOk ? 'good' : 'bad')}
      ${tile('Оценка рекрутера', cv.recruiter != null ? `${cv.recruiter}/5` : '—', 'LLM по рубрике', cv.recruiter == null ? '' : cv.recruiter >= 4 ? 'good' : 'warn')}
    </div>
    ${cv.topThird ? `<p class="${cv.topThird.pass ? 'muted' : 'warn-text'}" style="margin:8px 0 0">Верхняя треть (до Experience): главная задача ${cv.topThird.task ? 'видна ✓' : 'не видна ✗'} · обязательных ключей ${cv.topThird.hit} (нужно ≥ ${cv.topThird.need})${!cv.topThird.pass && cv.topThird.missingTop.length ? ` · поднять наверх: ${cv.topThird.missingTop.map((k) => esc(k.split('|')[0])).join(', ')}` : ''}</p>` : ''}
    ${cv.taglineOk === false ? `<p class="warn-text" style="margin:8px 0 0">Шапка не начинается с названия роли из вакансии «${esc(cv.expectedTitle)}» — CV собрано по старым правилам, пересобери.</p>` : ''}
    ${cv.note ? `<p>${esc(cv.note)}</p>` : ''}
    <dl class="kv">
      ${cv.mustMiss?.length ? `<dt>Не покрыто (must)</dt><dd>${cv.mustMiss.map((m) => `<span class="chip">${esc(m.split('|')[0])}</span>`).join(' ')}</dd>` : ''}
      ${cv.gaps?.length ? `<dt>Пробелы</dt><dd><ul class="tight">${cv.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></dd>` : ''}
    </dl>`;
}

// C10: PDF и DOCX письма; третий сегмент — имя файла для просмотрщика PDF (как у CV)
const letterFileUrl = (d, fmt, download) => `/letter-file/${enc(d.name)}/${fmt}/${enc(fmt === 'pdf' ? d.exportNames.letterPdf : d.exportNames.letterDocx)}${download ? '?download=1' : ''}`;

// Письмо не прошло проверки — спрашиваем перед скачиванием
function letterCheckProblem(d) {
  const L = d.letter || {};
  const out = [];
  if (L.mode === 'generated' && L.facts && !L.facts.pass) out.push(L.facts.issues?.[0] || `факты с источником ${L.facts.ok}/${L.facts.total}`);
  if (L.mode !== 'generated' && L.shareOk === false) out.push(`твоих слов ${pct(L.share)} (нужно ≥ 80%)`);
  if (L.humanizeOk === false) out.push(`humanizer ${L.humanize} (нужно ≤ 3)`);
  return out.join(', ');
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function bindLetterExport(d) {
  const ok = () => {
    const p = letterCheckProblem(d);
    return !p || confirm(`Письмо не прошло проверку: ${p}. Скачать всё равно?`);
  };
  document.querySelectorAll('[data-letterdl]').forEach((a) => a.addEventListener('click', (e) => {
    if (!ok()) { e.preventDefault(); return; }
    // число страниц появится после сборки файла
    setTimeout(() => { if (detail?.name === d.name) loadDetail(); }, 4000);
  }));
  $('#cvAndLetter')?.addEventListener('click', () => {
    if (!ok()) return;
    triggerDownload(`/files/${enc(d.name)}/CV.pdf?download=1`);
    setTimeout(() => triggerDownload(letterFileUrl(d, 'pdf', true)), 800);
    setTimeout(() => { if (detail?.name === d.name) loadDetail(); }, 5000);
  });
}

function letterBody(d) {
  const L = d.letter || {};
  const gen = L.mode === 'generated';
  const chips = [
    `<span class="chip ${gen ? 'info' : ''}">${gen ? 'сгенерировано' : 'из надиктовки'}</span>`,
    gen && L.facts ? `<span class="chip ${L.facts.pass ? 'good' : 'bad'}">факты с источником ${L.facts.ok}/${L.facts.total}</span>` : '',
    !gen && L.share != null ? `<span class="chip ${L.shareOk ? 'good' : 'bad'}">твоих слов ${pct(L.share)}</span>` : '',
    L.humanize != null ? `<span class="chip ${L.humanizeOk ? 'good' : 'bad'}">humanizer ${L.humanize} (≤3)</span>` : '',
    L.words ? `<span class="chip">${L.words} слов</span>` : '',
  ].join(' ');
  return `<div class="row" style="margin-bottom:8px">${chips}
      <span style="margin-left:auto" class="row">
        <button class="small primary" id="copyLetter">Копировать</button>
        ${d.files.includes('04-cover-letter-trace.md') ? `<button class="small" data-doc="04-cover-letter-trace.md">Трассировка</button>` : ''}
        <a href="/files/${enc(d.name)}/${enc(d.letterFile)}?download=1" title="${esc(d.exportNames.letter)}"><button class="small">.md</button></a>
      </span></div>
    <div class="row letter-export">
      <span class="muted small">Файлом для формы:</span>
      <a class="btn small-btn primary" data-letterdl href="${letterFileUrl(d, 'pdf', true)}" title="${esc(d.exportNames.letterPdf)}">PDF</a>
      <a class="btn small-btn ghost" data-letterdl href="${letterFileUrl(d, 'docx', true)}" title="${esc(d.exportNames.letterDocx)}">DOCX</a>
      <a class="btn small-btn ghost" data-letterdl href="${letterFileUrl(d, 'pdf', false)}" target="_blank" rel="noopener">Открыть PDF</a>
      ${d.files.includes('CV.pdf') ? '<button type="button" class="btn small-btn ghost" id="cvAndLetter" title="Скачать CV и письмо в PDF">CV + письмо</button>' : ''}
      <span class="muted small mono">${esc(d.exportNames.letterPdf)}</span>
    </div>
    ${d.letterPdf?.pages > 1 ? `<p class="warn-text" style="margin:6px 0 0">PDF письма — ${d.letterPdf.pages} страницы. Сократи письмо до одной страницы.</p>` : ''}
    ${gen && L.facts && !L.facts.pass ? `<p class="error" style="margin:0 0 8px">Не готово: ${esc(L.facts.issues.slice(0, 3).join('; '))}</p>` : ''}
    <div class="letter" id="letterText">${esc(d.letterText.trim())}</div>
    ${d.letterPrev ? `<details class="letter-prev"><summary class="small">Прежнее письмо · ${d.letterPrev.mode === 'generated' ? 'сгенерированное' : 'из надиктовки'} · ${d.letterPrev.words} слов${d.letterPrev.at ? ` · заменено ${fmtDay(d.letterPrev.at)}` : ''}</summary>
      <div class="letter muted">${esc(d.letterPrev.preview)}${d.letterPrev.preview.length >= 600 ? '…' : ''}</div>
      <button type="button" class="small" id="letterRevert">Вернуть прежнее письмо</button></details>` : ''}
    ${gen && d.letterFacts?.length ? `<details class="letter-facts"><summary>Откуда факты · ${d.letterFacts.length}</summary>
      <ol>${d.letterFacts.map((f) => `<li><span>${esc(f.text)}</span><span class="muted small"> — ${f.sources.map((s) => esc(factSource(s))).join(', ')}</span></li>`).join('')}</ol></details>` : ''}
    ${L.questions?.length ? `<p style="margin:12px 0 4px"><strong>${gen ? 'Проверь глазами' : 'Вопросы к тебе'}</strong></p><ul class="tight">${L.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    ${L.removed?.length ? `<p style="margin:12px 0 4px"><strong>Что убрано из надиктовки</strong></p><ul class="tight">${L.removed.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}`;
}

function bindDetail() {
  const d = detail;
  $('#status').addEventListener('change', async (e) => {
    if (e.target.value === 'sent' && !d.sent) {
      e.target.value = d.status;
      openSentDialog(d);
      return;
    }
    try { await api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { status: e.target.value } }); } catch (err) { alert(err.message); }
    if (e.target.value === 'rejected') openRejectDialog(d);
    refreshAfterSend();
  });
  bindSendBlock(d);
  bindProcess(d);
  bindInterview(d);
  bindOffer(d);
  bindExportName(d);
  $('#reveal').addEventListener('click', () => api(`/api/vacancies/${enc(d.name)}/reveal`, { method: 'POST' }));
  document.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => openDoc(b.dataset.doc)));
  $('#fitBtn')?.addEventListener('click', () => startStep('fit'));
  $('#fitDeepBtn')?.addEventListener('click', () => {
    if (!confirm('Подробный фит агентом: читает скил, бриф и карточки сам. ≈ $0.3, около минуты. Запустить?')) return;
    startStep('fit', { mode: 'deep' });
  });
  $('#vacText')?.addEventListener('input', (e) => {
    const n = e.target.value.trim() ? e.target.value.trim().split(/\s+/).length : 0;
    $('#vacTextHint').textContent = n ? `${n} слов${n < 50 ? ' — нужно хотя бы 50' : ''}` : '';
  });
  $('#vacTextBtn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api(`/api/vacancies/${enc(d.name)}/vacancy-text`, { method: 'POST', body: { text: $('#vacText').value } }); }
    catch (err) { alert(err.message); e.target.disabled = false; return; }
    await loadDetail();
    loadList();
  });
  $('#kwBtn')?.addEventListener('click', () => startStep('keywords'));
  $('#tailorBtn')?.addEventListener('click', () => {
    if (d.hasCV && !confirm('Пересобрать CV заново? Текущие файлы в папке будут перезаписаны.')) return;
    startStep('tailor');
  });
  $('#letterGenBtn')?.addEventListener('click', () => {
    if (d.letterText && !confirm('Сгенерировать письмо агентом? Текущее письмо станет «прежним» — его можно будет вернуть одной кнопкой.')) return;
    startStep('letter-generate');
  });
  $('#letterBtn')?.addEventListener('click', () => {
    if (d.letterText && !confirm('Пересобрать письмо из текущей надиктовки? Текущее письмо станет «прежним» — его можно будет вернуть.')) return;
    startStep('letter', { dictation: $('#dictation').value });
  });
  $('#letterRevert')?.addEventListener('click', async (e) => {
    const p = d.letterPrev;
    if (!confirm(`Вернуть прежнее письмо (${p.mode === 'generated' ? 'сгенерированное' : 'из надиктовки'}, ${p.words} слов)? Текущее станет «прежним» — можно будет вернуть обратно.`)) return;
    e.target.disabled = true;
    e.target.textContent = 'Возвращаю…';
    try { await api(`/api/vacancies/${enc(d.name)}/letter-revert`, { method: 'POST' }); } catch (err) { alert(err.message); }
    loadDetail();
  });
  $('#copyLetter')?.addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText($('#letterText').innerText); e.target.textContent = 'Скопировано ✓'; } catch { e.target.textContent = 'Не вышло — выдели вручную'; }
    setTimeout(() => { e.target.textContent = 'Копировать'; }, 1500);
  });

  const ta = $('#dictation');
  let t;
  const count = () => { $('#dictCount').textContent = ta.value.trim() ? `${ta.value.trim().split(/\s+/).length} слов` : ''; };
  count();
  ta.addEventListener('input', () => {
    count();
    clearTimeout(t);
    t = setTimeout(() => api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { dictation: ta.value } }), 600);
  });
  setupMic(ta, count);
}

async function startStep(kind, body) {
  // W2: перед платным шагом — вакансия ещё открыта?
  if (['tailor', 'letter-generate'].includes(kind) && !(await aliveGuard(detail))) return;
  try {
    await api(`/api/vacancies/${enc(detail.name)}/${kind}`, { method: 'POST', body: body || {} });
  } catch (e) { alert(e.message); return; }
  await loadDetail();
  loadList();
}

// ---------- живая лента агента (SSE) ----------

function attachFeed(job) {
  const box = document.querySelector(`[data-feed="${job.id}"]`);
  if (!box) return;
  const render = () => {
    const evs = feeds.get(job.id) || [];
    box.innerHTML = evs.map((e) => `<div class="${e.kind}">${e.kind === 'tool' ? '→ ' : ''}${esc(e.text)}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  };
  if (streams.has(job.id)) { render(); return; }
  feeds.set(job.id, []);
  const es = new EventSource(`/api/jobs/${job.id}/stream`);
  streams.set(job.id, es);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    feeds.get(job.id).push(ev);
    const live = document.querySelector(`[data-feed="${job.id}"]`);
    if (live) { live.insertAdjacentHTML('beforeend', `<div class="${ev.kind}">${ev.kind === 'tool' ? '→ ' : ''}${esc(ev.text)}</div>`); live.scrollTop = live.scrollHeight; }
    if (ev.done) {
      es.close();
      setTimeout(() => { loadList(); if (detail?.name === job.target) loadDetail(); }, 300);
    }
  };
  es.onerror = () => { es.close(); };
}

setInterval(() => {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const s = Math.floor((Date.now() - Number(el.dataset.elapsed)) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
}, 1000);

// Пока что-то идёт — обновляем список (фит новых вакансий идёт без открытой карточки)
setInterval(async () => {
  const active = inbox.some((i) => i.state === 'running') || items.some((i) => runningJobs(i).length);
  if (!active) return;
  await loadList();
}, 3000);

// ---------- микрофон (Web Speech API) ----------

// Панель браузера Claude блокирует микрофон для страниц — это ограничение платформы.
// Вместо кода ошибки показываем, где 🎤 работает: та же заявка в Chrome / Safari.
const MIC_BLOCKED = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

function micBlockedHint(reason, opts = {}) {
  const box = opts.hint || $('#micHint');
  if (!box || (!detail && !opts.link)) return;
  const link = opts.link || `${location.origin}/#/v/${enc(detail.name)}`;
  box.className = 'mic-blocked';
  box.innerHTML = `<p style="margin:0">${reason} Открой эту заявку в <strong>Chrome или Safari</strong> — там 🎤 работает.
      Надиктовка сохранится и появится здесь, когда вернёшься.</p>
    <div class="row"><code class="fname">${esc(link)}</code>
      <button type="button" class="small" id="copyMicLink">Скопировать ссылку</button></div>
    <p class="muted small" style="margin:0">Или диктовка macOS прямо здесь: поставь курсор в поле и дважды нажми Fn.</p>`;
  box.querySelector('#copyMicLink').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(link); e.target.textContent = 'Скопировано ✓'; } catch {
      // буфер обмена недоступен — выделяем ссылку, чтобы скопировать вручную
      const r = document.createRange(); r.selectNodeContents(box.querySelector('code'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      e.target.textContent = 'Выделено — нажми ⌘C';
    }
  });
}

// opts: {btn, hint, link} — для полей вне блока письма (база кейсов C9)
function setupMic(ta, onChange, opts = {}) {
  const btn = opts.btn || $('#mic');
  const hintBox = () => opts.hint || $('#micHint');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.title = 'Распознавание речи недоступно в этом браузере';
    btn.addEventListener('click', () => micBlockedHint('Этот браузер не умеет распознавать речь.', opts));
    return;
  }
  let rec = null;
  let base = '';
  let blocked = false;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    blocked = false;
    rec = new SR();
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = true;
    base = ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' : ta.value;
    rec.onresult = (e) => {
      let finalText = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      if (finalText) base += finalText.trim() + ' ';
      ta.value = base + interim;
      onChange();
    };
    rec.onerror = (e) => {
      if (MIC_BLOCKED.has(e.error)) {
        blocked = true;
        micBlockedHint('Микрофон здесь недоступен — панель браузера Claude его блокирует.', opts);
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        hintBox().textContent = `Микрофон: ${e.error}`;
      }
    };
    rec.onend = () => {
      rec = null;
      btn.classList.remove('on');
      ta.value = base.trimEnd();
      ta.dispatchEvent(new Event('input'));
      if (!blocked) hintBox().textContent = '';
    };
    rec.start();
    btn.classList.add('on');
    hintBox().textContent = 'Слушаю… нажми ещё раз, чтобы остановить.';
  });
}

// ---------- модалки ----------

async function openDoc(file) {
  const dlg = $('#docDialog');
  $('#docTitle').textContent = file === '__vacancy__' ? 'Текст вакансии' : file;
  $('#docBody').innerHTML = '<p class="muted">Загрузка…</p>';
  dlg.showModal();
  try {
    const { html } = await api(`/api/vacancies/${enc(detail.name)}/doc?file=${enc(file)}`);
    $('#docBody').innerHTML = html;
  } catch (e) { $('#docBody').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
$('#docClose').addEventListener('click', () => $('#docDialog').close());

const addDlg = $('#addDialog');
let addTab = 'text';
$('#addBtn').addEventListener('click', () => openAddDialog());

// Диалог «+ Вакансия»; foundOn — сайт каталога (C5), на котором нашёл вакансию
async function openAddDialog(foundOn = '') {
  $('#addError').textContent = '';
  if (!jobSites) { try { jobSites = await api('/api/job-sites'); } catch {} }
  const sel = $('#addFoundOn');
  const opts = (jobSites?.sites || []).filter((s) => !s.hidden || s.id === foundOn);
  sel.innerHTML = '<option value="">— не указано</option>' + opts.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = foundOn;
  syncManualChannel();
  syncAddTabs();
  addDlg.showModal();
}

// «Уже отправил»: канал по сайту, где нашёл (LinkedIn → LinkedIn, остальные → «Сайт вакансий»)
function syncManualChannel() {
  const id = $('#addFoundOn').value;
  if (id) $('#manChannel').value = id === 'linkedin' ? 'linkedin' : 'board';
}
$('#addFoundOn').addEventListener('change', syncManualChannel);
$('#addCancel').addEventListener('click', () => addDlg.close());
// Поля скрытых вкладок отключаем: иначе браузер проверяет required у «Уже отправил»
// и молча не отправляет форму с вкладки «Текст»
function syncAddTabs() {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === addTab));
  document.querySelectorAll('.tabpane').forEach((p) => {
    const off = p.dataset.pane !== addTab;
    p.classList.toggle('hidden', off);
    p.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = off; });
  });
  $('#addSubmit').textContent = addTab === 'manual' ? 'Добавить отправленную' : 'Оценить фит';
  if (addTab === 'manual' && !$('#manDate').value) $('#manDate').value = todayInput();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  addTab = b.dataset.tab;
  syncAddTabs();
}));
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addTab === 'manual') { submitManual(); return; }
  const body = addTab === 'text'
    ? { text: $('#addText').value, url: $('#addTextUrl').value }
    : { url: $('#addUrl').value };
  body.foundOn = $('#addFoundOn').value;
  try {
    await api('/api/vacancies', { method: 'POST', body });
    addDlg.close();
    $('#addText').value = ''; $('#addTextUrl').value = ''; $('#addUrl').value = '';
    if (currentRoute().view === 'home') loadList(); else location.hash = '#/';
  } catch (err) { $('#addError').textContent = err.message; }
});

// C4: заявка, отправленная вне приложения (docs/specs/11-manual-application.md)
async function submitManual() {
  const body = {
    company: $('#manCompany').value, role: $('#manRole').value, at: $('#manDate').value,
    channel: $('#manChannel').value, url: $('#manUrl').value, note: $('#manNote').value,
    foundOn: $('#addFoundOn').value,
  };
  try {
    const r = await api('/api/vacancies/manual', { method: 'POST', body });
    addDlg.close();
    ['#manCompany', '#manRole', '#manUrl', '#manNote'].forEach((s) => { $(s).value = ''; });
    location.hash = `#/v/${enc(r.name)}`;
  } catch (err) {
    $('#addError').innerHTML = esc(err.message) + (err.existing ? ` <a href="#/v/${enc(err.existing)}" id="openExisting">Открыть существующую</a>` : '');
    $('#openExisting')?.addEventListener('click', () => addDlg.close());
  }
}

// ---------- отправка и фоллоу-ап (M1, docs/specs/01-sent-and-follow-up.md) ----------

const CHANNEL_LABELS = {
  site: 'Сайт компании', board: 'Сайт вакансий', email: 'Email', linkedin: 'LinkedIn', referral: 'Реферал',
  recruiter: 'Рекрутер написал сам', other: 'Другое',
};
const OUTCOMES = [['replied', 'Ответили'], ['interview', 'Интервью'], ['offer', 'Оффер'], ['rejected', 'Отказ']];
const fmtDay = (iso) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
const todayInput = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysWord = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

let sentTarget = null; // заявка, для которой открыт диалог

function openSentDialog(it) {
  sentTarget = it;
  const dlg = $('#sentDialog');
  $('#sentRole').textContent = `${it.role} — ${it.company}`;
  $('#sentDate').value = todayInput();
  // Куда подавать: apply из файла вакансии (часто email), иначе ссылка на вакансию
  const apply = (it.apply || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  $('#sentTarget').value = apply || it.url || '';
  // Нашёл на сайте каталога (C5) — канал оттуда: LinkedIn или «Сайт вакансий»
  const found = it.foundOn ? (it.foundOn.id === 'linkedin' ? 'linkedin' : 'board') : '';
  dlg.querySelectorAll('input[name="channel"]').forEach((r) => { r.checked = r.value === (apply ? 'email' : found || (it.url ? 'site' : '')); });
  if (!$('#sentTarget').value && it.foundOn) $('#sentTarget').value = it.foundOn.name;
  $('#sentNote').value = '';
  $('#chkCvRow').classList.toggle('hidden', !it.hasCV);
  $('#chkLetterRow').classList.toggle('hidden', !it.letterFile);
  ['#chkCv', '#chkLetter', '#chkSkip'].forEach((s) => { $(s).checked = false; });
  $('#sentNoPackage').classList.toggle('hidden', it.hasCV);
  $('#sentError').textContent = '';
  updateSentButton();
  dlg.showModal();
}

function updateSentButton() {
  if (!sentTarget) return;
  const channel = $('#sentDialog').querySelector('input[name="channel"]:checked');
  const reviewed = $('#chkSkip').checked
    || ((!sentTarget.hasCV || $('#chkCv').checked) && (!sentTarget.letterFile || $('#chkLetter').checked));
  $('#sentSubmit').disabled = !channel || !reviewed || !$('#sentDate').value;
}

$('#sentDialog').addEventListener('change', updateSentButton);
$('#sentAnswersLink').addEventListener('click', (e) => {
  e.preventDefault();
  $('#sentDialog').close();
  focusAfterOpen = 'submitted';
  if (currentRoute().view === 'vacancy' && selected === sentTarget.name) select(sentTarget.name);
  else location.hash = `#/v/${enc(sentTarget.name)}`;
});
$('#sentCancel').addEventListener('click', () => $('#sentDialog').close());
$('#sentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    at: $('#sentDate').value,
    channel: $('#sentDialog').querySelector('input[name="channel"]:checked')?.value,
    target: $('#sentTarget').value,
    note: $('#sentNote').value,
    checklist: { cv: $('#chkCv').checked, letter: $('#chkLetter').checked, skipped: $('#chkSkip').checked },
  };
  try {
    await api(`/api/vacancies/${enc(sentTarget.name)}/sent`, { method: 'POST', body });
    $('#sentDialog').close();
    refreshAfterSend();
  } catch (err) { $('#sentError').textContent = err.message; }
});

function refreshAfterSend() {
  if (currentRoute().view === 'vacancy') loadDetail();
  loadList();
}

async function setOutcome(name, status, at) {
  await api(`/api/vacancies/${enc(name)}`, { method: 'PATCH', body: { status, at } });
  refreshAfterSend();
}

// Блок «Отправка» на карточке вакансии
// ---------- целевые компании и контакты (W4, docs/specs/26-target-companies.md) ----------

let targetsData = null;
let targetsTimer = null;
const CIRCLE_LABELS = { close: 'знаю близко', known: 'помнит меня', stranger: 'пока не знакомы' };
const CONTACT_STATUS = { none: 'не писал', written: 'написал', talked: 'поговорили', referred: 'рекомендовал' };
const LANGS = { en: 'English', pl: 'Polski', uk: 'Українська', ru: 'Русский' };

async function loadTargets(render = true) {
  try { targetsData = await api('/api/targets'); } catch { return; }
  if (render && feedTab === 'targets' && $('#targetsBox')) renderTargets();
}

function recruiterReply(p) {
  return `Thank you for reaching out! This role isn't quite my focus right now. I'm looking for ${p.role || '[role]'} roles in ${p.domain || '[domain]'}, where the main task is ${p.task || '[main task]'}. Happy to stay in touch if something like that comes up.`;
}

function contactRow(c, p) {
  const busy = p.job && ['running', 'queued'].includes(p.job.state);
  return `<li class="contact" data-pid="${esc(p.id)}">
    <div class="contact-head">
      <div><strong>${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</strong>
        ${p.role ? `<span class="muted"> · ${esc(p.role)}</span>` : ''} <span class="muted small">· ${CIRCLE_LABELS[p.circle] || p.circle} · ${LANGS[p.language] || p.language}</span>
        ${p.remind ? '<span class="pill warn">написал больше недели назад — можно напомнить</span>' : ''}</div>
      <div class="row small" style="gap:6px">
        <select data-cstatus="${esc(p.id)}" aria-label="Статус общения">${Object.entries(CONTACT_STATUS).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button type="button" class="small" data-cdraft="${esc(p.id)}" ${busy ? 'disabled' : ''}>${p.draft ? 'Новый черновик' : 'Черновик сообщения'}</button>
        <button type="button" class="link-btn inline danger" data-cdel="${esc(p.id)}">Удалить</button>
      </div>
    </div>
    ${busy ? `<div class="running small"><span class="spin"></span>Агент пишет черновик…</div>` : p.job?.state === 'error' ? `<p class="error small">${esc(p.job.error)}</p>` : ''}
    ${p.draft ? `<div class="draft"><p class="draft-text">${esc(p.draft.text)}</p>
      ${(p.draft.warn || []).map((w) => `<p class="warn-text small" style="margin:0">⚠ ${esc(w)}</p>`).join('')}
      <div class="row small"><button type="button" class="small primary" data-ccopy="${esc(p.id)}">Скопировать</button>
        <span class="muted">Отправляешь сам. После отправки поставь статус «написал».</span></div></div>` : ''}
  </li>`;
}

function targetCard(c) {
  const lastCheck = c.checkedAt ? `смотрел ${ago(c.checkedAt)}` : 'ещё не смотрел';
  const stale = !c.auto && (!c.checkedAt || Date.now() - Date.parse(c.checkedAt) > 7 * DAY_MS);
  return `<article class="ncard target" data-tid="${esc(c.id)}">
    <div class="ncard-head"><div><h3 style="margin:0">${esc(c.name)}</h3>
      <div class="muted small">${c.base ? `${c.base.sector === 'fintech' ? 'FinTech' : 'EdTech'} · ${c.auto ? 'вакансии подтягиваются сами' : 'без API'}` : 'нет в базах EdTech/FinTech'}</div></div>
      <button type="button" class="link-btn inline danger" data-tdel="${esc(c.id)}">Убрать</button></div>
    <label class="small muted" for="why-${esc(c.id)}">Чем интересна</label>
    <textarea id="why-${esc(c.id)}" data-twhy="${esc(c.id)}" rows="2" placeholder="Продукт, домен, команда, формат, зарплаты">${esc(c.why || '')}</textarea>
    <div class="row small" style="gap:8px;flex-wrap:wrap">
      ${c.careersUrl ? `<a href="${esc(c.careersUrl)}" target="_blank" rel="noopener" data-tcheck="${esc(c.id)}">Страница карьеры ↗</a>` : `<input data-turl="${esc(c.id)}" placeholder="Ссылка на страницу карьеры" style="flex:1 1 220px">`}
      ${!c.auto ? `<span class="${stale ? 'warn-text' : 'muted'}">${lastCheck} · проверяй раз в неделю</span>` : ''}
    </div>
    <div><strong class="small">Открытые вакансии сейчас · ${c.vacancies.length}</strong>
      ${c.vacancies.length ? `<ul class="tight small">${c.vacancies.slice(0, 6).map((v) => `<li>${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a>` : esc(v.title)} <span class="muted">· в ленте</span></li>`).join('')}</ul>`
        : `<p class="muted small" style="margin:2px 0 0">${c.auto ? 'Подходящих ролей нет — новые придут уведомлением.' : 'Приложение их не видит — смотри страницу карьеры.'}</p>`}
      ${c.applications.length ? `<p class="small" style="margin:4px 0 0">Твои заявки: ${c.applications.map((a) => `<a href="#/v/${enc(a.name)}">${esc(a.role)}</a> <span class="muted">(${esc(STATUS_LABELS[a.status] || a.status)})</span>`).join(', ')}</p>` : ''}
    </div>
    <div><strong class="small">Люди · ${c.contacts.length}</strong>
      ${c.contacts.length ? `<ul class="contacts">${c.contacts.map((p) => contactRow(c, p)).join('')}</ul>` : '<p class="muted small" style="margin:2px 0 0">Кто внутри или может познакомить? Бывшие коллеги, однокурсники, люди с той же функцией.</p>'}
      <form class="contact-add" data-tadd="${esc(c.id)}">
        <input name="name" placeholder="Имя" required>
        <input name="role" placeholder="Роль в компании">
        <select name="circle">${Object.entries(CIRCLE_LABELS).map(([k, l]) => `<option value="${k}" ${k === 'stranger' ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select name="language">${Object.entries(LANGS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <input name="link" placeholder="Ссылка (LinkedIn)">
        <button type="submit" class="small">+ Человек</button>
      </form>
    </div>
  </article>`;
}

function targetsHtml() {
  if (!targetsData) return '<div class="empty"><span class="spin"></span>Загружаю…</div>';
  const t = targetsData;
  const p = t.prefs || {};
  const n = t.companies.length;
  const people = t.companies.reduce((s, c) => s + c.contacts.length, 0);
  const talked = t.companies.reduce((s, c) => s + c.contacts.filter((x) => ['talked', 'referred'].includes(x.status)).length, 0);
  return `<div class="edtech-head">
      <div><p class="muted small" style="margin:0">Рекомендации — около 1% заявок, но 17–18% наймов (данные Ashby из воркбука). Держи список до ${t.limit} компаний,
        проверяй их раз в неделю и начинай с разговора, а не с просьбы о рекомендации.</p>
        <p style="margin:6px 0 0"><strong>${n} из ${t.limit}</strong> компаний · людей ${people} · поговорили ${talked}</p></div>
    </div>
    <form class="target-add row" id="targetAdd">
      <input name="name" placeholder="Компания" required style="flex:1 1 180px">
      <input name="why" placeholder="Чем интересна" style="flex:2 1 260px">
      <button type="submit" class="primary">+ В целевые</button>
    </form>
    ${n > t.limit ? `<p class="warn-text small">Компаний больше ${t.limit}: за длинным списком труднее следить каждую неделю.</p>` : ''}
    ${n ? `<div class="cards targets-grid">${t.companies.map(targetCard).join('')}</div>`
      : '<div class="table-box empty-box">Пока пусто. Добавь компанию здесь или кнопкой «★ В целевые» в карточке вакансии.</div>'}
    <details class="card recruiter-reply"><summary><strong>Ответ рекрутеру с неинтересной вакансией</strong> <span class="muted small">— поблагодарить и сказать, что ищешь</span></summary>
      <div class="form-grid" style="margin-top:10px">
        <label for="prefRole">Роль</label><input id="prefRole" data-pref="role" value="${esc(p.role || '')}" placeholder="Product Lead / Head of Product">
        <label for="prefDomain">Домен</label><input id="prefDomain" data-pref="domain" value="${esc(p.domain || '')}" placeholder="EdTech or FinTech">
        <label for="prefTask">Главная задача</label><input id="prefTask" data-pref="task" value="${esc(p.task || '')}" placeholder="building a learning product or academy from 0 to 1">
      </div>
      <p class="draft-text" id="replyText">${esc(recruiterReply(p))}</p>
      <button type="button" class="small primary" id="replyCopy">Скопировать</button>
    </details>`;
}

function renderTargets() {
  const box = $('#targetsBox');
  if (!box) return;
  // Пока печатаешь, перерисовку откладываем
  if (box.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
  box.innerHTML = targetsHtml();
  const tab = $('#feedView [data-ftab="targets"]');
  if (tab && targetsData) tab.textContent = `Компании · ${targetsData.companies.length}`;
  bindTargets();
}

function bindTargets() {
  const box = $('#targetsBox');
  if (!box || !targetsData) return;
  clearTimeout(targetsTimer);
  const busy = targetsData.companies.some((c) => c.contacts.some((p) => p.job && ['running', 'queued'].includes(p.job.state)));
  if (busy) targetsTimer = setTimeout(() => { if (feedTab === 'targets') loadTargets(); }, 4000);
  const call = async (url, method, body) => { try { await api(url, { method, body }); } catch (e) { alert(e.message); } };
  $('#targetAdd')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/api/targets', { method: 'POST', body: { name: f.elements.name.value, why: f.elements.why.value } });
      if (r.over) flash('Больше 15 компаний — держи список коротким.');
    } catch (err) { alert(err.message); return; }
    document.activeElement?.blur();
    loadTargets();
  });
  box.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Убрать компанию из целевых вместе с контактами?')) return;
    await call(`/api/targets/${enc(b.dataset.tdel)}`, 'DELETE');
    loadTargets();
  }));
  let t = null;
  box.querySelectorAll('[data-twhy]').forEach((ta) => ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => api(`/api/targets/${enc(ta.dataset.twhy)}`, { method: 'PATCH', body: { why: ta.value } }).catch(() => {}), 600);
  }));
  box.querySelectorAll('[data-turl]').forEach((inp) => inp.addEventListener('change', async () => {
    await call(`/api/targets/${enc(inp.dataset.turl)}`, 'PATCH', { careersUrl: inp.value });
    inp.blur();
    loadTargets();
  }));
  box.querySelectorAll('[data-tcheck]').forEach((a) => a.addEventListener('click', () => {
    api(`/api/targets/${enc(a.dataset.tcheck)}`, { method: 'PATCH', body: { checked: true } }).then(() => loadTargets()).catch(() => {});
  }));
  box.querySelectorAll('[data-tadd]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(['name', 'role', 'circle', 'language', 'link'].map((k) => [k, f.elements[k].value]));
    await call(`/api/targets/${enc(f.dataset.tadd)}/contacts`, 'POST', body);
    document.activeElement?.blur();
    loadTargets();
  }));
  const tidOf = (el) => el.closest('[data-tid]').dataset.tid;
  box.querySelectorAll('[data-cstatus]').forEach((s) => s.addEventListener('change', async () => {
    await call(`/api/targets/${enc(tidOf(s))}/contacts/${enc(s.dataset.cstatus)}`, 'PATCH', { status: s.value });
    s.blur();
    loadTargets();
  }));
  box.querySelectorAll('[data-cdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить контакт?')) return;
    await call(`/api/targets/${enc(tidOf(b))}/contacts/${enc(b.dataset.cdel)}`, 'DELETE');
    loadTargets();
  }));
  box.querySelectorAll('[data-cdraft]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await call(`/api/targets/${enc(tidOf(b))}/contacts/${enc(b.dataset.cdraft)}/draft`, 'POST');
    loadTargets();
  }));
  box.querySelectorAll('[data-ccopy]').forEach((b) => b.addEventListener('click', async () => {
    const c = targetsData.companies.find((x) => x.id === tidOf(b));
    const p = c.contacts.find((x) => x.id === b.dataset.ccopy);
    b.textContent = (await copyText(p.draft.text)) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { b.textContent = 'Скопировать'; }, 2000);
  }));
  let tp = null;
  box.querySelectorAll('[data-pref]').forEach((inp) => inp.addEventListener('input', () => {
    const prefs = Object.fromEntries([...box.querySelectorAll('[data-pref]')].map((x) => [x.dataset.pref, x.value]));
    $('#replyText').textContent = recruiterReply(prefs);
    clearTimeout(tp);
    tp = setTimeout(() => api('/api/targets-prefs', { method: 'PUT', body: prefs }).then((r) => { targetsData.prefs = r; }).catch(() => {}), 600);
  }));
  $('#replyCopy')?.addEventListener('click', async (e) => {
    e.target.textContent = (await copyText($('#replyText').textContent)) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { e.target.textContent = 'Скопировать'; }, 2000);
  });
}

// «★ В целевые» из карточки вакансии в ленте
async function addTargetFromFeed(company) {
  try {
    const r = await api('/api/targets', { method: 'POST', body: { name: company } });
    flash(`${company} — в целевых компаниях${r.over ? ' (их уже больше 15)' : ''}.`);
    loadTargets(false);
  } catch (e) { alert(e.message); }
}

// ---------- подготовка к собеседованию (W5, docs/specs/27-interview-prep.md) ----------

const STORY_THEMES = { 'hard-task': 'Сложная задача', conflict: 'Конфликт или несогласие', failure: 'Провал и что изменил',
  uncertainty: 'Решение в неопределённости', influence: 'Убедил людей без подчинения' };
let practiceQ = null;   // вопрос, на который сейчас отвечаешь
let practiceParent = null;
let aboutTimer = null;

function interviewVisible(d) {
  return ['replied', 'interview', 'offer'].includes(d.status) || ['recruiter', 'hiring_manager', 'final', 'offer'].includes(d.stage) || !!d.interview?.prep;
}

function forgotSummary(log) {
  const count = {};
  for (const r of log) for (const m of r.missing || []) {
    const k = String(m).toLowerCase().replace(/[^a-zа-яё0-9 ]/g, '').slice(0, 40).trim();
    if (k) (count[k] = count[k] || { text: m, n: 0 }).n += 1;
  }
  return Object.values(count).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
}

function interviewBlock(d) {
  if (!d.hasVacancy || !d.hasVacancyText) return '';
  const job = d.jobs.interview;
  const pjob = d.jobs.practice;
  const busy = job && ['running', 'queued'].includes(job.state);
  const pbusy = pjob && ['running', 'queued'].includes(pjob.state);
  const P = d.interview?.prep;
  const log = d.interview?.practice || [];
  if (!interviewVisible(d) && !busy) {
    return `<details class="card interview-card"><summary><strong>🎤 Подготовиться к собеседованию</strong> <span class="muted small">— откроется само, когда отметишь ответ или этап «Рекрутер»</span></summary>
      <div class="row" style="margin-top:10px"><button type="button" class="primary small" id="ivPrep">Подготовиться</button>
      <span class="hint" style="margin:0">«О себе», 5 историй из карточек, рискованные вопросы. Агент, ≈ $0.5–1.</span></div></details>`;
  }
  const qs = P ? [['__about', 'Расскажите о себе'], ...P.risky.map((r) => [r.q, r.q])] : [];
  if (!practiceQ && qs.length) practiceQ = qs[0][1];
  const last = log.slice().reverse().find((r) => r.question === practiceQ);
  const attempts = log.filter((r) => r.question === practiceQ);
  const forgot = forgotSummary(log);
  const words = P ? [P.about.now, P.about.strongest, P.about.why].join(' ').split(/\s+/).filter(Boolean).length : 0;
  return `<div class="card interview-card" id="interviewCard">
    <h2><span class="n">🎤</span>Собеседование
      <span class="right">${P && !busy ? '<button type="button" class="small" id="ivPrep">Подготовить заново</button>' : ''}</span></h2>
    ${busy || job?.state === 'error' ? jobBlock(job) : ''}
    ${!P && !busy ? `<div class="row"><button type="button" class="primary" id="ivPrep">Подготовиться</button>
      <span class="hint" style="margin:0">«О себе» под роль, 5 историй STAR из твоих карточек, рискованные вопросы и вопросы к компании. Агент, ≈ $0.5–1.</span></div>` : ''}
    ${P ? `
    <section class="iv-sec"><h3 class="st-h">Расскажите о себе <span class="muted small">· ~${Math.round(words / 2.5)} с вслух (цель 45–90)</span></h3>
      <ol class="tight"><li><strong>Кто я сейчас:</strong> ${esc(P.about.now)}</li><li><strong>Моё сильнейшее:</strong> ${esc(P.about.strongest)}</li><li><strong>Почему эта роль:</strong> ${esc(P.about.why)}</li></ol>
      <div class="row small"><button type="button" class="small" id="ivTimer">▶ Таймер</button><span class="mono" id="ivTime">0 с</span>
        <span class="muted">Скажи своими словами вслух — тезисы, а не текст для заучивания.</span></div></section>
    <section class="iv-sec"><h3 class="st-h">Банк историй · ${P.stories.length}</h3>
      ${P.stories.map((s) => `<details class="story"><summary><strong>${esc(STORY_THEMES[s.theme] || s.theme)}</strong> — ${esc(s.title)}
          ${s.card ? `<a class="small" href="#/cases/card/${enc(s.card)}">${esc(s.card)}</a>` : ''}</summary>
        <dl class="kv"><dt>S</dt><dd>${esc(s.s)}</dd><dt>T</dt><dd>${esc(s.t)}</dd><dt>A</dt><dd>${esc(s.a)}</dd><dt>R</dt><dd>${esc(s.r)}</dd>
          ${(s.fits || []).length ? `<dt>Подходит</dt><dd>${s.fits.map(esc).join('; ')}</dd>` : ''}</dl></details>`).join('')}
      ${(P.missing_themes || []).length ? `<p class="warn-text small">Нет карточки для: ${P.missing_themes.map(esc).join(', ')} — <a href="#/cases/new">надиктуй кейс</a>.</p>` : ''}</section>
    <section class="iv-sec"><h3 class="st-h">Рискованные вопросы</h3>
      <ul class="tight">${P.risky.map((r) => `<li><strong>${esc(r.q)}</strong><div class="muted small">${esc(r.why)}${r.hint ? ` · опора: ${esc(r.hint)}` : ''}</div></li>`).join('')}</ul></section>
    <section class="iv-sec"><h3 class="st-h">Вопросы к компании</h3><ul class="tight">${(P.ask || []).map((q) => `<li>${esc(q)}</li>`).join('')}</ul></section>
    <section class="iv-sec trainer"><h3 class="st-h">Тренажёр — голосом, по одному вопросу до сильного ответа</h3>
      <p class="muted small" style="margin:0 0 8px">Интервьюер копает уточнениями и не хвалит; ответ за тебя не переписывает. На живом собеседовании AI-подсказки не используй.</p>
      <label class="sr-only" for="ivQ">Вопрос</label>
      <select id="ivQ">${qs.map(([v, l]) => `<option value="${esc(v === '__about' ? l : v)}" ${practiceQ === (v === '__about' ? l : v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        ${practiceQ && !qs.some(([v, l]) => (v === '__about' ? l : v) === practiceQ) ? `<option selected>${esc(practiceQ)}</option>` : ''}</select>
      <div class="dict" style="margin-top:8px"><textarea id="ivAnswer" rows="5" placeholder="Нажми 🎤 и отвечай вслух, как на собеседовании"></textarea>
        <button class="mic" id="ivMic" type="button" title="Ответ голосом" aria-label="Ответ голосом">🎤</button></div>
      <div class="hint" id="ivMicHint"></div>
      <div class="row" style="margin-top:8px"><button type="button" class="primary small" id="ivSend" ${pbusy ? 'disabled' : ''}>Оценить ответ</button>
        <span class="hint" style="margin:0">≈ $0.05–0.15 за попытку.</span></div>
      ${pbusy ? `<div class="running small"><span class="spin"></span>Интервьюер слушает…</div>` : pjob?.state === 'error' ? `<p class="error">${esc(pjob.error)}</p>` : ''}
      ${last ? `<div class="attempt"><div class="row" style="gap:8px"><strong>Попытка ${attempts.length}: ${last.score}/4</strong>
          ${['example', 'own_role', 'decision', 'result'].map((k) => `<span class="chip ${last.criteria?.[k] ? 'good' : 'bad'}">${{ example: 'пример', own_role: 'моя роль', decision: 'решение', result: 'результат' }[k]}</span>`).join('')}</div>
        ${(last.missing || []).length ? `<p class="small" style="margin:6px 0 2px">Не хватило:</p><ul class="tight small">${last.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        ${(last.followups || []).map((f) => `<div class="row small" style="gap:6px;margin-top:4px"><span>↳ ${esc(f)}</span><button type="button" class="link-btn inline" data-follow="${esc(f)}">ответить на уточнение</button></div>`).join('')}
        ${attempts.length > 1 ? `<p class="muted small" style="margin:6px 0 0">Попытки: ${attempts.map((a) => `${a.score}/4`).join(' → ')}</p>` : ''}</div>` : ''}
      ${forgot.length ? `<p class="small" style="margin-top:10px"><strong>Что я каждый раз забываю сказать:</strong> ${forgot.map((f) => `${esc(f.text)} (${f.n}×)`).join('; ')}</p>` : ''}
    </section>` : ''}
  </div>`;
}

function bindInterview(d) {
  $('#ivPrep')?.addEventListener('click', () => {
    if (d.interview?.prep && !confirm('Подготовить заново? Текущая подготовка заменится; журнал тренировок сохранится.')) return;
    startStep('interview');
  });
  if (!$('#interviewCard')) return;
  $('#ivQ')?.addEventListener('change', (e) => { practiceQ = e.target.value; practiceParent = null; loadDetail(); });
  document.querySelectorAll('[data-follow]').forEach((b) => b.addEventListener('click', () => {
    practiceParent = practiceQ;
    practiceQ = b.dataset.follow;
    loadDetail().then(() => $('#ivAnswer')?.focus());
  }));
  const ta = $('#ivAnswer');
  if (ta) setupMic(ta, () => {}, { btn: $('#ivMic'), hint: $('#ivMicHint'), link: `${location.origin}/#/v/${enc(d.name)}` });
  $('#ivSend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api(`/api/vacancies/${enc(d.name)}/practice`, { method: 'POST', body: { question: practiceQ, answer: ta.value, parent: practiceParent } }); }
    catch (err) { alert(err.message); e.target.disabled = false; return; }
    loadDetail();
  });
  $('#ivTimer')?.addEventListener('click', (e) => {
    if (aboutTimer) { clearInterval(aboutTimer.id); aboutTimer = null; e.target.textContent = '▶ Таймер'; return; }
    const start = Date.now();
    e.target.textContent = '■ Стоп';
    aboutTimer = { id: setInterval(() => {
      const s = Math.round((Date.now() - start) / 1000);
      const el = $('#ivTime');
      if (!el) { clearInterval(aboutTimer?.id); aboutTimer = null; return; }
      el.textContent = `${s} с`;
      el.className = `mono ${s > 90 ? 'warn-text' : ''}`;
    }, 250) };
  });
}

// ---------- процесс найма: этапы, отказ, разбор после собеседования (W6, docs/specs/28-funnel-rejections.md) ----------

const FUNNEL_STAGES = [['applied', 'Отклик'], ['recruiter', 'Рекрутер'], ['hiring_manager', 'Hiring manager'], ['final', 'Финал'], ['offer', 'Оффер']];
const STAGE_LABEL = Object.fromEntries(FUNNEL_STAGES);
// Типичные причины отсева после этапа — таблица воркбука, блок 1
const STAGE_REASONS = {
  applied: 'Тишина после отклика: вакансия не про твой опыт; ключевой опыт спрятан глубоко в CV; ожидания не в бюджете.',
  recruiter: 'Отказ после рекрутера: долгий рассказ о себе; сумма вне вилки; непонятно, почему ищешь работу и почему эту.',
  hiring_manager: 'Отказ после hiring manager: общие ответы, мало конкретных примеров; не видно, что сделал именно ты и как думал; опыт не дотягивает до задачи.',
  final: 'Отказ после финала: не хватило ярких примеров «хочу работать с этим человеком»; нет вопросов к компании; у другого кандидата был опыт ровно в домене.',
};
const DEBRIEF_FIELDS = [['asked', 'Что спрашивали?'], ['concrete', 'Где отвечал конкретно?'], ['lost', 'Где поплыл?'], ['repeated', 'Какое уточнение повторялось?'], ['practice', 'Что потренировать к следующему?']];
const TPL_FEEDBACK = 'Thank you for the process! If you can share, what is the one thing that held me back the most? It would really help me in my search.';
const TPL_NUDGE = (role) => `Hi! I wanted to check whether there is any news on the ${role} position. If you need anything else from me, I'm happy to send it.`;

function processBlock(d) {
  if (!d.sent) return '';
  const cur = FUNNEL_STAGES.findIndex(([k]) => k === d.stage);
  const hist = Object.fromEntries((d.stageHistory || []).map((h) => [h.stage, h.at]));
  const r = d.rejection;
  const late = r && ['hiring_manager', 'final'].includes(r.stage);
  return `<div class="card process-card" id="processCard">
    <h2><span class="n">↻</span>Процесс найма</h2>
    <div class="stages" role="group" aria-label="Этап">
      ${FUNNEL_STAGES.map(([k, l], i) => `<button type="button" class="stage ${i <= cur ? 'done' : ''} ${i === cur ? 'cur' : ''}" data-stage="${k}" ${d.status === 'rejected' ? 'disabled' : ''}>
        <span>${l}</span>${hist[k] ? `<small>${fmtDay(hist[k])}</small>` : ''}</button>`).join('')}
    </div>
    ${!d.stageExplicit && d.status !== 'rejected' ? '<p class="muted small" style="margin:6px 0 0">Этап выведен из статуса — отметь, до какого дошёл, нажав на него.</p>' : ''}
    ${r ? `<div class="reject-box"><strong>Отказ на этапе «${esc(STAGE_LABEL[r.stage] || r.stage)}»</strong> <span class="muted small">${fmtDay(r.at)}</span>
      ${r.facts ? `<p><span class="muted small">Знаю точно:</span> ${esc(r.facts)}</p>` : ''}
      ${r.version ? `<p><span class="muted small">Моя версия:</span> ${esc(r.version)}</p>` : ''}
      ${r.feedback ? `<p><span class="muted small">Фидбек:</span> ${esc(r.feedback)}</p>` : ''}
      <div class="row small"><button type="button" class="link-btn inline" id="rejEdit">Изменить</button>
        ${late && !r.feedback ? '<button type="button" class="link-btn inline" data-tpl="feedback">Скопировать просьбу о фидбеке</button>' : ''}</div></div>`
      : d.status === 'rejected' ? '<div class="row"><button type="button" class="small" id="rejEdit">Записать отказ: факты и версия</button></div>'
        : `<div class="row small" style="margin-top:8px"><button type="button" class="link-btn inline" data-tpl="nudge">Скопировать напоминание «есть новости?»</button>
          <span class="muted">— если обещали ответить к сроку и молчат; один раз.</span></div>`}
    ${(d.debriefs || []).length ? `<div class="debriefs"><h3 class="st-h">Разборы после собеседований · ${d.debriefs.length}</h3>
      ${d.debriefs.slice().reverse().map((b) => `<details class="debrief"><summary>${fmtDay(b.at)} · ${esc(STAGE_LABEL[b.stage] || b.stage)}${b.practice ? ` — тренировать: ${esc(b.practice.slice(0, 60))}` : ''}</summary>
        <dl class="kv">${DEBRIEF_FIELDS.filter(([k]) => b[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(b[k])}</dd>`).join('')}</dl>
        <button type="button" class="link-btn inline danger" data-debdel="${esc(b.id)}">Удалить</button></details>`).join('')}</div>` : ''}
    ${cur >= 1 || (d.debriefs || []).length ? `<details class="debrief-new" ${sessionStorage.getItem(`cvc-deb-${d.name}`) ? 'open' : ''}><summary><strong>+ Разбор после собеседования</strong> <span class="muted small">5 минут, пока помнишь вопросы</span></summary>
      <form id="debForm" class="form-grid" style="margin-top:10px">
        <label for="debStage">Этап</label><select id="debStage">${FUNNEL_STAGES.slice(1, 4).map(([k, l]) => `<option value="${k}" ${k === d.stage ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${DEBRIEF_FIELDS.map(([k, l]) => `<label for="deb-${k}">${l}</label><textarea id="deb-${k}" data-deb="${k}" rows="2"></textarea>`).join('')}
        <span></span><div class="row"><button type="submit" class="primary small">Сохранить разбор</button><span class="error" id="debErr"></span></div>
      </form></details>` : ''}
  </div>`;
}

function bindProcess(d) {
  const box = $('#processCard');
  if (!box) return;
  box.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { stage: b.dataset.stage } }); } catch (e) { alert(e.message); return; }
    refreshAfterSend();
  }));
  $('#rejEdit')?.addEventListener('click', () => openRejectDialog(d));
  box.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', async () => {
    const text = b.dataset.tpl === 'feedback' ? TPL_FEEDBACK : TPL_NUDGE(d.exportNames?.role || d.role);
    const label = b.textContent;
    b.textContent = (await copyText(text)) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { b.textContent = label; }, 2000);
  }));
  box.querySelector('.debrief-new')?.addEventListener('toggle', (e) => {
    try { if (e.target.open) sessionStorage.setItem(`cvc-deb-${d.name}`, '1'); else sessionStorage.removeItem(`cvc-deb-${d.name}`); } catch {}
  });
  $('#debForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { stage: $('#debStage').value, ...Object.fromEntries([...box.querySelectorAll('[data-deb]')].map((t) => [t.dataset.deb, t.value])) };
    try { await api(`/api/vacancies/${enc(d.name)}/debrief`, { method: 'POST', body }); } catch (err) { $('#debErr').textContent = err.message; return; }
    try { sessionStorage.removeItem(`cvc-deb-${d.name}`); } catch {}
    flash('Разбор сохранён.');
    loadDetail();
  });
  box.querySelectorAll('[data-debdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить этот разбор?')) return;
    await api(`/api/vacancies/${enc(d.name)}/debrief/${enc(b.dataset.debdel)}`, { method: 'DELETE' });
    loadDetail();
  }));
}

let rejectTarget = null;
function openRejectDialog(it) {
  rejectTarget = it;
  const r = it.rejection || {};
  $('#rejectRole').textContent = `${it.role} — ${it.company}`;
  const st = r.stage || it.stage || 'applied';
  $('#rejStage').innerHTML = FUNNEL_STAGES.slice(0, 4).map(([k, l]) => `<option value="${k}" ${k === st ? 'selected' : ''}>${l}</option>`).join('');
  $('#rejFacts').value = r.facts || '';
  $('#rejVersion').value = r.version || '';
  $('#rejFeedback').value = r.feedback || '';
  $('#rejError').textContent = '';
  $('#rejectDialog').showModal();
}
$('#rejCancel').addEventListener('click', () => $('#rejectDialog').close());
$('#rejectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { stage: $('#rejStage').value, facts: $('#rejFacts').value, version: $('#rejVersion').value, feedback: $('#rejFeedback').value };
  try { await api(`/api/vacancies/${enc(rejectTarget.name)}/rejection`, { method: 'POST', body }); } catch (err) { $('#rejError').textContent = err.message; return; }
  $('#rejectDialog').close();
  refreshAfterSend();
});

function sendBlock(d) {
  const active = ACTIVE.includes(d.status);
  if (!d.sent) {
    if (!active) return '';
    const ready = d.hasCV && d.letterFile;
    return `<div class="card send-card">
      <div class="send-row">
        <div><h2 style="margin:0 0 4px">Отправка</h2>
          <p class="muted" style="margin:0">${ready ? 'Пакет готов. Отправь его сам на сайте или по почте и отметь здесь. Если не ответят — заявка сама уйдёт в архив «Без ответа».'
            : 'Отметь, когда подашься. Можно и без пакета — например, через Easy Apply с базовым CV.'}</p></div>
        <button type="button" class="btn ${ready ? 'primary' : 'ghost'}" id="markSent">Отметить отправленным</button>
      </div></div>`;
  }
  const s = d.sent;
  const where = [CHANNEL_LABELS[s.channel] || s.channel, s.target].filter(Boolean).map(esc).join(' · ');
  // Без фоллоу-апов: через N дней тишины заявка сама уйдёт в архив «Без ответа»
  const w = d.waiting;
  const fu = w ? `<p class="muted" style="margin:0">Ждём ответа ${daysWord(w.daysSinceSent)} · без ответа уйдёт в архив ${fmtDay(w.noReplyAt)}${w.daysLeft ? ` (через ${daysWord(w.daysLeft)})` : ''}</p>`
    : d.status === 'no_reply' ? '<p class="muted" style="margin:0">Ответа не было — заявка в архиве. Ответили позже? Выбери статус ниже.</p>' : '';
  const outcomes = ['sent', 'replied', 'interview', 'no_reply'].includes(d.status)
    ? `<div class="outcomes"><span class="muted">Что дальше:</span>
        ${OUTCOMES.filter(([k]) => k !== d.status).map(([k, l]) => `<button type="button" class="btn ghost small-btn" data-outcome="${k}">${l}</button>`).join('')}
        <label class="sr-only" for="outcomeDate">Дата</label><input type="date" id="outcomeDate" value="${todayInput()}" class="date-in">
      </div>` : '';
  const hist = (d.history || []).slice().reverse().map((h) =>
    `<li><span class="mono">${fmtDay(h.at)}</span> ${esc(STATUS_LABELS[h.from] || h.from || '—')} → <strong>${esc(STATUS_LABELS[h.to] || h.to)}</strong>${h.note ? ` <span class="muted">· ${esc(h.note)}</span>` : ''}</li>`).join('');
  return `<div class="card send-card">
    <div class="send-row">
      <div><h2 style="margin:0 0 4px">Отправлено ${fmtDay(s.at)} <span class="pill ${d.status === 'sent' ? 'info' : statusTone(d.status)}">${STATUS_LABELS[d.status]}</span></h2>
        <p style="margin:0">${where}${s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ''}</p>
        <p class="muted small" style="margin:4px 0 0">${s.package ? `CV из Master v${s.cvBaseVersion}${s.letterFile ? ' · письмо' : ''}` : 'без пакета'}${s.manual ? ' · добавлено вручную, отклик вне приложения' : s.checklist?.skipped ? ' · отправлено без проверки' : ''}</p></div>
      ${d.status === 'sent' ? '<button type="button" class="btn ghost muted-btn" id="undoSent">Отменить отправку</button>' : ''}
    </div>
    ${fu}
    ${outcomes}
    ${hist ? `<details class="hist"><summary>История</summary><ul>${hist}</ul></details>` : ''}
  </div>`;
}

function bindSendBlock(d) {
  $('#markSent')?.addEventListener('click', () => openSentDialog(d));
  $('#undoSent')?.addEventListener('click', async () => {
    if (!confirm('Отменить отметку отправки? Заявка вернётся в подготовку, след останется в истории.')) return;
    try { await api(`/api/vacancies/${enc(d.name)}/sent`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
    refreshAfterSend();
  });
  document.querySelectorAll('#detail [data-outcome]').forEach((b) => b.addEventListener('click', () => setOutcome(d.name, b.dataset.outcome, $('#outcomeDate')?.value)));
}

function statusTone(st) {
  return { sent: 'info', replied: 'info', interview: 'good', offer: 'good', rejected: 'bad', skip: 'neutral', no_reply: 'neutral' }[st] || 'neutral';
}

// ---------- разбор вакансии «коротко» (M2, docs/specs/02-vacancy-brief.md) ----------

const REQ_STATUS = {
  yes: ['✓', 'закрыто', 'good'],
  partial: ['≈', 'частично', 'warn'],
  gap: ['✕', 'пробел', 'bad'],
};
const FORMAT_LABELS = { remote: 'удалённо', hybrid: 'гибрид', onsite: 'офис' };
const SHOW_REQ = 5;

// Строка условий под заголовком: только то, что известно
function conditionsLine(b) {
  const c = b.conditions;
  const posted = c.postedDaysAgo != null
    ? (c.postedDaysAgo === 0 ? 'опубликовано сегодня' : `опубликовано ${daysWord(c.postedDaysAgo)} назад`)
    : /^\d{4}-\d{2}/.test(c.posted) ? `опубликовано ${c.posted}` : '';
  const parts = [
    c.salary && `<span class="cond strong">${esc(c.salary)}</span>`,
    c.format && `<span class="cond">${esc(FORMAT_LABELS[c.format] || c.format)}</span>`,
    c.location && `<span class="cond">${esc(c.location)}</span>`,
    c.seniority && `<span class="cond">${esc(c.seniority)}</span>`,
    c.source && `<span class="cond muted">${esc(c.source)}</span>`,
    posted && `<span class="cond muted">${posted}</span>`,
  ].filter(Boolean);
  return parts.length ? `<div class="conds">${parts.join('<span class="dot-sep" aria-hidden="true">·</span>')}</div>` : '';
}

// Шаги заявки из дизайна экрана 3: Фит → CV → Письмо → Отправка
function stepper(d) {
  const fit = d.fit?.total;
  const sent = !!d.sent;
  const steps = [
    { name: 'Фит', done: fit != null, note: fit == null ? 'не оценён' : `${fit} из 10 · ${fit >= 7 ? 'стоит идти' : fit >= 5 ? 'на грани' : 'ниже порога'}` },
    { name: 'CV', done: d.hasCV, note: d.hasCV ? `${pct(d.cv?.coverage)} ключей${d.cv?.pages ? ` · ${d.cv.pages} стр.` : ''}` : 'не собрано' },
    { name: 'Письмо', done: !!d.letterFile, note: d.letterFile ? (d.letter?.share != null ? `${pct(d.letter.share)} твоих слов` : 'готово') : d.hasCV ? 'нужна надиктовка' : 'после CV' },
    { name: 'Отправка', done: sent, note: sent ? `${fmtDay(d.sent.at)} · ${CHANNEL_LABELS[d.sent.channel] || d.sent.channel}` : 'проверь и отправь' },
  ];
  const current = steps.findIndex((s) => !s.done);
  return `<ol class="stepper" aria-label="Этапы заявки">${steps.map((s, i) => `
    <li class="${s.done ? 'done' : i === current ? 'current' : ''}" ${i === current ? 'aria-current="step"' : ''}>
      <span class="num" aria-hidden="true">${s.done ? '✓' : i + 1}</span>
      <span><span class="st-name">${s.name}</span><span class="st-note">${esc(s.note)}</span></span>
    </li>`).join('')}</ol>`;
}

function reqItem(r) {
  const [icon, label, tone] = REQ_STATUS[r.status] || ['○', 'не проверено', 'neutral'];
  return `<li class="req">
    <details>
      <summary><span class="req-ic ${tone}" title="${label}" aria-label="${label}">${icon}</span><span class="req-text">${esc(r.text)}</span></summary>
      ${r.evidence ? `<p class="req-ev">${r.status ? '' : '<span class="muted">Что считается доказательством: </span>'}${esc(r.evidence)}</p>` : ''}
    </details></li>`;
}

// C9: на какие карточки базы кейсов опираются фит, CV и письмо
function cardRefsLine(d) {
  const r = d.cardRefs;
  // Фит уже показан ссылкой «Кейс в центр» — здесь только CV и письмо
  if (!r || (!r.cv.length && !r.letter.length)) return '';
  const link = (x) => (x.missing ? `<span class="muted" title="карточки нет в базе">${esc(x.id)}?</span>` : `<a href="#/cases/card/${enc(x.id)}">${esc(x.id)}</a>`);
  const part = (label, list) => (list.length ? `<span><span class="muted small">${label}:</span> ${list.map(link).join(', ')}</span>` : '');
  return `<p class="card-refs"><span class="muted small">Опирается на карточки —</span> ${[part('CV', r.cv), part('Письмо', r.letter)].filter(Boolean).join('<span class="dot-sep" aria-hidden="true">·</span>')}</p>`;
}

function briefBlock(d) {
  const b = d.brief;
  if (!b) return '';
  const reqs = b.requirements;
  const shown = reqs.slice(0, SHOW_REQ);
  const rest = reqs.slice(SHOW_REQ);
  const c = b.counts;
  const tally = reqs.some((r) => r.status)
    ? `<span class="muted small">${[c.yes && `✓ ${c.yes}`, c.partial && `≈ ${c.partial}`, c.gap && `✕ ${c.gap}`].filter(Boolean).join(' · ')} из ${reqs.length}</span>`
    : reqs.length ? '<span class="muted small">статусы появятся после «Адаптировать CV»</span>' : '';
  const nodata = '<p class="muted small" style="margin:0">нет данных — нажми «Переоценить» в блоке «Матч»</p>';
  const missing = b.missing.filter((k) => !b.gaps.some((g) => g.toLowerCase().includes(k.split('|')[0].toLowerCase())));
  return `<section class="card brief" aria-labelledby="briefTitle">
    <h2 id="briefTitle" class="sr-only">Коротко о вакансии</h2>
    <div class="brief-grid">
      <div class="brief-col">
        <div class="brief-sec">
          <h3>Ты будешь</h3>
          ${b.task ? `<p class="brief-task">${esc(b.task)}</p>` : nodata}
          ${b.who && b.who !== b.task ? `<p class="muted small clamp" style="margin:6px 0 0" title="${esc(b.who)}">${esc(b.who)}</p>` : ''}
        </div>
        <div class="brief-sec">
          <h3>Что делать</h3>
          ${b.doing.length ? `<ul class="dots">${b.doing.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : nodata}
        </div>
        <div class="brief-sec">
          <div class="sec-head"><h3>Что нужно</h3>${tally}</div>
          ${reqs.length ? `<ul class="reqs">${shown.map(reqItem).join('')}</ul>
            ${rest.length ? `<details class="more"><summary>ещё ${rest.length}</summary><ul class="reqs">${rest.map(reqItem).join('')}</ul></details>` : ''}`
            : '<p class="muted small" style="margin:0">Требования появятся после извлечения ключей или «Адаптировать CV».</p>'}
        </div>
      </div>
      <div class="brief-col">
        <div class="brief-sec">
          <h3>Почему подходишь</h3>
          ${b.why ? `<p style="margin:0">${esc(b.why)}</p>` : nodata}
          ${b.anchor || d.cardRefs?.fit?.length ? `<p class="anchor"><span class="muted small">Кейс в центр</span>${d.cardRefs?.fit?.[0] && !d.cardRefs.fit[0].missing ? `<a href="#/cases/card/${enc(d.cardRefs.fit[0].id)}">${esc(d.cardRefs.fit[0].id)}</a>${b.anchor ? ' — ' : ''}` : ''}${esc(b.anchor || '')}</p>` : ''}
          ${cardRefsLine(d)}
          ${b.matched.length ? `<div class="chips">${b.matched.slice(0, 8).map((k) => `<span class="kchip good">${esc(k.split('|')[0])}</span>`).join('')}</div>` : ''}
        </div>
        <div class="brief-sec">
          <h3>Чего не хватает</h3>
          ${b.gaps.length ? `<ul class="dots">${b.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
          ${missing.length ? `<div class="chips"><span class="muted small">Нет в Master CV:</span>${missing.slice(0, 8).map((k) => `<span class="kchip">${esc(k.split('|')[0])}</span>`).join('')}</div>` : ''}
          ${!b.gaps.length && !missing.length ? '<p class="muted small" style="margin:0">Явных пробелов не найдено.</p>' : ''}
        </div>
      </div>
    </div>
  </section>`;
}

// ---------- имя файла при экспорте (E1, docs/specs/12-cv-export-filename.md) ----------

function exportNameRow(d) {
  const e = d.exportNames;
  return `<div class="export-name" id="exportName">
    <div class="row"><span class="muted small">Имя файла:</span>
      <code class="fname">${esc(e.cv)}</code><span class="muted small">.docx / .pdf</span>
      <button type="button" class="link-btn inline" id="exportEdit">Изменить</button></div>
    <form class="export-form hidden" id="exportForm">
      <label>Позиция <input id="exportRole" value="${esc(e.role)}" placeholder="${esc(e.defaultRole)}" maxlength="60"></label>
      <label>Компания <input id="exportCompany" value="${esc(e.company)}" placeholder="${esc(e.defaultCompany)}" maxlength="60"></label>
      <div class="row"><button type="submit" class="small primary">Сохранить</button>
        ${e.custom ? '<button type="button" class="small" id="exportReset">Как по умолчанию</button>' : ''}
        <button type="button" class="small" id="exportCancel">Отмена</button></div>
    </form>
  </div>`;
}

function bindExportName(d) {
  const form = $('#exportForm');
  if (!form) return;
  const save = async (body) => {
    try { await api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body }); } catch (e) { alert(e.message); }
    loadDetail();
  };
  $('#exportEdit').addEventListener('click', () => { form.classList.remove('hidden'); $('#exportRole').focus(); });
  $('#exportCancel').addEventListener('click', () => form.classList.add('hidden'));
  $('#exportReset')?.addEventListener('click', () => save({ exportRole: '', exportCompany: '' }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const role = $('#exportRole').value.trim();
    const company = $('#exportCompany').value.trim();
    // Совпало с вычисленным — не храним как своё
    save({ exportRole: role === d.exportNames.defaultRole ? '' : role, exportCompany: company === d.exportNames.defaultCompany ? '' : company });
  });
}

// ---------- статус и расход агента (S5, docs/specs/07-agent-status.md) ----------

const AGENT_STATES = {
  ok: ['ok', 'Агент на связи'],
  logged_out: ['bad', 'Агент не залогинен'],
  missing: ['bad', 'CLI не найден'],
  unknown: ['unknown', 'Статус агента неизвестен'],
};
const KIND_LABELS = { fit: 'Фит (подробно)', fitquick: 'Фит (быстрый)', tailor: 'Адаптация CV', letter: 'Письмо', keywords: 'Ключевые слова', master: 'Импорт Master CV', answers: 'Ответы формы', edtech: 'База компаний', outline: 'Структура письма', lettergen: 'Письмо (агент)', formfill: 'Форма на сайте', verdict: 'Вердикт рекрутера', interview: 'Собеседование', practice: 'Тренажёр', outreach: 'Сообщение контакту', case1: 'Кейс: вопросы', case2: 'Кейс: карточка', casescan: 'Факты из надиктовок', voice: 'Голосовой профиль' };
const usd = (x) => (x == null ? '—' : `≈ $${x.toFixed(2)}`);
const mins = (ms) => {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)} с` : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};
let agentStatus = null;
const runsWord = (x) => {
  const n = Math.round(x * 10) / 10;
  return `${n} ${Number.isInteger(n) ? plural(n, ['запуск', 'запуска', 'запусков']) : 'запуска'}`;
};

function renderAgentIndicator() {
  const el = $('#agentStatus');
  if (!el || !agentStatus) return;
  const [tone, label] = AGENT_STATES[agentStatus.state] || AGENT_STATES.unknown;
  const sub = agentStatus.state === 'ok' && agentStatus.subscription ? ` · ${agentStatus.subscription[0].toUpperCase()}${agentStatus.subscription.slice(1)}` : '';
  el.className = `agent-status ${tone}`;
  el.title = agentStatus.state === 'ok' ? 'Открыть статус и расход агента' : (agentStatus.error || label);
  const b = agentStatus.budget;
  const over = b?.limit && b.state !== 'ok' ? ` <span class="budget-chip ${b.state}">бюджет ${Math.round(b.pct * 100)}%</span>` : '';
  el.innerHTML = `<span class="dot"></span><span class="txt">${label}${sub}</span>${over}`;
}

// S5 P1 · мягкий бюджет: полоса и поле на экране «Агент»
function budgetBlock(b) {
  const pct = b.limit ? Math.round(b.pct * 100) : 0;
  return `<div class="card budget-card" id="budgetCard">
    <div class="row" style="justify-content:space-between"><strong>Бюджет на месяц</strong>
      <span class="mono">${b.limit ? `${usd(b.spent)} из ${usd(b.limit)} · ${pct}%` : `${usd(b.spent)} · бюджет не задан`}</span></div>
    ${b.limit ? `<div class="fn-bar" style="margin:8px 0"><span class="${b.state}" style="width:${Math.min(100, pct)}%"></span></div>` : ''}
    ${b.state === 'over' ? '<p class="error" style="margin:0 0 8px">Бюджет исчерпан. Задачи запускаются, но подумай, какие из них сейчас нужны.</p>'
      : b.state === 'warn' ? '<p class="warn-text small" style="margin:0 0 8px">Потрачено больше 80% бюджета.</p>' : ''}
    <form class="row" id="budgetForm"><label for="budgetIn" class="small">Лимит, $ в месяц</label>
      <input id="budgetIn" type="number" min="0" step="1" style="width:110px" value="${b.limit ?? ''}" placeholder="не задан">
      <button type="submit" class="small">Сохранить</button>
      <span class="hint" style="margin:0">Мягкий: ничего не блокирует, предупреждает при 80% и 100% (уведомление). Условная стоимость по ценам API.</span></form>
  </div>`;
}

function bindBudget() {
  $('#budgetForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const b = await api('/api/agent/budget', { method: 'PUT', body: { monthlyUsd: $('#budgetIn').value } });
      $('#budgetCard').outerHTML = budgetBlock(b);
      bindBudget();
      if (agentStatus) { agentStatus.budget = b; renderAgentIndicator(); }
    } catch (err) { alert(err.message); }
  });
}

async function loadAgentStatus(force) {
  try { agentStatus = await api('/api/agent/status', force ? { method: 'POST' } : {}); } catch { return; }
  renderAgentIndicator();
}
setInterval(() => loadAgentStatus(false), 60 * 1000);

async function loadAgentPage() {
  const root = $('#agentView');
  root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Загружаю…</div></div>';
  let u;
  try { u = await api('/api/agent/usage'); } catch (e) { root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`; return; }
  agentStatus = { ...u.status, budget: u.budget };
  renderAgentIndicator();
  const s = u.status;
  const [tone, label] = AGENT_STATES[s.state] || AGENT_STATES.unknown;
  const m = u.month;
  const pa = u.perApplication;
  const monthName = new Date().toLocaleDateString('ru-RU', { month: 'long' });
  const kinds = Object.entries(m.byKind).sort((a, b) => b[1].costUsd - a[1].costUsd);
  root.innerHTML = `<div class="page-wrap">
    <section class="home-head"><div><h1>Агент</h1>
      <p class="lead">Задачи конвейера выполняет Claude Code CLI на твоей подписке.</p></div></section>

    <section class="card agent-card ${tone}">
      <div class="agent-head">
        <span class="big-dot ${tone}" aria-hidden="true"></span>
        <div><h2>${label}</h2>
          <p class="muted" style="margin:2px 0 0">${[s.subscription && `подписка ${esc(s.subscription)}`, s.authMethod && s.authMethod !== 'none' && `вход через ${esc(s.authMethod)}`, s.version && `CLI ${esc(s.version)}`,
            s.checkedAt && `проверено ${new Date(s.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`].filter(Boolean).join(' · ')}</p></div>
        <button type="button" class="btn ghost" id="agentRecheck">Проверить снова</button>
      </div>
      ${s.state === 'logged_out' ? `<div class="banner warn"><p>Задачи не запустятся, пока CLI не залогинен. Открой Терминал и выполни:</p><code class="cmd">claude auth login</code></div>` : ''}
      ${s.state === 'missing' ? `<div class="banner warn"><p>Команда <code>claude</code> не найдена. Установи Claude Code CLI и перезапусти приложение (<code>npm run app</code>).</p></div>` : ''}
      ${s.state === 'unknown' && s.error ? `<p class="muted small" style="margin:0">${esc(s.error)}</p>` : ''}
    </section>

    <section class="stack" aria-labelledby="modelsTitle">
      <h2 id="modelsTitle">Модель по задачам</h2>
      <p class="muted small" style="margin:0">Sonnet — почти вдвое дешевле Opus с тем же качеством на CV и письмах. Haiku — ещё в разы дешевле: на ней быстрый фит
        (один ход без инструментов, ≈ $0.004; на 22 вакансиях решение «7+ / ниже» совпало с Sonnet в 20–21 случае) и задачи, которые проверяет скрипт или ты.
        «По умолчанию» — модель Claude Code (сейчас Opus, самая дорогая). Применяется к следующим запускам.</p>
      <div class="table-box" id="modelsBox"><p class="muted small" style="padding:12px">Загружаю…</p></div>
    </section>

    <section class="stack" aria-labelledby="usageTitle">
      <h2 id="usageTitle">Расход за ${monthName}</h2>
      ${budgetBlock(u.budget)}
      <div class="kpis">
        <div class="kpi"><span class="k">Запусков</span><span class="v mono">${m.runs}</span>${m.failed ? `<span class="s">из них с ошибкой: ${m.failed}</span>` : ''}</div>
        <div class="kpi"><span class="k">Время агента</span><span class="v mono">${mins(m.durationMs)}</span></div>
        <div class="kpi"><span class="k">Условная стоимость</span><span class="v mono">${usd(m.costUsd)}</span><span class="s">по ценам API, не счёт</span></div>
        <div class="kpi"><span class="k">Средняя заявка</span><span class="v mono">${pa.count ? usd(pa.costUsd) : '—'}</span>
          <span class="s">${pa.count ? `${mins(pa.durationMs)} · ${runsWord(pa.runs)} · по ${pa.count} ${plural(pa.count, ['заявке', 'заявкам', 'заявкам'])} с CV` : 'появится после первой адаптации CV'}</span></div>
      </div>
      ${kinds.length ? `<div class="table-box"><table class="apps">
        <thead><tr><th>Задача</th><th>Запусков</th><th>Время</th><th>Условно</th><th>В среднем</th></tr></thead>
        <tbody>${kinds.map(([k, v]) => `<tr><td>${KIND_LABELS[k] || esc(k)}</td><td class="mono">${v.runs}${v.failed ? ` <span class="muted">(${v.failed} ош.)</span>` : ''}</td>
          <td class="mono">${mins(v.durationMs)}</td><td class="mono">${usd(v.costUsd)}</td><td class="mono">${usd(v.costUsd / v.runs)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
      <p class="muted small" style="margin:0">Стоимость — оценка из ответа CLI по ценам API. На подписке за токены ты не платишь; реальный лимит подписки CLI не показывает.
        ${u.backfilled ? ` Журнал ведётся с ${new Date(u.since).toLocaleDateString('ru-RU')}; ${u.backfilled} ранних ${plural(u.backfilled, ['запуск восстановлен', 'запуска восстановлены', 'запусков восстановлены'])} из логов — история до этого неполная.` : ''}</p>
    </section>

    <section class="stack" aria-labelledby="lastTitle">
      <h2 id="lastTitle">Последние запуски</h2>
      ${u.last.length ? `<div class="table-box"><table class="apps">
        <thead><tr><th>Когда</th><th>Задача</th><th>Заявка</th><th>Модель</th><th>Время</th><th>Условно</th><th>Итог</th></tr></thead>
        <tbody>${u.last.map(runRow).join('')}</tbody></table></div>` : '<div class="table-box empty-box">Запусков пока не было.</div>'}
    </section>
  </div>`;
  bindBudget();
  $('#agentRecheck').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await loadAgentStatus(true);
    loadAgentPage();
  });
  loadModels();
}

// Модель по задачам: haiku / sonnet / opus / по умолчанию CLI
const MODEL_LABELS = { haiku: 'Haiku — дешевле всего', sonnet: 'Sonnet — баланс', opus: 'Opus — сильнее и дороже', default: 'По умолчанию (Claude Code)' };
const modelLabel = (m) => (!m ? '—' : /haiku/i.test(m) ? 'Haiku' : /sonnet/i.test(m) ? 'Sonnet' : /opus/i.test(m) ? 'Opus' : m === 'default' ? 'по умолч.' : m);

async function loadModels() {
  const box = $('#modelsBox');
  if (!box) return;
  let r;
  try { r = await api('/api/agent/models'); } catch (e) { box.innerHTML = `<p class="error" style="padding:12px">${esc(e.message)}</p>`; return; }
  box.innerHTML = `<table class="apps"><thead><tr><th>Задача</th><th>Модель</th><th></th></tr></thead><tbody>
    ${Object.entries(r.tasks).map(([k, t]) => `<tr><td>${esc(t.label)}</td>
      <td><select data-model="${esc(k)}">${r.choices.map((c) => `<option value="${c}" ${r.models[k] === c ? 'selected' : ''}>${esc(MODEL_LABELS[c] || c)}</option>`).join('')}</select></td>
      <td class="muted small">${r.models[k] !== t.default ? `рекомендовано: ${esc(modelLabel(t.default))}` : ''}</td></tr>`).join('')}
  </tbody></table>`;
  box.querySelectorAll('[data-model]').forEach((sel) => sel.addEventListener('change', async () => {
    try { await api('/api/agent/models', { method: 'PUT', body: { models: { [sel.dataset.model]: sel.value } } }); flash('Модель сохранена — со следующего запуска.'); } catch (e) { alert(e.message); }
    loadModels();
  }));
}

function runRow(r) {
  const known = items.find((i) => i.name === r.target);
  const target = r.target === 'master' ? 'Master CV'
    : known ? `<a href="#/v/${enc(known.name)}" class="row-link">${esc(known.role)}</a><div class="muted small">${esc(known.company)}</div>`
      : `<span class="muted">${esc(/^[0-9a-f]{8}$/.test(r.target) ? 'новая вакансия' : r.target)}</span>`;
  return `<tr>
    <td class="mono">${new Date(r.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${KIND_LABELS[r.kind] || esc(r.kind)}</td>
    <td>${target}</td>
    <td class="small">${esc(modelLabel(r.model))}</td>
    <td class="mono">${mins(r.durationMs)}</td>
    <td class="mono">${usd(r.costUsd)}</td>
    <td>${r.ok ? '<span class="pill good">готово</span>' : `<span class="pill bad" title="${esc(r.error || '')}">ошибка</span>`}${r.backfilled ? ' <span class="muted small" title="восстановлено из лога">лог</span>' : ''}</td>
  </tr>`;
}

// Строка расхода на карточке вакансии
function agentUsageLine(d) {
  const u = d.agentUsage;
  if (!u || !u.runs) return '';
  return `<p class="muted small usage-line">Агент по этой заявке: ${u.runs} ${plural(u.runs, ['запуск', 'запуска', 'запусков'])} · ${mins(u.durationMs)} · ${usd(u.costUsd)} условно
    · <a href="#/agent">подробнее</a></p>`;
}

// ---------- лента вакансий (S1, docs/specs/03-job-feed.md) ----------

const FEED_STEP = 20;
const DOMAIN_LABELS = { fintech_broker: 'финтех / брокеры', edtech: 'EdTech', crypto: 'крипто' };
const FEED_SOURCE_LABELS = { himalayas: 'Himalayas', remoteok: 'RemoteOK', remotive: 'Remotive' };
let feedData = null;
let feedTab = 'fit';
const feedShown = { fit: FEED_STEP, product: FEED_STEP, edtech: FEED_STEP, fintech: FEED_STEP, skipped: FEED_STEP };
try { feedTab = localStorage.getItem('cvc-feed-tab') || 'fit'; } catch {}

async function loadFeed() {
  const root = $('#feedView');
  if (!feedData) root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Собираю ленту…</div></div>';
  api('/api/job-sites').then((s) => { jobSites = s; if (feedTab === 'sites' && $('#sitesBox')) renderSites(); }).catch(() => {});
  try { feedData = await api('/api/feed'); } catch (e) {
    root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  // «Новые» — ключей не было в ленте при прошлом открытии; отметка держится до следующего захода в ленту
  if (!feedNewKeys) {
    const seen = readSeenFeed();
    feedNewKeys = new Set(seen ? feedData.items.map((i) => i.key).filter((k) => !seen.has(k)) : []);
  }
  writeSeenFeed(feedData.items.map((i) => i.key));
  renderFeedCounter(0);
  renderFeed();
  if (feedData.refresh) watchRefresh(feedData.refresh);
}

// ---------- S1 P1 · новые в ленте и клавиши S / X / O ----------
let feedNewKeys = null;   // новые с прошлого открытия ленты (до ухода с экрана)
let feedFocus = 0;        // индекс карточки под клавишами
function readSeenFeed() { try { const v = localStorage.getItem('cvc-feed-seen'); return v ? new Set(JSON.parse(v)) : null; } catch { return null; } }
function writeSeenFeed(keys) { try { localStorage.setItem('cvc-feed-seen', JSON.stringify(keys)); } catch {} }

function renderFeedCounter(n) {
  const a = document.querySelector('[data-nav="feed"]');
  if (!a) return;
  a.querySelector('.nav-count')?.remove();
  if (n > 0) a.insertAdjacentHTML('beforeend', ` <span class="nav-count" title="Новые вакансии с прошлого открытия ленты">${n}</span>`);
}

async function checkFeedNew() {
  if (currentRoute().view === 'feed') return;
  let r;
  try { r = await api('/api/feed/keys'); } catch { return; }
  const seen = readSeenFeed();
  if (!seen) { writeSeenFeed(r.keys); return; }   // первый запуск — точка отсчёта, без счётчика
  renderFeedCounter(r.keys.filter((k) => !seen.has(k)).length);
}

function feedKeyCards() { return [...document.querySelectorAll('#feedBody .feed-card')]; }
function markFeedFocus(scroll) {
  const cards = feedKeyCards();
  if (!cards.length) return;
  feedFocus = Math.max(0, Math.min(feedFocus, cards.length - 1));
  cards.forEach((c, i) => c.classList.toggle('kfocus', i === feedFocus));
  if (scroll) cards[feedFocus].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.addEventListener('keydown', (e) => {
  if (currentRoute().view !== 'feed' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable], dialog[open]')) return;
  const cards = feedKeyCards();
  if (!cards.length) return;
  const k = e.key.toLowerCase();
  const card = cards[Math.min(feedFocus, cards.length - 1)];
  if (k === 'j' || e.key === 'ArrowDown') { feedFocus += 1; markFeedFocus(true); }
  else if (k === 'k' || e.key === 'ArrowUp') { feedFocus -= 1; markFeedFocus(true); }
  else if (k === 's' || k === 'ы') card.querySelector('[data-fsave]')?.click();
  else if (k === 'x' || k === 'ч') card.querySelector('[data-fskip]')?.click();
  else if (k === 'o' || k === 'щ') { const a = card.querySelector('.feed-foot a[href]'); if (a) window.open(a.href, '_blank', 'noopener'); }
  else return;
  e.preventDefault();
});

function ago(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
  return d <= 0 ? 'сегодня' : `${daysWord(d)} назад`;
}

function renderFeed() {
  const d = feedData;
  const fit = d.items.filter((i) => i.section === 'fit');
  const product = d.items.filter((i) => i.section === 'product');
  const edtech = sortSectorList(d.items.filter((i) => i.section === 'edtech'));
  const fintech = sortSectorList(d.items.filter((i) => i.section === 'fintech'));
  const lists = { fit, product, edtech, fintech, skipped: d.skipped };
  const list = lists[feedTab] || fit;
  const last = d.sources.map((s) => s.date).sort().pop();
  const names = [...new Set(d.sources.filter((s) => !SECTORS_UI.includes(s.source)).map((s) => FEED_SOURCE_LABELS[s.source] || s.source))].join(', ');
  const tabs = [['fit', 'Подходят', fit.length], ['product', 'Продуктовые роли', product.length], ['edtech', 'EdTech', edtech.length], ['fintech', 'FinTech', fintech.length],
    ['sites', 'Сайты', jobSites ? jobSites.sites.filter((s) => !s.hidden).length : 20], ['targets', 'Компании', targetsData ? targetsData.companies.length : '…'],
    ['skipped', 'Пропущенные', d.skipped.length]];
  const empty = {
    fit: 'Строгих совпадений нет — загляни в «Продуктовые роли» или обнови ленту.',
    product: 'Продуктовых ролей в ленте нет. Обнови ленту.',
    edtech: 'Новых EdTech-вакансий нет. Нажми «Обновить EdTech» — или всё уже просмотрено.',
    fintech: 'Новых FinTech-вакансий нет. Нажми «Обновить FinTech» — или всё уже просмотрено.',
    skipped: 'Пропущенных нет.',
  }[feedTab];
  $('#feedView').innerHTML = `<div class="page-wrap">
    <section class="home-head">
      <div><h1>Лента вакансий</h1>
        <p class="lead">${names || 'Источники'} · ${d.total} в сырье${last ? ` · обновлено ${ago(last)}` : ''}</p>
        ${d.hidden_us?.length ? `<details class="hidden-us"><summary class="muted small">Скрыто ${d.hidden_us.length} ${plural(d.hidden_us.length, ['вакансия', 'вакансии', 'вакансий'])} только для США — переезд или резидентство</summary>
          <ul class="tight small">${d.hidden_us.slice(0, 60).map((h) => `<li>${esc(h.title)} — ${esc(h.company)} <span class="muted">· ${esc(h.location || h.why)}</span></li>`).join('')}</ul>
          <p class="muted small" style="margin:4px 0 0">Отключить фильтр — <a href="#/profile">Профиль</a> → «Вакансии только для США».</p></details>` : ''}</div>
      <div class="feed-refresh">
        <button type="button" class="btn dark" id="feedRefresh">Обновить ленту</button>
        <p class="muted small" style="margin:6px 0 0">Только открытые API. LinkedIn и сайты с логином — вручную.</p>
      </div>
    </section>
    <section id="refreshBox" class="hidden"></section>
    <section class="stack">
      <div class="all-head">
        <div class="seg" role="group" aria-label="Раздел ленты">
          ${tabs.map(([k, l, n]) => `<button type="button" data-ftab="${k}" aria-pressed="${feedTab === k}">${l} · ${n}</button>`).join('')}
        </div>
        ${feedTab === 'product' ? '<p class="muted small" style="margin:0;max-width:520px">Продуктовые роли без задачи обучения в тексте. Фит по задаче, скорее всего, ниже — сохраняй те, где видишь академию, онбординг или образовательный продукт.</p>' : ''}
      </div>
      ${SECTORS_UI.includes(feedTab) ? sectorHead(d, feedTab) : ''}
      ${feedTab === 'targets' ? `<div id="targetsBox">${targetsHtml()}</div>` : feedTab === 'sites' ? `<div id="sitesBox">${sitesHtml()}</div>` : `
      ${feedTab === 'skipped' ? '' : filterBar('feed', feedFilterGroups(list), feedVisible(list).length, list.length)}
      <div id="feedBody">${feedBodyHtml(list, empty)}</div>`}
    </section>
  </div>`;
  bindFeed();
}

function feedCard(j) {
  const meta = [SECTORS_UI.includes(j.source) ? [j.country, j.segment].filter(Boolean).join(' · ') : FEED_SOURCE_LABELS[j.source] || j.source,
    j.posted && `опубликовано ${ago(j.posted)}`].filter(Boolean).join(' · ');
  const conds = [j.salary && `<span class="cond strong">${esc(j.salary)}</span>`, j.location && `<span class="cond">${esc(j.location)}</span>`,
    j.seniority && `<span class="cond">${esc(j.seniority)}</span>`].filter(Boolean).join('<span class="dot-sep" aria-hidden="true">·</span>');
  const chips = [
    ...j.domains.map((x) => `<span class="kchip good">${esc(DOMAIN_LABELS[x] || x)}</span>`),
    ...(j.section === 'fit' ? j.hits.map((x) => `<span class="kchip">${esc(x)}</span>`) : []),
    j.role_group ? `<span class="kchip ${j.role_group === 'edu' ? 'edu' : ''}">${ROLE_GROUP_LABELS[j.role_group] || esc(j.role_group)}</span>` : '',
    j.stream === 'B' ? '<span class="kchip" title="Компания строит обучение — сигнал потока B">поток B</span>' : '',
    j.academy_signal ? '<span class="kchip edu" title="Роль «обучение клиентов» есть, продуктовой роли в компании нет — повод написать Head of Product / CMO напрямую (строка добавлена в signals.md)">строит академию без продакта</span>' : '',
  ].join('');
  const k = esc(j.key);
  return `<article class="ncard feed-card" data-key="${k}">
    <div class="ncard-head"><div><div class="company">${esc(j.company)} · <span class="muted">${meta}</span>${feedNewKeys?.has(j.key) ? ' <span class="kchip new">новая</span>' : ''}</div><h3>${esc(j.title)}</h3></div></div>
    ${conds ? `<div class="conds" style="margin:0">${conds}</div>` : ''}
    ${chips ? `<div class="chips" style="margin:0">${chips}</div>` : ''}
    <p class="ncard-text clamp">${esc(j.excerpt)}</p>
    <div class="ncard-foot">
      <div class="two"><button type="button" class="btn primary" data-fsave="${k}">Сохранить</button>
        <button type="button" class="btn ghost" data-fskip="${k}">Пропустить</button></div>
      <button type="button" class="link-btn inline" data-ftarget="${esc(j.company)}" title="Добавить компанию в целевые (W4)">★ В целевые</button>
      <div class="feed-foot"><span class="muted small">Сохранить = быстрый фит (Haiku, один ход), ≈ $0.004</span>
        ${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">Открыть на сайте ↗</a>` : ''}</div>
    </div>
  </article>`;
}

function skippedCard(s) {
  return `<article class="ncard">
    <div class="ncard-head"><div><div class="company">${esc(s.company)} · <span class="muted">пропущено ${ago(s.at)}</span></div><h3>${esc(s.title || s.key)}</h3></div></div>
    <div class="ncard-foot"><div class="two"><button type="button" class="btn ghost" data-funskip="${esc(s.key)}">Вернуть в ленту</button>
      ${s.url ? `<a class="btn ghost" href="${esc(s.url)}" target="_blank" rel="noopener">Открыть ↗</a>` : ''}</div></div>
  </article>`;
}

function bindFeed() {
  const root = $('#feedView');
  const byKey = (k) => feedData.items.find((i) => i.key === k);
  root.querySelectorAll('[data-ftab]').forEach((b) => b.addEventListener('click', () => {
    feedTab = b.dataset.ftab;
    try { localStorage.setItem('cvc-feed-tab', feedTab); } catch {}
    renderFeed();
  }));
  if (feedTab === 'sites') { bindSites(); return bindFeedRefresh(); }
  if (feedTab === 'targets') { bindTargets(); loadTargets(); return bindFeedRefresh(); }
  bindFeedCards();
  if (feedTab !== 'skipped') bindFilters('feed', renderFeedBody);
  if (SECTORS_UI.includes(feedTab)) bindSector(feedTab);
  bindFeedRefresh();
}

function bindFeedRefresh() {
  $('#feedRefresh').addEventListener('click', async () => {
    try { const r = await api('/api/feed/refresh', { method: 'POST' }); watchRefresh(r.job); } catch (e) { alert(e.message); }
  });
}

function bindFeedCards() {
  const root = $('#feedBody');
  if (!root) return;
  const byKey = (k) => feedData.items.find((i) => i.key === k);
  bindEmptyReset();
  markFeedFocus(false);
  root.querySelectorAll('.feed-card').forEach((c, i) => c.addEventListener('click', () => { feedFocus = i; markFeedFocus(false); }));
  $('#feedMore')?.addEventListener('click', () => { feedShown[feedTab] += FEED_STEP; renderFeedBody(); });
  root.querySelectorAll('[data-fsave]').forEach((b) => b.addEventListener('click', async () => {
    const j = byKey(b.dataset.fsave);
    b.disabled = true;
    try {
      await api('/api/feed/save', { method: 'POST', body: { key: j.key } });
      feedData.items = feedData.items.filter((i) => i.key !== j.key);
      renderFeed();
      flash(`«${j.title}» сохранена — агент оценивает фит. Она уже на главном экране.`);
    } catch (e) { b.disabled = false; alert(e.message); }
  }));
  root.querySelectorAll('[data-ftarget]').forEach((b) => b.addEventListener('click', () => addTargetFromFeed(b.dataset.ftarget)));
  root.querySelectorAll('[data-fskip]').forEach((b) => b.addEventListener('click', async () => {
    const j = byKey(b.dataset.fskip);
    b.disabled = true;
    try {
      await api('/api/feed/skip', { method: 'POST', body: { key: j.key, title: j.title, company: j.company, url: j.url } });
      feedData.items = feedData.items.filter((i) => i.key !== j.key);
      feedData.skipped.unshift({ key: j.key, title: j.title, company: j.company, url: j.url, at: new Date().toISOString() });
      renderFeed();
    } catch (e) { b.disabled = false; alert(e.message); }
  }));
  root.querySelectorAll('[data-funskip]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await api('/api/feed/skip', { method: 'DELETE', body: { key: b.dataset.funskip } });
    loadFeed();
  }));
}

// Прогресс обновления: строки fetch.py через тот же SSE, что у задач агента
function watchRefresh(job) {
  const box = $('#refreshBox');
  if (!box) return;
  box.className = 'card';
  box.innerHTML = `<div class="running"><span class="spin"></span>Обновляю ленту <span class="muted" data-elapsed="${job.started}"></span></div><div class="feed" id="refreshFeed"></div>`;
  ['#feedRefresh', '#sectorRefresh'].forEach((s) => { if ($(s)) $(s).disabled = true; });
  const es = new EventSource(`/api/jobs/${job.id}/stream`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    const f = $('#refreshFeed');
    if (f) { f.insertAdjacentHTML('beforeend', `<div class="${ev.kind === 'warn' ? 'state' : ev.kind}">${esc(ev.text)}</div>`); f.scrollTop = f.scrollHeight; }
    if (ev.kind === 'result') flash(`Лента обновлена: ${ev.text}`);
    if (ev.done) { es.close(); feedData = null; loadFeed(); }
  };
  es.onerror = () => es.close();
}

function flash(text) {
  let el = $('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.className = 'flash';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 5000);
}

loadAgentStatus(false);
setTimeout(checkFeedNew, 3000);
setInterval(checkFeedNew, 10 * 60 * 1000);
window.addEventListener('hashchange', () => { if (currentRoute().view !== 'feed') feedNewKeys = null; });

// Надиктовка могла прийти из другой вкладки (Chrome/Safari, где работает микрофон):
// при возврате на вкладку перечитываем карточку, если поле надиктовки сейчас не редактируется
// (переход из Chrome в окно Claude меняет фокус окна, а не видимость вкладки — слушаем оба)
function refreshDictationFromServer() {
  if (currentRoute().view !== 'vacancy') return;
  if (document.activeElement?.id === 'dictation') return;
  if (document.activeElement?.closest?.('#submittedCard')) return;
  loadDetail({ fromServer: true });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDictationFromServer(); });
window.addEventListener('focus', refreshDictationFromServer);

// ---------- доска заявок (S2, docs/specs/04-application-board.md) ----------

const BOARD_COLS = [
  ['prep', 'Готовится', ['new', 'ready']],
  ['sent', 'Отправлено', ['sent']],
  ['replied', 'Ответили', ['replied']],
  ['interview', 'Интервью', ['interview']],
  ['offer', 'Оффер', ['offer']],
];
const MOVE_LABELS = { prep: 'Готовится', sent: 'Отправлено', replied: 'Ответили', interview: 'Интервью', offer: 'Оффер', rejected: 'Отказ', skip: 'Не подаюсь', no_reply: 'Без ответа' };
let homeView = 'table';
try { homeView = localStorage.getItem('cvc-home-view') || 'table'; } catch {}

const colOf = (status) => (ARCHIVE.includes(status) ? status : (BOARD_COLS.find(([, , st]) => st.includes(status)) || BOARD_COLS[0])[0]);

// Сколько дней заявка в текущем статусе: последняя запись истории о переходе в него
function daysOnStage(i) {
  const h = (i.history || []).filter((x) => x.to === i.status).pop();
  // «Отправлено» считаем от даты отправки из диалога M1 — отметить могли позже, чем отправил
  const since = (i.status === 'sent' && i.sent?.at) || h?.at || (i.created && new Date(i.created).toISOString());
  return since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / DAY_MS)) : null;
}

// S2 P1 · «застряла»: дольше порога на стадии — пора напомнить, подать или убрать в архив
const STUCK_DAYS = { prep: 5, replied: 7, interview: 7, offer: 5 }; // «Отправлено» не застревает — само уходит в «Без ответа»
const STUCK_HINTS = { prep: 'подай или убери в «Не подаюсь»', sent: 'напомни или убери в архив', replied: 'спроси о следующем шаге',
  interview: 'спроси о решении', offer: 'ответь на оффер' };
let boardStuck = false;
try { boardStuck = localStorage.getItem('cvc-board-stuck') === '1'; } catch {}
function isStuck(i) {
  const col = colOf(i.status);
  const d = daysOnStage(i);
  return !!STUCK_DAYS[col] && d != null && d >= STUCK_DAYS[col];
}

function boardCard(i, st) {
  const fit = i.fit?.total;
  const days = daysOnStage(i);
  const col = colOf(i.status);
  const meta = [];
  if (col === 'prep') meta.push(`<span class="pill ${st.tone}">${st.key === 'agent' ? '<span class="spin"></span>' : ''}${st.chip}</span>`);
  if (i.sent && ['sent', 'replied', 'interview', 'offer'].includes(i.status)) {
    meta.push(`<span class="muted small">отпр. ${fmtDay(i.sent.at)} · ${esc(CHANNEL_LABELS[i.sent.channel] || i.sent.channel)}</span>`);
  }
  if (i.submittedAnswers?.length) meta.push(`<span class="muted small">${esc(answersCount(i))}</span>`);
  if (i.salaryMismatch) meta.push(i.salaryMismatch.kind === 'check' ? `<span class="muted small" title="${esc(salaryWarn(i))}">вилка: проверь</span>`
    : `<span class="pill warn" title="${esc(salaryWarn(i))}">вилка ≠ якорь</span>`);
  if (i.status === 'sent' && i.waiting?.daysSinceSent >= 1) {
    meta.push(`<span class="muted small" title="без ответа уйдёт в архив ${fmtDay(i.waiting.noReplyAt)}">ждёт ответа ${daysWord(i.waiting.daysSinceSent)}</span>`);
  }
  const targets = Object.keys(MOVE_LABELS).filter((k) => k !== col);
  return `<article class="bcard" draggable="true" data-name="${esc(i.name)}">
    <div class="bc-top"><span class="company">${esc(i.company)}</span>${fit != null ? `<span class="mono small ${fit < FIT_THRESHOLD ? 'warn' : ''}">${fit}/10</span>` : ''}</div>
    <a href="#/v/${enc(i.name)}" class="row-link bc-role">${esc(i.role)}</a>
    ${meta.length ? `<div class="bc-meta">${meta.join('')}</div>` : ''}
    <div class="bc-foot">
      ${days != null ? (isStuck(i) ? `<span class="pill warn" title="${esc(STUCK_HINTS[col] || '')}">застряла: ${daysWord(days)}</span>`
        : `<span class="muted small">${days === 0 ? 'сегодня' : `${daysWord(days)} на стадии`}</span>`) : '<span></span>'}
      <label class="sr-only" for="mv-${esc(i.name)}">Переместить «${esc(i.role)}»</label>
      <select class="bc-move" id="mv-${esc(i.name)}" data-move="${esc(i.name)}">
        <option value="">Переместить в…</option>
        ${targets.map((k) => `<option value="${k}">${MOVE_LABELS[k]}</option>`).join('')}
      </select>
    </div>
  </article>`;
}

function boardView(stages) {
  const all = homeVisible();
  const onBoard = all.filter((i) => !ARCHIVE.includes(i.status));
  const stuckN = onBoard.filter(isStuck).length;
  const vis = boardStuck ? all.filter(isStuck) : all;
  const toolbar = `<div class="row board-tools"><button type="button" class="small ${boardStuck ? 'primary' : ''}" id="boardStuck" aria-pressed="${boardStuck}">
      Только застрявшие · ${stuckN}</button>
    <span class="muted small">Порог: подготовка и оффер — 5 дней, «Ответили» и «Интервью» — 7. «Отправлено» без ответа само уходит в архив.</span></div>`;
  const cols = BOARD_COLS.map(([k, label, st]) => {
    const list = vis.filter((i) => st.includes(i.status))
      .sort((a, b) => (daysOnStage(b) ?? 0) - (daysOnStage(a) ?? 0));
    const total = onBoard.filter((i) => st.includes(i.status)).length;
    const share = onBoard.length ? Math.round((total / onBoard.length) * 100) : 0;
    return `<section class="bcol" data-drop="${k}" aria-label="${label}">
      <h3><span>${label}</span><span class="mono muted" title="${boardStuck ? 'застрявших / всего в колонке' : 'доля от заявок на доске (без архива)'}">${boardStuck ? `${list.length} / ${total}` : `${total} · ${share}%`}</span></h3>
      <div class="bcol-body">${list.map((i) => boardCard(i, stages.get(i.name))).join('') || '<p class="muted small bc-empty">Пусто</p>'}</div>
    </section>`;
  }).join('');
  const archived = all.filter((i) => ARCHIVE.includes(i.status));
  return `${toolbar}<div class="board">${cols}</div>
    <details class="archive-strip" ${archived.length ? '' : ''}>
      <summary>Архив · ${archived.length} <span class="muted small">— перетащи карточку сюда</span></summary>
      <div class="archive-drops">
        <div class="adrop" data-drop="rejected">Отказ</div>
        <div class="adrop" data-drop="skip">Не подаюсь</div>
        <div class="adrop" data-drop="no_reply">Без ответа</div>
      </div>
      ${archived.length ? `<div class="board-arch">${archived.map((i) => boardCard(i, stages.get(i.name))).join('')}</div>` : ''}
    </details>`;
}

// Перенос: «Отправлено» — через диалог M1, назад в «Готовится» из «Отправлено» — отмена отправки
async function moveTo(name, target) {
  const i = items.find((x) => x.name === name);
  if (!i || !target || colOf(i.status) === target) return;
  try {
    if (target === 'sent' && !i.sent) { openSentDialog(i); return; }
    if (target === 'prep') {
      if (i.status === 'sent' && i.sent) {
        if (!confirm(`Отменить отправку «${i.role}»? Заявка вернётся в подготовку, след останется в истории.`)) return;
        await api(`/api/vacancies/${enc(name)}/sent`, { method: 'DELETE' });
      } else {
        await api(`/api/vacancies/${enc(name)}`, { method: 'PATCH', body: { status: i.hasCV && i.letterFile ? 'ready' : 'new' } });
      }
    } else {
      await api(`/api/vacancies/${enc(name)}`, { method: 'PATCH', body: { status: target } });
      if (target === 'rejected') openRejectDialog(i);
    }
  } catch (e) { alert(e.message); }
  loadList();
}

function bindBoard() {
  const root = $('#homeView');
  $('#boardStuck')?.addEventListener('click', () => {
    boardStuck = !boardStuck;
    try { localStorage.setItem('cvc-board-stuck', boardStuck ? '1' : '0'); } catch {}
    renderAllBody();
  });
  root.querySelectorAll('.bcard').forEach((c) => makeCardClickable(c, c.dataset.name));
  root.querySelectorAll('[data-move]').forEach((s) => s.addEventListener('change', () => moveTo(s.dataset.move, s.value)));
  root.querySelectorAll('.bcard').forEach((c) => {
    c.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', c.dataset.name);
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
      root.querySelector('.archive-strip')?.setAttribute('open', '');
    });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  root.querySelectorAll('[data-drop]').forEach((z) => {
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      z.classList.remove('over');
      moveTo(e.dataTransfer.getData('text/plain'), z.dataset.drop);
    });
  });
}

// ---------- статистика воронки (S3, docs/specs/05-funnel-stats.md) ----------
// «Ответ» — любая реакция после отправки, включая отказ (авто-отказ от живого в данных не отличить);
// отказы показываются отдельной цифрой. Считается из истории статусов и записи отправки (M1).

const RESPONSES = ['replied', 'interview', 'offer', 'rejected'];
const STAGE_RANK = { sent: 1, replied: 2, interview: 3, offer: 4 };
const MIN_N = 5;

function appStats(i) {
  const sentAt = i.sent?.at;
  const hist = i.history || [];
  // самый дальний этап из текущего статуса и истории
  const rank = Math.max(i.sent ? 1 : 0, STAGE_RANK[i.status] || 0, ...hist.map((h) => STAGE_RANK[h.to] || 0));
  let firstResponse = null;
  if (sentAt) {
    const h = hist.find((x) => RESPONSES.includes(x.to) && x.at >= sentAt);
    firstResponse = h ? h.at : RESPONSES.includes(i.status) ? sentAt : null;
  }
  return { sent: !!sentAt, rank, responded: !!firstResponse, rejected: !!sentAt && i.status === 'rejected',
    daysToResponse: firstResponse ? Math.max(0, (Date.parse(firstResponse) - Date.parse(sentAt)) / DAY_MS) : null };
}

const ratio = (a, b) => (b ? a / b : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function sliceRows(groups) {
  return groups.map(([label, list]) => {
    const n = list.length;
    const r = list.filter((x) => x.st.responded).length;
    const few = n < MIN_N;
    return `<tr class="${few ? 'few' : ''}"><td>${label}</td><td class="mono">${n}</td><td class="mono">${r}</td>
      <td class="mono">${n ? pct(ratio(r, n)) : '—'}</td><td class="muted small">${n === 0 ? 'нет отправленных' : few ? 'мало данных' : ''}</td></tr>`;
  }).join('');
}

// ---------- вердикт рекрутера (W3, docs/specs/25-recruiter-verdict.md) ----------

const VERDICT_LABELS = { yes: ['good', 'позвал бы'], maybe: ['warn', 'может быть'], no: ['bad', 'не позвал бы'] };
const REASON_LABELS = { domain: 'нет опыта в домене', seniority: 'уровень не тот', 'top-third': 'релевантное не видно сверху',
  location: 'формат или география', language: 'язык', 'role-type': 'другой тип роли', other: 'другое' };
const reasonLabel = (tag) => (String(tag).startsWith('missing-skill') ? `нет навыка: ${String(tag).split(':')[1] || '?'}` : REASON_LABELS[tag] || tag);
const AGREE = [['yes', 'согласен'], ['partial', 'частично'], ['no', 'не согласен']];

function verdictBlock(d) {
  const v = d.verdict;
  const job = d.jobs.verdict;
  const busy = job && ['running', 'queued'].includes(job.state);
  if (busy || job?.state === 'error') return `<div class="verdict">${jobBlock(job)}</div>`;
  if (!v) {
    if (!d.hasVacancy || !d.hasVacancyText) return '';
    return `<div class="verdict row"><button type="button" class="small" id="verdictBtn">Вердикт рекрутера</button>
      <span class="hint" style="margin:0">Позвал бы рекрутер на разговор и почему нет — по ${d.hasCV ? 'этому CV' : 'Master CV'}. Агент, ≈ $0.1–0.3.</span></div>`;
  }
  const [tone, label] = VERDICT_LABELS[v.verdict] || ['neutral', v.verdict];
  return `<div class="verdict">
    <div class="row" style="gap:8px;flex-wrap:wrap"><strong>Рекрутер на первом отборе:</strong> <span class="pill ${tone}">${label}</span>
      ${v.verdict !== 'yes' ? `<span class="chip">${esc(reasonLabel(v.tag))}</span>` : ''}
      ${v.cv === 'master' ? '<span class="muted small">по Master CV</span>' : ''}</div>
    ${v.reason ? `<p style="margin:6px 0">${esc(v.reason)}</p>` : ''}
    ${v.verdict !== 'yes' ? `<div class="row small" style="gap:6px;flex-wrap:wrap"><span class="muted">С причиной:</span>
      ${AGREE.map(([k, l]) => `<button type="button" class="small ${d.verdictAgree === k ? 'primary' : ''}" data-agree="${k}">${l}</button>`).join('')}
      <button type="button" class="link-btn inline" id="verdictBtn">обновить вердикт</button></div>` : ''}
  </div>`;
}

function bindVerdict(d) {
  $('#verdictBtn')?.addEventListener('click', () => startStep('verdict'));
  document.querySelectorAll('[data-agree]').forEach((b) => b.addEventListener('click', async () => {
    const v = d.verdictAgree === b.dataset.agree ? '' : b.dataset.agree;
    try { await api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { verdictAgree: v } }); } catch (e) { alert(e.message); return; }
    d.verdictAgree = v;
    document.querySelectorAll('[data-agree]').forEach((x) => x.classList.toggle('primary', x.dataset.agree === v));
  }));
}

// W6: отказы — версии по этапам; одинаковый фидбек в ≥ 2 компаниях — «это факт»
function rejectionsHtml(all) {
  const rej = all.map((x) => x.i).filter((i) => i.rejection);
  if (!rej.length) return '';
  const words = (t) => new Set(String(t).toLowerCase().match(/[a-zа-яё]{4,}/g) || []);
  const similar = (a, b) => { const A = words(a), B = words(b); const inter = [...A].filter((w) => B.has(w)).length; return A.size && B.size ? inter / Math.min(A.size, B.size) >= 0.5 : false; };
  const fb = rej.filter((i) => i.rejection.feedback);
  const facts = fb.filter((i) => fb.some((j) => j !== i && j.company !== i.company && similar(i.rejection.feedback, j.rejection.feedback)));
  const by = {};
  for (const i of rej) (by[i.rejection.stage] = by[i.rejection.stage] || []).push(i);
  return `<div class="rej-summary"><h4 style="margin:14px 0 6px">Отказы: что знаю и что думаю</h4>
    ${FUNNEL_STAGES.filter(([k]) => by[k]).map(([k, l]) => `<p style="margin:4px 0"><strong>${l} · ${by[k].length}</strong>
      ${by[k].filter((i) => i.rejection.version).map((i) => `<span class="muted small">— ${esc(i.company)}: ${esc(i.rejection.version.slice(0, 80))}</span>`).join(' ')}</p>`).join('')}
    ${facts.length ? `<p class="small" style="margin:6px 0 0"><span class="pill warn">это факт</span> похожий фидбек в разных компаниях: ${facts.map((i) => esc(i.company)).join(', ')}</p>` : ''}
  </div>`;
}

// Сводка причин за 30 дней: повторяется в 3+ вакансиях — узкое место. С причиной «не согласен» не считаем.
function reasonsSection(list) {
  const since = Date.now() - 30 * DAY_MS;
  const vs = list.filter((i) => i.verdict && i.verdict.verdict !== 'yes' && Date.parse(i.verdict.at) >= since && i.verdictAgree !== 'no');
  const all = list.filter((i) => i.verdict && Date.parse(i.verdict.at) >= since);
  const by = {};
  for (const i of vs) (by[i.verdict.tag] = by[i.verdict.tag] || []).push(i);
  const rows = Object.entries(by).sort((a, b) => b[1].length - a[1].length);
  const action = (tag) => (String(tag).startsWith('missing-skill') || tag === 'domain' ? '<a href="#/cases/new">надиктовать кейс</a>'
    : tag === 'top-third' ? 'поднять главное в верх CV (пересобрать)' : ['seniority', 'location', 'role-type', 'language'].includes(tag) ? '<a href="#/profile">поправить профиль поиска</a>' : '');
  const yes = all.filter((i) => i.verdict.verdict === 'yes').length;
  return `<section class="card reasons"><h3 class="st-h">Почему рекрутер может не позвать · 30 дней</h3>
    ${!all.length ? '<p class="muted small" style="margin:0">Появится после первых вердиктов: новые CV получают его сами, для старых — кнопка «Вердикт рекрутера» в заявке.</p>' : `
    <p class="muted small" style="margin:0 0 8px">Вердиктов ${all.length}: позвал бы ${yes}, может ${all.filter((i) => i.verdict.verdict === 'maybe').length}, нет ${all.filter((i) => i.verdict.verdict === 'no').length}.
      Причины, с которыми ты не согласен, не считаются.</p>
    ${rows.length ? `<div class="table-box flat"><table class="apps"><thead><tr><th>Причина</th><th>Вакансий</th><th>Где</th><th>Что сделать</th></tr></thead><tbody>
      ${rows.map(([tag, l]) => `<tr class="${l.length >= 3 ? 'bottleneck' : ''}"><td>${esc(reasonLabel(tag))}${l.length >= 3 ? ' <span class="pill warn">узкое место</span>' : ''}</td>
        <td class="mono">${l.length}</td><td class="small">${l.slice(0, 3).map((i) => `<a href="#/v/${enc(i.name)}">${esc(i.company)}</a>`).join(', ')}${l.length > 3 ? ` +${l.length - 3}` : ''}</td>
        <td class="small">${action(tag)}</td></tr>`).join('')}</tbody></table></div>` : ''}`}
  </section>`;
}

// S3 P1 · период: заявка попадает в период по дате отправки, неотправленная — по дате добавления
const STATS_PERIODS = [['all', 'Всё время'], ['30', '30 дней'], ['7', '7 дней']];
let statsPeriod = 'all';
try { statsPeriod = localStorage.getItem('cvc-stats-period') || 'all'; } catch {}
function inStatsPeriod(i) {
  if (statsPeriod === 'all') return true;
  const t = i.sent?.at ? Date.parse(i.sent.at) : Number(i.created) || 0;
  return t >= Date.now() - Number(statsPeriod) * 86400000;
}
function statsPeriodBar() {
  return `<div class="row" style="justify-content:space-between">
    <p class="muted small" style="margin:0">Статистика — без фильтров таблицы. Период: отправленные — по дате отправки, остальные — по дате добавления.</p>
    <div class="seg" role="group" aria-label="Период статистики">${STATS_PERIODS.map(([k, l]) =>
      `<button type="button" data-speriod="${k}" aria-pressed="${statsPeriod === k}">${l}</button>`).join('')}</div></div>`;
}
function bindStatsPeriod() {
  document.querySelectorAll('[data-speriod]').forEach((b) => b.addEventListener('click', () => {
    statsPeriod = b.dataset.speriod;
    try { localStorage.setItem('cvc-stats-period', statsPeriod); } catch {}
    renderHome();
  }));
}

function statsView() {
  const pool = items.filter(inStatsPeriod);
  const all = pool.map((i) => ({ i, st: appStats(i) }));
  const sent = all.filter((x) => x.st.sent);
  const responded = sent.filter((x) => x.st.responded);
  const rejected = sent.filter((x) => x.st.rejected);
  const interview = sent.filter((x) => x.st.rank >= 3);
  const offer = sent.filter((x) => x.st.rank >= 4);
  const archived = pool.filter((i) => ARCHIVE.includes(i.status)).length;
  const med = median(responded.map((x) => x.st.daysToResponse));

  // W6: воронка по этапам воркбука — сколько заявок дошли хотя бы до этапа
  const reached = (k) => sent.filter((x) => FUNNEL_STAGES.findIndex(([s]) => s === x.i.stage) >= FUNNEL_STAGES.findIndex(([s]) => s === k)).length;
  const funnel = [['Всего заявок', all.length, null], ['Отправлено', sent.length, all.length]];
  FUNNEL_STAGES.slice(1).forEach(([k, l], idx) => funnel.push([l, reached(k), idx === 0 ? sent.length : reached(FUNNEL_STAGES[idx][0])]));
  // Самое сильное сужение: переход с наименьшей долей, где на входе ≥ MIN_N заявок (иначе это шум)
  const drops = funnel.slice(2).map(([l, n, prev], i) => ({ l, n, prev, r: prev ? n / prev : null, from: FUNNEL_STAGES[i][0] })).filter((x) => x.prev >= MIN_N);
  const worst = drops.length ? drops.reduce((m, x) => (x.r < m.r ? x : m)) : null;
  const top = Math.max(1, all.length);

  const fitHi = sent.filter((x) => (x.i.fit?.total ?? -1) >= FIT_THRESHOLD);
  const fitLo = sent.filter((x) => x.i.fit?.total != null && x.i.fit.total < FIT_THRESHOLD);
  const fitNone = sent.filter((x) => x.i.fit?.total == null);
  const channels = Object.keys(CHANNEL_LABELS).map((k) => [CHANNEL_LABELS[k], sent.filter((x) => x.i.sent.channel === k)])
    .filter(([, l]) => l.length);
  const foundNames = [...new Set(sent.map((x) => x.i.foundOn?.name).filter(Boolean))].sort();
  const foundOn = [...foundNames.map((n) => [n, sent.filter((x) => x.i.foundOn?.name === n)]),
    ['Не указано', sent.filter((x) => !x.i.foundOn)]].filter(([, l]) => l.length);
  const letterModeOf = (x) => x.i.sent.letterMode || (x.i.sent.letterFile ? 'dictated' : 'none');
  const letterModes = [['Сгенерировано агентом', 'generated'], ['Из надиктовки', 'dictated'], ['Без письма', 'none']]
    .map(([l, k]) => [l, sent.filter((x) => letterModeOf(x) === k)]).filter(([, l]) => l.length);
  const pkgYes = sent.filter((x) => x.i.sent.package);
  const pkgNo = sent.filter((x) => !x.i.sent.package);

  const rate = (l) => ratio(l.filter((x) => x.st.responded).length, l.length);
  const hypothesis = fitHi.length >= MIN_N && fitLo.length >= MIN_N
    ? `На фит ${FIT_THRESHOLD}+ отвечают в <strong>${pct(rate(fitHi))}</strong> случаев, на фит ниже — в <strong>${pct(rate(fitLo))}</strong>
       (${fitHi.length} и ${fitLo.length} отправленных).${rate(fitHi) > rate(fitLo) ? ' Гипотеза «фит по задаче» пока подтверждается.' : rate(fitHi) < rate(fitLo) ? ' Пока не подтверждается — стоит пересмотреть рубрику.' : ''}`
    : `Отвечают ли на фит ${FIT_THRESHOLD}+ чаще? Пока мало данных: отправлено ${fitHi.length} с фитом ${FIT_THRESHOLD}+ и ${fitLo.length} с фитом ниже — нужно хотя бы по ${MIN_N}.`;

  const kpi = (k, v, s) => `<div class="kpi"><span class="k">${k}</span><span class="v mono">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  const head = '<thead><tr><th>Группа</th><th>Отправлено</th><th>Ответили</th><th>Доля ответов</th><th></th></tr></thead>';

  return `<div class="stats">
    <div class="kpis five">
      ${kpi('Всего', all.length, `${all.length - archived} активных · ${archived} в архиве`)}
      ${kpi('Отправлено', sent.length, sent.length ? `${pct(ratio(sent.length, all.length))} от всех` : 'отметь первую отправку')}
      ${kpi('Ответили', responded.length, sent.length ? `${pct(ratio(responded.length, sent.length))} от отправленных${rejected.length ? ` · из них отказ: ${rejected.length}` : ''}` : '')}
      ${kpi('Интервью', interview.length, sent.length ? `${pct(ratio(interview.length, sent.length))} от отправленных` : '')}
      ${kpi('Офферы', offer.length, med != null ? `до ответа в среднем ${Math.round(med)} ${plural(Math.round(med), ['день', 'дня', 'дней'])} (медиана)` : 'медиана до ответа — после первого ответа')}
    </div>

    <div class="banner hyp ${fitHi.length >= MIN_N && fitLo.length >= MIN_N ? 'info' : ''}"><p>${hypothesis}</p></div>

    <section class="card week-card" id="weekCard"><p class="muted small" style="margin:0"><span class="spin"></span>Считаю неделю…</p></section>
    ${reasonsSection(items)}
    <div class="stats-grid">
      <section class="card"><h3 class="st-h">Воронка</h3>
        <div class="funnel">${funnel.map(([label, n, prev]) => `<div class="fn-row ${worst && label === worst.l ? 'worst' : ''}">
          <span class="fn-label">${label}</span>
          <span class="fn-bar"><span style="width:${(n / top) * 100}%"></span></span>
          <span class="mono fn-n">${n}</span>
          <span class="muted small fn-p">${prev != null ? (prev ? pct(ratio(n, prev)) : '—') : ''}</span></div>`).join('')}</div>
        <p class="muted small" style="margin:10px 0 0">Доля — от предыдущего этапа. Этап — отмеченный в заявке («Процесс найма»), иначе выведен из статуса.</p>
        ${worst ? `<div class="banner warn" style="margin-top:10px"><p style="margin:0"><strong>Сильнее всего сужается: ${esc(STAGE_LABEL[worst.from])} → ${esc(worst.l)}</strong>
          (${worst.n} из ${worst.prev}). ${esc(STAGE_REASONS[worst.from] || '')}</p></div>` : ''}
        ${rejectionsHtml(all)}
      </section>
      <section class="card"><h3 class="st-h">Доля ответов по фиту</h3>
        <div class="table-box flat"><table class="apps">${head}<tbody>
          ${sliceRows([[`Фит ${FIT_THRESHOLD}+`, fitHi], [`Фит ниже ${FIT_THRESHOLD}`, fitLo], ['Фит не оценён', fitNone]])}</tbody></table></div>
      </section>
      <section class="card"><h3 class="st-h">По каналу</h3>
        ${channels.length ? `<div class="table-box flat"><table class="apps">${head}<tbody>${sliceRows(channels)}</tbody></table></div>`
          : '<p class="muted small" style="margin:0">Появится после первой отметки отправки.</p>'}
      </section>
      <section class="card"><h3 class="st-h">Где нашёл вакансию</h3>
        ${foundNames.length ? `<div class="table-box flat"><table class="apps">${head}<tbody>${sliceRows(foundOn)}</tbody></table></div>`
          : '<p class="muted small" style="margin:0">Появится, когда отправишь вакансию, добавленную с вкладки «Поиск вакансий → Сайты».</p>'}
      </section>
      <section class="card"><h3 class="st-h">Письмо: сгенерировано или надиктовано</h3>
        ${letterModes.length ? `<div class="table-box flat"><table class="apps">${head}<tbody>${sliceRows(letterModes)}</tbody></table></div>`
          : '<p class="muted small" style="margin:0">Появится после первой отметки отправки.</p>'}
      </section>
      <section class="card"><h3 class="st-h">Адаптированное CV или базовое</h3>
        <div class="table-box flat"><table class="apps">${head}<tbody>
          ${sliceRows([['С пакетом (адаптированное CV)', pkgYes], ['Без пакета (базовое CV)', pkgNo]])}</tbody></table></div>
      </section>
      <section class="card"><h3 class="st-h">С контактом в компании или без</h3>
        <div class="table-box flat"><table class="apps">${head}<tbody>
          ${sliceRows([['Есть контакт (поговорили / рекомендовал)', sent.filter((x) => x.i.warm)], ['Без контакта', sent.filter((x) => !x.i.warm)]])}</tbody></table></div>
      </section>
    </div>
    <p class="muted small" style="margin:0">Даты отправки и история статусов ведутся с 13 октября 2026 (фича «Отправлено»). Заявки, отправленные раньше без отметки, сюда не попадают.
      Ответ — любая реакция после отправки, включая отказ. Группы меньше ${MIN_N} заявок помечены «мало данных».</p>
  </div>`;
}

// ---------- ответы на вопросы формы (S4, docs/specs/06-application-questions.md) ----------

const Q_TYPES = { factual: 'факт', experience: 'опыт', motivation: 'мотивация', other: 'другое' };
const Q_STATUS = { ok: ['good', 'готово'], partial: ['warn', 'частично'], no_data: ['bad', 'нет данных'] };

// ---------- структура для надиктовки письма (C7, docs/specs/18-letter-outline.md) ----------

const outlineClosedKey = (name) => `cvc-outline-closed:${name}`;
const factSource = (s) => String(s || '').split('/').pop().replace(/\.md$/, '');

function outlineBlock(d, job) {
  const busy = job && ['running', 'queued'].includes(job.state);
  const o = d.outline;
  const ok = !!(o && o.check?.pass && o.blocks?.length);
  let closed = false;
  try { closed = !!sessionStorage.getItem(outlineClosedKey(d.name)); } catch {}
  const actions = `<div class="row outline-actions">
      <button id="outlineBtn" class="small ${ok ? '' : 'primary'}" ${!d.hasVacancyText || busy ? 'disabled' : ''}>${ok ? 'Сгенерировать заново' : 'Сгенерировать структуру'}</button>
      ${ok ? '<button id="outlineCopy" class="small">Скопировать структуру</button>' : ''}
      <span class="hint" style="margin:0">${!d.hasVacancyText ? 'Вставь текст вакансии — структура строится по нему.'
        : ok ? '' : 'План надиктовки под эту вакансию: о чём сказать и факты из твоего опыта. Фразы — твои. Агент, ≈ $0.5–1, 1–2 минуты.'}</span>
    </div>`;
  const bad = o && !ok ? `<p class="error" style="margin:8px 0 0">Структура не прошла проверку: ${esc((o.check?.issues || []).slice(0, 3).join('; '))}. Сгенерируй заново.</p>` : '';
  if (!ok) return `<div class="outline-wrap">${busy || job?.state === 'error' ? jobBlock(job) : ''}${actions}${bad}</div>`;
  const done = new Set(o.done || []);
  const blocks = o.blocks.map((b, i) => `<li class="ol-block ${done.has(i) ? 'is-done' : ''}">
      <div class="ol-head"><strong>${esc(b.title)}</strong>
        <label class="check small"><input type="checkbox" data-oldone="${i}" ${done.has(i) ? 'checked' : ''}> надиктовал</label></div>
      <p class="ol-prompt">${esc(b.prompt)}</p>
      ${(b.facts || []).length ? `<ul class="ol-facts">${b.facts.map((f) => `<li title="${esc(f.source)}">${esc(f.text)} <span class="muted">· ${esc(factSource(f.source))}</span></li>`).join('')}</ul>` : ''}
    </li>`).join('');
  return `<div class="outline-wrap">
    ${busy || job?.state === 'error' ? jobBlock(job) : ''}
    <details class="outline" id="outlineBox" ${closed ? '' : 'open'}>
      <summary><strong>Структура надиктовки</strong> <span class="muted">· надиктовано ${done.size} из ${o.blocks.length}</span></summary>
      ${o.role_task ? `<p class="muted small" style="margin:8px 0 0">Главная задача роли: ${esc(o.role_task)}</p>` : ''}
      <ol class="ol-blocks">${blocks}</ol>
      ${(o.gaps || []).length ? `<div class="ol-gaps"><strong>Пробелы</strong> <span class="muted small">— в базе нечем подтвердить; не обещай или скажи честно</span>
        <ul>${o.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
      ${o.length_hint ? `<p class="muted small" style="margin:8px 0 0">${esc(o.length_hint)}</p>` : ''}
    </details>
    ${actions}
  </div>`;
}

function outlineText(o) {
  const lines = ['Структура надиктовки', ''];
  if (o.role_task) lines.push(`Главная задача роли: ${o.role_task}`, '');
  o.blocks.forEach((b, i) => {
    lines.push(`${i + 1}. ${b.title}`, `   ${b.prompt}`);
    for (const f of b.facts || []) lines.push(`   – ${f.text}`);
    lines.push('');
  });
  if ((o.gaps || []).length) lines.push('Пробелы:', ...o.gaps.map((g) => `– ${g}`), '');
  if (o.length_hint) lines.push(o.length_hint);
  return lines.join('\n').trim();
}

function bindOutline(d) {
  $('#outlineBtn')?.addEventListener('click', () => {
    if (d.outline?.check?.pass && !confirm('Сгенерировать структуру заново? Текущая структура и галочки «надиктовал» будут заменены.')) return;
    startStep('outline');
  });
  $('#outlineCopy')?.addEventListener('click', async (e) => {
    e.target.textContent = (await copyText(outlineText(d.outline))) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { e.target.textContent = 'Скопировать структуру'; }, 2000);
  });
  $('#outlineBox')?.addEventListener('toggle', (e) => {
    try { if (e.target.open) sessionStorage.removeItem(outlineClosedKey(d.name)); else sessionStorage.setItem(outlineClosedKey(d.name), '1'); } catch {}
  });
  document.querySelectorAll('[data-oldone]').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      const r = await api(`/api/vacancies/${enc(d.name)}/outline/done`, { method: 'POST', body: { block: Number(cb.dataset.oldone), done: cb.checked } });
      d.outline.done = r.done;
      cb.closest('.ol-block').classList.toggle('is-done', cb.checked);
      const s = $('#outlineBox summary .muted');
      if (s) s.textContent = `· надиктовано ${r.done.length} из ${d.outline.blocks.length}`;
    } catch (e) { cb.checked = !cb.checked; alert(e.message); }
  }));
}

// ---------- «Вакансия ещё живая?» (W2, docs/specs/24-vacancy-alive.md) ----------

function aliveHtml(r) {
  const when = r.at ? `проверено ${ago(r.at)}` : '';
  const st = { open: ['good', 'вакансия открыта'], closed: ['bad', 'вакансия закрыта на сайте'], unknown: ['neutral', 'статус не проверить'] }[r.status] || ['neutral', r.status];
  return `<span class="pill ${st[0]}">${st[1]}</span>
    ${r.note ? `<span class="muted">${esc(r.note)}</span>` : ''}
    ${when ? `<span class="muted">· ${when}</span>` : ''}
    ${r.old ? `<span class="warn-text">· опубликована ${r.age} дн. назад — проверь, что найм идёт</span>` : r.age != null ? `<span class="muted">· опубликована ${r.age === 0 ? 'сегодня' : `${r.age} дн. назад`}</span>` : ''}
    <button type="button" class="link-btn inline" id="aliveRecheck">Проверить снова</button>`;
}

async function loadAlive(d, force = false) {
  const box = $('#aliveLine');
  if (!box) return null;
  if (force) box.innerHTML = '<span class="muted"><span class="spin"></span>Проверяю вакансию на сайте…</span>';
  let r;
  try { r = await api(`/api/vacancies/${enc(d.name)}/alive${force ? '?force=1' : ''}`); } catch { return null; }
  if (detail?.name !== d.name || !$('#aliveLine')) return r;
  $('#aliveLine').innerHTML = aliveHtml(r);
  $('#aliveRecheck')?.addEventListener('click', () => loadAlive(d, true));
  return r;
}

// Закрыта → «всё равно?»; если согласен на архив — переводим заявку в «Не подаюсь»
async function aliveGuard(d) {
  let r;
  try { r = await api(`/api/vacancies/${enc(d.name)}/alive`); } catch { return true; }
  if (r.status !== 'closed') return true;
  if (confirm('Вакансия закрыта на сайте компании (страница или API систем найма её больше не показывают).\n\nВсё равно запустить агента? Это платный шаг.')) return true;
  if (confirm('Убрать заявку в архив («Не подаюсь»)?')) {
    try { await api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { status: 'skip', note: 'вакансия закрыта на сайте' } }); } catch {}
    refreshAfterSend();
  }
  return false;
}

// ---------- подать на сайте: заполнение формы заявки (C11, docs/specs/22-autofill-application.md) ----------

let formTimer = null;
const FORM_SOURCES = { 'шапка CV': 'CV', ты: 'ты' };

function formValueInput(f, a) {
  const v = a?.value ?? '';
  const id = `fv-${f.key}`;
  if (f.type === 'file') return `<span class="mono small">${esc(a?.display || (a?.status === 'skip' ? '—' : ''))}</span>`;
  if (f.sensitive) return '<span class="muted small">заполнишь сам в окне</span>';
  const shown = Array.isArray(v) ? v.join(', ') : v;
  if (['select', 'radio', 'boolean'].includes(f.type) && f.options.length) {
    return `<select id="${id}" data-fkey="${esc(f.key)}"><option value="">—</option>${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (f.type === 'textarea' || String(shown).length > 80) return `<textarea id="${id}" data-fkey="${esc(f.key)}" rows="3">${esc(shown)}</textarea>`;
  return `<input id="${id}" data-fkey="${esc(f.key)}" value="${esc(shown)}">`;
}

function formCardHtml(d, st) {
  const t = st.target;
  const head = '<h2><span class="n">↗</span>Подать на сайте</h2>';
  if (!t.url) return `${head}<p class="muted" style="margin:0">${esc(t.reason)}</p>`;
  const link = `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.ats)} ↗</a>`;
  if (!st.hasCVPdf) return `${head}<p class="muted" style="margin:0">Сначала адаптируй CV — в форму прикладывается CV.pdf. Форма: ${link}</p>`;
  const startBtn = (label = 'Заполнить заявку', primary = true) => `<button type="button" class="${primary ? 'primary' : ''}" id="formStart">${label}</button>`;
  const intro = `<p class="hint" style="margin:0 0 10px">Агент откроет форму (${link}), подставит ответы из базы и приложит CV${st.hasLetter ? ' и письмо' : ''}.
    Чего нет в базе — спросит тебя. <strong>Submit нажимаешь ты</strong> в открывшемся окне Chrome.</p>`;
  const busy = (st.stage === 'inspect' || st.stage === 'agent') && !st.error;
  if (busy) {
    return `${head}${intro}<div class="running"><span class="spin"></span>${st.stage === 'inspect' ? 'Открываю форму и разбираю поля…' : 'Агент подбирает ответы из базы…'}</div>
      ${st.job ? `<div class="feed" data-feed="${st.job.id}"></div>` : ''}`;
  }
  if (st.error) return `${head}${intro}<p class="${st.stage === 'closed' ? 'warn-text' : 'error'}">${esc(st.error)}</p><div class="row">${startBtn('Попробовать снова')}</div>`;
  if (!st.form) return `${head}${intro}<div class="row">${startBtn()}<span class="hint" style="margin:0">Контакты и файлы — бесплатно; вопросы формы — агент, ≈ $0.3–0.8.</span></div>`;

  const F = st.form;
  const ans = F.answers;
  const askOpen = F.fields.filter((f) => ans[f.key]?.status === 'ask' && !ans[f.key].answeredByUser);
  const run = st.run;
  let runBlock = '';
  if (run) {
    const unf = (run.unfilled || []).map((u) => `<li>${esc(u.label)} <span class="muted small">— ${esc(u.why)}</span></li>`).join('');
    if (run.state === 'opening') runBlock = '<div class="running"><span class="spin"></span>Открываю окно Chrome и заполняю форму…</div>';
    else {
      const msg = run.state === 'submitted' ? '<strong>Похоже, заявка отправлена</strong> — страница показала подтверждение.'
        : run.windowOpen ? `<strong>Форма заполнена:</strong> ${run.filled?.length || 0} полей. Проверь в окне Chrome, дозаполни подсвеченное и нажми Submit.`
          : 'Окно с формой закрыто. Если ты отправил заявку — запиши это.';
      runBlock = `<div class="banner ${run.state === 'submitted' ? 'info' : 'warn'} form-run"><div><p style="margin:0">${msg}</p>
        ${unf ? `<p class="small" style="margin:8px 0 2px">Не заполнено — сделай сам:</p><ul class="tight">${unf}</ul>` : ''}</div></div>
        <div class="row" style="margin-top:10px">
          <button type="button" class="primary" id="formSubmitted">Я отправил</button>
          ${st.shot ? `<a class="btn ghost small-btn" href="/api/vacancies/${enc(d.name)}/form/shot" target="_blank" rel="noopener">Скриншот формы</a>` : ''}
        </div>`;
    }
  }
  const rows = F.fields.map((f) => {
    const a = ans[f.key] || {};
    const cls = f.sensitive || a.status === 'user' ? 'user' : a.status === 'ask' && !a.answeredByUser ? 'ask' : a.status === 'ok' ? 'ok' : 'skip';
    const src = a.status === 'ok' ? (FORM_SOURCES[a.source] || a.source || '') : f.sensitive ? 'ты, в окне' : a.status === 'ask' ? 'нет в базе' : a.note || '';
    return `<tr class="fr-${cls}">
      <td><div>${esc(f.label || '(без подписи)')}${f.required ? ' <span class="warn-text">*</span>' : ''}</div>
        ${a.status === 'ask' && a.question_ru && !a.answeredByUser ? `<div class="small ask-q">${esc(a.question_ru)}</div>` : ''}
        ${f.description && f.type === 'number' ? `<details class="small"><summary class="muted">варианты</summary>${esc(f.description)}</details>` : ''}</td>
      <td>${formValueInput(f, a)}</td>
      <td class="small muted">${esc(src)}${a.note && a.status === 'ok' ? `<div title="${esc(a.note)}">${esc(a.note.slice(0, 60))}</div>` : ''}</td></tr>`;
  }).join('');
  return `${head}${intro}${runBlock}
    ${askOpen.length ? `<div class="banner warn"><p style="margin:0"><strong>Агенту нужны ответы: ${askOpen.length}.</strong> Ответь в таблице — фактические ответы сохранятся в «Стандартные ответы», про опыт — в базу кейсов на подтверждение.</p></div>` : ''}
    <div class="table-box flat form-table"><table class="apps">
      <thead><tr><th>Поле формы</th><th>Значение</th><th>Источник</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row" style="margin-top:12px">
      ${run?.windowOpen || run?.state === 'opening' ? '' : `<button type="button" class="${run ? '' : 'primary'}" id="formFill">${run ? 'Заполнить ещё раз' : 'Открыть и заполнить форму'}</button>`}
      <button type="button" id="formSave">Сохранить ответы</button>
      ${startBtn('Разобрать форму заново', false)}
      <span class="hint" style="margin:0" id="formMsg"></span>
    </div>`;
}

async function loadFormCard(d) {
  clearTimeout(formTimer);
  const box = $('#formCard');
  if (!box) return;
  // Пока правишь значения, опрос не перерисовывает таблицу
  if (box.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
    formTimer = setTimeout(() => loadFormCard(d), 3000);
    return;
  }
  let st;
  try { st = await api(`/api/vacancies/${enc(d.name)}/form`); } catch (e) {
    box.innerHTML = `<h2><span class="n">↗</span>Подать на сайте</h2><p class="error">${esc(e.message)}</p>`;
    return;
  }
  if (detail?.name !== d.name || !$('#formCard')) return;
  $('#formCard').innerHTML = formCardHtml(d, st);
  if (st.job && ['running', 'queued'].includes(st.job.state)) attachFeed(st.job);
  bindFormCard(d, st);
  const active = ((st.stage === 'inspect' || st.stage === 'agent') && !st.error) || st.run?.windowOpen || st.run?.state === 'opening';
  if (active) formTimer = setTimeout(() => { if (detail?.name === d.name) loadFormCard(d); }, 3000);
}

function bindFormCard(d, st) {
  const changed = () => {
    const out = {};
    for (const el of document.querySelectorAll('#formCard [data-fkey]')) {
      const a = st.form?.answers?.[el.dataset.fkey];
      const cur = Array.isArray(a?.value) ? a.value.join(', ') : a?.value ?? '';
      if (String(el.value).trim() !== String(cur).trim()) out[el.dataset.fkey] = el.value;
    }
    return out;
  };
  const save = async () => {
    const body = changed();
    if (!Object.keys(body).length) return true;
    try {
      const r = await api(`/api/vacancies/${enc(d.name)}/form/answers`, { method: 'POST', body: { answers: body } });
      if (r.saved?.length) flash(`Сохранено в базу: ${r.saved.join('; ')}`);
      return true;
    } catch (e) { $('#formMsg').textContent = e.message; return false; }
  };
  $('#formStart')?.addEventListener('click', async () => {
    if (!(await aliveGuard(d))) return;
    if (st.form && !confirm('Разобрать форму заново? Подстановка соберётся снова (твои ответы в базе сохранятся).')) return;
    try { await api(`/api/vacancies/${enc(d.name)}/form/start`, { method: 'POST' }); } catch (e) { alert(e.message); }
    loadFormCard(d);
  });
  $('#formSave')?.addEventListener('click', async () => { if (await save()) { document.activeElement?.blur(); loadFormCard(d); } });
  $('#formFill')?.addEventListener('click', async () => {
    if (!(await save())) return;
    try { await api(`/api/vacancies/${enc(d.name)}/form/fill`, { method: 'POST' }); } catch (e) {
      if (e.asks && confirm(`${e.message}: ${e.asks.join('; ')}.\nОткрыть форму всё равно? Эти поля останутся пустыми.`)) {
        try { await api(`/api/vacancies/${enc(d.name)}/form/fill`, { method: 'POST', body: { force: true } }); } catch (e2) { alert(e2.message); }
      } else if (!e.asks) alert(e.message);
    }
    document.activeElement?.blur();
    setTimeout(() => loadFormCard(d), 800);
  });
  $('#formSubmitted')?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/vacancies/${enc(d.name)}/form/submitted`, { method: 'POST' });
      flash(`Записано в «Мои ответы при подаче»: ${r.added}. Отметь отправку.`);
      await loadDetail();
      openSentDialog(detail);
    } catch (e) { alert(e.message); }
  });
}

// ---------- мои ответы при подаче (C6, docs/specs/17-submitted-answers.md) ----------

let subEdit = null; // id пары в режиме правки

// Буфер обмена: Clipboard API, а где он запрещён (панель браузера Claude) — через скрытое поле
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

const answersCount = (i) => (i.submittedAnswers?.length ? `ответы: ${i.submittedAnswers.length}` : '');

function submittedItem(x) {
  if (subEdit === x.id) {
    return `<li class="sub-item" data-sid="${esc(x.id)}">
      <form class="sub-form" data-sedit-form="${esc(x.id)}">
        <input name="q" value="${esc(x.q)}" maxlength="300" aria-label="Вопрос">
        <textarea name="a" rows="4" maxlength="5000" aria-label="Ответ">${esc(x.a)}</textarea>
        <p class="error" data-suberr></p>
        <div class="row"><button type="submit" class="primary small">Сохранить</button><button type="button" class="small" data-subcancel>Отмена</button></div>
      </form></li>`;
  }
  return `<li class="sub-item" data-sid="${esc(x.id)}">
    <div class="sub-q">${esc(x.q)}</div>
    <div class="sub-a">${esc(x.a)}</div>
    <div class="sub-meta"><span class="muted small">${fmtDay(x.at)}${x.updated ? ` · изменено ${fmtDay(x.updated)}` : ''}</span>
      <button type="button" class="link-btn inline" data-subcopy="${esc(x.id)}">Скопировать</button>
      <button type="button" class="link-btn inline" data-subedit="${esc(x.id)}">Изменить</button>
      <button type="button" class="link-btn inline danger" data-subdel="${esc(x.id)}">Удалить</button></div>
  </li>`;
}

function submittedBlock(d) {
  const list = d.submittedAnswers || [];
  return `<div class="card" id="submittedCard">
    <h2><span class="n">5</span>Мои ответы при подаче${list.length ? ` <span class="muted" style="font-weight:500">· ${list.length}</span>` : ''}</h2>
    ${d.salaryMismatch?.kind === 'off' ? `<div class="banner warn"><p style="margin:0"><strong>Зарплата названа не по якорю.</strong> «${esc(d.salaryMismatch.a)}»${d.salaryMismatch.yearly ? ` (≈ ${d.salaryMismatch.low} в месяц)` : ''} —
      якорь ${esc(d.salaryMismatch.anchor)}. На звонке держись якоря. <a href="#/profile">Профиль → Деньги</a></p></div>`
      : d.salaryMismatch ? `<div class="banner"><p style="margin:0"><strong>Вилку не сравнить автоматически</strong> — ${esc(d.salaryMismatch.why)}: «${esc(d.salaryMismatch.a)}».
      Проверь сам, что это соответствует якорю ${esc(d.salaryMismatch.anchor)}.</p></div>` : ''}
    ${list.length ? `<ol class="sub-list">${list.map(submittedItem).join('')}</ol>`
      : '<p class="muted" style="margin:0 0 12px">Здесь будут твои ответы из формы заявки — компенсация, опыт, срок выхода. Запиши их сразу после отправки.</p>'}
    <form class="sub-form sub-new" id="subNew">
      <label for="subQ" class="sr-only">Вопрос</label>
      <input id="subQ" name="q" maxlength="300" placeholder="Вопрос из формы, например: Expected salary?">
      <label for="subA" class="sr-only">Ответ</label>
      <textarea id="subA" name="a" rows="3" maxlength="5000" placeholder="Что ты ответил — как в форме"></textarea>
      <p class="error" id="subErr"></p>
      <div class="row"><button type="submit" class="${list.length ? '' : 'primary'}">Добавить</button></div>
    </form>
  </div>`;
}

function bindSubmitted(d) {
  const card = $('#submittedCard');
  if (!card) return;
  const base = `/api/vacancies/${enc(d.name)}/submitted-answers`;
  // keep — сохранить недописанную новую пару при перерисовке (правка, удаление другой пары)
  const rerender = (keep = true) => {
    const v = keep ? [$('#subQ').value, $('#subA').value] : null;
    card.outerHTML = submittedBlock(d);
    bindSubmitted(d);
    if (v) [$('#subQ').value, $('#subA').value] = v;
  };
  $('#subNew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const item = await api(base, { method: 'POST', body: { q: f.elements.q.value, a: f.elements.a.value } });
      d.submittedAnswers = [...(d.submittedAnswers || []), item];
      rerender(false);
      $('#subQ').focus();
    } catch (err) { $('#subErr').textContent = err.message; }
  });
  card.querySelectorAll('[data-subedit]').forEach((b) => b.addEventListener('click', () => { subEdit = b.dataset.subedit; rerender(); }));
  card.querySelectorAll('[data-subcancel]').forEach((b) => b.addEventListener('click', () => { subEdit = null; rerender(); }));
  card.querySelectorAll('[data-sedit-form]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = f.dataset.seditForm;
    try {
      const item = await api(`${base}/${enc(id)}`, { method: 'PATCH', body: { q: f.elements.q.value, a: f.elements.a.value } });
      d.submittedAnswers = d.submittedAnswers.map((x) => (x.id === id ? item : x));
      subEdit = null;
      rerender();
    } catch (err) { f.querySelector('[data-suberr]').textContent = err.message; }
  }));
  card.querySelectorAll('[data-subdel]').forEach((b) => b.addEventListener('click', async () => {
    const x = d.submittedAnswers.find((y) => y.id === b.dataset.subdel);
    if (!confirm(`Удалить ответ на «${x.q}»?`)) return;
    try { await api(`${base}/${enc(x.id)}`, { method: 'DELETE' }); } catch (err) { alert(err.message); return; }
    d.submittedAnswers = d.submittedAnswers.filter((y) => y.id !== x.id);
    rerender();
  }));
  card.querySelectorAll('[data-subcopy]').forEach((b) => b.addEventListener('click', async () => {
    const x = d.submittedAnswers.find((y) => y.id === b.dataset.subcopy);
    b.textContent = (await copyText(x.a)) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { b.textContent = 'Скопировать'; }, 2000);
  }));
}

function answersBlock(d, job) {
  const busy = job && ['running', 'queued'].includes(job.state);
  const A = d.answers;
  const h = A?.humanize;
  return `<div class="card" id="answersCard">
    <h2><span class="n">4</span>Вопросы формы заявки
      ${h ? `<span class="right"><span class="chip ${h.pass ? 'good' : 'bad'}">humanizer ${h.score} (≤${h.max})</span></span>` : ''}</h2>
    ${busy || job?.state === 'error' ? jobBlock(job) : ''}
    ${A?.questions?.length ? `<ol class="answers">${A.questions.map(answerItem).join('')}</ol>` : ''}
    <div class="${A?.questions?.length ? 'hint' : ''}" style="margin:${A?.questions?.length ? '16px 0 6px' : '0 0 6px'}">
      ${A?.questions?.length ? 'Вопросы (можно поправить и подготовить заново):' : 'Вставь вопросы из формы заявки — по одному в строке. Лимит символов — в скобках в конце: <code>Why do you want to join us? (500)</code>. Факты агент берёт только из базы знаний и стандартных ответов.'}
    </div>
    <label class="sr-only" for="formQuestions">Вопросы формы</label>
    <textarea id="formQuestions" rows="5" placeholder="Why do you want to join us? (500)&#10;What is your notice period?&#10;Describe a product you launched from scratch (1500)">${esc(d.formQuestions)}</textarea>
    <div class="row" style="margin-top:10px">
      <button id="answersBtn" class="${A ? '' : 'primary'}" ${busy ? 'disabled' : ''}>${A ? 'Подготовить заново' : 'Подготовить ответы'}</button>
      <span class="hint" style="margin:0">≈ $0.5–1 за прогон · <a href="#/profile" id="profileLink">стандартные ответы</a> (срок выхода, зарплата, виза)</span>
    </div>
  </div>`;
}

function answerItem(a, qi) {
  const [tone, label] = Q_STATUS[a.status] || Q_STATUS.ok;
  const variants = (a.variants || []).map((v, vi) => {
    const len = (v.text || '').length;
    const over = a.limit && len > a.limit;
    return `<div class="variant">
      <div class="v-head"><span class="muted small">${v.label === 'short' ? 'Коротко' : v.label === 'long' ? 'Развёрнуто' : v.label === 'library' ? 'Из библиотеки' : esc(v.label)}</span>
        <span class="mono small ${over ? 'over' : 'muted'}">${len}${a.limit ? ` / ${a.limit}` : ''} симв.</span>
        <button type="button" class="small" data-copy="${qi}:${vi}">Копировать</button>
        ${v.label !== 'library' ? `<button type="button" class="small" data-libsave="${qi}:${vi}" title="Поправь текст при желании и сохрани — в следующих формах этот вопрос ответится без агента">★ В библиотеку</button>` : ''}</div>
      <p class="v-text" id="ans-${qi}-${vi}">${esc(v.text)}</p>
    </div>`;
  }).join('');
  const src = (a.sources || []).map((s) => `<span class="kchip">${esc(s.replace(/^card:/, '').replace(/^profile:/, 'профиль: '))}</span>`).join('');
  return `<li class="answer">
    <div class="a-head"><strong>${esc(a.q)}</strong>
      <span class="pill ${tone}">${label}</span>${a.type ? `<span class="muted small">${Q_TYPES[a.type] || esc(a.type)}</span>` : ''}</div>
    ${a.note ? `<p class="a-note ${a.status === 'ok' ? '' : 'warn'}">${esc(a.note)}</p>` : ''}
    ${variants}
    ${src ? `<div class="chips"><span class="muted small">Источники:</span>${src}</div>` : ''}
    <div class="row small" style="gap:6px;margin-top:4px"><button type="button" class="link-btn inline" data-redo="${qi}">Переделать этот ответ…</button>
      ${a.redo ? `<span class="muted">переделан: «${esc(a.redo)}»</span>` : ''}</div>
  </li>`;
}

function bindAnswers(d) {
  const ta = $('#formQuestions');
  if (!ta) return;
  let t;
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { formQuestions: ta.value } }), 600);
  });
  $('#profileLink')?.addEventListener('click', () => { try { sessionStorage.setItem('cvc-scroll', 'profileAnswers'); } catch {} });
  $('#answersBtn').addEventListener('click', async (e) => {
    if (d.answers && !confirm('Подготовить ответы заново? Текущие варианты будут заменены.')) return;
    e.target.disabled = true;
    let r;
    try { r = await api(`/api/vacancies/${enc(d.name)}/answers`, { method: 'POST', body: { questions: ta.value } }); }
    catch (err) { alert(err.message); e.target.disabled = false; return; }
    if (r.library) flash(r.jobId ? `Из библиотеки: ${r.library} — без агента, остальные готовит агент.` : `Все ответы (${r.library}) взяты из библиотеки — агент не запускался.`);
    await loadDetail();
  });
  // S4 P1: сохранить вариант (можно поправить прямо в тексте) в библиотеку
  document.querySelectorAll('#answersCard [data-libsave]').forEach((b) => b.addEventListener('click', async () => {
    const [qi, vi] = b.dataset.libsave.split(':');
    const p = $(`#ans-${qi}-${vi}`);
    if (p.contentEditable !== 'true') {
      p.contentEditable = 'true';
      p.classList.add('editing');
      p.focus();
      b.textContent = 'Сохранить в библиотеку';
      return;
    }
    try {
      await api('/api/answer-library', { method: 'POST', body: { q: d.answers.questions[qi].q, a: p.innerText.trim(), vacancy: d.name } });
      p.contentEditable = 'false';
      p.classList.remove('editing');
      b.textContent = 'В библиотеке ✓';
      b.disabled = true;
    } catch (err) { alert(err.message); }
  }));
  document.querySelectorAll('#answersCard [data-redo]').forEach((b) => b.addEventListener('click', async () => {
    const comment = prompt('Что поменять в ответе? Например: «короче», «больше про LMS», «без цифр про команду»');
    if (!comment?.trim()) return;
    try { await api(`/api/vacancies/${enc(d.name)}/answers/${b.dataset.redo}/redo`, { method: 'POST', body: { comment } }); }
    catch (err) { alert(err.message); return; }
    await loadDetail();
  }));
  document.querySelectorAll('#answersCard [data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const [qi, vi] = b.dataset.copy.split(':');
    b.textContent = (await copyText(d.answers.questions[qi].variants[vi].text)) ? 'Скопировано ✓' : 'Не вышло — выдели вручную';
    setTimeout(() => { b.textContent = 'Копировать'; }, 1500);
  }));
}

// ---------- клик по плитке открывает заявку (E2, docs/specs/13-clickable-card.md) ----------

// Кнопки, ссылки и поля внутри плитки делают своё; клик по остальной площади — переход в заявку
const CARD_INTERACTIVE = 'a, button, input, textarea, select, label, summary, details';

function makeCardClickable(card, name) {
  const url = `#/v/${enc(name)}`;
  card.addEventListener('click', (e) => {
    if (e.target.closest(CARD_INTERACTIVE)) return;
    if (String(getSelection?.() || '').trim()) return; // выделяли текст — не переходим
    if (e.metaKey || e.ctrlKey) { window.open(url, '_blank'); return; }
    openVacancy(name);
  });
  // средняя кнопка мыши — в новой вкладке, как у обычной ссылки
  card.addEventListener('auxclick', (e) => {
    if (e.button !== 1 || e.target.closest(CARD_INTERACTIVE)) return;
    e.preventDefault();
    window.open(url, '_blank');
  });
}

// ---------- отраслевые разделы: «EdTech» (S6) и «FinTech» (S7) ----------

const ROLE_GROUP_LABELS = { edu: 'обучение клиентов', product: 'продукт', growth: 'рост и маркетинг', business: 'бизнес и рынки', ops: 'операции и контент' };
const ATS_LABELS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee', personio: 'Personio', none: '—' };
const COMPANY_STATUS = { ok: ['good', 'автосбор'], no_api: ['neutral', 'без API'], broken: ['bad', 'не отвечает'], retry: ['warn', 'перепроверить'] };
const SECTOR_INFO = {
  edtech: { label: 'EdTech', what: 'Продуктовые и бизнес-роли EdTech-компаний мира' },
  fintech: { label: 'FinTech', what: 'Роли брокеров, трейдинг- и крипто-компаний: обучение клиентов, продукт, рост, бизнес' },
};
const SECTORS_UI = Object.keys(SECTOR_INFO);
const sectorBase = {};

const baseSummary = (b) => (b ? ` · ${b.summary.total} · автосбор ${b.summary.ok} · без API ${b.summary.no_api}${b.summary.broken ? ` · не отвечают ${b.summary.broken}` : ''}${b.summary.retry ? ` · перепроверить ${b.summary.retry}` : ''}` : '');

function sectorHead(d, sector) {
  const info = SECTOR_INFO[sector];
  const last = d.sources.filter((s) => s.source === sector).map((s) => s.date).sort().pop();
  const b = sectorBase[sector];
  return `<div class="edtech-head">
    <div><p class="muted small" style="margin:0">${info.what} — прямо со страниц карьеры через открытые API систем найма.
      ${last ? `Обновлено ${ago(last)}.` : 'Ещё не обновлялось.'}</p></div>
    <button type="button" class="btn primary" id="sectorRefresh">Обновить ${info.label}</button>
  </div>
  <details class="edtech-base" id="sectorBase" ${sessionStorage.getItem(`cvc-${sector}-base`) ? 'open' : ''}>
    <summary>База компаний${baseSummary(b)}</summary>
    <div id="sectorBaseBody">${b ? sectorBaseBody(sector) : '<p class="muted small">Загружаю…</p>'}</div>
  </details>`;
}

function sectorBaseBody(sector) {
  const b = sectorBase[sector];
  const agent = b.agent;
  const busy = agent && ['running', 'queued'].includes(agent.state);
  const rows = b.companies.slice().sort((x, y) => (x.status === 'ok' ? 0 : 1) - (y.status === 'ok' ? 0 : 1) || x.name.localeCompare(y.name))
    .map((c) => {
      const [tone, label] = COMPANY_STATUS[c.status] || COMPANY_STATUS.no_api;
      return `<tr><td>${c.careers_url ? `<a href="${esc(c.careers_url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}</td>
        <td class="muted">${esc(c.country || '')}</td><td>${esc(c.segment || '')}</td><td>${ATS_LABELS[c.ats] || esc(c.ats)}</td>
        <td><span class="pill ${tone}">${label}</span></td>
        <td class="mono">${c.status === 'ok' ? `${c.roles_last ?? '—'} / ${c.jobs_last ?? '—'}` : ''}</td></tr>`;
    }).join('');
  return `<div class="row" style="margin:10px 0">
      <button type="button" class="btn ghost" id="sectorDiscover" ${busy ? 'disabled' : ''}>Найти новые компании</button>
      <span class="muted small">Агент ищет страницы карьеры компаний без автосбора и новые ${SECTOR_INFO[sector].label}-компании — до 30 за запуск, ≈ $5–8 условно, 10–15 минут.
        В базу попадает только то, что подтвердил API.</span>
    </div>
    ${busy || agent?.state === 'error' ? `<div class="running">${busy ? '<span class="spin"></span>Агент расширяет базу…' : `<span class="error">Ошибка: ${esc(agent.error)}</span>`}</div><div class="feed" data-feed="${agent.id}"></div>` : ''}
    <form class="company-add" id="companyAdd">
      <strong class="small">Добавить компанию</strong>
      <input id="caName" placeholder="Название, например Coursera" maxlength="80" aria-label="Название компании">
      <input id="caUrl" placeholder="Страница вакансий (необязательно)" maxlength="300" aria-label="Страница вакансий">
      <button type="submit" class="small">Проверить и добавить</button>
      <p class="hint" style="margin:0;flex-basis:100%">Скрипт бесплатно проверит Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio по названию и ссылке.
        Не нашёл — можно попросить агента (≈ $0.3–0.8).</p>
      <div id="caResult" style="flex-basis:100%"></div>
    </form>
    <div class="table-box"><table class="apps">
      <thead><tr><th>Компания</th><th>Страна</th><th>Сегмент</th><th>Система найма</th><th>Статус</th><th>Роли / вакансии</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

async function loadSectorBase(sector) {
  try { sectorBase[sector] = await api(`/api/feed/${sector}/companies`); } catch { return; }
  if (feedTab === sector && $('#sectorBase')) {
    $('#sectorBase summary').textContent = `База компаний${baseSummary(sectorBase[sector])}`;
    $('#sectorBaseBody').innerHTML = sectorBaseBody(sector);
    bindSectorBase(sector);
  }
}

function bindSectorBase(sector) {
  $('#companyAdd')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#caName').value.trim();
    const careersUrl = $('#caUrl').value.trim();
    const out = $('#caResult');
    if (!name) { out.innerHTML = '<p class="error">Нужно название.</p>'; return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    out.innerHTML = '<p class="muted small"><span class="spin"></span>Проверяю системы найма…</p>';
    let r;
    try { r = await api(`/api/feed/${sector}/companies`, { method: 'POST', body: { name, careersUrl } }); }
    catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; btn.disabled = false; return; }
    btn.disabled = false;
    const c = r.company || {};
    if (!r.added) out.innerHTML = `<p class="small">«${esc(c.name || name)}» уже в базе с автосбором (${esc(ATS_LABELS[c.ats] || c.ats || '')}).</p>`;
    else if (c.status === 'ok') out.innerHTML = `<p class="small">✓ «${esc(c.name)}» ${r.existed ? 'уже была в базе — проверена заново' : 'добавлена'}: ${esc(ATS_LABELS[c.ats] || c.ats)} · ${c.jobs_last ?? 0} вакансий. Роли появятся после «Обновить ${SECTOR_INFO[sector].label}».</p>`;
    else {
      out.innerHTML = `<p class="small">«${esc(c.name)}» ${r.existed ? 'уже есть в базе, но' : 'записана'} без автосбора${c.note ? ` (${esc(c.note)})` : ''}: открытый API по названию${careersUrl ? ' и ссылке' : ''} не нашёлся.
        <button type="button" class="small" id="caAgent">Найти через агента</button></p>`;
      $('#caAgent').addEventListener('click', async (ev) => {
        if (!confirm(`Запустить агента? Он найдёт страницу вакансий и систему найма «${c.name}». ≈ $0.3–0.8.`)) return;
        ev.target.disabled = true;
        try { await api(`/api/feed/${sector}/companies/find`, { method: 'POST', body: { name: c.name, careersUrl } }); } catch (err) { alert(err.message); }
        loadSectorBase(sector);
      });
    }
    $('#caName').value = '';
    $('#caUrl').value = '';
    api(`/api/feed/${sector}/companies`).then((d) => { sectorBase[sector] = d; if ($('#sectorBase')) $('#sectorBase summary').textContent = `База компаний${baseSummary(d)}`; }).catch(() => {});
  });
  $('#sectorDiscover')?.addEventListener('click', async (e) => {
    if (!confirm(`Запустить агента? Он найдёт до 30 компаний: страницы карьеры для компаний без автосбора и новые ${SECTOR_INFO[sector].label}-компании. ≈ $5–8 условно, 10–15 минут.`)) return;
    e.target.disabled = true;
    try { await api(`/api/feed/${sector}/discover`, { method: 'POST', body: { limit: 30 } }); } catch (err) { alert(err.message); }
    loadSectorBase(sector);
  });
  const agent = sectorBase[sector]?.agent;
  if (agent && ['running', 'queued'].includes(agent.state)) {
    attachFeed({ ...agent, target: `__${sector}__` });
    clearTimeout(bindSectorBase.t);
    bindSectorBase.t = setTimeout(() => loadSectorBase(sector), 15000);
  }
}

function bindSector(sector) {
  $('#sectorRefresh')?.addEventListener('click', async () => {
    try { const r = await api('/api/feed/refresh', { method: 'POST', body: { mode: sector } }); watchRefresh(r.job); } catch (e) { alert(e.message); }
  });
  $('#sectorBase')?.addEventListener('toggle', (e) => {
    try { if (e.target.open) sessionStorage.setItem(`cvc-${sector}-base`, '1'); else sessionStorage.removeItem(`cvc-${sector}-base`); } catch {}
  });
  if (sectorBase[sector]) bindSectorBase(sector);
  loadSectorBase(sector);
}

// ---------- поиск и фильтры (C1, docs/specs/08-search-and-filters.md) ----------
// Фильтрация на клиенте. Состояние — в адресе (#/?q=…&fmt=remote), обновляется через replaceState,
// чтобы экран не перерисовывался целиком и фокус оставался в поле поиска.

const FMT_LABELS = { remote: 'удалённо', hybrid: 'гибрид', onsite: 'офис', unknown: 'не указан' };
const FIT_BUCKETS = { hi: `фит ${FIT_THRESHOLD}+`, mid: 'фит 5–6', lo: 'ниже 5', none: 'не оценён' };
const AGE_LABELS = { 1: '24 ч', 3: '3 дня', 7: 'неделя', 30: 'месяц' };
const SORTS = {
  home: { added: 'по дате добавления', fit: 'по фиту', master: 'по матчу с Master CV', sent: 'по дате отправки' },
  feed: { signal: 'по сигналу фита', fresh: 'сначала свежие' },
};
const filters = { home: {}, feed: {} };
const LIST_KEYS = ['fmt', 'sen', 'fit', 'age', 'seg', 'grp', 'src'];

function readFilters(ctx) {
  const p = currentRoute().params || {};
  const f = {};
  if (p.q) f.q = p.q;
  for (const k of LIST_KEYS) if (p[k]) f[k] = p[k].split(',').filter(Boolean);
  if (p.sal) f.sal = true;
  if (p.sort && SORTS[ctx][p.sort]) f.sort = p.sort;
  filters[ctx] = f;
}

function writeFilters(ctx) {
  const f = filters[ctx];
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  for (const k of LIST_KEYS) if (f[k]?.length) q.set(k, f[k].join(','));
  if (f.sal) q.set('sal', '1');
  if (f.sort) q.set('sort', f.sort);
  const base = ctx === 'feed' ? '#/feed' : '#/';
  const qs = q.toString();
  history.replaceState(null, '', base + (qs ? `?${qs}` : ''));
}

const filtersActive = (ctx) => Object.entries(filters[ctx]).some(([k, v]) => k !== 'sort' && (Array.isArray(v) ? v.length : v));

// Признаки записи для фильтров — у заявок и вакансий ленты они лежат в разных полях
function fmtFromLocation(loc) {
  const s = String(loc || '');
  if (/hybrid|гибрид/i.test(s)) return 'hybrid';
  if (/remote|anywhere|worldwide|distributed|удал|віддал/i.test(s)) return 'remote';
  return s ? 'onsite' : '';
}
const normSen = (x) => [].concat(x || []).join(' ').toLowerCase().split(/[,/]| and /).map((t) => t.trim()).filter(Boolean);
function homeFacts(i) {
  const fit = i.fit?.total;
  return {
    text: `${i.role} ${i.company} ${i.fit?.location || ''} ${i.name}`.toLowerCase(),
    fmt: i.fit?.work_format || '', sen: normSen(i.fit?.seniority), sal: !!i.fit?.salary,
    fit: fit == null ? 'none' : fit >= FIT_THRESHOLD ? 'hi' : fit >= 5 ? 'mid' : 'lo',
  };
}
function feedFacts(j) {
  return {
    text: `${j.title} ${j.company} ${j.location} ${j.segment || ''} ${(j.hits || []).join(' ')}`.toLowerCase(),
    fmt: fmtFromLocation(j.location), sen: normSen(j.seniority), sal: !!j.salary,
    age: j.posted ? Math.floor((Date.now() - Date.parse(j.posted)) / DAY_MS) : null,
    seg: j.segment || '', grp: j.role_group || '', src: j.source || '',
  };
}

function applyFilters(ctx, list) {
  const f = filters[ctx];
  const facts = ctx === 'feed' ? feedFacts : homeFacts;
  const q = (f.q || '').toLowerCase().trim();
  return list.filter((x) => {
    const a = facts(x);
    if (q && !q.split(/\s+/).every((w) => a.text.includes(w))) return false;
    if (f.fmt?.length && !f.fmt.includes(a.fmt)) return false;
    if (f.sen?.length && !a.sen.some((s) => f.sen.includes(s))) return false;
    if (f.fit?.length && !f.fit.includes(a.fit)) return false;
    if (f.sal && !a.sal) return false;
    if (f.age?.length && (a.age == null || a.age > Math.max(...f.age.map(Number)))) return false;
    if (f.seg?.length && !f.seg.includes(a.seg)) return false;
    if (f.grp?.length && !f.grp.includes(a.grp)) return false;
    if (f.src?.length && !f.src.includes(a.src)) return false;
    return true;
  });
}

function sortHome(list) {
  const by = filters.home.sort || 'added';
  const key = {
    added: (i) => i.created || 0, fit: (i) => i.fit?.total ?? -1, master: (i) => i.master?.score ?? -1,
    sent: (i) => (i.sent?.at ? Date.parse(i.sent.at) : -1),
  }[by];
  return list.slice().sort((a, b) => key(b) - key(a) || (b.fit?.total ?? -1) - (a.fit?.total ?? -1));
}

// Панель фильтров. groups — какие группы чипов показать и их значения
function filterBar(ctx, groups, shown, total) {
  const f = filters[ctx];
  const pressed = (g, v) => (g === 'sal' ? !!f.sal : (f[g] || []).includes(String(v)));
  const chip = (g, v, label) => `<button type="button" class="fchip" data-fg="${g}" data-fv="${esc(v)}" aria-pressed="${pressed(g, v)}">${esc(label)}</button>`;
  const group = (g, title, opts) => (opts.length ? `<div class="fgroup" role="group" aria-label="${title}"><span class="fg-title">${title}</span>${opts.map(([v, l]) => chip(g, v, l)).join('')}</div>` : '');
  return `<div class="filters" data-ctx="${ctx}">
    <div class="frow">
      <label class="sr-only" for="fq-${ctx}">Поиск</label>
      <input type="search" id="fq-${ctx}" class="fsearch" placeholder="Поиск: компания, роль, локация" value="${esc(f.q || '')}" autocomplete="off">
      <label class="sr-only" for="fs-${ctx}">Сортировка</label>
      <select id="fs-${ctx}" class="fsort">${Object.entries(SORTS[ctx]).map(([k, l]) => `<option value="${k}" ${(f.sort || Object.keys(SORTS[ctx])[0]) === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="frow chips-row">
      ${groups.map(([g, title, opts]) => group(g, title, opts)).join('')}
    </div>
    <div class="frow fmeta"><span class="muted small" id="fcount-${ctx}">${filterCount(shown, total, ctx)}</span>
      <button type="button" class="link-btn inline ${filtersActive(ctx) ? '' : 'hidden'}" id="freset-${ctx}">Сбросить фильтры</button></div>
  </div>`;
}

const filterCount = (shown, total, ctx) => (filtersActive(ctx) ? `Показано ${shown} из ${total}` : `Всего ${total}`);

// Значения для чипов — только те, что есть в данных
function presentValues(list, factsFn, key) {
  const vals = new Set();
  list.forEach((x) => [].concat(factsFn(x)[key] || []).forEach((v) => v && vals.add(v)));
  return [...vals].sort();
}

function bindFilters(ctx, rerender) {
  const root = document.querySelector(`.filters[data-ctx="${ctx}"]`);
  if (!root) return;
  const changed = () => { writeFilters(ctx); rerender(); };
  let t;
  root.querySelector('.fsearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { filters[ctx].q = e.target.value.trim() || undefined; changed(); }, 150);
  });
  root.querySelector('.fsort').addEventListener('change', (e) => { filters[ctx].sort = e.target.value; changed(); });
  root.querySelectorAll('.fchip').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.fg;
    const v = b.dataset.fv;
    if (g === 'sal') filters[ctx].sal = !filters[ctx].sal;
    else {
      const cur = new Set(filters[ctx][g] || []);
      if (cur.has(v)) cur.delete(v); else cur.add(v);
      filters[ctx][g] = [...cur];
    }
    b.setAttribute('aria-pressed', g === 'sal' ? String(!!filters[ctx].sal) : String((filters[ctx][g] || []).includes(v)));
    changed();
  }));
  root.querySelector(`#freset-${ctx}`).addEventListener('click', () => {
    filters[ctx] = filters[ctx].sort ? { sort: filters[ctx].sort } : {};
    writeFilters(ctx);
    if (ctx === 'home') renderHome(); else renderFeed(); // перерисовать и чипы, и список
  });
}

function updateFilterMeta(ctx, shown, total) {
  const c = document.getElementById(`fcount-${ctx}`);
  if (c) c.textContent = filterCount(shown, total, ctx);
  document.getElementById(`freset-${ctx}`)?.classList.toggle('hidden', !filtersActive(ctx));
}

const emptyFiltered = (ctx) => `<div class="table-box empty-box">Ничего не нашлось.
  <button type="button" class="link-btn inline" data-freset-empty="${ctx}">Сбросить фильтры</button></div>`;

// Главный экран: что показать в «Все заявки» с учётом фильтров
const homeVisible = () => sortHome(applyFilters('home', items));

function homeFilterGroups() {
  const sen = presentValues(items, homeFacts, 'sen');
  return [
    ['fmt', 'Формат', presentValues(items, homeFacts, 'fmt').map((v) => [v, FMT_LABELS[v] || v])],
    ['fit', 'Фит', Object.entries(FIT_BUCKETS).filter(([k]) => items.some((i) => homeFacts(i).fit === k))],
    ['sen', 'Уровень', sen.map((v) => [v, v === 'unknown' ? 'не указан' : v])],
    ...(items.some((i) => i.fit?.salary) ? [['sal', 'Зарплата', [['1', 'указана']]]] : []),
  ];
}

function renderAllBody() {
  const body = $('#allBody');
  if (!body) return;
  const stages = new Map(items.map((i) => [i.name, stageOf(i)]));
  body.innerHTML = homeView === 'board' ? boardView(stages) : homeView === 'stats' ? statsView() : allTable(stages);
  if (homeView === 'board') bindBoard();
  if (homeView === 'stats') loadWeek();
  updateFilterMeta('home', homeVisible().length, items.length);
  bindEmptyReset();
}

// Лента: фильтр внутри текущей вкладки
function feedVisible(list) {
  const out = applyFilters('feed', list);
  if (filters.feed.sort === 'fresh') out.sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));
  return out;
}

function feedFilterGroups(list) {
  const groups = [
    ['fmt', 'Формат', presentValues(list, feedFacts, 'fmt').map((v) => [v, FMT_LABELS[v] || v])],
    ['age', 'Опубликовано', Object.entries(AGE_LABELS).filter(([d]) => list.some((j) => { const a = feedFacts(j).age; return a != null && a <= Number(d); }))],
  ];
  if (SECTORS_UI.includes(feedTab)) {
    groups.push(['grp', 'Роль', presentValues(list, feedFacts, 'grp').map((v) => [v, ROLE_GROUP_LABELS[v] || v])]);
    groups.push(['seg', 'Сегмент', presentValues(list, feedFacts, 'seg').map((v) => [v, v])]);
  } else {
    groups.push(['sen', 'Уровень', presentValues(list, feedFacts, 'sen').slice(0, 8).map((v) => [v, v === 'unknown' ? 'не указан' : v])]);
    const srcs = presentValues(list, feedFacts, 'src');
    if (srcs.length > 1) groups.push(['src', 'Источник', srcs.map((v) => [v, FEED_SOURCE_LABELS[v] || v])]);
  }
  if (list.some((j) => j.salary)) groups.push(['sal', 'Зарплата', [['1', 'указана']]]);
  return groups;
}

function currentFeedList() {
  const d = feedData;
  if (feedTab === 'skipped') return d.skipped;
  const list = d.items.filter((i) => i.section === feedTab);
  return SECTORS_UI.includes(feedTab) ? sortSectorList(list) : list;
}

function feedBodyHtml(list, empty) {
  const vis = feedTab === 'skipped' ? list : feedVisible(list);
  if (!vis.length) return list.length && filtersActive('feed') ? emptyFiltered('feed') : `<div class="table-box empty-box">${empty}</div>`;
  return `${feedTab !== 'skipped' ? '<p class="muted small keys-hint" style="margin:0 0 8px">Клавиши: J / K — следующая / предыдущая, S — сохранить, X — пропустить, O — открыть на сайте.</p>' : ''}
    <div class="cards">${vis.slice(0, feedShown[feedTab]).map(feedTab === 'skipped' ? skippedCard : feedCard).join('')}</div>
    ${vis.length > feedShown[feedTab] ? `<button type="button" class="btn ghost" id="feedMore" style="align-self:center">Показать ещё · ${vis.length - feedShown[feedTab]}</button>` : ''}`;
}

function renderFeedBody() {
  const body = $('#feedBody');
  if (!body) return;
  const list = currentFeedList();
  body.innerHTML = feedBodyHtml(list, 'Здесь пусто.');
  bindFeedCards();
  updateFilterMeta('feed', feedVisible(list).length, list.length);
}

// «Сбросить фильтры» в пустом состоянии
function bindEmptyReset() {
  document.querySelectorAll('[data-freset-empty]').forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', () => {
      const ctx = b.dataset.fresetEmpty;
      filters[ctx] = filters[ctx].sort ? { sort: filters[ctx].sort } : {};
      writeFilters(ctx);
      if (ctx === 'home') renderHome(); else renderFeed();
    });
  });
}

// ---------- профиль поиска (C2, docs/specs/09-search-profile.md) ----------
// Жёсткие фильтры скоринга и логистика фита читают knowledge-base/profile.json; стандартные ответы
// для форм (S4) — knowledge-base/profile-answers.md. После сохранения профиля запускается калибровка.

const RELOC_LABELS = { no: 'не рассматриваю — офис только в моих локациях', with_support: 'только с поддержкой релокации', any: 'готов к любому офису' };
const SEN_LEVELS = ['junior', 'mid', 'senior', 'lead', 'head'];

async function loadProfile() {
  const root = $('#profileView');
  root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Загружаю…</div></div>';
  let p, answers;
  try {
    [p, answers, moneyData] = await Promise.all([api('/api/profile'), api('/api/profile-answers').then((r) => r.text), api('/api/money')]);
  } catch (e) { root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`; return; }
  renderProfile(p.profile, answers, p.canRevert, null);
}

function renderProfile(pr, answers, canRevert, cal) {
  const ms = pr.min_salary || {};
  const check = (name, v, on, label) => `<label class="ck"><input type="checkbox" name="${name}" value="${v}" ${on ? 'checked' : ''}> ${label}</label>`;
  $('#profileView').innerHTML = `<div class="page-wrap">
    <section class="home-head"><div><h1>Профиль поиска</h1>
      <p class="lead">Что отсеивать при оценке фита и что отвечать в формах заявок.</p></div></section>

    <form class="card profile-form" id="profileForm">
      <h2>Предпочтения</h2>
      <p class="muted small" style="margin:-4px 0 12px">Жёсткие фильтры <code>score_job.py</code>: вакансия, которая под них попадает, уходит в корпус без дайджеста.
        Балл «логистика» агент ставит по этому же профилю. После сохранения запускается калибровка на эталонах.</p>
      <div class="pf-grid">
        <span class="lbl">Форматы работы</span>
        <div class="checks">${['remote', 'hybrid', 'onsite'].map((f) => check('work_formats', f, pr.work_formats.includes(f), FMT_LABELS[f])).join('')}</div>
        <label for="pfLoc">Офис — где готов</label>
        <div><input id="pfLoc" value="${esc(pr.onsite_locations.join(', '))}"><p class="hint">Города и страны через запятую, на любом языке написания: warsaw, warszawa, poland…</p></div>
        <span class="lbl">Офис в других местах</span>
        <div class="radios">${Object.entries(RELOC_LABELS).map(([k, l]) => `<label><input type="radio" name="relocation" value="${k}" ${pr.relocation === k ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        <label for="pfLang">Языки</label>
        <div><input id="pfLang" value="${esc(pr.languages.join(', '))}"><p class="hint">Вакансия с требованием другого языка отсеивается. Полное название и код: polish, pl.</p></div>
        <span class="lbl">Исключить уровни</span>
        <div class="checks">${SEN_LEVELS.map((s) => check('seniority_exclude', s, pr.seniority_exclude.includes(s), s)).join('')}</div>
        <span class="lbl">Вакансии только для США</span>
        <div class="checks"><label class="ck"><input type="checkbox" id="pfNoUS" ${pr.exclude_us_only !== false ? 'checked' : ''}> скрывать в ленте</label>
          <span class="hint" style="margin:0">все локации в США или требуется право работать / жить в США</span></div>
        <label for="pfNoReply">Без ответа через</label>
        <div class="row"><input id="pfNoReply" type="number" min="1" max="90" step="1" style="width:90px" value="${pr.no_reply_days ?? 14}">
          <span class="hint" style="margin:0">дней после отправки заявка без ответа сама уходит в архив «Без ответа»</span></div>
        <label for="pfSal">Минимальная зарплата</label>
        <div class="row"><input id="pfSal" type="number" min="0" step="any" style="width:160px" value="${ms.amount ?? ''}" placeholder="не задана">
          <select id="pfCur" style="width:auto">${['EUR', 'PLN', 'USD', 'GBP'].map((c) => `<option ${ms.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <select id="pfPer" style="width:auto"><option value="year" ${ms.period !== 'month' ? 'selected' : ''}>в год</option><option value="month" ${ms.period === 'month' ? 'selected' : ''}>в месяц</option></select>
          <span class="hint" style="margin:0">учитывается в логистике фита, жёстко не отсекает</span></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button type="submit" class="primary" id="pfSave">Сохранить и проверить калибровку</button>
        ${canRevert ? '<button type="button" id="pfRevert">Вернуть прежний профиль</button>' : ''}
      </div>
      <p class="error" id="pfError"></p>
      ${cal ? `<div class="banner ${cal.pass ? 'hyp info' : 'warn'}" style="margin-top:12px"><p>${cal.pass ? '✓ Калибровка: все эталоны в диапазоне.'
        : '⚠ Калибровка: есть отклонения — профиль сдвинул оценку эталонов. Проверь вывод ниже или верни прежний профиль.'}</p></div>
        ${cal.impact ? `<div class="banner ${cal.impact.changed.length ? 'warn' : 'hyp'}" style="margin-top:8px"><p>${cal.impact.changed.length
          ? `Профиль меняет решение по ${cal.impact.changed.length} из ${cal.impact.corpus} вакансий корпуса: отсеются ${cal.impact.dropped}, вернутся ${cal.impact.restored}.`
          : `Решения по корпусу (${cal.impact.corpus} вакансий) не меняются.`}</p>
          ${cal.impact.changed.length ? `<ul class="tight">${cal.impact.changed.slice(0, 12).map((c) => `<li>${esc(c.title)} — ${esc(c.company)}: ${c.old} → <strong>${c.new}</strong>${c.hard_filters.length ? ` <span class="muted">(${esc(c.hard_filters.join('; '))})</span>` : ''}</li>`).join('')}</ul>` : ''}</div>` : ''}
        <details style="margin-top:8px"><summary class="muted small">Вывод калибровки</summary><pre class="cal-out">${esc(cal.output)}</pre></details>` : ''}
    </form>

    ${moneyCard()}

    <div class="card" id="answerLib"><h2>Библиотека ответов</h2><p class="muted small">Загружаю…</p></div>

    <div class="card" id="profileAnswers">
      <h2>Стандартные ответы для форм</h2>
      <p class="muted small" style="margin:-4px 0 10px">Срок выхода, зарплатные ожидания, разрешение на работу, релокация — агент берёт их отсюда дословно
        для фактических вопросов в формах заявок. Пустой раздел — агент ответит «нет данных», а не придумает.
        Формат: заголовок <code>## Раздел</code>, под ним — ответ.</p>
      <label class="sr-only" for="profileText">Стандартные ответы</label>
      <textarea id="profileText" rows="16" spellcheck="false" class="mono-ta">${esc(answers)}</textarea>
      <div class="row" style="margin-top:10px"><button type="button" class="primary" id="profileSave">Сохранить</button>
        <span class="hint" style="margin:0" id="profileMsg"></span></div>
    </div>
  </div>`;
  bindProfile(answers);
  bindMoney();
  loadAnswerLib();
}

// S4 P1 · библиотека: ответы, сохранённые из заявок; совпавший вопрос в новой форме отвечается без агента
async function loadAnswerLib() {
  const box = $('#answerLib');
  if (!box) return;
  let r;
  try { r = await api('/api/answer-library'); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  box.innerHTML = `<h2>Библиотека ответов <span class="muted" style="font-weight:500">· ${r.items.length}</span></h2>
    <p class="muted small" style="margin:-4px 0 10px">Ответы, которые ты сохранил кнопкой «★ В библиотеку» в заявке. Похожий вопрос в новой форме
      (совпадает ≥ 60% значимых слов, ответ укладывается в лимит) отвечается отсюда дословно — агент не запускается.</p>
    ${r.items.length ? `<ol class="sub-list">${r.items.map((e) => `<li class="sub-item" data-lib="${esc(e.id)}">
      <div class="sub-q">${esc(e.q)}</div><div class="sub-a" data-libtext="${esc(e.id)}">${esc(e.a)}</div>
      <div class="sub-meta"><span class="muted small">${e.a.length} симв. · ${fmtDay(e.at)}${e.used ? ` · использован ${e.used}×` : ''}${e.vacancy ? ` · из «${esc(e.vacancy)}»` : ''}</span>
        <button type="button" class="link-btn inline" data-libedit="${esc(e.id)}">Изменить</button>
        <button type="button" class="link-btn inline danger" data-libdel="${esc(e.id)}">Удалить</button></div></li>`).join('')}</ol>`
      : '<p class="muted" style="margin:0">Пока пусто. В заявке у варианта ответа нажми «★ В библиотеку».</p>'}`;
  box.querySelectorAll('[data-libdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить ответ из библиотеки?')) return;
    await api(`/api/answer-library/${enc(b.dataset.libdel)}`, { method: 'DELETE' });
    loadAnswerLib();
  }));
  box.querySelectorAll('[data-libedit]').forEach((b) => b.addEventListener('click', async () => {
    const t = box.querySelector(`[data-libtext="${b.dataset.libedit}"]`);
    if (t.contentEditable !== 'true') { t.contentEditable = 'true'; t.classList.add('editing'); t.focus(); b.textContent = 'Сохранить'; return; }
    try { await api(`/api/answer-library/${enc(b.dataset.libedit)}`, { method: 'PATCH', body: { a: t.innerText.trim() } }); } catch (err) { alert(err.message); return; }
    loadAnswerLib();
  }));
}

function bindProfile(answers) {
  const form = $('#profileForm');
  const listOf = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const checked = (n) => [...form.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => x.value);
    const body = {
      work_formats: checked('work_formats'), seniority_exclude: checked('seniority_exclude'),
      relocation: form.querySelector('input[name="relocation"]:checked')?.value,
      onsite_locations: listOf($('#pfLoc').value), languages: listOf($('#pfLang').value),
      min_salary: { amount: $('#pfSal').value, currency: $('#pfCur').value, period: $('#pfPer').value },
      no_reply_days: $('#pfNoReply').value, exclude_us_only: $('#pfNoUS').checked,
    };
    $('#pfSave').disabled = true;
    $('#pfSave').textContent = 'Проверяю калибровку…';
    try {
      const r = await api('/api/profile', { method: 'PUT', body });
      renderProfile(r.profile, $('#profileText').value, r.canRevert, r.calibration);
    } catch (err) {
      $('#pfError').textContent = err.message;
      $('#pfSave').disabled = false;
      $('#pfSave').textContent = 'Сохранить и проверить калибровку';
    }
  });
  $('#pfRevert')?.addEventListener('click', async () => {
    const r = await api('/api/profile/revert', { method: 'POST' });
    renderProfile(r.profile, $('#profileText').value, false, r.calibration);
  });
  $('#profileSave').addEventListener('click', async () => {
    try {
      await api('/api/profile-answers', { method: 'PUT', body: { text: $('#profileText').value } });
      $('#profileMsg').textContent = 'Сохранено ✓';
    } catch (e) { $('#profileMsg').textContent = e.message; }
  });
  if (sessionStorage.getItem('cvc-scroll') === 'profileAnswers') {
    sessionStorage.removeItem('cvc-scroll');
    $('#profileAnswers').scrollIntoView({ block: 'start' });
  }
}

// ---------- W7 · деньги, чеклист оффера и «Моя неделя» (docs/specs/29-offer-numbers.md) ----------
// Цель и якорь — в профиле (якорь сам уходит в «Стандартные ответы» → Salary expectations); граница — отдельный файл,
// её не видят агенты. Неделя считается по своим действиям: хорошие ставки, сообщения контактам, тренировки.

let moneyData = null;
const MONEY_FORMS = ['B2B net', 'B2B gross', 'UoP net', 'UoP gross'];
const MONEY_PERIODS = { month: 'в месяц', year: 'в год', hour: 'в час' };
const PHRASE_PARTS = [
  ['interest', 'Интерес к роли', 'I’m genuinely interested in this role because…'],
  ['value', 'Что принесу', 'Building a learning product from zero to …'],
  ['basis', 'На чём основана цифра', 'Based on market data for similar Product Lead roles…'],
  ['flex', 'Гибкость по пакету', 'I’m open to discussing the overall package.'],
];
const OFFER_CHECKS = [
  ['target', 'Сумма не ниже цели (не границы)'],
  ['net', 'Посчитано «на руки» в своей форме (B2B net / UoP)'],
  ['review', 'Пересмотр: когда и по каким критериям — письменно'],
  ['scope', 'Роль, задачи и кому подчиняюсь — совпадают с тем, что обсуждали'],
  ['terms', 'Испытательный срок, уведомление, условия расторжения'],
  ['alt', 'Сравнил с альтернативой и взял время подумать'],
];

function phraseText(m) {
  const p = m.phrase || {};
  return [p.interest, p.value, m.anchor ? `My expectation is ${m.anchor}.` : '', p.basis, p.flex].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
}

function moneyCard() {
  if (!moneyData) return '';
  const m = moneyData.money;
  const pk = m.packages || {};
  const pkg = (k, label) => `<fieldset class="pkg"><legend>${label}</legend>
    ${[['salary', 'Зарплата'], ['review', 'Пересмотр'], ['bonus', 'Бонус за выход'], ['other', 'Другое']].map(([f, l]) =>
      `<label class="small">${l}<input data-pkg="${k}.${f}" value="${esc(pk[k]?.[f] || '')}"></label>`).join('')}</fieldset>`;
  return `<form class="card profile-form" id="moneyForm">
    <h2>Деньги</h2>
    <p class="muted small" style="margin:-4px 0 12px">Три цифры до первой формы. Якорь сам записывается в «Стандартные ответы» → Salary expectations —
      его подставляют формы на сайте и ответы на вопросы. Граница хранится отдельно и никуда не подставляется.</p>
    <div class="pf-grid">
      <label for="mTarget">Цель</label>
      <div><input id="mTarget" type="number" min="0" step="any" style="width:160px" value="${m.target ?? ''}" placeholder="по рынку">
        <textarea id="mSources" rows="2" placeholder="Источники: DOU, статистика сайтов вакансий, коллеги…" style="margin-top:6px">${esc(m.sources || '')}</textarea></div>
      <label for="mFrom">Якорь — что называю</label>
      <div class="row"><input id="mFrom" type="number" min="0" step="any" style="width:120px" value="${m.anchorFrom ?? ''}" placeholder="от">
        <span>–</span><input id="mTo" type="number" min="0" step="any" style="width:120px" value="${m.anchorTo ?? ''}" placeholder="до">
        <input id="mCur" value="${esc(m.currency)}" maxlength="3" style="width:64px" aria-label="Валюта">
        <select id="mPer" style="width:auto" aria-label="Период">${Object.entries(MONEY_PERIODS).map(([k, l]) => `<option value="${k}" ${m.period === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="mForm" style="width:auto" aria-label="Форма">${MONEY_FORMS.map((f) => `<option ${m.form === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <span class="lbl">В формах</span>
      <div class="mono">${moneyData.anchor ? esc(moneyData.anchor) : '<span class="muted">заполни якорь</span>'}</div>
      <label for="mAlt">Альтернатива</label>
      <div><input id="mAlt" value="${esc(m.alternative || '')}" placeholder="Что будет, если не договоримся: текущий проект, другой процесс…"></div>
      <label for="mLimit">Граница — знаешь только ты</label>
      <div class="row"><input id="mLimit" type="number" min="0" step="any" style="width:160px" value="${moneyData.limit ?? ''}" placeholder="ниже — отказ">
        <span class="hint" style="margin:0">web/data/limit.json — не попадает в базу знаний и промпты</span></div>
    </div>
    ${moneyData.warnings.length ? `<div class="banner warn" style="margin-top:12px">${moneyData.warnings.map((w) => `<p style="margin:0">⚠ ${esc(w)}</p>`).join('')}</div>` : ''}
    <details style="margin-top:12px" ${pk.a || pk.b ? 'open' : ''}><summary><strong>Два пакета (MESO)</strong> <span class="muted small">— равноценные для тебя варианты, чтобы предложить выбор</span></summary>
      <div class="pkgs">${pkg('a', 'Пакет A')}${pkg('b', 'Пакет B')}</div></details>
    <details style="margin-top:8px" ${m.phrase ? 'open' : ''}><summary><strong>Фраза для рекрутера</strong> <span class="muted small">— из частей, якорь подставляется сам</span></summary>
      <div class="pf-grid" style="margin-top:8px">${PHRASE_PARTS.map(([k, l, ph]) => `<label for="mp_${k}">${l}</label>
        <div><input id="mp_${k}" data-phrase="${k}" value="${esc(m.phrase?.[k] || '')}" placeholder="${esc(ph)}"></div>`).join('')}</div>
      <div class="phrase-out" id="mPhrase">${esc(phraseText({ ...m, anchor: moneyData.anchor })) || '<span class="muted">Заполни части — фраза соберётся здесь.</span>'}</div>
      <div class="row"><button type="button" class="small" id="mPhraseCopy">Скопировать</button>
        <span class="hint" style="margin:0">Пиши своими словами, по-английски; проговори вслух до звонка.</span></div></details>
    <div class="row" style="margin-top:14px"><button type="submit" class="primary" id="mSave">Сохранить</button><span class="hint" style="margin:0" id="mMsg"></span></div>
    <p class="error" id="mErr"></p>
  </form>`;
}

function bindMoney() {
  const form = $('#moneyForm');
  if (!form) return;
  const collect = () => {
    const packages = {};
    form.querySelectorAll('[data-pkg]').forEach((i) => { const [k, f] = i.dataset.pkg.split('.'); (packages[k] = packages[k] || {})[f] = i.value.trim(); });
    const phrase = Object.fromEntries([...form.querySelectorAll('[data-phrase]')].map((i) => [i.dataset.phrase, i.value.trim()]));
    return { target: $('#mTarget').value, sources: $('#mSources').value, anchorFrom: $('#mFrom').value, anchorTo: $('#mTo').value,
      currency: $('#mCur').value, period: $('#mPer').value, form: $('#mForm').value, alternative: $('#mAlt').value, limit: $('#mLimit').value, packages, phrase };
  };
  form.querySelectorAll('[data-phrase]').forEach((i) => i.addEventListener('input', () => {
    const t = phraseText({ phrase: collect().phrase, anchor: moneyData.anchor });
    $('#mPhrase').textContent = t;
  }));
  $('#mPhraseCopy').addEventListener('click', async (e) => {
    const ok = await copyText($('#mPhrase').textContent);
    e.target.textContent = ok ? 'Скопировано ✓' : 'Не удалось';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#mSave').disabled = true;
    try {
      moneyData = await api('/api/money', { method: 'PUT', body: collect() });
      const answers = (await api('/api/profile-answers')).text;   // якорь записан в Salary expectations
      const open = [...form.querySelectorAll('details')].map((d) => d.open);
      form.outerHTML = moneyCard();
      bindMoney();
      $('#moneyForm').querySelectorAll('details').forEach((d, i) => { d.open = open[i]; });
      $('#mMsg').textContent = moneyData.anchor ? 'Сохранено ✓ · якорь в «Стандартных ответах»' : 'Сохранено ✓';
      if ($('#profileText')) $('#profileText').value = answers;
    } catch (err) { $('#mErr').textContent = err.message; $('#mSave').disabled = false; }
  });
}

// Чеклист «перед тем как сказать да» — на заявке со статусом «Оффер»
function offerBlock(d) {
  if (d.status !== 'offer' && d.stage !== 'offer') return '';
  const c = d.offerChecklist || {};
  const done = OFFER_CHECKS.filter(([k]) => c[k]).length;
  return `<div class="card" id="offerCard"><h2><span class="n">✓</span>Перед тем как сказать «да» <span class="muted" style="font-weight:500">· ${done}/${OFFER_CHECKS.length}</span></h2>
    <div class="checks col">${OFFER_CHECKS.map(([k, l]) => `<label class="ck"><input type="checkbox" data-offer="${k}" ${c[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <p class="muted small" style="margin:8px 0 0">Цель, якорь и пакеты — <a href="#/profile">Профиль → Деньги</a>.${done < OFFER_CHECKS.length ? ' Не отвечай «да» на звонке — попроси оффер письменно.' : ''}</p></div>`;
}

function bindOffer(d) {
  document.querySelectorAll('[data-offer]').forEach((b) => b.addEventListener('change', async () => {
    const offerChecklist = Object.fromEntries([...document.querySelectorAll('[data-offer]')].map((x) => [x.dataset.offer, x.checked]));
    d.offerChecklist = offerChecklist;
    try { await api(`/api/vacancies/${enc(d.name)}`, { method: 'PATCH', body: { offerChecklist } }); } catch (e) { alert(e.message); }
    $('#offerCard').outerHTML = offerBlock(d);
    bindOffer(d);
  }));
}

const salaryWarn = (x) => {
  const sm = x?.salaryMismatch;
  if (!sm) return '';
  return sm.kind === 'check' ? `проверь сам: ${sm.why}; якорь ${sm.anchor}` : `в форме названо иначе, чем якорь (${sm.anchor})`;
};

// «Моя неделя» — над статистикой: план и факт по своим действиям
async function loadWeek() {
  const box = $('#weekCard');
  if (!box) return;
  let w;
  try { w = await api('/api/week'); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  renderWeek(w);
}

function renderWeek(w) {
  const box = $('#weekCard');
  if (!box) return;
  const c = w.current;
  const friday = new Date().getDay() === 5 || new Date().getDay() === 6 || new Date().getDay() === 0;
  const row = (k, label, hint) => {
    const f = c.fact[k], p = c.plan[k];
    return `<div class="wk-row"><span class="wk-l">${label}<span class="muted small">${hint}</span></span>
      <span class="fn-bar"><span style="width:${p ? Math.min(100, (f / p) * 100) : 0}%" class="${f >= p ? 'ok' : ''}"></span></span>
      <span class="mono">${f} / <input type="number" min="0" max="50" data-wplan="${k}" value="${p}" aria-label="План: ${label}"></span></div>`;
  };
  const prev = w.previous;
  box.innerHTML = `<h3 class="st-h">Моя неделя <span class="muted small">· с ${fmtDay(c.week)} · меряю действия, а не офферы</span></h3>
    ${row('bets', 'Хорошие ставки', ' — отправлено с фитом 7+ и вердиктом не «нет»')}
    ${row('messages', 'Сообщения контактам', ' — «написал» в целевых компаниях')}
    ${row('practice', 'Тренировки', ' — попытки в тренажёре собеседования')}
    ${c.sentAll > c.fact.bets ? `<p class="muted small" style="margin:6px 0 0">Ещё отправлено ${c.sentAll - c.fact.bets} — с фитом ниже 7 или вердиктом «нет».</p>` : ''}
    <p class="muted small" style="margin:6px 0 0">Прошлая неделя: ставки ${prev.fact.bets}, сообщения ${prev.fact.messages}, тренировки ${prev.fact.practice}.</p>
    <div class="row" style="margin-top:8px">${c.reviewedAt ? `<span class="chip good">Обзор недели сделан ${fmtDay(c.reviewedAt)}</span>`
      : `<button type="button" class="small ${friday ? 'primary' : ''}" id="wkReview">Обзор трекера сделан</button>
         <span class="hint" style="margin:0">В пятницу: что сработало, на что не отвечают, план на следующую неделю.</span>`}</div>`;
  box.querySelectorAll('[data-wplan]').forEach((i) => i.addEventListener('change', async () => {
    const plan = { [i.dataset.wplan]: i.value };
    renderWeek({ ...w, current: (await api('/api/week', { method: 'PUT', body: { plan } })).current });
  }));
  $('#wkReview')?.addEventListener('click', async () => {
    renderWeek({ ...w, current: (await api('/api/week', { method: 'PUT', body: { reviewed: true } })).current });
  });
}

// ---------- уведомления (C3, docs/specs/10-notifications.md) ----------
// Колокольчик опрашивает сервер раз в 15 с. Системное уведомление — только если вкладка в фоне,
// браузер разрешил и ты включил их кнопкой (разрешение не запрашиваем при загрузке).

const EVENT_ICONS = { job_done: '✓', job_error: '!', strong_fit: '★', follow_up: '↻', no_reply: '⌛', feed: '+', week: '▦', budget: '$' };
let bell = { events: [], unread: 0, lastId: 0, primed: false };
const notifyOn = () => { try { return localStorage.getItem('cvc-notify') === 'on'; } catch { return false; } };
const canNotify = () => typeof Notification !== 'undefined';

async function pollEvents() {
  let r;
  try { r = await api(`/api/events?limit=40`); } catch { return; }
  const fresh = r.events.filter((e) => e.id > bell.lastId);
  if (bell.primed && fresh.length && document.hidden && notifyOn() && canNotify() && Notification.permission === 'granted') {
    fresh.slice(0, 3).reverse().forEach((e) => {
      const n = new Notification(e.title, { body: e.text, tag: String(e.id) });
      n.onclick = () => { window.focus(); location.hash = e.link; markEventsRead([e.id]); n.close(); };
    });
  }
  bell = { events: r.events, unread: r.unread, lastId: Math.max(bell.lastId, r.lastId), primed: true };
  renderBell();
}

function renderBell() {
  const badge = $('#bellBadge');
  if (!badge) return;
  badge.textContent = bell.unread > 9 ? '9+' : String(bell.unread);
  badge.classList.toggle('hidden', !bell.unread);
  if (!$('#bellPanel').classList.contains('hidden')) renderBellPanel();
}

function renderBellPanel() {
  const perm = canNotify() ? Notification.permission : 'unsupported';
  const notifyCtl = perm === 'unsupported' ? '<span class="muted small">Браузер не поддерживает системные уведомления</span>'
    : perm === 'denied' ? '<span class="muted small">Системные уведомления запрещены в браузере</span>'
      : notifyOn() && perm === 'granted' ? '<button type="button" class="link-btn inline" id="notifyOff">Выключить системные уведомления</button>'
        : '<button type="button" class="link-btn inline" id="notifyOn">Включить системные уведомления</button>';
  $('#bellPanel').innerHTML = `<div class="bp-head"><strong>Уведомления</strong>
      ${bell.unread ? '<button type="button" class="link-btn inline" id="readAll">Прочитать все</button>' : ''}</div>
    <div class="bp-list">${bell.events.length ? bell.events.map((e) => `<a href="${esc(e.link)}" class="bp-item ${e.read ? '' : 'unread'}" data-ev="${e.id}">
        <span class="bp-ic ${e.type}" aria-hidden="true">${EVENT_ICONS[e.type] || '•'}</span>
        <span class="bp-body"><span class="bp-title">${esc(e.title)}</span>${e.text ? `<span class="bp-text">${esc(e.text)}</span>` : ''}
          <span class="bp-time">${new Date(e.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></span></a>`).join('')
      : '<p class="muted small" style="margin:12px">Пока пусто. Здесь появятся завершённые задачи агента, сильные фиты и заявки, ушедшие в «Без ответа».</p>'}</div>
    <div class="bp-foot">${notifyCtl}</div>`;
  $('#readAll')?.addEventListener('click', () => markEventsRead(null, true));
  $('#notifyOn')?.addEventListener('click', async () => {
    const p = await Notification.requestPermission();
    try { localStorage.setItem('cvc-notify', p === 'granted' ? 'on' : 'off'); } catch {}
    if (p === 'granted') new Notification('Уведомления включены', { body: 'Сообщу, когда агент закончит, даже если вкладка в фоне.' });
    renderBellPanel();
  });
  $('#notifyOff')?.addEventListener('click', () => { try { localStorage.setItem('cvc-notify', 'off'); } catch {} renderBellPanel(); });
  document.querySelectorAll('.bp-item').forEach((a) => a.addEventListener('click', () => {
    markEventsRead([Number(a.dataset.ev)]);
    toggleBell(false);
  }));
}

async function markEventsRead(ids, all = false) {
  try { await api('/api/events/read', { method: 'POST', body: all ? { all: true } : { ids } }); } catch { return; }
  bell.events.forEach((e) => { if (all || ids.includes(e.id)) e.read = true; });
  bell.unread = bell.events.filter((e) => !e.read).length;
  renderBell();
}

function toggleBell(open) {
  const panel = $('#bellPanel');
  const show = open ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  $('#bellBtn').setAttribute('aria-expanded', String(show));
  if (show) renderBellPanel();
}

$('#bellBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.bell-wrap')) toggleBell(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleBell(false); });
pollEvents();
setInterval(pollEvents, 15000);

// ---------- каталог сайтов вакансий (C5, docs/specs/16-job-sites.md) ----------

let jobSites = null;
let siteEdit = null; // id сайта в режиме правки или 'new'
let sitesShowHidden = false;
const LAST_SITE_KEY = 'cvc-last-site';
const LAST_SITE_TTL = 3 * 60 * 60 * 1000; // «сразу после клика» — в пределах 3 часов

const siteStale = (s) => !s.lastVisit || Date.now() - Date.parse(s.lastVisit) > jobSites.staleDays * DAY_MS;

function lastSite() {
  try {
    const v = JSON.parse(sessionStorage.getItem(LAST_SITE_KEY) || 'null');
    return v && Date.now() - v.at < LAST_SITE_TTL ? v.id : '';
  } catch { return ''; }
}

function siteForm(s) {
  const v = s || { name: '', url: '', note: '', login: false };
  return `<form class="ncard site-tile site-form" data-sform="${s ? esc(s.id) : 'new'}">
    <div class="form-grid">
      <label>Название</label><input name="name" value="${esc(v.name)}" required maxlength="60">
      <label>Ссылка</label><input name="url" type="url" value="${esc(v.url)}" placeholder="https://…" required>
      <label>Зачем</label><input name="note" value="${esc(v.note || '')}" maxlength="160" placeholder="Одна строка: что здесь искать">
      <span class="lbl"></span><label class="check"><input type="checkbox" name="login" ${v.login ? 'checked' : ''}> нужен вход</label>
    </div>
    <p class="error" data-serr></p>
    <div class="two"><button type="submit" class="btn primary small-btn">Сохранить</button>
      <button type="button" class="btn ghost small-btn" data-scancel>Отмена</button></div>
  </form>`;
}

function siteTile(s) {
  if (siteEdit === s.id) return siteForm(s);
  const stale = siteStale(s);
  return `<article class="ncard site-tile ${stale ? 'stale' : ''} ${s.hidden ? 'is-hidden' : ''}">
    <a class="site-link" href="${esc(s.url)}" target="_blank" rel="noopener" data-visit="${esc(s.id)}">${esc(s.name)} <span aria-hidden="true">↗</span></a>
    ${s.note ? `<p class="muted small" style="margin:0">${esc(s.note)}</p>` : ''}
    <div class="chips" style="margin:0">
      <span class="pill ${stale ? 'warn' : 'neutral'}">${s.lastVisit ? `смотрел ${ago(s.lastVisit)}` : 'ещё не смотрел'}</span>
      ${s.login ? '<span class="pill neutral">нужен вход</span>' : ''}
      ${s.hidden ? '<span class="pill neutral">скрыт</span>' : ''}
    </div>
    <div class="site-actions">
      <button type="button" class="link-btn inline" data-sedit="${esc(s.id)}">Изменить</button>
      <button type="button" class="link-btn inline" data-shide="${esc(s.id)}">${s.hidden ? 'Вернуть' : 'Скрыть'}</button>
      ${s.custom ? `<button type="button" class="link-btn inline danger" data-sdel="${esc(s.id)}">Удалить</button>` : ''}
    </div>
  </article>`;
}

function sitesHtml() {
  if (!jobSites) return '<div class="empty"><span class="spin"></span>Загружаю сайты…</div>';
  const visible = jobSites.sites.filter((s) => !s.hidden);
  const hidden = jobSites.sites.length - visible.length;
  const stale = visible.filter(siteStale).length;
  const shown = sitesShowHidden ? jobSites.sites : visible;
  const groups = Object.entries(jobSites.groups).map(([g, label]) => {
    const list = shown.filter((s) => s.group === g);
    const add = g === 'custom' && siteEdit === 'new' ? siteForm(null) : '';
    if (!list.length && !add) return '';
    return `<section class="sites-group"><h3 class="st-h">${esc(label)} <span class="muted">· ${list.length}</span></h3>
      <div class="cards sites-grid">${add}${list.map(siteTile).join('')}</div></section>`;
  }).join('');
  return `<div class="edtech-head sites-head">
      <div><p class="muted small" style="margin:0">Площадки с логином приложение не обходит — открывай их здесь, в новой вкладке, где ты уже вошёл.
        Подсвечены сайты, которые не открывал больше ${jobSites.staleDays} дней.</p>
        <p style="margin:6px 0 0"><strong>${visible.length} сайтов</strong> · давно не смотрел: <strong class="${stale ? 'warn-text' : ''}">${stale}</strong></p></div>
      <div class="two"><button type="button" class="btn primary" id="siteFoundAdd">Добавить найденную вакансию</button>
        <button type="button" class="btn ghost" id="siteNew">+ Свой сайт</button></div>
    </div>
    ${groups}
    ${hidden ? `<label class="check muted small" style="align-self:flex-start"><input type="checkbox" id="sitesShowHidden" ${sitesShowHidden ? 'checked' : ''}> показать скрытые (${hidden})</label>` : ''}`;
}

function renderSites() {
  const box = $('#sitesBox');
  if (!box) return;
  box.innerHTML = sitesHtml();
  const tab = $('#feedView [data-ftab="sites"]');
  if (tab && jobSites) tab.textContent = `Сайты · ${jobSites.sites.filter((s) => !s.hidden).length}`;
  bindSites();
}

async function reloadSites() {
  try { jobSites = await api('/api/job-sites'); } catch (e) { alert(e.message); }
  renderSites();
}

function bindSites() {
  const box = $('#sitesBox');
  if (!box || !jobSites) return;
  const markVisit = async (id) => {
    try { sessionStorage.setItem(LAST_SITE_KEY, JSON.stringify({ id, at: Date.now() })); } catch {}
    try {
      const r = await api(`/api/job-sites/${enc(id)}/visit`, { method: 'POST' });
      const s = jobSites.sites.find((x) => x.id === id);
      if (s) s.lastVisit = r.at;
      renderSites();
    } catch {}
  };
  box.querySelectorAll('[data-visit]').forEach((a) => {
    a.addEventListener('click', () => markVisit(a.dataset.visit));
    a.addEventListener('auxclick', (e) => { if (e.button === 1) markVisit(a.dataset.visit); });
  });
  $('#siteFoundAdd')?.addEventListener('click', () => openAddDialog(lastSite()));
  $('#siteNew')?.addEventListener('click', () => { siteEdit = 'new'; renderSites(); box.querySelector('[data-sform="new"] input')?.focus(); });
  $('#sitesShowHidden')?.addEventListener('change', (e) => { sitesShowHidden = e.target.checked; renderSites(); });
  box.querySelectorAll('[data-sedit]').forEach((b) => b.addEventListener('click', () => { siteEdit = b.dataset.sedit; renderSites(); }));
  box.querySelectorAll('[data-scancel]').forEach((b) => b.addEventListener('click', () => { siteEdit = null; renderSites(); }));
  box.querySelectorAll('[data-shide]').forEach((b) => b.addEventListener('click', async () => {
    const s = jobSites.sites.find((x) => x.id === b.dataset.shide);
    try { await api(`/api/job-sites/${enc(s.id)}`, { method: 'PATCH', body: { hidden: !s.hidden } }); } catch (e) { alert(e.message); }
    reloadSites();
  }));
  box.querySelectorAll('[data-sdel]').forEach((b) => b.addEventListener('click', async () => {
    const s = jobSites.sites.find((x) => x.id === b.dataset.sdel);
    if (!confirm(`Удалить «${s.name}» из каталога?`)) return;
    try { await api(`/api/job-sites/${enc(s.id)}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
    reloadSites();
  }));
  box.querySelectorAll('[data-sform]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: f.elements.name.value, url: f.elements.url.value, note: f.elements.note.value, login: f.elements.login.checked };
    const id = f.dataset.sform;
    try {
      await api(id === 'new' ? '/api/job-sites' : `/api/job-sites/${enc(id)}`, { method: id === 'new' ? 'POST' : 'PATCH', body });
      siteEdit = null;
      reloadSites();
    } catch (err) { f.querySelector('[data-serr]').textContent = err.message; }
  }));
}

// Отраслевой раздел: роли «обучение клиентов» (S7) первыми, дальше свежие
function sortSectorList(list) {
  return list.sort((a, b) => (b.role_group === 'edu') - (a.role_group === 'edu') || (b.posted || '').localeCompare(a.posted || ''));
}

// Первый route() — в конце master-view.js, когда загружены все экраны
