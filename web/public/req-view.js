// ---------- C20 · требование → кейс (docs/specs/45-requirement-cases.md) ----------
// Отдельная карточка на странице заявки: строки «что они ждут», под каждой — свой кейс, матч 0–100, «Предложить кейс» из базы.
// Карточка грузит свои данные сама и перерисовывает только себя (и только изменившиеся строки), чтобы не терять набранный текст.

let reqState = null;       // { name, data }
const reqOpen = new Set(); // id раскрытых строк
const reqEditing = new Set(); // id строк, где правится текст требования
const reqTimers = {};      // автосохранение текста
let reqPoll = null;
let reqShowWish = false;

const REQ_BUCKET = { minimum: ['bad', 'минимум'], desired: ['info', 'желательно'], wishlist: ['neutral', 'вишлист'], other: ['neutral', 'требование'] };
const REQ_PARTS = [['relevance', 'про то самое', 40], ['evidence', 'результат и цифры', 25], ['ownership', 'что сделал сам', 20], ['scale', 'масштаб', 15]];
const reqQ = (req) => `Требование вакансии: ${req}`;
const reqTone = (s) => (s >= 70 ? 'good' : s >= 45 ? 'warn' : 'bad');

function reqBlock(d) {
  if (!d.hasVacancy || !d.hasVacancyText) return '';
  const cached = reqState?.name === d.name ? reqState.data : null;
  return `<div class="card req-card" id="reqCard">${cached ? reqInner(cached) : reqHead(null) + '<p class="muted small">Загружаю строки вакансии…</p>'}</div>`;
}

function reqHead(v) {
  return `<h2><span class="n">☑</span>Требования → мои кейсы${v ? ` <span class="muted" style="font-weight:500">· готово ${v.ready}/${v.total}</span>` : ''}
    <span class="right">${v ? '<button type="button" class="small" id="reqRebuild" title="Строки с кейсами и свои останутся">Собрать строки заново</button>' : ''}</span></h2>`;
}

function reqInner(v) {
  const shown = v.items.filter((x) => x.bucket !== 'wishlist' || reqShowWish);
  const wish = v.items.filter((x) => x.bucket === 'wishlist').length;
  return `${reqHead(v)}
    <p class="muted small" style="margin:-4px 0 10px">Под каждую строку — своя история: надиктуй, проверь матч (готово — от ${v.threshold}), поправь и проверь ещё раз.
      Кейс от ${v.threshold} сам уходит в базу и подсказывается в других вакансиях. ${v.source === 'buckets' ? 'Строки — из корзин фита: списка требований в тексте вакансии не нашлось.' : ''}</p>
    ${v.items.length ? '' : '<p class="muted">В тексте вакансии не нашлось списка требований, и у фита нет корзин. Добавь строки сам.</p>'}
    <div class="req-list">${shown.map(reqRow).join('')}</div>
    ${wish ? `<button type="button" class="link-btn inline" id="reqWish">${reqShowWish ? 'скрыть вишлист' : `показать вишлист · ${wish}`}</button>` : ''}
    <div class="row req-add"><label class="sr-only" for="reqNew">Новое требование</label>
      <input id="reqNew" placeholder="Своя строка: что ещё они ждут" />
      <button type="button" class="small" id="reqAdd">Добавить строку</button></div>`;
}

function reqStatus(it) {
  if (it.match?.state === 'running') return '<span class="pill info"><span class="spin"></span> считаю матч</span>';
  if (it.last) return `<span class="pill ${reqTone(it.last.score)}" title="${it.last.stale ? 'текст или требование изменились после оценки' : ''}">${it.last.score}${it.last.stale ? ' · изменено' : ''}</span>`;
  if (it.text.trim()) return '<span class="pill neutral">кейс без матча</span>';
  return `<span class="pill neutral">${it.similar?.length ? 'есть похожий' : 'нет кейса'}</span>`;
}

function reqRow(it) {
  const [tone, label] = REQ_BUCKET[it.bucket] || REQ_BUCKET.other;
  const open = reqOpen.has(it.id);
  return `<details class="req-row" data-reqrow="${it.id}" ${open ? 'open' : ''}>
    <summary><span class="req-text">${esc(it.req)}</span>
      <span class="req-meta">${it.bucket !== 'other' ? `<span class="pill ${tone}">${label}</span>` : ''}${it.saved ? '<span class="pill good" title="кейс в базе">в базе</span>' : ''}${reqStatus(it)}</span></summary>
    ${open ? reqBody(it) : ''}
  </details>`;
}

function reqBody(it) {
  const id = it.id;
  const L = it.last;
  const mrun = it.match?.state === 'running';
  const srun = it.suggest?.state === 'running';
  const hist = it.attempts.length > 1 ? `<span class="muted small">попытки: ${it.attempts.map((a) => a.score).join(' → ')}</span>` : '';
  return `<div class="req-body">
    ${reqEditing.has(id) ? `<div class="row"><label class="sr-only" for="reqEdit-${id}">Требование</label><input id="reqEdit-${id}" value="${esc(it.req)}" />
        <button type="button" class="small" data-reqreqsave="${id}">Сохранить</button><button type="button" class="small" data-reqreqcancel="${id}">Отмена</button></div>`
      : `<div class="row small req-tools"><button type="button" class="link-btn inline" data-reqedit="${id}">изменить требование</button>
        <button type="button" class="link-btn inline" data-reqmove="${id}" data-dir="-1" title="выше">↑</button><button type="button" class="link-btn inline" data-reqmove="${id}" data-dir="1" title="ниже">↓</button>
        <button type="button" class="link-btn inline danger" data-reqdel="${id}">удалить строку</button></div>`}
    ${(it.similar || []).map((s) => `<div class="req-similar small"><strong>Уже писал похожее</strong>${s.score != null ? ` · ${s.score}` : ''} · <span class="muted">${esc(s.vacancy)}</span>
        <div class="muted">«${esc(s.req)}»</div><div class="req-quote">${esc(s.text.slice(0, 400))}${s.text.length > 400 ? '…' : ''}</div>
        <button type="button" class="small" data-reqsim="${id}" data-sim="${esc(s.id)}">Подставить</button></div>`).join('')}
    <div class="dict"><label class="sr-only" for="reqTa-${id}">Мой кейс</label>
      <textarea id="reqTa-${id}" data-reqta="${id}" rows="5" placeholder="Нажми 🎤 и расскажи, где ты это делал: ситуация → что сделал сам → результат с цифрами">${esc(it.text)}</textarea>
      <button class="mic" id="reqMic-${id}" type="button" title="Надиктовать" aria-label="Надиктовать кейс">🎤</button></div>
    <div class="hint" id="reqMicHint-${id}"></div>
    <div class="row" style="margin-top:8px">
      <button type="button" class="primary small" data-reqmatch="${id}" ${mrun ? 'disabled' : ''}>${L ? 'Проверить ещё раз' : 'Проверить матч'}</button>
      <button type="button" class="small" data-reqsuggest="${id}" ${srun ? 'disabled' : ''} title="Найти в базе кейсов карточку под это требование">Предложить кейс</button>
      ${it.saved ? `<span class="small muted">в базе ✓</span> <button type="button" class="link-btn inline" data-requnsave="${id}">убрать из базы</button>`
        : `<button type="button" class="small" data-reqsave="${id}" title="Сохранить в библиотеку кейсов под требования, даже если матч ниже порога">Сохранить в базу</button>`}
      <span class="hint" style="margin:0">матч ≈ $0.003 · предложить ≈ $0.01</span></div>
    ${it.match?.state === 'error' || it.match?.state === 'lost' ? `<p class="error small">Матч: ${esc(it.match.error || 'не удался')}</p>` : ''}
    ${L ? `<div class="req-score">
        <div class="row" style="gap:8px"><strong class="req-big ${reqTone(L.score)}-text">${L.score}/100</strong>${hist}
          ${L.stale === 'text' ? '<span class="warn-text small">текст изменился после оценки — проверь ещё раз</span>' : L.stale === 'req' ? '<span class="warn-text small">требование изменилось — проверь ещё раз</span>' : ''}
          ${L.gap ? '<span class="pill bad">пробел: опыт не про это</span>' : ''}</div>
        <div class="req-parts small">${REQ_PARTS.map(([k, l, max]) => `<span>${l} <strong>${L.parts[k]}</strong>/${max}</span>`).join(' · ')}</div>
        ${L.verdict ? `<p class="small" style="margin:6px 0">${esc(L.verdict)}</p>` : ''}
        ${L.hit.length ? `<ul class="tight small req-hit">${L.hit.map((x) => `<li>✓ ${esc(x)}</li>`).join('')}</ul>` : ''}
        ${L.missing.length ? `<div class="small"><strong>Чего не хватает:</strong><ul class="tight">${L.missing.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div>` : ''}
    ${srun ? '<div class="running small"><span class="spin"></span>Ищу в базе кейсов…</div>' : ''}
    ${it.suggest?.state === 'error' || it.suggest?.state === 'lost' ? `<p class="error small">Предложить кейс: ${esc(it.suggest.error || 'не удалось')}</p>` : ''}
    ${it.suggest?.state === 'done' ? reqSuggestBox(it) : ''}
    ${it.saved && it.text.trim() ? factsLine(it.facts, reqQ(it.req), it.text) : ''}
  </div>`;
}

function reqSuggestBox(it) {
  const s = it.suggest;
  if (s.none) {
    return `<div class="req-suggest small"><strong>В базе нет кейса под это требование.</strong> ${s.hint ? esc(s.hint) : ''}
      <button type="button" class="link-btn inline" data-reqnewcase="${it.id}">Надиктовать новый кейс</button></div>`;
  }
  return `<div class="req-suggest small"><strong>Из базы кейсов</strong> <button type="button" class="link-btn inline" data-reqsugclose="${it.id}">скрыть</button>
    ${s.options.map((o, i) => `<div class="req-opt">
      <div><a href="#/cases/card/${enc(o.card)}">${esc(o.card)}</a></div>
      ${o.why ? `<div><span class="muted">Матчится:</span> ${esc(o.why)}</div>` : ''}
      ${o.covers ? `<div><span class="muted">Закрывает:</span> ${esc(o.covers)}</div>` : ''}
      ${o.not_covers ? `<div><span class="muted">Не закрывает:</span> ${esc(o.not_covers)}</div>` : ''}
      ${o.draft ? `<div class="req-quote">${esc(o.draft)}</div><button type="button" class="small" data-reqins="${it.id}" data-opt="${i}">Вставить в мой кейс</button>`
        : o.draftNote ? `<div class="warn-text">${esc(o.draftNote)}</div>` : ''}
    </div>`).join('')}</div>`;
}

// ---------- данные и перерисовка ----------
async function loadReq(d, { quiet = false } = {}) {
  let v;
  try { v = await api(`/api/vacancies/${enc(d.name)}/reqcases`); } catch (e) {
    const box = $('#reqCard');
    if (box && !quiet) box.innerHTML = `${reqHead(null)}<p class="error">${esc(e.message)}</p>`;
    return;
  }
  const prev = reqState?.name === d.name ? reqState.data : null;
  reqState = { name: d.name, data: v };
  reqRender(prev);
  reqSchedulePoll(d);
}

// Полная перерисовка, если поменялся состав строк; иначе — только изменившиеся строки (текст в фокусе не трогаем)
function reqRender(prev) {
  const box = $('#reqCard');
  if (!box || !reqState) return;
  const v = reqState.data;
  // Набранный, но ещё не сохранённый текст — в состояние, чтобы перерисовка его не потеряла
  box.querySelectorAll('[data-reqta]').forEach((ta) => {
    const it = v.items.find((x) => x.id === ta.dataset.reqta);
    if (it && ta.value !== it.text) { it.text = ta.value; reqSaveText(it.id); }
  });
  const same = prev && prev.items.length === v.items.length && prev.items.every((x, i) => x.id === v.items[i].id) && box.querySelector('.req-list');
  if (!same) {
    box.innerHTML = reqInner(v);
    bindReqCard();
    return;
  }
  const head = box.querySelector('h2');
  if (head) head.outerHTML = reqHead(v);
  box.querySelector('#reqRebuild')?.addEventListener('click', reqRebuild);
  v.items.forEach((it, i) => {
    const old = prev.items[i];
    const sig = (x) => JSON.stringify({ ...x, text: '' });
    if (sig(old) === sig(it) && old.text === it.text) return;
    const el = box.querySelector(`[data-reqrow="${it.id}"]`);
    if (!el) return;
    const ta = el.querySelector('textarea');
    const typing = ta && document.activeElement === ta;
    const keep = ta ? ta.value : null;
    el.outerHTML = reqRow(it);
    const fresh = box.querySelector(`[data-reqrow="${it.id}"]`);
    bindReqRow(fresh);
    if (keep != null) {
      const t2 = fresh.querySelector('textarea');
      if (t2) { t2.value = keep; if (typing) { t2.focus(); t2.setSelectionRange(keep.length, keep.length); } }
    }
  });
}

function reqSchedulePoll(d) {
  clearTimeout(reqPoll);
  const running = reqState?.data.items.some((x) => x.match?.state === 'running' || x.suggest?.state === 'running' || x.facts?.state === 'running');
  if (!running) return;
  reqPoll = setTimeout(() => { if ($('#reqCard') && detail?.name === d.name) loadReq(d, { quiet: true }); }, 3000);
}

const reqItemOf = (id) => reqState?.data.items.find((x) => x.id === id);
const reqUrl = (id, tail = '') => `/api/vacancies/${enc(reqState.name)}/reqcases/items/${enc(id)}${tail}`;

function reqSaveText(id, now = false) {
  clearTimeout(reqTimers[id]);
  const run = async () => {
    const ta = document.querySelector(`[data-reqta="${id}"]`);
    const it = reqItemOf(id);
    if (!ta || !it || ta.value === it.text) return;
    it.text = ta.value;
    try { await api(reqUrl(id), { method: 'PATCH', body: { text: ta.value } }); } catch { /* сохранится при следующей правке */ }
  };
  if (now) return run();
  reqTimers[id] = setTimeout(run, 800);
}

async function reqAction(fn) {
  try { await fn(); } catch (e) { alert(e.message); }
  const d = detail;
  if (d) await loadReq(d, { quiet: true });
}

function reqRebuild() {
  if (!confirm('Собрать строки заново из текста вакансии? Строки с кейсами, свои и правленые останутся.')) return;
  reqAction(() => api(`/api/vacancies/${enc(reqState.name)}/reqcases/rebuild`, { method: 'POST' }));
}

function bindReqCard() {
  const box = $('#reqCard');
  if (!box) return;
  box.querySelector('#reqRebuild')?.addEventListener('click', reqRebuild);
  box.querySelector('#reqWish')?.addEventListener('click', () => { reqShowWish = !reqShowWish; box.innerHTML = reqInner(reqState.data); bindReqCard(); });
  const add = async () => {
    const inp = box.querySelector('#reqNew');
    if (!inp.value.trim()) return;
    await reqAction(() => api(`/api/vacancies/${enc(reqState.name)}/reqcases/items`, { method: 'POST', body: { req: inp.value } }));
    const last = reqState.data.items[reqState.data.items.length - 1];
    if (last) { reqOpen.add(last.id); box.innerHTML = reqInner(reqState.data); bindReqCard(); }
  };
  box.querySelector('#reqAdd')?.addEventListener('click', add);
  box.querySelector('#reqNew')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  box.querySelectorAll('[data-reqrow]').forEach(bindReqRow);
  pollFacts(); // C13: строка «ищу факты…» у сохранённых кейсов
}

function bindReqRow(row) {
  const id = row.dataset.reqrow;
  row.addEventListener('toggle', () => {
    const was = reqOpen.has(id);
    if (row.open === was) return;
    if (row.open) reqOpen.add(id); else { reqSaveText(id, true); reqOpen.delete(id); }
    const it = reqItemOf(id);
    if (!it) return;
    row.outerHTML = reqRow(it);
    const fresh = $('#reqCard').querySelector(`[data-reqrow="${id}"]`);
    bindReqRow(fresh);
    if (row.open) fresh.querySelector('textarea')?.focus();
  });
  const ta = row.querySelector('textarea');
  if (!ta) return;
  ta.addEventListener('input', () => reqSaveText(id));
  ta.addEventListener('blur', () => reqSaveText(id, true));
  setupMic(ta, () => reqSaveText(id), { btn: row.querySelector('.mic'), hint: row.querySelector(`#reqMicHint-${id}`), link: `${location.origin}/#/v/${enc(reqState.name)}` });
  pollFacts();
  const on = (sel, fn) => row.querySelectorAll(sel).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); fn(b); }));
  on('[data-reqmatch]', (b) => { b.disabled = true; reqAction(() => api(reqUrl(id, '/match'), { method: 'POST', body: { text: ta.value } })); });
  on('[data-reqsuggest]', (b) => { b.disabled = true; reqAction(() => api(reqUrl(id, '/suggest'), { method: 'POST' })); });
  on('[data-reqsave]', () => reqAction(() => api(reqUrl(id, '/save'), { method: 'POST', body: { text: ta.value } })));
  on('[data-requnsave]', () => { if (confirm('Убрать этот кейс из библиотеки? Факты, уже добавленные в карточки, останутся.')) reqAction(() => api(reqUrl(id, '/save'), { method: 'DELETE' })); });
  on('[data-reqdel]', () => { if (confirm('Удалить строку вместе с кейсом? Запись в базе (если есть) останется.')) reqAction(() => api(reqUrl(id), { method: 'DELETE' })); });
  on('[data-reqmove]', (b) => reqAction(() => api(reqUrl(id), { method: 'PATCH', body: { move: Number(b.dataset.dir) } }).then(() => reqSaveText(id, true))));
  on('[data-reqedit]', () => { reqEditing.add(id); reqRender(null); });
  on('[data-reqreqcancel]', () => { reqEditing.delete(id); reqRender(null); });
  on('[data-reqreqsave]', () => {
    const v = row.querySelector(`#reqEdit-${id}`).value;
    reqEditing.delete(id);
    reqAction(() => api(reqUrl(id), { method: 'PATCH', body: { req: v } }));
  });
  on('[data-reqsim]', (b) => {
    const s = reqItemOf(id)?.similar.find((x) => x.id === b.dataset.sim);
    if (!s) return;
    ta.value = s.text;
    reqSaveText(id, true);
  });
  on('[data-reqins]', (b) => {
    const o = reqItemOf(id)?.suggest?.options[Number(b.dataset.opt)];
    if (!o?.draft) return;
    if (ta.value.trim() && !confirm('Заменить текущий текст кейса черновиком из карточки?')) return;
    ta.value = o.draft;
    reqAction(() => api(reqUrl(id), { method: 'PATCH', body: { text: o.draft, card: o.card } }));
  });
  on('[data-reqsugclose]', () => {
    const it = reqItemOf(id);
    if (it) { it.suggest = null; reqRender(null); }
  });
  on('[data-reqnewcase]', async () => {
    const it = reqItemOf(id);
    const text = `Требование вакансии «${reqState.name}»: ${it?.req || ''}\n\nМой опыт под это требование: ${ta.value}\n\n`;
    try { await api('/api/cases/new-dictation', { method: 'PUT', body: { text } }); } catch { /* текст можно вставить руками */ }
    location.hash = '#/cases/new';
  });
}

function bindReq(d) {
  if (!$('#reqCard')) return;
  if (reqState?.name === d.name) bindReqCard();
  loadReq(d);
}
