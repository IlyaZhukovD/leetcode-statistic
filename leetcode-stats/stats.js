'use strict';
// Чистые функции без chrome.* — их можно тестировать отдельно.

const DIFFS = ['Easy', 'Medium', 'Hard'];

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayDate = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const tsToDayKey = (ts) => dayKey(new Date(ts * 1000));

function plural(n, forms) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}

/**
 * subs: [{id, slug, title, status, ts, lang}]
 * questions: {slug: {id, title, difficulty}}
 * Задача считается решённой в периоде, если в периоде есть её Accepted.
 * День задачи — день первого Accepted в периоде.
 * Попытки — число отправок в периоде до первого Accepted включительно.
 */
function computeStats(subs, questions, startTs, endTs) {
  const list = subs
    .filter((s) => s.ts >= startTs && s.ts < endTs)
    .sort((a, b) => a.ts - b.ts || Number(a.id) - Number(b.id));

  const per = new Map();
  for (const s of list) {
    let p = per.get(s.slug);
    if (!p) { p = { slug: s.slug, title: s.title, attempts: 0, totalSubs: 0, acTs: null, lastTs: 0 }; per.set(s.slug, p); }
    p.totalSubs++;
    p.lastTs = s.ts;
    if (p.acTs !== null) continue;
    p.attempts++;
    if (s.status === 'Accepted') p.acTs = s.ts;
  }

  const solved = [], unsolved = [];
  for (const p of per.values()) {
    const q = questions[p.slug] || {};
    p.difficulty = DIFFS.includes(q.difficulty) ? q.difficulty : 'Unknown';
    p.frontId = q.id || null;
    if (q.title) p.title = q.title;
    (p.acTs !== null ? solved : unsolved).push(p);
  }

  const byDiff = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
  const attemptsByDiff = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
  let attemptsSum = 0, firstTry = 0;
  const days = {};
  for (const p of solved) {
    byDiff[p.difficulty]++;
    attemptsByDiff[p.difficulty] += p.attempts;
    attemptsSum += p.attempts;
    if (p.attempts === 1) firstTry++;
    const k = tsToDayKey(p.acTs);
    (days[k] ||= []).push(p);
  }
  for (const k in days) days[k].sort((a, b) => a.acTs - b.acTs);

  const avgByDiff = {};
  for (const d of [...DIFFS, 'Unknown']) avgByDiff[d] = byDiff[d] ? attemptsByDiff[d] / byDiff[d] : null;

  return {
    total: solved.length,
    byDiff,
    avgAttempts: solved.length ? attemptsSum / solved.length : null,
    avgByDiff,
    firstTry,
    totalSubs: list.length,
    activeDays: Object.keys(days).length,
    days,
    unsolved: unsolved.sort((a, b) => b.lastTs - a.lastTs),
  };
}

if (typeof module !== 'undefined') {
  module.exports = { DIFFS, dayKey, parseDay, addDays, todayDate, tsToDayKey, plural, computeStats };
}
