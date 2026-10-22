// Экран «Master CV»: актуальная версия, редактор с diff, загрузка файла, история, адаптированные CV.
// Использует хелперы из app.js ($, esc, enc, api, pct, delta, select, STATUS_LABELS).
const SOURCE_LABELS = { initial: 'исходная', upload: 'из файла', edit: 'правка', restore: 'возврат' };

let mv = null;          // ответ /api/master
let editor = null;      // { mode: 'edit'|'draft', text, base, notes, check }
let mvPoll = null;

// ---------- данные ----------

async function loadMaster() {
  try {
    mv = await api('/api/master');
  } catch (e) {
    $('#masterView').innerHTML = `<div class="wrap"><p class="error">${esc(e.message)}</p></div>`;
    return;
  }
  // Черновик из файла готов — открываем ревью
  if (mv.draft?.state === 'ready' && (!editor || editor.mode !== 'draft')) {
    const d = await api('/api/master/draft');
    editor = { mode: 'draft', text: d.text, base: await activeText(), notes: d.notes, check: null, original: d.draft.original };
  }
  renderMaster();
  clearTimeout(mvPoll);
  if (mv.draft?.state === 'running') mvPoll = setTimeout(loadMaster, 3000);
}

async function activeText() {
  const v = await api(`/api/master/versions/${mv.active}`);
  return v.text;
}

// ---------- рендер ----------

function renderMaster() {
  const act = mv.versions.find((v) => v.active);
  const next = Math.max(...mv.versions.map((v) => v.version)) + 1;
  $('#masterView').innerHTML = `<div class="wrap">
    ${draftBanner()}
    <div class="card">
      <div class="cur-head">
        <h1>Master CV v${act.version}</h1>
        <span class="chip good">актуальная</span>
        <span class="muted">${fmtDate(act.created)} · ${SOURCE_LABELS[act.source] || act.source}${act.note ? ' · ' + esc(act.note) : ''}</span>
        <div class="tools">
          ${act.hasDocx ? `<a href="/master-files/${act.version}/${enc('Master CV.docx')}?download=1"><button class="small primary">.docx</button></a>` : ''}
          ${act.hasPdf ? `<a href="/master-files/${act.version}/${enc('Master CV.pdf')}/${enc(act.exportName + '.pdf')}?download=1" title="${esc(act.exportName)}.pdf"><button class="small">.pdf</button></a>
          <a href="/master-files/${act.version}/${enc('Master CV.pdf')}/${enc(act.exportName + '.pdf')}" target="_blank" rel="noopener"><button class="small">PDF ↗</button></a>` : ''}
          <button class="small" id="mEdit" ${editor ? 'disabled' : ''}>Править</button>
          <button class="small" id="mUpload" ${editor || mv.draft?.state === 'running' ? 'disabled' : ''}>Загрузить файл</button>
        </div>
      </div>
      <div class="row muted" style="margin-top:6px">
        ${act.pages ? `<span>${act.pages} стр., запас ${act.bottom_free_mm} мм</span>` : ''}
        ${act.avgMatch != null ? `<span>· средний матч с вакансиями ${pct(act.avgMatch)}</span>` : ''}
      </div>
      ${editor ? editorBlock(next) : act.hasPdf ? `<iframe class="pdf" src="/master-files/${act.version}/${enc('Master CV.pdf')}#view=FitH" title="Master CV v${act.version}"></iframe>` : ''}
    </div>

    <div class="card">
      <h2>История версий</h2>
      <div class="table-wrap"><table class="grid">
        <thead><tr><th>Версия</th><th>Дата</th><th>Источник</th><th>Комментарий</th><th>Изменение</th><th>Ср. матч</th><th>Стр.</th><th></th></tr></thead>
        <tbody>${mv.versions.map(versionRow).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>Адаптированные CV <span class="muted" style="font-weight:400">· ${mv.tailored.length}</span></h2>
      ${mv.tailored.length ? `<div class="table-wrap"><table class="grid">
        <thead><tr><th>Вакансия</th><th>Собрано</th><th>Из Master</th><th>Покрытие</th><th>Дрейф</th><th>Стр.</th><th>Статус</th><th></th></tr></thead>
        <tbody>${mv.tailored.map(tailoredRow).join('')}</tbody>
      </table></div>` : '<p class="muted">Пока нет — адаптируй CV на карточке вакансии.</p>'}
    </div>
  </div>`;
  bindMaster();
  if (editor) renderDiff();
}

function draftBanner() {
  const d = mv.draft;
  if (!d || (editor && editor.mode === 'draft')) return '';
  if (d.state === 'running') {
    return `<div class="card banner"><span class="running"><span class="spin"></span>Агент переносит «${esc(d.original)}» в формат CV…</span>
      <span class="muted" data-elapsed="${d.created}"></span><span class="muted">${esc(d.job?.last || '')}</span></div>`;
  }
  if (d.state === 'error') {
    return `<div class="card banner"><span class="error" style="margin:0">Импорт «${esc(d.original)}» не удался: ${esc(d.error)}</span>
      <button class="small" id="mDraftDrop">Убрать</button></div>`;
  }
  return '';
}

function versionRow(v) {
  return `<tr class="${v.active ? 'active' : ''}">
    <td class="num"><strong>v${v.version}</strong>${v.active ? ' <span class="chip good">актуальная</span>' : ''}</td>
    <td class="num">${fmtDate(v.created)}</td>
    <td>${SOURCE_LABELS[v.source] || v.source}${v.original_file && v.source === 'upload' ? `<div class="muted">${esc(v.original_file)}</div>` : ''}${v.restored_from ? `<div class="muted">копия v${v.restored_from}</div>` : ''}</td>
    <td>${esc(v.note || '')}</td>
    <td class="num">${v.change_vs_prev != null ? pctFine(v.change_vs_prev) : '—'}</td>
    <td class="num">${pct(v.avgMatch)}</td>
    <td class="num">${v.pages ?? '—'}</td>
    <td class="num">
      <button class="small" data-open="${v.version}">Открыть</button>
      ${v.hasDocx ? `<a href="/master-files/${v.version}/${enc('Master CV.docx')}?download=1"><button class="small">.docx</button></a>` : ''}
      ${v.source_file ? `<a href="/master-files/${v.version}/${enc(v.source_file)}?download=1"><button class="small" title="Исходный файл">исх.</button></a>` : ''}
      ${!v.active ? `<button class="small" data-restore="${v.version}">Сделать актуальной</button>` : ''}
    </td></tr>`;
}

function tailoredRow(t) {
  return `<tr>
    <td><a href="#" data-goto="${esc(t.name)}">${esc(t.role)}</a><div class="muted">${esc(t.company)}</div></td>
    <td class="num">${t.builtAt ? new Date(t.builtAt).toLocaleDateString('ru-RU') : '—'}</td>
    <td class="num"><span class="chip ${t.stale ? 'warn' : ''}">v${t.baseVersion}</span>${t.stale ? '<div class="muted">устарело</div>' : ''}</td>
    <td class="num">${pct(t.coverage)}</td>
    <td class="num ${t.changeOk === false ? 'error' : ''}">${pct(t.change)}</td>
    <td class="num">${t.pages ?? '—'}</td>
    <td>${STATUS_LABELS[t.status] || t.status}</td>
    <td class="num"><a href="/files/${enc(t.name)}/CV.docx?download=1" title="${esc(t.exportNames.cvDocx)}"><button class="small">.docx</button></a>
      ${t.hasPdf ? `<a href="/files/${enc(t.name)}/CV.pdf?download=1" title="${esc(t.exportNames.cvPdf)}"><button class="small">PDF</button></a>
        <a href="/files/${enc(t.name)}/CV.pdf/${enc(t.exportNames.cvPdf)}" target="_blank" rel="noopener" title="Открыть во вкладке"><button class="small">↗</button></a>` : ''}</td></tr>`;
}

function editorBlock(next) {
  const n = editor.notes;
  const list = (title, arr) => (arr?.length ? `<strong>${title}</strong><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const notes = n && (n.issues?.length || n.changes?.length || n.conflicts?.length)
    ? `<div class="notes">${list('Расхождения с базой знаний — проверь', n.conflicts)}${list('Что изменилось по смыслу', n.changes)}${list('Сомнения агента', n.issues)}</div>` : '';
  return `<div class="sub">
    <div class="row"><strong>${editor.mode === 'draft' ? `Ревью черновика из «${esc(editor.original)}»` : 'Правка Master CV'}</strong>
      <span class="muted">слева — текст в формате CV.md, справа — изменения относительно v${mv.active}</span></div>
    ${notes}
    <div class="editor">
      <textarea id="mText" spellcheck="false">${esc(editor.text)}</textarea>
      <div><div class="row" style="margin-bottom:6px"><span class="muted" id="mDiffStat"></span></div><div class="diff" id="mDiff"></div></div>
    </div>
    <div class="row" style="margin-top:12px">
      <input id="mNote" placeholder="Комментарий к версии (что поменял и зачем)" style="flex:1;min-width:220px" value="${esc(editor.note || '')}">
      <button id="mCheck">Проверить</button>
      <button id="mSave" class="primary">Сохранить как v${next}</button>
      <button id="mCancel">${editor.mode === 'draft' ? 'Отклонить черновик' : 'Отмена'}</button>
    </div>
    <div class="check" id="mCheckOut">${checkOut(editor.check)}</div>
  </div>`;
}

function checkOut(c) {
  if (!c) return '<span class="hint">Перед сохранением CV собирается в .docx и рендерится в PDF — проверяются структура и длина.</span>';
  if (c.busy) return '<span class="running"><span class="spin"></span>Собираю .docx и PDF…</span>';
  const parts = [];
  for (const e of c.errors || []) parts.push(`<div class="error" style="margin:2px 0">✕ ${esc(e)}</div>`);
  for (const w of c.warnings || []) parts.push(`<div style="color:var(--warn)">⚠ ${esc(w)}</div>`);
  if (c.ok) parts.unshift(`<div class="ok">✓ Структура в порядке · ${c.pages ?? '?'} стр., запас ${c.bottomFree ?? '?'} мм · ${c.words} слов · изменение к v${mv.active}: ${pctFine(c.change)}</div>`);
  return parts.join('');
}

// ---------- построчный diff (LCS) ----------

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', A[i++]]);
    else out.push(['add', B[j++]]);
  }
  while (i < n) out.push(['del', A[i++]]);
  while (j < m) out.push(['add', B[j++]]);
  return out;
}

function renderDiff() {
  const ta = $('#mText');
  if (!ta) return;
  const d = lineDiff(editor.base.trimEnd(), ta.value.trimEnd());
  const changed = d.filter(([k, l]) => k !== 'same' && l.trim()).length;
  // Неизменённые куски сворачиваем, оставляя по строке контекста
  const html = [];
  d.forEach(([k, line], idx) => {
    if (k === 'same') {
      const near = (o) => d[idx + o] && d[idx + o][0] !== 'same';
      if (!near(-1) && !near(1)) {
        if (html[html.length - 1] !== 'gap') html.push('gap');
        return;
      }
    }
    html.push(`<div class="${k}">${k === 'add' ? '+ ' : k === 'del' ? '− ' : '  '}${esc(line) || '&nbsp;'}</div>`);
  });
  $('#mDiff').innerHTML = changed
    ? html.map((h) => (h === 'gap' ? '<div class="gap">  ⋯</div>' : h)).join('')
    : '<div class="same">Отличий от актуальной версии нет.</div>';
  $('#mDiffStat').textContent = changed ? `изменено строк: ${changed}` : '';
}

// ---------- действия ----------

function bindMaster() {
  $('#mEdit')?.addEventListener('click', async () => {
    editor = { mode: 'edit', text: await activeText(), base: await activeText(), notes: null, check: null };
    renderMaster();
  });
  $('#mUpload')?.addEventListener('click', () => $('#masterFile').click());
  $('#mDraftDrop')?.addEventListener('click', async () => { await api('/api/master/draft', { method: 'DELETE' }); loadMaster(); });

  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
    const v = await api(`/api/master/versions/${b.dataset.open}`);
    $('#docTitle').textContent = `Master CV v${v.meta.version} · ${fmtDate(v.meta.created)}`;
    $('#docBody').innerHTML = v.html;
    $('#docDialog').showModal();
  }));
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const n = b.dataset.restore;
    if (!confirm(`Сделать v${n} актуальной? Будет создана новая версия — копия v${n}. История не теряется.`)) return;
    b.disabled = true;
    try { await api(`/api/master/versions/${n}/restore`, { method: 'POST' }); } catch (e) { alert(e.message); }
    loadMaster();
  }));
  document.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openVacancy(a.dataset.goto);
  }));

  const ta = $('#mText');
  if (!ta) return;
  let t;
  ta.addEventListener('input', () => {
    editor.text = ta.value;
    editor.check = null;
    $('#mCheckOut').innerHTML = checkOut(null);
    clearTimeout(t);
    t = setTimeout(renderDiff, 250);
  });
  $('#mNote').addEventListener('input', (e) => { editor.note = e.target.value; });
  $('#mCheck').addEventListener('click', runCheck);
  $('#mSave').addEventListener('click', async (e) => {
    const c = await runCheck();
    if (!c?.ok) return;
    if (c.change === 0 && !confirm('Текст не отличается от актуальной версии. Всё равно сохранить новую версию?')) return;
    e.target.disabled = true;
    try {
      await api('/api/master/versions', { method: 'POST', body: { text: editor.text, note: editor.note || '', fromDraft: editor.mode === 'draft' } });
      editor = null;
      await loadMaster();
    } catch (err) {
      e.target.disabled = false;
      alert(err.message);
    }
  });
  $('#mCancel').addEventListener('click', async () => {
    if (editor.mode === 'draft') {
      if (!confirm('Отклонить черновик? Новая версия не будет создана.')) return;
      await api('/api/master/draft', { method: 'DELETE' });
    }
    editor = null;
    loadMaster();
  });
}

async function runCheck() {
  const ed = editor; // пока шла проверка, редактор могли закрыть «Отменой»
  ed.check = { busy: true };
  $('#mCheckOut').innerHTML = checkOut(ed.check);
  let check;
  try {
    check = await api('/api/master/validate', { method: 'POST', body: { text: ed.text } });
  } catch (e) {
    check = { ok: false, errors: [e.message] };
  }
  if (editor !== ed) return null;
  ed.check = check;
  $('#mCheckOut').innerHTML = checkOut(check);
  return check;
}

$('#masterFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const res = await fetch('/api/master/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
      body: f,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) { alert(`Не удалось загрузить: ${err.message}`); }
  loadMaster();
});

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

route();
