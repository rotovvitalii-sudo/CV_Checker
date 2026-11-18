// ---------- C25: спросить Claude в уроке (docs/specs/50-lesson-chat.md) ----------
// Выделение в тексте урока + правая кнопка (на телефоне — плавающая кнопка) → меню действий → панель чата справа.
// Слушатели делегированы на document: урок рисуется заново, а меню и панель живут своей жизнью.

const LC_ACTIONS = [['explain', 'Объясни подробнее'], ['simpler', 'Объясни проще'], ['example', 'Пример с числами'], ['interview', 'Как спросят на интервью']];
const lc = { slug: null, lang: 'en', course: '', quote: '', section: '', id: null, chat: null, es: null, list: null, busy: false };
const lcCoarse = () => window.matchMedia('(pointer: coarse)').matches;

// Выделение внутри статьи урока → контекст: тема, язык, курс, цитата, ближайший заголовок раздела
function lcSelection() {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text || !sel.rangeCount) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const art = el?.closest('article.lesson[data-lesson]');
  if (!art) return null;
  let section = '';
  let cur = el;
  while (cur && cur.parentElement !== art) cur = cur.parentElement;
  for (let x = cur; x; x = x.previousElementSibling) if (/^H[1-4]$/.test(x.tagName)) { section = x.textContent.trim(); break; }
  return { slug: art.dataset.lesson, lang: art.dataset.lang || 'en', course: art.dataset.course || '', quote: text, section, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

function lcCloseMenu() { $('#lcMenu')?.remove(); }
function lcMenu(x, y, ctx) {
  lcCloseMenu();
  const m = document.createElement('div');
  m.id = 'lcMenu';
  m.className = 'lc-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `<div class="lc-menu-h">Спросить Claude</div>${LC_ACTIONS.map(([k, l]) => `<button type="button" role="menuitem" data-lca="${k}">${l}</button>`).join('')}
    <button type="button" role="menuitem" data-lca="">Свой вопрос…</button>`;
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  m.querySelectorAll('[data-lca]').forEach((b) => b.addEventListener('click', () => {
    lcCloseMenu();
    lcHideFab();
    lcOpen({ ...ctx, id: null });
    if (b.dataset.lca) lcSend({ action: b.dataset.lca }); else $('#lcInput')?.focus();
  }));
  m.querySelector('button')?.focus();
}

// Плавающая кнопка для сенсорных экранов
function lcHideFab() { $('#lcFab')?.remove(); }
function lcFab(ctx) {
  lcHideFab();
  const b = document.createElement('button');
  b.id = 'lcFab';
  b.type = 'button';
  b.className = 'lc-fab';
  b.textContent = 'Спросить';
  b.style.left = `${Math.max(8, Math.min(ctx.rect.left, window.innerWidth - 110))}px`;
  b.style.top = `${Math.min(window.innerHeight - 52, ctx.rect.bottom + 8)}px`;
  b.addEventListener('mousedown', (e) => e.preventDefault()); // не сбрасывать выделение
  b.addEventListener('click', () => { const r = b.getBoundingClientRect(); lcMenu(r.left, r.bottom + 4, ctx); });
  document.body.appendChild(b);
}

document.addEventListener('contextmenu', (e) => {
  const ctx = lcSelection();
  if (!ctx) return; // вне урока или без выделения — меню браузера
  e.preventDefault();
  lcMenu(e.clientX, e.clientY, ctx);
});
let lcSelTimer = null;
document.addEventListener('selectionchange', () => {
  if (!lcCoarse()) return;
  clearTimeout(lcSelTimer);
  // Панель на весь экран телефона — кнопку под ней не показываем
  lcSelTimer = setTimeout(() => { const ctx = !$('#lessonChat') && lcSelection(); if (ctx) lcFab(ctx); else lcHideFab(); }, 350);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#lcMenu')) lcCloseMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { lcCloseMenu(); if ($('#lessonChat') && !lc.busy) lcClose(); } });
document.addEventListener('scroll', () => lcCloseMenu(), true);
document.addEventListener('click', (e) => {
  const ask = e.target.closest('[data-chat-ask]'), lst = e.target.closest('[data-chat-list]');
  if (!ask && !lst) return;
  const art = document.querySelector(`article.lesson[data-lesson="${CSS.escape((ask || lst).dataset.chatAsk || (ask || lst).dataset.chatList)}"]`);
  const ctx = { slug: art?.dataset.lesson || (ask || lst).dataset.chatAsk || (ask || lst).dataset.chatList, lang: art?.dataset.lang || 'en', course: art?.dataset.course || '', quote: '', section: '' };
  lcOpen({ ...ctx, id: null });
  if (lst) lcShowList(); else $('#lcInput')?.focus();
});

// ---------- панель ----------
function lcOpen(ctx) {
  lcHideFab();
  if (lc.es) { lc.es.close(); lc.es = null; }
  Object.assign(lc, { slug: ctx.slug, lang: ctx.lang, course: ctx.course, quote: ctx.quote || '', section: ctx.section || '', id: ctx.id || null, chat: null, busy: false, list: null });
  let p = $('#lessonChat');
  if (!p) {
    p = document.createElement('aside');
    p.id = 'lessonChat';
    p.className = 'lc-panel';
    p.setAttribute('aria-label', 'Спросить Claude');
    document.body.appendChild(p);
    document.body.classList.add('lc-open');
  }
  lcRender();
}
function lcClose() {
  if (lc.es) { lc.es.close(); lc.es = null; }
  $('#lessonChat')?.remove();
  document.body.classList.remove('lc-open');
}

function lcRender(streamText = null, error = '') {
  const p = $('#lessonChat');
  if (!p) return;
  const quote = lc.chat?.quote ?? lc.quote;
  const section = lc.chat?.section ?? lc.section;
  const msgs = lc.chat?.messages || [];
  p.innerHTML = `<div class="lc-head"><strong>Спросить Claude</strong>
      <span class="row" style="gap:8px"><button type="button" class="link-btn inline" id="lcList">мои вопросы</button>
      <button type="button" class="link-btn inline" id="lcNew" title="Новый вопрос по уроку">новый</button>
      <button type="button" class="link-btn inline" id="lcClose" aria-label="Закрыть">✕</button></span></div>
    <div class="lc-body" id="lcBody">
      ${quote ? `<div class="lc-quote">${section ? `<div class="muted small">${esc(section)}</div>` : ''}${quote.length > 280
        ? `<details><summary>${esc(quote.slice(0, 220))}…</summary>${esc(quote)}</details>` : esc(quote)}${lc.chat?.cut ? '<div class="muted small">цитата обрезана</div>' : ''}</div>`
        : '<p class="muted small" style="margin:0">Вопрос по всему уроку. Чтобы спросить про кусок — выдели текст в уроке и нажми правую кнопку.</p>'}
      ${msgs.map((m) => (m.role === 'user' ? `<div class="lc-msg lc-user">${esc(m.text)}</div>`
        : `<div class="lc-msg lc-bot">${m.html || esc(m.text)}${m.model ? `<div class="muted small lc-meta">${esc(String(m.model).replace('claude-', ''))}${m.cost != null ? ` · $${Number(m.cost).toFixed(3)}` : ''}</div>` : ''}</div>`)).join('')}
      ${streamText != null ? `<div class="lc-msg lc-bot lc-stream">${streamText ? esc(streamText) : '<span class="spin"></span>думаю…'}</div>` : ''}
      ${error ? `<p class="error small">${esc(error)}</p>` : ''}
      ${!msgs.length && streamText == null ? `<div class="lc-quick">${LC_ACTIONS.map(([k, l]) => `<button type="button" class="small" data-lcq="${k}">${l}</button>`).join('')}</div>` : ''}
    </div>
    <form class="lc-form" id="lcForm"><div class="dict"><textarea id="lcInput" rows="2" placeholder="${msgs.length ? 'Уточни или спроси ещё' : 'Свой вопрос'}" ${lc.busy ? 'disabled' : ''}></textarea>
      <button type="button" class="mic" id="lcMic" title="Диктовка голосом" aria-label="Диктовка голосом">🎤</button></div>
      <div class="row" style="justify-content:space-between"><span class="hint" id="lcMicHint" style="margin:0">Enter — отправить, Shift+Enter — новая строка</span>
        <button type="submit" class="primary small" ${lc.busy ? 'disabled' : ''}>Спросить</button></div></form>`;
  $('#lcClose').addEventListener('click', lcClose);
  $('#lcNew').addEventListener('click', () => lcOpen({ slug: lc.slug, lang: lc.lang, course: lc.course }));
  $('#lcList').addEventListener('click', lcShowList);
  p.querySelectorAll('[data-lcq]').forEach((b) => b.addEventListener('click', () => lcSend({ action: b.dataset.lcq })));
  const ta = $('#lcInput');
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#lcForm').requestSubmit(); } });
  $('#lcForm').addEventListener('submit', (e) => { e.preventDefault(); const q = ta.value.trim(); if (q) lcSend({ question: q }); });
  setupMic(ta, () => {}, { btn: $('#lcMic'), hint: $('#lcMicHint'), link: location.href });
  const body = $('#lcBody');
  body.scrollTop = body.scrollHeight;
}

async function lcSend({ question = '', action = '' }) {
  if (lc.busy) return;
  lc.busy = true;
  const pending = { role: 'user', text: question || LC_ACTIONS.find(([k]) => k === action)?.[1] || '' };
  lc.chat = { ...(lc.chat || { quote: lc.quote, section: lc.section, messages: [] }), messages: [...(lc.chat?.messages || []), pending] };
  lcRender('');
  try {
    const base = `/api/topics/${enc(lc.slug)}/chats`;
    const r = lc.id ? await api(`${base}/${lc.id}/messages`, { method: 'POST', body: { question, action } })
      : await api(base, { method: 'POST', body: { question, action, quote: lc.quote, section: lc.section, lang: lc.lang, course: lc.course } });
    if (r.id) lc.id = r.id;
    lcStream(r.jobId);
  } catch (e) {
    lc.busy = false;
    lc.chat.messages.pop();
    lcRender(null, e.message);
    $('#lcInput').value = question;
  }
}
function lcStream(jobId) {
  let text = '';
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  lc.es = es;
  const slug = lc.slug, id = lc.id;
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === 'delta') {
      text = ev.snapshot ? ev.text : text + ev.text;
      const box = $('#lessonChat .lc-stream');
      if (box) { box.textContent = text; const b = $('#lcBody'); b.scrollTop = b.scrollHeight; }
    }
    if (ev.done) { es.close(); lc.es = null; lcFinish(slug, id); }
  };
  es.onerror = () => { es.close(); lc.es = null; lcFinish(slug, id); };
}
async function lcFinish(slug, id) {
  if (lc.slug !== slug || lc.id !== id) return;
  lc.busy = false;
  try {
    const c = await api(`/api/topics/${enc(slug)}/chats/${id}`);
    lc.chat = c;
    lcRender(null, c.job?.state === 'error' ? `Ошибка: ${c.job.error}` : '');
    if (c.job?.state === 'error') $('#lcInput').value = c.messages.filter((m) => m.role === 'user').slice(-1)[0]?.text || '';
  } catch (e) { lcRender(null, e.message); }
  // Счётчик «мои вопросы» у урока
  const lst = document.querySelector(`[data-chat-list="${CSS.escape(slug)}"]`);
  if (!lst) document.querySelector(`[data-chat-ask="${CSS.escape(slug)}"]`)?.insertAdjacentHTML('afterend', ` <button type="button" class="link-btn inline" data-chat-list="${esc(slug)}">мои вопросы</button>`);
}

async function lcShowList() {
  const p = $('#lessonChat');
  if (!p) return;
  let r;
  try { r = await api(`/api/topics/${enc(lc.slug)}/chats`); } catch (e) { lcRender(null, e.message); return; }
  const body = $('#lcBody');
  body.innerHTML = r.list.length ? `<ul class="lc-list">${r.list.map((c) => `<li><button type="button" class="link-btn" data-lco="${esc(c.id)}">${esc(c.quote || c.first || 'вопрос по уроку')}</button>
      <div class="muted small">${esc(c.first)} · ${new Date(c.updated).toLocaleDateString('ru-RU')} · сообщений: ${c.n}
      <button type="button" class="link-btn inline" data-lcd="${esc(c.id)}">удалить</button></div></li>`).join('')}</ul>`
    : '<p class="muted small">Вопросов по этому уроку ещё нет.</p>';
  body.querySelectorAll('[data-lco]').forEach((b) => b.addEventListener('click', async () => {
    try { const c = await api(`/api/topics/${enc(lc.slug)}/chats/${b.dataset.lco}`); Object.assign(lc, { id: c.id, chat: c, quote: c.quote, section: c.section }); lcRender();
      if (['running', 'queued'].includes(c.job?.state)) { lc.busy = true; lcRender(''); lcStream(c.job.id); } } catch (e) { lcRender(null, e.message); }
  }));
  body.querySelectorAll('[data-lcd]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить разговор?')) return;
    await api(`/api/topics/${enc(lc.slug)}/chats/${b.dataset.lcd}`, { method: 'DELETE' }).catch((e) => alert(e.message));
    lcShowList();
  }));
}
