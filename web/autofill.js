// Заполнение формы заявки (C11, docs/specs/22-autofill-application.md): серверная часть.
// Ссылка на форму по системе найма, ответы без агента (профиль, файлы, память прошлых форм),
// сохранение новых ответов в базу: фактические → стандартные ответы, про опыт → надиктовка + предложение в базу кейсов.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./agent');
const store = require('./store');
const cases = require('./cases');

const MEMORY = path.join(store.DATA, 'form-memory.json');
const PROFILE_ANSWERS = path.join(ROOT, 'knowledge-base', 'profile-answers.md');

// Поддерживаемые системы найма и адрес страницы с формой
const ATS = [
  { ats: 'ashby', re: /^https:\/\/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}/i, form: (m) => `${m[0]}/application` },
  { ats: 'lever', re: /^https:\/\/jobs\.(eu\.)?lever\.co\/[^/]+\/[0-9a-f-]{36}/i, form: (m) => `${m[0]}/apply` },
  { ats: 'greenhouse', re: /^https:\/\/(job-boards|boards)(\.eu)?\.greenhouse\.io\/[^/]+\/jobs\/\d+/i, form: (m) => m[0] },
  { ats: 'workable', re: /^https:\/\/apply\.workable\.com\/[^/]+\/j\/[A-Z0-9]+/i, form: (m) => `${m[0]}/apply/` },
  { ats: 'smartrecruiters', re: /^https:\/\/jobs\.smartrecruiters\.com\/[^/]+\/\d+[^?#]*/i, form: (m) => m[0] },
  { ats: 'recruitee', re: /^https:\/\/[a-z0-9-]+\.recruitee\.com\/o\/[^/?#]+/i, form: (m) => `${m[0]}/c/new` },
  { ats: 'personio', re: /^https:\/\/[a-z0-9-]+\.jobs\.personio\.(de|com)\/job\/\d+/i, form: (m) => m[0] },
];

function applyTarget(info) {
  const urls = [info.apply, info.url].map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//.test(u));
  for (const u of urls) {
    for (const a of ATS) {
      const m = u.match(a.re);
      if (m) return { ats: a.ats, url: a.form(m), source: u };
    }
  }
  const email = String(info.apply || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const reason = email ? `заявка по email (${email[0]}) — отправь письмо сам`
    : urls.length ? 'форма не на поддерживаемой системе найма (Ashby, Lever, Greenhouse, Workable, SmartRecruiters, Recruitee, Personio)'
      : 'у вакансии нет ссылки на форму';
  return { ats: null, url: null, reason };
}

// Имя и контакты — из шапки CV заявки (или базового CV)
function contacts(dir) {
  const p = fs.existsSync(path.join(dir, 'CV.md')) ? path.join(dir, 'CV.md') : path.join(ROOT, 'knowledge-base', 'base-cv.md');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const name = (lines.find((l) => l.startsWith('# ')) || '').slice(2).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const line = lines.find((l) => /@/.test(l)) || '';
  const parts = line.split('|').map((s) => s.trim());
  const email = (line.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
  const phone = (parts.find((s) => /^\+?[\d\s()-]{8,}$/.test(s)) || '');
  const linkedin = (parts.find((s) => /linkedin\.com/i.test(s)) || '');
  return { name, email, phone, linkedin: linkedin && !/^https?:/.test(linkedin) ? `https://${linkedin}` : linkedin, location: parts[0] || '' };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-я]+/g, ' ').trim();

function memory() { try { return JSON.parse(fs.readFileSync(MEMORY, 'utf8')); } catch { return {}; } }
function remember(entries) {
  const m = memory();
  for (const e of entries) {
    if (!e.label || e.value == null || e.value === '' || e.file) continue;
    m[norm(e.label)] = { label: e.label, value: e.value, source: e.source || 'user', at: new Date().toISOString() };
  }
  fs.writeFileSync(MEMORY, JSON.stringify(m, null, 2));
}

// Ответы без агента: файлы, контакты, память прошлых форм. Остальное — агенту (или тебе)
function preAnswers(fields, dir) {
  const c = contacts(dir);
  const mem = memory();
  const files = {
    resume: fs.existsSync(path.join(dir, 'CV.pdf')) ? path.join(dir, 'CV.pdf') : null,
    cover: fs.existsSync(path.join(dir, 'Cover Letter.pdf')) ? path.join(dir, 'Cover Letter.pdf') : null,
  };
  const out = {};
  for (const f of fields) {
    const l = norm(f.label);
    if (f.sensitive) { out[f.key] = { status: 'user', note: 'личные данные или согласие — заполни сам' }; continue; }
    if (f.type === 'file') {
      const p = files[f.file];
      out[f.key] = p ? { status: 'ok', value: p, display: path.basename(p), source: f.file === 'cover' ? 'Cover Letter.pdf' : 'CV.pdf' }
        : { status: 'skip', note: f.file === 'other' ? 'не прикладываем' : 'файла нет' };
      continue;
    }
    const pick = (value, source) => { out[f.key] = { status: 'ok', value, source }; };
    if (/^(full )?name$|^your name|^first and last/.test(l) && c.name) pick(c.name, 'шапка CV');
    else if (/^first name/.test(l) && c.name) pick(c.name.split(' ')[0], 'шапка CV');
    else if (/^last name|surname/.test(l) && c.name) pick(c.name.split(' ').slice(1).join(' '), 'шапка CV');
    else if (f.type === 'email' || /^e ?mail/.test(l)) { if (c.email) pick(c.email, 'шапка CV'); }
    else if (f.type === 'tel' || /^phone|mobile/.test(l)) { if (c.phone) pick(c.phone, 'шапка CV'); }
    else if (/linkedin/.test(l)) { if (c.linkedin) pick(c.linkedin, 'шапка CV'); }
    else if (/^(current )?location|^city|where are you (based|located)/.test(l) && c.location) pick(c.location, 'шапка CV');
    else if (/(twitter|github|portfolio|other website)/.test(l) && !f.required) out[f.key] = { status: 'skip', note: 'нет в базе, необязательно' };
    else if (mem[l]) pick(mem[l].value, `прошлая форма (${mem[l].source})`);
  }
  return out;
}

// Ответ про опыт — твоя надиктовка: сохраняется дословно в raw/ и предлагается в базу кейсов (C9)
function saveExperienceAnswer({ question, answer, vacancy }) {
  const d = new Date().toISOString().slice(0, 10);
  const slug = norm(vacancy).replace(/ /g, '-').slice(0, 40) || 'form';
  let file = `${d}-form-${slug}.md`;
  for (let i = 2; fs.existsSync(path.join(cases.RAW, file)); i++) file = `${d}-form-${slug}-${i}.md`;
  fs.writeFileSync(path.join(cases.RAW, file), `---\ndate: ${d}\ntopic: ответ в форме заявки — ${vacancy}\nvacancy: vacancies/${vacancy}.md\ntype: form-answer\n---\n\nВопрос: ${question}\n\n${answer}\n`);
  cases.addSuggestions([{ fact: `${question.slice(0, 140)} → ${answer.slice(0, 140)}`, quote: answer.slice(0, 400), card: null, source: file, vacancy }], 'form');
  return file;
}

// Фактический ответ — в раздел стандартных ответов (S4); раздел выбирает агент, иначе «Other / прочее»
function saveFactualAnswer({ question, answer, section }) {
  let md = fs.existsSync(PROFILE_ANSWERS) ? fs.readFileSync(PROFILE_ANSWERS, 'utf8') : '# Стандартные ответы для форм заявок\n';
  const heads = [...md.matchAll(/^## (.+)$/gm)];
  const target = heads.find((h) => section && norm(h[1]).includes(norm(section).split(' ')[0])) || heads.find((h) => /^other/i.test(h[1]));
  // С вопросом: голое «No» в разделе ничего не скажет в следующей форме
  const entry = `- ${question.replace(/\s+/g, ' ').trim()} — ${answer}`;
  if (!target) md = `${md.trimEnd()}\n\n## Other / прочее\n${entry}\n`;
  else {
    const start = target.index + target[0].length;
    const next = md.slice(start).search(/\n## /);
    const end = next === -1 ? md.length : start + next;
    const body = md.slice(start, end).trim();
    md = `${md.slice(0, start)}\n${body ? `${body}\n` : ''}${entry}\n${md.slice(end)}`;
  }
  fs.writeFileSync(PROFILE_ANSWERS, md);
  return target ? target[1] : 'Other / прочее';
}

module.exports = { applyTarget, contacts, preAnswers, memory, remember, saveExperienceAnswer, saveFactualAnswer, norm };
