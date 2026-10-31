// Разбор вакансии «коротко» (M2, docs/specs/02-vacancy-brief.md).
// Собирается из того, что уже лежит в пакете: таблицы must-требований в 02-match-report.md
// (со статусом ✅/🟡/❌ и доказательством) или в 01-requirements.md, плюс фит и матч с Master CV.
// Агент не запускается — это чтение файлов.
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const clean = (s) => String(s || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();

// Секция «## <title>», где title подходит под re; возвращает текст до следующего «## »
function section(md, re) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && re.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

// Первая markdown-таблица секции → [{колонка: значение}]
function table(text) {
  const rows = text.split('\n').filter((l) => /^\s*\|/.test(l));
  if (rows.length < 2) return [];
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  return rows.slice(1)
    .filter((l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l))
    .map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i] || `c${i}`, c])));
}

const col = (row, re) => {
  const k = Object.keys(row).find((h) => re.test(h));
  return k ? row[k] : '';
};

function status(s) {
  if (/❌|GAP/i.test(s)) return 'gap';
  if (/🟡|частич/i.test(s)) return 'partial';
  if (/✅/.test(s)) return 'yes';
  return null;
}

const MUST_RE = /^##\s+must\b/i;

function requirements(dir) {
  const report = read(path.join(dir, '02-match-report.md'));
  const rows = table(section(report, MUST_RE));
  if (rows.length) {
    return {
      source: '02-match-report.md',
      items: rows.map((r) => {
        const evidence = col(r, /доказ|чем закрыть|коммент/i);
        return {
          id: clean(col(r, /^#$/)),
          text: clean(col(r, /требован/i)),
          status: status(col(r, /статус/i)),
          evidence: clean(evidence),
          cards: [...new Set([...evidence.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]))],
        };
      }).filter((r) => r.text),
    };
  }
  const req = read(path.join(dir, '01-requirements.md'));
  const rrows = table(section(req, MUST_RE));
  return {
    source: rrows.length ? '01-requirements.md' : null,
    items: rrows.map((r) => ({
      id: clean(col(r, /^#$/)),
      text: clean(col(r, /требован/i)),
      status: null,
      evidence: clean(col(r, /доказ/i)),
      cards: [],
    })).filter((r) => r.text),
  };
}

// «Кто нужен в одной фразе» / «Что это за работа» / «Контекст роли» — первый абзац
function summary(dir) {
  const req = read(path.join(dir, '01-requirements.md'));
  const text = section(req, /кто нужен|что это за работа|контекст|одной фразе/i);
  const para = text.split(/\n\s*\n/).map(clean).find((p) => p && !p.startsWith('|'));
  return para || '';
}

function daysAgo(posted) {
  const s = String(posted || '').trim();
  // Himalayas отдаёт unix-время строкой
  const t = /^\d{9,11}$/.test(s) ? Number(s) * 1000 : Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 864e5));
}

// V2: покрытие корзин требований — та же логика совпадения, что term_regex в scorer/check_cv.py
function termRegex(term) {
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alts = String(term).split('|').map((a) => a.trim()).filter(Boolean).map((a) => {
    const words = a.split(/\s+/).map(esc);
    words[words.length - 1] += '(?:s|es|ing|ed)?';
    return `\\b${words.join('[\\s\\-/]+')}\\b`;
  });
  return alts.length ? new RegExp(alts.join('|'), 'i') : null;
}
const mdText = (md) => md.replace(/^#{1,3}\s+/gm, '').replace(/^\s*-\s+/gm, '').replace(/\*\*/g, '').replace(/_/g, ' ');

const BUCKETS = [['minimum', 'Минимум'], ['desired', 'Желательно'], ['wishlist', 'Вишлист']];
function buckets(fit, dir, masterFile) {
  const b = fit?.buckets;
  if (!b || !BUCKETS.some(([k]) => b[k]?.length)) return null;
  const cvFile = fs.existsSync(path.join(dir, 'CV.md')) ? path.join(dir, 'CV.md') : masterFile;
  const text = mdText(read(cvFile || ''));
  return {
    against: cvFile && cvFile !== masterFile ? 'cv' : 'master',
    groups: BUCKETS.map(([key, label]) => {
      const items = (b[key] || []).map((x) => {
        const re = termRegex(x.kw || x.req);
        return { req: clean(x.req), kw: clean(x.kw), hit: !!(re && text && re.test(text)) };
      });
      return { key, label, items, hit: items.filter((x) => x.hit).length, total: items.length };
    }).filter((g) => g.total),
  };
}

const known = (v) => (v && !/^(unknown|n\/a|none|null|-|—)$/i.test(String(v).trim()) ? String(v).trim() : '');

function build({ dir, fit, master, url, masterFile }) {
  const f = fit || {};
  const req = requirements(dir);
  const counts = { yes: 0, partial: 0, gap: 0 };
  for (const r of req.items) if (r.status) counts[r.status] += 1;
  return {
    task: known(f.current_task),
    pain: known(f.pain),
    situation: known(f.situation),
    buckets: buckets(f, dir, masterFile),
    who: summary(dir),
    doing: (f.what_you_do || []).map(clean).filter(Boolean).slice(0, 5),
    requirements: req.items,
    requirementsSource: req.source,
    counts,
    why: known(f.why),
    anchor: known(f.anchor_case),
    matched: master?.mustHit || [],
    gaps: (f.gaps || []).map(clean).filter(Boolean),
    missing: master?.mustMiss || [],
    conditions: {
      salary: known(f.salary),
      format: known(f.work_format),
      location: known(f.location),
      seniority: known(f.seniority),
      source: known(f.source),
      posted: known(f.date_posted),
      postedDaysAgo: daysAgo(f.date_posted),
      url: url || '',
    },
  };
}

// Для списка и статистики (V3 P1): закрыт ли минимум — {hit, total} или null
function minimum(fit, dir, masterFile) {
  const g = buckets(fit, dir, masterFile)?.groups.find((x) => x.key === 'minimum');
  return g ? { hit: g.hit, total: g.total } : null;
}

module.exports = { build, requirements, summary, minimum };
