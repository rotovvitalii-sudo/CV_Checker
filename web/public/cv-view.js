// ---------- моя версия CV (C15, docs/specs/40-my-cv-version.md) ----------
// Блок на странице заявки: загрузка своей версии, сравнение перед заменой, история и откат, факты из правок.

function cvCheckRow(label, before, after, ok = true) {
  const changed = before !== after;
  return `<tr><td>${label}</td><td class="mono">${esc(before ?? '—')}</td><td class="mono ${ok ? '' : 'warn-text'}">${changed ? `<strong>${esc(after ?? '—')}</strong>` : esc(after ?? '—')}</td></tr>`;
}
function cvMarks(ms) {
  return ms.map(([t, op]) => (op === '+' ? `<ins>${esc(t)}</ins>` : op === '-' ? `<del>${esc(t)}</del>` : esc(t))).join(' ');
}
function cvDraftHtml(d) {
  const r = d.cvDraft;
  if (!r) return '';
  if (r.state === 'running') return `<div class="cv-draft card-in">${d.jobs.cvlayout ? jobBlock(d.jobs.cvlayout) : '<div class="running"><span class="spin"></span>Читаю файл…</div>'}</div>`;
  if (r.state === 'error') {
    return `<div class="cv-draft card-in"><p class="error" style="margin:0">Файл «${esc(r.original)}» не загружен: ${esc(r.error)}</p>
      <div class="row" style="margin-top:8px"><button type="button" class="small" id="cvDraftDrop">Закрыть</button></div></div>`;
  }
  const c = r.compare, a = r.after, b = r.before || {};
  const n = c.counts;
  const secs = c.sections.map((s) => `<div class="cv-sec"><h4>${esc(s.title)}</h4>
    ${s.changed.map((x) => `<p class="cv-ch">${cvMarks(x.marks)}</p>`).join('')}
    ${s.added.map((x) => `<p class="cv-ch"><ins>${esc(x)}</ins></p>`).join('')}
    ${s.removed.map((x) => `<p class="cv-ch"><del>${esc(x)}</del></p>`).join('')}</div>`).join('');
  return `<div class="cv-draft card-in">
    <h3 class="st-h" style="margin-top:0">Что изменилось: ${esc(r.original)}</h3>
    ${r.foreign ? `<p class="warn-text small">Файл совпадает с текущим CV только на ${Math.round(c.similarity * 100)}% — похоже, это другой файл.</p>` : ''}
    ${c.same ? '<p class="muted small">Текст тот же, отличается только оформление. Файл заменится, агент не запустится.</p>'
      : `<p class="muted small">Изменено строк: ${n.changed} · добавлено: ${n.added} · убрано: ${n.removed}</p><div class="cv-diff">${secs}</div>`}
    <table class="cv-checks small"><thead><tr><th></th><th>Сейчас</th><th>Твоя версия</th></tr></thead><tbody>
      ${cvCheckRow('Покрытие', pct(b.coverage), pct(a.coverage), a.coverage == null || a.coverage >= 0.6)}
      ${cvCheckRow('Обязательные', b.must, a.must)}
      ${cvCheckRow('Верхняя треть', b.topThird ? (b.topThird.pass ? 'ок' : 'нет') : null, a.topThird ? (a.topThird.pass ? 'ок' : 'нет') : null, !a.topThird || a.topThird.pass)}
      ${cvCheckRow('Страниц', b.pages, a.pages, a.pages == null || a.pages === 1)}
      ${cvCheckRow('Дрейф от Master', pctFine(b.change), pctFine(a.change), a.changeOk !== false)}
      ${cvCheckRow('Факты сходятся с базой', !b.evidence ? null : b.evidence.pass ? 'да' : 'нет', !a.evidence ? null : a.evidence.pass ? 'да' : 'нет', !a.evidence || a.evidence.pass)}
      ${cvCheckRow('Шапка с названием роли', b.taglineOk == null ? null : b.taglineOk ? 'да' : 'нет', a.taglineOk == null ? null : a.taglineOk ? 'да' : 'нет', a.taglineOk !== false)}
    </tbody></table>
    <p class="muted small" style="margin:6px 0 0">Проверки только предупреждают: решение за тобой.${r.ext === '.pdf' ? ' PDF останется твоим байт в байт, DOCX соберётся нашим оформлением из текста.' : ' Твой DOCX останется как есть, PDF соберётся из него.'}</p>
    <div class="row" style="margin-top:10px">
      <button type="button" class="primary small" id="cvApply">Сделать актуальной</button>
      <button type="button" class="small" id="cvDraftDrop">Отмена</button></div>
    <p class="error" id="cvErr"></p></div>`;
}

function myCvBlock(d) {
  const mine = d.cvAuthor === 'me';
  const hist = (d.cvVersions || []);
  const sentV = d.sent?.cvVersion;
  const row = (v) => `<li><span>v${v.version} · ${v.author === 'me' ? 'твоя' : 'агент'}${v.original ? ` · ${esc(v.original)}` : ''}${v.at ? ` · ${fmtDay(v.at)}` : ''}
      ${v.current ? ' · <strong>актуальная</strong>' : ''}${v.restoredFrom ? ` · возврат к v${v.restoredFrom}` : ''}${sentV === v.version ? ' · <span class="chip info">отправлена</span>' : ''}</span>
    ${v.current ? '' : `<span class="row" style="gap:8px"><a href="/api/vacancies/${enc(d.name)}/cv-versions/${v.version}/CV.pdf?download=1">PDF</a>
      <a href="/api/vacancies/${enc(d.name)}/cv-versions/${v.version}/CV.docx?download=1">DOCX</a>
      <button type="button" class="link-btn inline" data-cvrestore="${v.version}">вернуть</button></span>`}</li>`;
  const q = `Правки в адаптированном CV (версия ${d.cvVersion})`;
  return `<div class="my-cv">
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${mine ? `<span class="chip good">Твоя версия${d.cvFile ? ` · ${esc(d.cvFile)}` : ''}${d.cvAt ? ` · ${fmtDay(d.cvAt)}` : ''}</span>` : ''}
      <label class="btn small-btn" for="cvFile">Загрузить свою версию</label>
      <input type="file" id="cvFile" accept=".docx,.pdf" class="sr-only">
      <span class="hint" style="margin:0">Поправил CV в Word или Google Docs? Загрузи DOCX или PDF — сначала покажем, что изменилось.</span>
    </div>
    <p class="error" id="cvUpErr"></p>
    ${(d.cvOutdated || []).length ? `<p class="warn-text small" style="margin:6px 0 0">CV изменилось после: ${d.cvOutdated.map(esc).join(', ')}. Пересобери, если правки важны.</p>` : ''}
    ${d.cvFacts ? factsLine(d.cvFacts, q, d.cvFactsText) : ''}
    ${cvDraftHtml(d)}
    ${hist.length > 1 ? `<details class="cv-hist"><summary class="small">История версий · ${hist.length}</summary><ul class="tight small">${hist.map(row).join('')}</ul></details>` : ''}
  </div>`;
}

function bindMyCv(d) {
  $('#cvFile')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('#cvUpErr').textContent = '';
    try {
      const res = await fetch(`/api/vacancies/${enc(d.name)}/cv-upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) { $('#cvUpErr').textContent = err.message; return; }
    loadDetail();
  });
  $('#cvDraftDrop')?.addEventListener('click', async () => {
    await api(`/api/vacancies/${enc(d.name)}/cv-upload`, { method: 'DELETE' }).catch(() => {});
    loadDetail();
  });
  $('#cvApply')?.addEventListener('click', async (e) => {
    const foreign = d.cvDraft?.foreign;
    if (foreign && !confirm('Файл не похож на текущее CV. Точно сделать его актуальным?')) return;
    e.target.disabled = true;
    try { await api(`/api/vacancies/${enc(d.name)}/cv-upload/apply`, { method: 'POST', body: { force: !!foreign } }); }
    catch (err) { $('#cvErr').textContent = err.message; e.target.disabled = false; return; }
    await loadDetail();
    loadList();
  });
  document.querySelectorAll('[data-cvrestore]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Вернуть версию ${b.dataset.cvrestore}? Текущая останется в истории.`)) return;
    try { await api(`/api/vacancies/${enc(d.name)}/cv-versions/${b.dataset.cvrestore}/restore`, { method: 'POST', body: {} }); } catch (err) { alert(err.message); }
    await loadDetail();
    loadList();
  }));
}
