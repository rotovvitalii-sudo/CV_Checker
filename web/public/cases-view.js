// ---------- база кейсов (C9, docs/specs/20-case-base.md) ----------
// #/cases[/letters|/suggestions|/gaps] — списки; #/cases/card/<id> — карточка;
// #/cases/new[?target=<id>] — новый кейс или дополнение; #/cases/draft/<id> — черновик (раунды агента).

let casesData = null;
let casesQuery = '';
let casesStatus = '';
let caseDraftTimer = null;

const CASE_STATUS = { complete: ['good', 'готово'], 'needs-facts': ['warn', 'нужны факты'] };
const casePill = (st) => {
  const [tone, label] = CASE_STATUS[st] || ['neutral', st || '—'];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
};
const CASE_TABS = [['', 'Карточки'], ['letters', 'Надиктовки писем'], ['insights', 'Инсайты'], ['suggestions', 'Предложено добавить'], ['gaps', 'Пробелы']];

async function loadCases(r) {
  clearTimeout(caseDraftTimer);
  const sub = r.sub || '';
  const root = $('#casesView');
  if (sub.startsWith('card/')) return renderCaseCard(sub.slice(5));
  if (sub.startsWith('draft/')) return renderCaseDraft(sub.slice(6));
  if (sub === 'new') return renderCaseNew(r.params.target || '');
  if (!casesData) root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Читаю базу кейсов…</div></div>';
  if (sub === 'insights') { try { insightsData = await api('/api/insights'); } catch { insightsData = null; } }
  try { casesData = await api('/api/cases'); } catch (e) {
    root.innerHTML = `<div class="page-wrap"><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  renderCasesList(sub);
}

function casesHead(d) {
  const ready = d.cards.filter((c) => c.status === 'complete').length;
  return `<section class="home-head">
      <div><h1>База кейсов</h1>
        <p class="lead">${d.cards.length} ${plural(d.cards.length, ['карточка', 'карточки', 'карточек'])} · готово ${ready} · нужны факты ${d.cards.length - ready}.
          Фит, CV и письма берут факты только отсюда.</p></div>
      <a class="btn primary" href="#/cases/new">+ Новый кейс</a>
    </section>`;
}

function renderCasesList(sub) {
  const d = casesData;
  const counts = { '': d.cards.length, letters: d.letters.length, insights: d.insightsCount ?? 0, suggestions: d.suggestions.length, gaps: d.gaps.top.length };
  const drafts = d.drafts.length ? `<section class="case-drafts">
      <h3 class="st-h">Черновики кейсов</h3>
      ${d.drafts.map((x) => `<a class="case-draft-row" href="#/cases/draft/${enc(x.id)}">
        <span>${esc(x.summary || (x.dictation || '').slice(0, 90) || 'кейс')}${x.target ? ` <span class="muted">· дополнение к ${esc(x.target)}</span>` : ''}</span>
        <span class="pill ${['error1', 'error2'].includes(x.state) ? 'bad' : x.state === 'answers' ? 'warn' : 'neutral'}">${{ round1: 'агент разбирает', round2: 'агент собирает карточку', answers: 'ждёт ответов', error1: 'ошибка', error2: 'ошибка' }[x.state] || x.state}</span></a>`).join('')}
    </section>` : '';
  const body = { '': casesCardsHtml, letters: casesLettersHtml, insights: insightsHtml, suggestions: casesSuggestionsHtml, gaps: casesGapsHtml }[sub] || casesCardsHtml;
  $('#casesView').innerHTML = `<div class="page-wrap">
    ${casesHead(d)}
    ${drafts}
    <section class="stack">
      <div class="seg" role="group" aria-label="Раздел базы кейсов">
        ${CASE_TABS.map(([k, l]) => `<button type="button" data-ctab="${k}" aria-pressed="${sub === k}">${l} · ${counts[k]}</button>`).join('')}
      </div>
      <div id="casesBody">${body(d)}</div>
    </section>
  </div>`;
  bindCasesList(sub);
  if (sub === 'insights') bindInsights();
}

function casesCardsHtml(d) {
  const q = casesQuery.toLowerCase();
  const list = d.cards.filter((c) => (!casesStatus || c.status === casesStatus)
    && (!q || [c.id, c.company, c.role, c.period, c.product, ...c.roleFit].join(' ').toLowerCase().includes(q)));
  const rows = list.map((c) => `<tr class="clickable" data-card="${esc(c.id)}">
      <td><a href="#/cases/card/${enc(c.id)}" class="row-link">${esc(c.company)}</a><div class="muted small">${esc(c.id)}${c.inIndex ? '' : ' · <span class="warn-text">нет в реестре</span>'}</div></td>
      <td>${esc(c.role)}</td>
      <td class="small">${esc(c.period)}</td>
      <td>${casePill(c.status)}${c.gaps ? `<div class="muted small">пробелов: ${c.gaps}</div>` : ''}${c.additions ? `<div class="muted small">дополнений: ${c.additions}</div>` : ''}</td>
      <td><div class="chips" style="margin:0">${c.roleFit.slice(0, 5).map((r) => `<span class="kchip">${esc(r)}</span>`).join('')}</div></td>
    </tr>`).join('');
  return `<div class="cases-filters">
      <input type="search" id="casesSearch" placeholder="Поиск: компания, роль, тема" value="${esc(casesQuery)}">
      <div class="seg small-seg" role="group" aria-label="Готовность">
        ${[['', 'все'], ['complete', 'готово'], ['needs-facts', 'нужны факты']].map(([k, l]) => `<button type="button" data-cstatus="${k}" aria-pressed="${casesStatus === k}">${l}</button>`).join('')}
      </div>
    </div>
    ${list.length ? `<div class="table-box"><table class="apps cases-table">
      <thead><tr><th>Компания</th><th>Роль</th><th>Период</th><th>Готовность</th><th>Для каких ролей</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<div class="table-box empty-box">Ничего не найдено.</div>'}`;
}

function casesLettersHtml(d) {
  const j = d.scanJob;
  const busy = j && ['running', 'queued'].includes(j.state);
  const rows = d.letters.map((l) => `<tr>
      <td class="mono small">${esc(l.date)}</td>
      <td>${l.vacancy ? `<a href="#/v/${enc(l.vacancy)}" class="row-link">${esc(l.vacancy)}</a>` : `<span class="muted">${esc(l.topic)}</span>`}</td>
      <td class="mono">${l.words}</td>
      <td><button type="button" class="small" data-raw="${esc(l.file)}">Текст</button></td>
    </tr>`).join('');
  const v = d.voice || {};
  const vbusy = v.job && ['running', 'queued'].includes(v.job.state);
  const voiceBox = `<section class="card voice-card">
      <div class="row" style="justify-content:space-between"><div><strong>Голосовой профиль</strong>
        <span class="muted small">${v.exists ? `· собран ${esc(v.built || '')} · ${v.newRaw ? `<span class="warn-text">новых надиктовок после сборки: ${v.newRaw}</span>` : 'актуален'}`
          : '· ещё не собран — «Сгенерировать письмо» читает все надиктовки каждый раз'}</span></div>
        <span class="row">${v.exists ? '<button type="button" class="small" id="voiceShow">Посмотреть</button>' : ''}
          <button type="button" class="small ${!v.exists || v.newRaw ? 'primary' : ''}" id="voiceBuild" ${vbusy ? 'disabled' : ''}>${v.exists ? 'Обновить профиль' : 'Собрать профиль'}</button></span></div>
      <p class="muted small" style="margin:6px 0 0">Агент один раз читает все ${v.raw ?? ''} надиктовок и выписывает манеру: заход, порядок мысли, твои обороты, запреты — без фактов.
        Дальше генерация письма читает только профиль. ≈ $0.5–1 за сборку.</p>
      ${vbusy || v.job?.state === 'error' ? `<div class="running">${vbusy ? '<span class="spin"></span>Агент читает надиктовки…' : `<span class="error">Ошибка: ${esc(v.job.error)}</span>`}</div><div class="feed" data-feed="${v.job.id}"></div>` : ''}
      <pre class="voice-text hidden" id="voiceText"></pre>
    </section>`;
  return `${voiceBox}<div class="edtech-head">
      <div><p class="muted small" style="margin:0">Твои надиктовки сопроводительных писем. Это образец голоса для «Сгенерировать письмо» (C8).
        Факты из них, которых нет в карточках, попадают в «Предложено добавить» — после каждого письма из надиктовки.</p></div>
      <button type="button" class="btn ghost" id="casesScan" ${busy ? 'disabled' : ''}>Найти новые факты в надиктовках</button>
    </div>
    ${busy || j?.state === 'error' ? `<div class="running">${busy ? '<span class="spin"></span>Агент читает надиктовки…' : `<span class="error">Ошибка: ${esc(j.error)}</span>`}</div><div class="feed" data-feed="${j.id}"></div>` : ''}
    <p class="muted small" style="margin:0">Один прогон агента по всем надиктовкам, ≈ $0.5–1. Карточки он не меняет — только предлагает.</p>
    ${d.letters.length ? `<div class="table-box"><table class="apps">
      <thead><tr><th>Дата</th><th>Вакансия</th><th>Слов</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="table-box empty-box">Надиктовок писем пока нет.</div>'}`;
}

function cardOptions(d, selected) {
  return `<option value="">— выбери карточку</option>${d.cards.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.company)} · ${esc(c.id)}</option>`).join('')}`;
}

function casesSuggestionsHtml(d) {
  if (!d.suggestions.length) {
    return `<div class="table-box empty-box">Новых предложений нет${d.suggestionsDone ? ` — разобрано ${d.suggestionsDone}` : ''}.
      Они появляются после писем из надиктовки или по кнопке «Найти новые факты» во вкладке «Надиктовки писем».</div>`;
  }
  return `<p class="muted small" style="margin:0">Факты, которые ты назвал в надиктовках, но которых нет в карточках. Пока не добавишь — агенты их не используют.
      «Добавить» дописывает факт в раздел карточки «Дополнения из надиктовок» со ссылкой на надиктовку.</p>
    <div class="sug-list">${d.suggestions.map((s) => `<article class="ncard sug" data-sug="${esc(s.id)}">
      <p class="sug-fact"><strong>${esc(s.fact)}</strong></p>
      ${s.quote ? `<blockquote class="sug-quote">«${esc(s.quote)}»</blockquote>` : ''}
      <p class="muted small" style="margin:0">${s.source ? `<button type="button" class="link-btn inline" data-raw="${esc(s.source)}">${esc(s.source)}</button>` : ''}
        ${s.vacancy ? ` · письмо для <a href="#/v/${enc(s.vacancy)}">${esc(s.vacancy)}</a>` : ''}</p>
      <div class="row sug-actions">
        <label class="sr-only" for="sc-${esc(s.id)}">Карточка</label>
        <select id="sc-${esc(s.id)}" data-sugcard="${esc(s.id)}">${cardOptions(d, s.card)}</select>
        <button type="button" class="primary small" data-sugadd="${esc(s.id)}">Добавить в карточку</button>
        <button type="button" class="small" data-sugnew="${esc(s.id)}">Начать новый кейс</button>
        <button type="button" class="small" data-sugrej="${esc(s.id)}">Отклонить</button>
      </div>
      <p class="error" data-sugerr></p>
    </article>`).join('')}</div>`;
}

function casesGapsHtml(d) {
  const g = d.gaps;
  if (!g.top.length) return '<div class="table-box empty-box">Пробелов нет — или ещё нет вакансий с извлечёнными ключевыми словами.</div>';
  return `<p class="muted small" style="margin:0">Ключевые требования вакансий (кроме архива), которых нет в Master CV, — по частоте среди ${g.vacancies} вакансий.
      Если такой опыт был — надиктуй кейс, и фит, CV и письма смогут на него опереться.</p>
    <div class="table-box"><table class="apps">
      <thead><tr><th>Требование</th><th>Вакансий</th><th>Где</th><th></th></tr></thead>
      <tbody>${g.top.map((x) => `<tr>
        <td><strong>${esc(x.keyword.split('|')[0])}</strong></td>
        <td class="mono">${x.n}</td>
        <td class="small">${x.vacancies.slice(0, 3).map((v) => `<a href="#/v/${enc(v)}">${esc(v)}</a>`).join(', ')}${x.vacancies.length > 3 ? ` <span class="muted">+${x.vacancies.length - 3}</span>` : ''}</td>
        <td><button type="button" class="small" data-gapnew="${esc(x.keyword.split('|')[0])}">Надиктовать кейс</button></td>
      </tr>`).join('')}</tbody></table></div>`;
}

async function showRaw(file) {
  const dlg = $('#docDialog');
  $('#docTitle').textContent = file;
  $('#docBody').innerHTML = '<p class="muted">Загрузка…</p>';
  dlg.showModal();
  try {
    const r = await api(`/api/cases/raw/${enc(file)}`);
    $('#docBody').innerHTML = `${r.fm.topic ? `<p class="muted">${esc(r.fm.topic)}</p>` : ''}<p class="raw-text">${esc(r.text)}</p>`;
  } catch (e) { $('#docBody').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function startNewCaseWith(text) {
  try { await api('/api/cases/new-dictation', { method: 'PUT', body: { text } }); } catch {}
  location.hash = '#/cases/new';
}

function bindCasesList(sub) {
  const root = $('#casesView');
  root.querySelectorAll('[data-ctab]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.ctab ? `#/cases/${b.dataset.ctab}` : '#/cases'; }));
  root.querySelectorAll('[data-raw]').forEach((b) => b.addEventListener('click', () => showRaw(b.dataset.raw)));
  const rerender = () => { $('#casesBody').innerHTML = casesCardsHtml(casesData); bindCasesList(sub); };
  $('#casesSearch')?.addEventListener('input', (e) => {
    casesQuery = e.target.value;
    const pos = e.target.selectionStart;
    rerender();
    const el = $('#casesSearch'); el.focus(); el.setSelectionRange(pos, pos);
  });
  root.querySelectorAll('[data-cstatus]').forEach((b) => b.addEventListener('click', () => { casesStatus = b.dataset.cstatus; rerender(); }));
  root.querySelectorAll('tr[data-card]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    location.hash = `#/cases/card/${enc(tr.dataset.card)}`;
  }));
  $('#casesScan')?.addEventListener('click', async (e) => {
    if (!confirm('Запустить агента? Он прочитает все надиктовки писем и предложит факты, которых нет в карточках. ≈ $0.5–1.')) return;
    e.target.disabled = true;
    try { await api('/api/cases/scan-letters', { method: 'POST' }); } catch (err) { alert(err.message); }
    loadCases(currentRoute());
  });
  $('#voiceBuild')?.addEventListener('click', async (e) => {
    if (!confirm('Собрать голосовой профиль? Агент прочитает все надиктовки, ≈ $0.5–1.')) return;
    e.target.disabled = true;
    try { await api('/api/voice', { method: 'POST' }); } catch (err) { alert(err.message); }
    loadCases(currentRoute());
  });
  $('#voiceShow')?.addEventListener('click', async () => {
    const box = $('#voiceText');
    if (box.classList.toggle('hidden')) return;
    box.textContent = await (await fetch('/api/voice/text')).text();
  });
  const vj = casesData.voice?.job;
  if (sub === 'letters' && vj && ['running', 'queued'].includes(vj.state)) {
    attachFeed(vj);
    caseDraftTimer = setTimeout(() => { if (currentRoute().view === 'cases') loadCases(currentRoute()); }, 5000);
  }
  const j = casesData.scanJob;
  if (sub === 'letters' && j && ['running', 'queued'].includes(j.state)) {
    attachFeed(j);
    caseDraftTimer = setTimeout(() => { if (currentRoute().view === 'cases') loadCases(currentRoute()); }, 5000);
  }
  root.querySelectorAll('[data-sugadd]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.sugadd;
    const card = root.querySelector(`[data-sugcard="${id}"]`).value;
    const box = b.closest('.sug');
    try {
      const r = await api(`/api/cases/suggestions/${enc(id)}/accept`, { method: 'POST', body: { card } });
      flash(`Факт добавлен в карточку ${r.card}.`);
      loadCases(currentRoute());
    } catch (err) { box.querySelector('[data-sugerr]').textContent = err.message; }
  }));
  root.querySelectorAll('[data-sugrej]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/cases/suggestions/${enc(b.dataset.sugrej)}/reject`, { method: 'POST' }); } catch (err) { alert(err.message); }
    loadCases(currentRoute());
  }));
  root.querySelectorAll('[data-sugnew]').forEach((b) => b.addEventListener('click', () => {
    const s = casesData.suggestions.find((x) => x.id === b.dataset.sugnew);
    startNewCaseWith(`${s.fact}${s.quote ? `\n\nКак я говорил в письме: «${s.quote}»` : ''}\n\n`);
  }));
  root.querySelectorAll('[data-gapnew]').forEach((b) => b.addEventListener('click', () => {
    startNewCaseWith(`Кейс про «${b.dataset.gapnew}»: `);
  }));
}

// ---------- инсайты (C12, docs/specs/34-insights-base.md) ----------

let insightsData = null;
let insightForm = false;     // форма «+ Инсайт» открыта
let insightEdit = null;      // id инсайта в режиме правки
let insightQuery = '';
let insightTag = '';
let insightSrc = '';
const WHERE_LABELS = { interview: 'подготовка к интервью', answers: 'ответы формы', letter: 'письмо', 'cv-report': 'отчёт CV' };

function insightSourceLine(i, types) {
  const s = i.source || {};
  return `${esc(types[s.type] || s.type || '')}${s.title ? `: ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}` : s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">ссылка</a>` : ''} · ${esc(s.date || i.created || '')}`;
}

function insightFormHtml(D) {
  const dr = D.draft;
  const busy = dr?.job && ['running', 'queued'].includes(dr.job.state);
  const types = D.sourceTypes;
  const src = dr?.source || { type: 'video', date: new Date().toISOString().slice(0, 10) };
  if (dr?.parsed) {
    const p = dr.parsed;
    return `<section class="card insight-form" id="insightForm"><h3 class="st-h">Проверь и сохрани</h3>
      ${p.looks_like_case ? `<div class="banner warn" style="margin:0 0 8px"><p>Похоже на кейс — это твой опыт с результатом${p.case_hint ? `: «${esc(p.case_hint)}»` : ''}. В инсайте это будет только взглядом; чтобы опыт попал в CV, надиктуй кейс.</p>
        <button type="button" class="small" id="insCase">Надиктовать кейс</button></div>` : ''}
      ${p.multiple ? `<div class="banner info" style="margin:0 0 8px"><p>Похоже на несколько мыслей${p.parts.length ? `: ${p.parts.map(esc).join('; ')}` : ''}. Можно сохранить как один инсайт или убрать лишнее и надиктовать остальное отдельно.</p></div>` : ''}
      <label>Заголовок <input id="insTitle" value="${esc(p.title)}" maxlength="120"></label>
      <label>Суть — твоими словами <textarea id="insEssence" rows="4">${esc(p.essence)}</textarea></label>
      <label>Для интервью (EN) <textarea id="insEn" rows="2">${esc(p.en)}</textarea></label>
      <label>Теги, через запятую <input id="insTags" value="${esc(p.tags.join(', '))}"></label>
      <p class="muted small" style="margin:4px 0">${insightSourceLine({ source: src }, types)}</p>
      <details class="more"><summary>Исходная надиктовка</summary><p class="raw-text small">${esc(dr.text)}</p></details>
      <div class="row" style="margin-top:8px"><button type="button" class="primary small" id="insSave">Сохранить</button>
        <button type="button" class="small" id="insReparse">Разобрать заново</button>
        <button type="button" class="link-btn inline" id="insCancel">отменить</button></div>
      <p class="error" id="insErr"></p></section>`;
  }
  return `<section class="card insight-form" id="insightForm"><h3 class="st-h">Новый инсайт</h3>
    ${busy ? `<div class="running"><span class="spin"></span>Разбираю надиктовку…</div>` : dr?.job?.state === 'error' ? `<p class="error">Разбор не удался: ${esc(dr.job.error)}</p>` : ''}
    <div class="ins-src">
      <label>Источник <select id="insType">${Object.entries(types).map(([k, l]) => `<option value="${k}" ${src.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Название <input id="insSrcTitle" value="${esc(src.title || '')}" placeholder="ProductCamp 2026, «Inspired», подкаст Lenny…"></label>
      <label>Ссылка <input id="insUrl" value="${esc(src.url || '')}" placeholder="необязательно"></label>
      <label>Дата <input id="insDate" type="date" value="${esc(src.date || '')}"></label>
    </div>
    <div class="dict"><textarea id="insText" placeholder="Нажми 🎤 и расскажи, что запомнилось и почему это важно…" ${busy ? 'disabled' : ''}>${esc(dr?.text || '')}</textarea>
      <button class="mic" id="insMic" type="button" title="Диктовка голосом" aria-label="Диктовка голосом">🎤</button></div>
    <div class="hint" id="insMicHint"></div>
    <div class="row" style="margin-top:8px"><button type="button" class="primary small" id="insParse" ${busy ? 'disabled' : ''}>Разобрать</button>
      <button type="button" class="link-btn inline" id="insCancel">отменить</button>
      <span class="hint" style="margin:0">Исправит ошибки распознавания, даст заголовок, суть твоими словами, фразу для интервью и теги. Haiku, ≈ $0.002, ~10 с.</span></div>
    <p class="error" id="insErr"></p></section>`;
}

function insightsHtml() {
  const D = insightsData;
  if (!D) return '<div class="table-box empty-box">Не удалось прочитать инсайты.</div>';
  const q = insightQuery.toLowerCase();
  const list = D.items.filter((i) => (!insightTag || i.tags.includes(insightTag)) && (!insightSrc || i.source.type === insightSrc)
    && (!q || [i.title, i.essence, i.en, i.source.title, ...i.tags].join(' ').toLowerCase().includes(q)));
  const showForm = insightForm || D.draft;
  const card = (i) => insightEdit === i.id ? `<article class="card insight" data-ins="${esc(i.id)}">
      <label>Заголовок <input data-ef="title" value="${esc(i.title)}"></label>
      <label>Суть <textarea data-ef="essence" rows="4">${esc(i.essence)}</textarea></label>
      <label>Для интервью (EN) <textarea data-ef="en" rows="2">${esc(i.en)}</textarea></label>
      <label>Теги <input data-ef="tags" value="${esc(i.tags.join(', '))}"></label>
      <div class="row"><button type="button" class="primary small" data-insupd="${esc(i.id)}">Сохранить</button>
        <button type="button" class="link-btn inline" data-insedit="">отменить</button></div></article>`
    : `<article class="card insight" data-ins="${esc(i.id)}">
      <div class="ins-head"><h3>${esc(i.title)}</h3>
        <span class="row small"><button type="button" class="link-btn inline" data-insedit="${esc(i.id)}">изменить</button>
          <button type="button" class="link-btn inline danger" data-insdel="${esc(i.id)}">удалить</button></span></div>
      <p class="muted small" style="margin:0 0 6px">${insightSourceLine(i, D.sourceTypes)}</p>
      <div class="ins-essence">${esc(i.essence)}</div>
      ${i.en ? `<p class="ins-en">${esc(i.en)}</p>` : ''}
      <div class="chips" style="margin:6px 0 0">${i.tags.map((t) => `<button type="button" class="kchip" data-instag="${esc(t)}">${esc(t)}</button>`).join('')}
        ${i.looks_like_case ? '<span class="pill warn">похоже на кейс</span>' : ''}</div>
      ${i.used_in.length ? `<details class="more"><summary>Использован: ${i.used_in.length}</summary><ul class="tight small">${i.used_in.map((u) => `<li><a href="#/v/${enc(u.vacancy)}">${esc(u.vacancy)}</a> — ${esc(WHERE_LABELS[u.where] || u.where)} · ${esc(u.at)}</li>`).join('')}</ul></details>`
        : '<p class="muted small" style="margin:6px 0 0">Ещё не использован.</p>'}
    </article>`;
  return `<div class="edtech-head">
      <div><p class="muted small" style="margin:0">Мысли о профессии после видео, конференций, книг, разговоров. Это <strong>взгляд, а не опыт</strong>: в CV не попадают.
        Используются в подготовке к интервью, ответах на вопросы о мнении и одной фразой в сгенерированном письме; под вакансию подбираются до 5 самых близких.</p></div>
      ${showForm ? '' : '<button type="button" class="btn primary" id="insNew">+ Инсайт</button>'}
    </div>
    ${showForm ? insightFormHtml(D) : ''}
    <div class="cases-filters">
      <input type="search" id="insSearch" placeholder="Поиск по тексту и тегам" value="${esc(insightQuery)}">
      <select id="insTagF" aria-label="Тег"><option value="">все теги</option>${D.tags.map((t) => `<option ${insightTag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="insSrcF" aria-label="Источник"><option value="">все источники</option>${Object.entries(D.sourceTypes).map(([k, l]) => `<option value="${k}" ${insightSrc === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${list.length ? `<div class="insights">${list.map(card).join('')}</div>`
      : `<div class="table-box empty-box">${D.items.length ? 'Ничего не найдено.' : 'Инсайтов пока нет — нажми «+ Инсайт» и надиктуй, что запомнилось.'}</div>`}`;
}

function bindInsights() {
  const D = insightsData;
  if (!D) return;
  const rerender = () => { $('#casesBody').innerHTML = insightsHtml(); bindInsights(); };
  const reload = () => loadCases(currentRoute());
  $('#insNew')?.addEventListener('click', () => { insightForm = true; rerender(); $('#insText')?.focus(); });
  $('#insCancel')?.addEventListener('click', async () => {
    if (D.draft && !confirm('Отменить черновик инсайта? Текст надиктовки пропадёт.')) return;
    insightForm = false;
    if (D.draft) await api('/api/insights/draft', { method: 'DELETE' }).catch(() => {});
    reload();
  });
  const ta = $('#insText');
  if (ta) setupMic(ta, () => {}, { btn: $('#insMic'), hint: $('#insMicHint'), link: `${location.origin}/#/cases/insights` });
  const source = () => ({ type: $('#insType').value, title: $('#insSrcTitle').value, url: $('#insUrl').value, date: $('#insDate').value });
  $('#insParse')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('/api/insights/parse', { method: 'POST', body: { text: ta.value, source: source() } }); }
    catch (err) { $('#insErr').textContent = err.message; e.target.disabled = false; return; }
    reload();
  });
  $('#insReparse')?.addEventListener('click', async () => {
    try { await api('/api/insights/parse', { method: 'POST', body: { text: D.draft.text, source: D.draft.source } }); } catch (err) { $('#insErr').textContent = err.message; return; }
    reload();
  });
  $('#insCase')?.addEventListener('click', () => startNewCaseWith(`${D.draft.parsed.case_hint || D.draft.text}\n\n`));
  $('#insSave')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/insights', { method: 'POST', body: { title: $('#insTitle').value, essence: $('#insEssence').value, en: $('#insEn').value, tags: $('#insTags').value } });
    } catch (err) { $('#insErr').textContent = err.message; e.target.disabled = false; return; }
    insightForm = false;
    flash('Инсайт сохранён в базу знаний.');
    reload();
  });
  const busy = D.draft?.job && ['running', 'queued'].includes(D.draft.job.state);
  if (busy) caseDraftTimer = setTimeout(() => { if (currentRoute().view === 'cases') reload(); }, 2500);
  $('#insSearch')?.addEventListener('input', (e) => {
    insightQuery = e.target.value;
    const pos = e.target.selectionStart;
    rerender();
    const el = $('#insSearch'); el.focus(); el.setSelectionRange(pos, pos);
  });
  $('#insTagF')?.addEventListener('change', (e) => { insightTag = e.target.value; rerender(); });
  $('#insSrcF')?.addEventListener('change', (e) => { insightSrc = e.target.value; rerender(); });
  document.querySelectorAll('[data-instag]').forEach((b) => b.addEventListener('click', () => { insightTag = b.dataset.instag; rerender(); }));
  document.querySelectorAll('[data-insedit]').forEach((b) => b.addEventListener('click', () => { insightEdit = b.dataset.insedit || null; rerender(); }));
  document.querySelectorAll('[data-insupd]').forEach((b) => b.addEventListener('click', async () => {
    const box = b.closest('[data-ins]');
    const f = (k) => box.querySelector(`[data-ef="${k}"]`).value;
    try { await api(`/api/insights/${enc(b.dataset.insupd)}`, { method: 'PATCH', body: { title: f('title'), essence: f('essence'), en: f('en'), tags: f('tags') } }); }
    catch (err) { alert(err.message); return; }
    insightEdit = null;
    reload();
  }));
  document.querySelectorAll('[data-insdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить инсайт из базы? Исходная надиктовка останется в knowledge-base/raw/insights/.')) return;
    try { await api(`/api/insights/${enc(b.dataset.insdel)}`, { method: 'DELETE' }); } catch (err) { alert(err.message); return; }
    reload();
  }));
}

// ---------- карточка ----------

async function renderCaseCard(id) {
  const root = $('#casesView');
  root.innerHTML = '<div class="page-wrap"><div class="empty"><span class="spin"></span>Открываю карточку…</div></div>';
  let c;
  try { c = await api(`/api/cases/card/${enc(id)}`); } catch (e) {
    root.innerHTML = `<div class="page-wrap"><a href="#/cases" class="back">← База кейсов</a><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  const fm = c.fm;
  const roleFit = Array.isArray(fm.role_fit) ? fm.role_fit : [];
  root.innerHTML = `<div class="page-wrap">
    <a href="#/cases" class="back">← База кейсов</a>
    <section class="home-head">
      <div><h1>${esc(fm.company || id)}</h1>
        <p class="lead">${esc(fm.role || '')}${fm.period ? ` · ${esc(fm.period)}` : ''}</p>
        <div class="chips" style="margin-top:10px">${casePill(fm.status)}${fm.updated ? `<span class="muted small">обновлена ${esc(fm.updated)}</span>` : ''}</div></div>
      <a class="btn ghost" href="#/cases/new?target=${enc(id)}">Дополнить кейс</a>
    </section>
    ${roleFit.length ? `<div class="chips">${roleFit.map((r) => `<span class="kchip">${esc(r)}</span>`).join('')}</div>` : ''}
    <div class="case-grid">
      <article class="card md case-md">${c.html}</article>
      <aside class="card">
        <h2>Надиктовки · ${c.sources.length}</h2>
        ${c.sources.length ? `<ul class="tight">${c.sources.map((s) => `<li>${s.exists ? `<button type="button" class="link-btn inline" data-raw="${esc(s.file)}">${esc(s.file)}</button>` : `<span class="muted">${esc(s.file)} (нет файла)</span>`}</li>`).join('')}</ul>` : '<p class="muted small">Источников нет.</p>'}
        <p class="muted small">Файл: <code>knowledge-base/cards/${esc(id)}.md</code></p>
      </aside>
    </div>
  </div>`;
  root.querySelectorAll('[data-raw]').forEach((b) => b.addEventListener('click', () => showRaw(b.dataset.raw)));
}

// ---------- новый кейс ----------

async function renderCaseNew(target) {
  const root = $('#casesView');
  let text = '';
  try { text = (await api('/api/cases')).newDictation || ''; } catch {}
  root.innerHTML = `<div class="page-wrap">
    <a href="#/cases" class="back">← База кейсов</a>
    <section class="home-head"><div><h1>${target ? 'Дополнить кейс' : 'Новый кейс'}</h1>
      <p class="lead">${target ? `Карточка <a href="#/cases/card/${enc(target)}">${esc(target)}</a>: расскажи, что добавить или уточнить.` : 'Расскажи о проекте своими словами — голосом или текстом.'}</p></div></section>
    <div class="card">
      <p class="hint" style="margin:0 0 8px">Что сказать: где и когда это было, твоя роль и что ты сделал сам, задача и почему она была важна,
        результат в цифрах (было → стало, за какой период), масштаб (команда, пользователи, деньги). Не помнишь — так и скажи.</p>
      <div class="dict">
        <textarea id="caseDict" placeholder="Нажми 🎤 и говори, или вставь текст…">${esc(text)}</textarea>
        <button class="mic" id="caseMic" type="button" title="Диктовка голосом" aria-label="Диктовка голосом">🎤</button>
      </div>
      <div class="hint" id="caseMicHint"></div>
      <div class="row" style="margin-top:10px">
        <button type="button" class="primary" id="caseSend">Отправить агенту</button>
        <span class="hint" style="margin:0" id="caseCount"></span>
        <span class="hint" style="margin:0">Агент сохранит надиктовку как есть и задаст до 6 вопросов. ≈ $0.5–1, 1–3 минуты.</span>
      </div>
      <p class="error" id="caseErr"></p>
    </div>
  </div>`;
  const ta = $('#caseDict');
  let t = null;
  const count = () => {
    const n = ta.value.trim().split(/\s+/).filter(Boolean).length;
    $('#caseCount').textContent = `${n} ${plural(n, ['слово', 'слова', 'слов'])}`;
  };
  // Черновик пишется на сервер только при наборе, не при открытии страницы
  const update = () => {
    count();
    clearTimeout(t);
    if (!target) t = setTimeout(() => api('/api/cases/new-dictation', { method: 'PUT', body: { text: ta.value } }).catch(() => {}), 600);
  };
  ta.addEventListener('input', update);
  count();
  setupMic(ta, update, { btn: $('#caseMic'), hint: $('#caseMicHint'), link: `${location.origin}/#/cases/new${target ? `?target=${enc(target)}` : ''}` });
  $('#caseSend').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/cases/drafts', { method: 'POST', body: { dictation: ta.value, target: target || null } });
      location.hash = `#/cases/draft/${enc(r.id)}`;
    } catch (err) { $('#caseErr').textContent = err.message; e.target.disabled = false; }
  });
}

// ---------- черновик: вопросы агента и сборка карточки ----------

async function renderCaseDraft(id) {
  const root = $('#casesView');
  if (!casesData) { try { casesData = await api('/api/cases'); } catch {} }
  let d;
  try { d = await api(`/api/cases/drafts/${enc(id)}`); } catch (e) {
    root.innerHTML = `<div class="page-wrap"><a href="#/cases" class="back">← База кейсов</a><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  // Пока печатаешь ответ, опрос не перерисовывает страницу
  if (document.activeElement?.closest?.('#caseDraftForm') && d.state === 'answers') return;
  const running = ['round1', 'round2'].includes(d.state);
  const head = `<a href="#/cases" class="back">← База кейсов</a>
    <section class="home-head"><div><h1>${d.target ? 'Дополнение кейса' : 'Новый кейс'}</h1>
      <p class="lead">${esc(d.summary || 'Черновик')}${d.target ? ` · карточка <a href="#/cases/card/${enc(d.target)}">${esc(d.target)}</a>` : ''}</p></div></section>`;
  let body = '';
  if (running) {
    body = `<div class="card"><div class="running"><span class="spin"></span>${d.state === 'round1' ? 'Агент сохраняет надиктовку и готовит вопросы…' : 'Агент собирает карточку…'}</div>
      ${d.job ? `<div class="feed" data-feed="${d.job.id}"></div>` : ''}</div>`;
  } else if (d.state === 'error1' || d.state === 'error2') {
    body = `<div class="card"><p class="error">Ошибка: ${esc(d.error || d.job?.error || 'агент не справился')}</p>
      <div class="row">${d.state === 'error2' ? '<button type="button" class="primary" id="caseBuild">Собрать ещё раз</button>' : ''}
      <button type="button" id="caseDrop">Удалить черновик</button></div></div>`;
  } else if (d.state === 'done') {
    body = `<div class="card"><p><strong>Карточка готова:</strong> <a href="#/cases/card/${enc(d.cardId)}">${esc(d.cardId)}</a>.
      Фит, CV и письма уже могут на неё опираться.</p></div>`;
  } else if (d.state === 'answers') {
    const dup = d.duplicateOf && !d.target ? `<div class="banner warn"><p>Похоже на карточку <a href="#/cases/card/${enc(d.duplicateOf)}">${esc(d.duplicateOf)}</a> — можно дополнить её вместо новой.</p></div>` : '';
    const where = d.target || d.duplicateOf || '';
    body = `${dup}
      <form class="card" id="caseDraftForm">
        <div class="form-grid" style="margin-bottom:14px">
          <label for="caseTarget">Куда записать</label>
          <select id="caseTarget"><option value="">новая карточка</option>${(casesData?.cards || []).map((c) => `<option value="${esc(c.id)}" ${c.id === where ? 'selected' : ''}>дополнить: ${esc(c.company)} · ${esc(c.id)}</option>`).join('')}</select>
        </div>
        <h2>Вопросы агента · ${d.questions.length}</h2>
        ${d.questions.length ? '<p class="muted small" style="margin:0 0 10px">Ответь, что знаешь. Пустой ответ = «не знаю»: в карточке будет [НЕТ ДАННЫХ].</p>' : '<p class="muted">Вопросов нет — всё нужное есть в надиктовке.</p>'}
        <ol class="case-qs">${d.questions.map((q) => `<li>
          <label for="qa-${esc(q.id)}"><strong>${esc(q.q)}</strong>${q.why ? ` <span class="muted small">· ${esc(q.why)}</span>` : ''}</label>
          <textarea id="qa-${esc(q.id)}" data-qid="${esc(q.id)}" rows="2">${esc(d.answers?.[q.id] || '')}</textarea>
        </li>`).join('')}</ol>
        <div class="row" style="margin-top:12px">
          <button type="submit" class="primary">Собрать карточку</button>
          <button type="button" id="caseSkip">Сохранить без ответов</button>
          <button type="button" id="caseDrop">Удалить черновик</button>
          <span class="hint" style="margin:0">≈ $0.5–1, 1–3 минуты.</span>
        </div>
        <p class="error" id="caseErr"></p>
      </form>
      ${d.draftHtml ? `<details class="card"><summary><strong>Черновик карточки</strong></summary><div class="md case-md">${d.draftHtml}</div></details>` : ''}`;
  }
  root.innerHTML = `<div class="page-wrap">${head}${body}
    <details class="card"><summary><strong>Твоя надиктовка</strong></summary><p class="raw-text">${esc(d.dictation)}</p></details></div>`;
  if (d.job && running) attachFeed(d.job);
  if (running) caseDraftTimer = setTimeout(() => { if (location.hash === `#/cases/draft/${enc(id)}`) renderCaseDraft(id); }, 3000);
  bindCaseDraft(d);
}

function bindCaseDraft(d) {
  const answers = () => Object.fromEntries([...document.querySelectorAll('[data-qid]')].map((t) => [t.dataset.qid, t.value]));
  const target = () => ($('#caseTarget') ? $('#caseTarget').value || null : d.target || null);
  $('#caseTarget')?.addEventListener('change', () => api(`/api/cases/drafts/${enc(d.id)}`, { method: 'PATCH', body: { target: target() } }).catch(() => {}));
  let t = null;
  document.querySelectorAll('[data-qid]').forEach((ta) => ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => api(`/api/cases/drafts/${enc(d.id)}`, { method: 'PATCH', body: { answers: answers() } }).catch(() => {}), 600);
  }));
  const build = async (skip) => {
    try {
      await api(`/api/cases/drafts/${enc(d.id)}/build`, { method: 'POST', body: { answers: answers(), skip, target: target() } });
      renderCaseDraft(d.id);
    } catch (err) { ($('#caseErr') || {}).textContent = err.message; }
  };
  $('#caseDraftForm')?.addEventListener('submit', (e) => { e.preventDefault(); build(false); });
  $('#caseSkip')?.addEventListener('click', () => {
    if (confirm('Собрать карточку без ответов? Неизвестное станет [НЕТ ДАННЫХ], статус «нужны факты».')) build(true);
  });
  $('#caseBuild')?.addEventListener('click', () => build(false));
  $('#caseDrop')?.addEventListener('click', async () => {
    if (!confirm('Удалить черновик? Надиктовка уже сохранена в knowledge-base/raw/ и останется там.')) return;
    try { await api(`/api/cases/drafts/${enc(d.id)}`, { method: 'DELETE' }); location.hash = '#/cases'; } catch (err) { alert(err.message); }
  });
}
