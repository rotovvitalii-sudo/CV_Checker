#!/usr/bin/env node
// Заполнение формы заявки (C11, docs/specs/22-autofill-application.md) — Playwright.
//
//   node web/autofill/form.js inspect <url> <out.json>          — разбор формы (без окна)
//   node web/autofill/form.js fill <url> <answers.json> <run.json> <shot.png>
//                                                              — видимое окно, заполнить, НЕ нажимать Submit
//
// Submit всегда нажимает человек. Поля про пол/расу/инвалидность/ветеранов и галочки согласия агент не трогает.
// Браузер — установленный Google Chrome с отдельным профилем приложения (web/data/browser-profile): без паролей и cookies пользователя.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Установленный Google Chrome (скачивание Chromium Playwright из сети недоступно); профиль — свой, отдельный
const CHANNEL = process.env.CVC_BROWSER_CHANNEL || 'chrome';

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = path.join(ROOT, 'web', 'data', 'browser-profile');
const CLOSED_RE = /job not found|no longer (available|accepting|open)|position (has been )?(filled|closed)|this job is (closed|no longer)|job (has been )?(closed|expired)|page not found/i;
const DONE_RE = /thank you for (applying|your application)|application (has been )?(submitted|received)|we('|’)ve received your application|successfully (submitted|applied)/i;

// Выполняется в странице: находит поля формы в порядке документа. Тот же алгоритм используется при заполнении,
// поэтому ключ поля (f0, f1…) совпадает между разбором и заполнением; дополнительно сверяется подпись.
function extract() {
  const SENSITIVE = /gender|pronoun|race|ethnic|hispanic|latino|veteran|disab|sexual orientation|transgender|consent|i agree|privacy|terms|future (job )?opportunit|marketing|newsletter/i;
  const CONTAINERS = '.ashby-application-form-field-entry, .application-question, li.application-question, [data-ui="field"], .field, .form-group, fieldset';
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const clean = (s) => String(s || '').replace(/[✱*]\s*$/, '').replace(/\s+/g, ' ').trim();
  const labelOf = (el, box) => {
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const own = box && box.querySelector('label, legend, .application-label, [class*="label"]');
    return clean((byFor || own)?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name || '');
  };
  const controls = [...document.querySelectorAll('input, textarea, select')]
    .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(el.type))
    .filter((el) => el.type === 'file' || visible(el) || el.type === 'checkbox' || el.type === 'radio');
  const seen = new Set();
  const fields = [];
  for (const el of controls) {
    const box = el.closest(CONTAINERS) || el.parentElement;
    let groupKey = el.type === 'radio' || el.type === 'checkbox' ? `${el.name || ''}|${box ? [...document.querySelectorAll(CONTAINERS)].indexOf(box) : ''}` : null;
    if (groupKey && seen.has(groupKey)) continue;
    if (groupKey) seen.add(groupKey);
    const label = labelOf(el, box);
    const desc = box ? clean([...box.querySelectorAll('p, .description, [class*="description"]')].map((p) => p.innerText).join(' | ')).slice(0, 1200) : '';
    let type = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : el.type || 'text';
    let options = [];
    const buttons = box ? [...box.querySelectorAll('button')].map((b) => clean(b.innerText)).filter(Boolean) : [];
    if (el.type === 'checkbox' && buttons.length >= 2 && buttons.every((b) => /^(yes|no|да|нет|tak|nie)$/i.test(b))) {
      type = 'boolean'; options = buttons;
    } else if (el.getAttribute('role') === 'combobox') {
      type = 'combobox';
    } else if (el.tagName === 'SELECT') {
      options = [...el.options].map((o) => clean(o.textContent)).filter((t) => t && !/^select|^choose|^--/i.test(t));
    } else if (el.type === 'radio' || el.type === 'checkbox') {
      const group = el.name ? [...(box || document).querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
      options = group.map((g) => clean((g.id && document.querySelector(`label[for="${CSS.escape(g.id)}"]`)?.innerText) || g.closest('label')?.innerText || g.value));
      if (el.type === 'checkbox' && group.length === 1) type = 'checkbox_single';
    }
    // Обязательность: атрибут, aria или звёздочка в подписи — в том числе нарисованная стилем (::after у Ashby)
    const lab = box?.querySelector('label, legend, .application-label');
    const star = lab && (/✱|\*\s*$/.test(lab.innerText) || /\*/.test(getComputedStyle(lab, '::after').content) || /required/i.test(lab.className));
    fields.push({
      key: `f${fields.length}`, label, type, required: !!(el.required || el.getAttribute('aria-required') === 'true' || star),
      options, description: desc && desc !== label ? desc : '', limit: el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : null,
      sensitive: SENSITIVE.test(label) || SENSITIVE.test(desc.slice(0, 200)),
      file: type === 'file' ? (/cover|letter|motivation/i.test(label) ? 'cover' : /resume|cv/i.test(label) ? 'resume' : 'other') : undefined,
    });
  }
  return { title: document.title, url: location.href, text: document.body.innerText.slice(0, 3000), fields };
}

async function openPage(context, url) {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Формы на React дорисовываются после загрузки
  await page.waitForTimeout(3500);
  return page;
}

async function inspect(url, out) {
  const browser = await chromium.launch({ headless: true, channel: CHANNEL });
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await openPage(context, url);
  const r = await page.evaluate(extract);
  const closed = CLOSED_RE.test(r.text) && r.fields.length < 3;
  fs.writeFileSync(out, JSON.stringify({ url: r.url, title: r.title, closed, fields: r.fields, inspected: new Date().toISOString() }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ ok: true, fields: r.fields.length, closed }));
}

// Локатор поля по ключу из разбора: тот же порядок элементов, что в extract()
async function fieldHandles(page) {
  return page.evaluateHandle(() => {
    const CONTAINERS = '.ashby-application-form-field-entry, .application-question, li.application-question, [data-ui="field"], .field, .form-group, fieldset';
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const controls = [...document.querySelectorAll('input, textarea, select')]
      .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(el.type))
      .filter((el) => el.type === 'file' || visible(el) || el.type === 'checkbox' || el.type === 'radio');
    const seen = new Set();
    const out = [];
    for (const el of controls) {
      const box = el.closest(CONTAINERS) || el.parentElement;
      const g = el.type === 'radio' || el.type === 'checkbox' ? `${el.name || ''}|${box ? [...document.querySelectorAll(CONTAINERS)].indexOf(box) : ''}` : null;
      if (g && seen.has(g)) continue;
      if (g) seen.add(g);
      out.push({ el, box });
    }
    return out;
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-я]+/g, ' ').trim();

async function mark(page, el, ok, note) {
  await el.evaluate((n, [good, title]) => {
    // Скрытые элементы (файл, чекбокс под кнопками Да/Нет) — подсвечиваем строку поля целиком
    const hidden = !(n.offsetWidth || n.offsetHeight) || n.type === 'file' || n.type === 'checkbox';
    const t = hidden ? (n.closest('.ashby-application-form-field-entry, .application-question, .field, fieldset') || n.parentElement) : n;
    t.style.outline = good ? '2px solid #2e9e6a' : '3px solid #d9480f';
    t.style.outlineOffset = '2px';
    if (title) t.title = title;
  }, [ok, note || '']).catch(() => {});
}

async function fillOne(page, item, f, a) {
  const el = await item.getProperty('el');
  const box = await item.getProperty('box');
  const v = a.value;
  switch (f.type) {
    case 'file': await el.asElement().setInputFiles(v); break;
    case 'select': await el.asElement().selectOption({ label: String(v) }); break;
    case 'boolean': {
      const btn = await box.asElement().$(`button:text-is("${String(v).replace(/"/g, '')}")`);
      if (!btn) throw new Error(`нет кнопки «${v}»`);
      await btn.click();
      break;
    }
    case 'radio': case 'checkbox': {
      const want = (Array.isArray(v) ? v : [v]).map(norm);
      const inputs = await box.asElement().$$(`input[type="${f.type}"]`);
      let hit = 0;
      for (const inp of inputs) {
        const lab = await inp.evaluate((n) => (n.id && document.querySelector(`label[for="${CSS.escape(n.id)}"]`)?.innerText) || n.closest('label')?.innerText || n.value);
        if (want.includes(norm(lab))) { await inp.check({ force: true }); hit += 1; }
      }
      if (!hit) throw new Error(`нет варианта «${v}»`);
      break;
    }
    case 'checkbox_single': if (/^(yes|true|да)$/i.test(String(v))) await el.asElement().check({ force: true }); break;
    case 'combobox': {
      await el.asElement().fill(String(v));
      await page.waitForTimeout(1500);
      const opt = await page.$('[role="option"]');
      if (opt) await opt.click(); else await el.asElement().press('Enter');
      break;
    }
    default: await el.asElement().fill(String(v));
  }
  await mark(page, el.asElement(), true, a.source ? `источник: ${a.source}` : '');
}

async function fill(url, answersPath, runPath, shotPath) {
  const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
  const write = (r) => fs.writeFileSync(runPath, JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2));
  write({ state: 'opening' });
  fs.mkdirSync(PROFILE, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, { headless: false, channel: CHANNEL, viewport: null, locale: 'en-US', args: ['--start-maximized'] });
  const page = await openPage(context, url);
  const live = await page.evaluate(extract);
  const handles = await fieldHandles(page);
  const filled = [];
  const unfilled = [];
  for (const f of answers.fields) {
    const a = answers.answers[f.key];
    const idx = live.fields.findIndex((x, i) => (x.key === f.key && norm(x.label) === norm(f.label)) || (norm(x.label) === norm(f.label) && i >= 0));
    const item = idx >= 0 ? await handles.getProperty(String(idx)) : null;
    if (!item || !a || a.status !== 'ok' || a.value == null || a.value === '') {
      const why = !item ? 'поле не найдено на странице' : f.sensitive ? 'заполни сам (личные данные или согласие)' : a?.status === 'ask' ? 'нет ответа в базе' : 'оставлено тебе';
      // Подсвечиваем только то, что требует тебя: обязательное, личное или вопрос без ответа
      const needsYou = f.required || f.sensitive || a?.status === 'ask';
      if (item && needsYou) await mark(page, (await item.getProperty('el')).asElement(), false, why);
      if (needsYou) unfilled.push({ key: f.key, label: f.label, why });
      continue;
    }
    try {
      await fillOne(page, item, f, a);
      filled.push({ key: f.key, label: f.label, value: a.display || a.value, source: a.source });
    } catch (e) {
      const el = (await item.getProperty('el')).asElement();
      if (el) await mark(page, el, false, String(e.message).slice(0, 120));
      unfilled.push({ key: f.key, label: f.label, why: `не удалось: ${String(e.message).slice(0, 100)}` });
    }
  }
  await page.waitForTimeout(800);
  try { await page.screenshot({ path: shotPath, fullPage: true }); } catch {}
  write({ state: 'filled', filled, unfilled });
  // Окно — твоё: проверяешь и нажимаешь Submit. Следим только за страницей подтверждения и закрытием окна.
  let done = false;
  const finish = (state) => { if (done) return; done = true; write({ state, filled, unfilled }); };
  context.on('close', () => { finish('closed'); process.exit(0); });
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let text = '';
    try { text = await page.evaluate(() => document.body.innerText.slice(0, 4000)); } catch { break; }
    if (DONE_RE.test(text)) { finish('submitted'); break; }
  }
  if (!done) finish('closed');
}

const [, , cmd, ...args] = process.argv;
(cmd === 'inspect' ? inspect(...args) : cmd === 'fill' ? fill(...args) : Promise.reject(new Error('inspect | fill')))
  .catch((e) => { console.error(e.message); process.exit(1); });
