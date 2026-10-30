'use strict';
/* global DIFFS, dayKey, parseDay, addDays, todayDate, plural, computeStats */

const LC = 'https://leetcode.com';
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get: async (k, d) => (await chrome.storage.local.get(k))[k] ?? d,
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ───────────────────────── Работа с LeetCode ─────────────────────────
// Запросы выполняются внутри вкладки leetcode.com — так используются твои
// cookie и CSRF-токен, как будто запрос делает сам сайт.

// Эта функция сериализуется и выполняется в контексте вкладки LeetCode.
async function pageFetch(req) {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  const opts = { method: req.method || 'GET', credentials: 'include', headers: {} };
  if (m) opts.headers['x-csrftoken'] = m[1];
  if (req.body) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(req.body);
  }
  try {
    const r = await fetch(req.url, opts);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* не JSON */ }
    return { status: r.status, json, text: json ? null : text.slice(0, 200) };
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

let lcTab = null; // { id, created }

async function waitLoaded(id, timeout = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = await chrome.tabs.get(id);
    if (t.status === 'complete') return;
    await sleep(300);
  }
  throw new Error('Вкладка LeetCode не загрузилась.');
}

async function ensureTab() {
  if (lcTab) {
    try {
      const t = await chrome.tabs.get(lcTab.id);
      if (t.url && t.url.startsWith(LC) && !t.discarded) return lcTab.id;
    } catch (e) { /* вкладку закрыли */ }
    lcTab = null;
  }
  const tabs = (await chrome.tabs.query({ url: LC + '/*' })).filter((t) => !t.discarded);
  let tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: LC + '/problemset/', active: false });
    created = true;
  }
  await waitLoaded(tab.id);
  lcTab = { id: tab.id, created };
  return tab.id;
}

async function releaseTab() {
  if (lcTab && lcTab.created) {
    try { await chrome.tabs.remove(lcTab.id); } catch (e) { /* уже закрыта */ }
  }
  lcTab = null;
}

async function lcFetch(req, tries = 5) {
  let delay = 1500;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const tabId = await ensureTab();
    let res;
    try {
      [{ result: res }] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFetch, args: [req] });
    } catch (e) {
      lcTab = null;
      res = { status: 0, error: String(e.message || e) };
    }
    last = res;
    if (res && res.status === 200 && res.json) return res.json;
    if (res && [400, 401, 403, 404].includes(res.status)) {
      const err = new Error(`LeetCode ответил HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    await sleep(delay);
    delay *= 2;
  }
  throw new Error('LeetCode не отвечает' + (last && last.status === 429 ? ' (слишком много запросов)' : '') + '. Попробуй позже.');
}

async function gql(query, variables = {}) {
  const j = await lcFetch({ url: LC + '/graphql/', method: 'POST', body: { query, variables } });
  if (j.errors && !j.data) throw new Error('GraphQL: ' + j.errors.map((e) => e.message).join('; '));
  return j.data;
}

async function getUsername() {
  const d = await gql('query { userStatus { username isSignedIn } }');
  if (!d.userStatus || !d.userStatus.isSignedIn) {
    throw new Error('Ты не залогинен в LeetCode в этом браузере. Войди на leetcode.com и нажми «Обновить».');
  }
  return d.userStatus.username;
}

const norm = (id, slug, title, status, ts, lang) => ({ id: String(id), slug, title, status, ts: Number(ts), lang });

const SUBS_QUERY = `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String) {
  submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
    lastKey hasNext
    submissions { id title titleSlug statusDisplay timestamp lang }
  }
}`;

let subsMode = 'rest';

async function fetchSubsPage(offset, lastKey) {
  if (subsMode === 'rest') {
    try {
      const j = await lcFetch({ url: `${LC}/api/submissions/?offset=${offset}&limit=20&lastkey=${encodeURIComponent(lastKey || '')}` });
      if (Array.isArray(j.submissions_dump)) {
        return {
          subs: j.submissions_dump.map((s) => norm(s.id, s.title_slug, s.title, s.status_display, s.timestamp, s.lang)),
          hasNext: !!j.has_next,
          lastKey: j.last_key || '',
        };
      }
    } catch (e) {
      if (offset !== 0) throw e; // посреди пагинации не переключаемся
    }
    subsMode = 'gql';
  }
  const d = await gql(SUBS_QUERY, { offset, limit: 20, lastKey: lastKey || null, questionSlug: null });
  const l = d.submissionList;
  return {
    subs: l.submissions.map((s) => norm(s.id, s.titleSlug, s.title, s.statusDisplay, s.timestamp, s.lang)),
    hasNext: !!l.hasNext,
    lastKey: l.lastKey || '',
  };
}

async function ensureQuestions(slugs) {
  const q = await store.get('questions', {});
  const missing = [...new Set(slugs)].filter((s) => s && !q[s]);
  for (let i = 0; i < missing.length; i += 20) {
    setStatus(`Загружаю сложность задач: ${i}/${missing.length}…`);
    const batch = missing.slice(i, i + 20);
    const query = '{' + batch.map((s, j) =>
      `q${j}: question(titleSlug: ${JSON.stringify(s)}) { questionFrontendId title difficulty }`).join('\n') + '}';
    const d = await gql(query);
    batch.forEach((s, j) => {
      const x = d[`q${j}`];
      if (x) q[s] = { id: x.questionFrontendId, title: x.title, difficulty: x.difficulty };
    });
    await store.set('questions', q);
    await sleep(300);
  }
  return q;
}

// Кэш отправок: { username, subs: {id: sub}, coveredFrom, syncedAt }.
// [coveredFrom, syncedAt] — интервал, за который история загружена полностью.
async function syncFromLeetCode(startTs) {
  const username = await getUsername();
  let cache = await store.get('cache', null);
  if (!cache || cache.username !== username) cache = { username, subs: {}, coveredFrom: null, syncedAt: null };

  const haveOld = cache.coveredFrom !== null && startTs >= cache.coveredFrom;
  const stopAt = haveOld ? cache.syncedAt - 3600 : startTs; // час перекрытия на всякий случай
  const syncStart = Math.floor(Date.now() / 1000);

  let offset = 0, lastKey = '', loaded = 0, reachedEnd = false;
  for (;;) {
    const p = await fetchSubsPage(offset, lastKey);
    let stop = false;
    for (const s of p.subs) {
      if (s.ts < stopAt) { stop = true; break; }
      if (!s.status || /pending|judging/i.test(s.status)) continue;
      cache.subs[s.id] = s;
      loaded++;
    }
    const oldest = p.subs.length ? p.subs[p.subs.length - 1].ts : null;
    setStatus(`Загружено отправок: ${loaded}` + (oldest ? `, дошли до ${new Date(oldest * 1000).toLocaleDateString('ru-RU')}` : '') + '…');
    if (stop) break;
    if (!p.hasNext || !p.subs.length) { reachedEnd = true; break; }
    offset += 20;
    lastKey = p.lastKey;
    await sleep(400);
  }

  cache.coveredFrom = reachedEnd ? 0 : (haveOld ? cache.coveredFrom : startTs);
  cache.syncedAt = syncStart;
  await store.set('cache', cache);

  const slugs = Object.values(cache.subs).filter((s) => s.ts >= startTs).map((s) => s.slug);
  await ensureQuestions(slugs);
  return cache;
}

// ───────────────────────── Диапазон дат ─────────────────────────

function defaultRange() {
  return { start: dayKey(addDays(todayDate(), -29)), end: dayKey(todayDate()), toNow: true };
}

function readRange() {
  return { start: $('#start').value, end: $('#end').value, toNow: $('#toNow').checked };
}

function applyRangeToForm(r) {
  $('#start').value = r.start;
  $('#toNow').checked = !!r.toNow;
  $('#end').value = r.toNow ? dayKey(todayDate()) : r.end;
  $('#end').disabled = !!r.toNow;
}

function rangeBounds(r) {
  const start = parseDay(r.start);
  const end = r.toNow ? todayDate() : parseDay(r.end);
  return { start, end, startTs: start.getTime() / 1000, endTs: addDays(end, 1).getTime() / 1000 };
}

function validRange(r) {
  if (!r.start || (!r.toNow && !r.end)) return false;
  const b = rangeBounds(r);
  return b.start <= b.end;
}

// ───────────────────────── Отрисовка ─────────────────────────

const fmtAvg = (v) => (v === null ? '—' : v.toFixed(2).replace(/\.?0+$/, '').replace('.', ','));
const diffClass = (d) => String(d).toLowerCase();

function renderCards(st) {
  const firstPct = st.total ? Math.round((st.firstTry / st.total) * 100) : 0;
  const unk = st.byDiff.Unknown ? `<span class="c-unknown">? <b>${st.byDiff.Unknown}</b></span>` : '';
  $('#cards').innerHTML = `
    <div class="card">
      <div class="label">Решено задач</div>
      <div class="value">${st.total}</div>
      <div class="split">
        <span class="c-easy">Easy <b>${st.byDiff.Easy}</b></span>
        <span class="c-medium">Medium <b>${st.byDiff.Medium}</b></span>
        <span class="c-hard">Hard <b>${st.byDiff.Hard}</b></span>${unk}
      </div>
    </div>
    <div class="card">
      <div class="label">Среднее число попыток до сдачи</div>
      <div class="value">${fmtAvg(st.avgAttempts)}</div>
      <div class="split">
        <span class="c-easy">Easy <b>${fmtAvg(st.avgByDiff.Easy)}</b></span>
        <span class="c-medium">Medium <b>${fmtAvg(st.avgByDiff.Medium)}</b></span>
        <span class="c-hard">Hard <b>${fmtAvg(st.avgByDiff.Hard)}</b></span>
      </div>
    </div>
    <div class="card">
      <div class="label">С первой попытки</div>
      <div class="value">${st.total ? firstPct + '%' : '—'}</div>
      <div class="split"><span>${st.firstTry} из ${st.total}</span></div>
    </div>
    <div class="card">
      <div class="label">Активных дней</div>
      <div class="value">${st.activeDays}</div>
      <div class="split"><span>${st.totalSubs} ${plural(st.totalSubs, ['отправка', 'отправки', 'отправок'])} за период</span></div>
    </div>`;
}

let chartState = null;

function renderChart(st, start, end) {
  chartState = { st, start, end };
  const keys = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) keys.push(dayKey(d));
  const counts = keys.map((k) => {
    const c = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
    for (const p of st.days[k] || []) c[p.difficulty]++;
    c.total = c.Easy + c.Medium + c.Hard + c.Unknown;
    return c;
  });

  const wrap = $('#chart');
  const avail = Math.max(wrap.clientWidth, 300);
  const padL = 28, padR = 6, padT = 10, padB = 26, H = 240;
  const n = keys.length;
  const slot = Math.max(6, (avail - padL - padR) / n);
  const W = Math.round(padL + slot * n + padR);
  const innerH = H - padT - padB;
  const maxV = Math.max(1, ...counts.map((c) => c.total));
  const step = Math.max(1, Math.ceil(maxV / 5));
  const yMax = step * Math.ceil(maxV / step);
  const y = (v) => padT + innerH - (v / yMax) * innerH;
  const barW = Math.max(3, Math.min(28, slot * 0.72));

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (let v = 0; v <= yMax; v += step) {
    svg += `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  const labelEvery = Math.ceil(42 / slot);
  keys.forEach((k, i) => {
    const x0 = padL + i * slot;
    svg += `<rect class="hit" data-i="${i}" x="${x0}" y="${padT}" width="${slot}" height="${innerH}"/>`;
    let acc = 0;
    for (const d of [...DIFFS, 'Unknown']) {
      const v = counts[i][d];
      if (!v) continue;
      const yTop = y(acc + v), yBot = y(acc);
      svg += `<rect x="${x0 + (slot - barW) / 2}" y="${yTop}" width="${barW}" height="${Math.max(0, yBot - yTop - 1)}" rx="2" fill="var(--${diffClass(d)})" pointer-events="none"/>`;
      acc += v;
    }
    if (i % labelEvery === 0) {
      const dd = parseDay(k);
      svg += `<text x="${x0 + slot / 2}" y="${H - 8}" text-anchor="middle">${String(dd.getDate()).padStart(2, '0')}.${String(dd.getMonth() + 1).padStart(2, '0')}</text>`;
    }
  });
  svg += '</svg>';
  wrap.innerHTML = svg;

  const tip = $('#tooltip');
  wrap.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('mouseenter', () => {
      const i = Number(r.dataset.i);
      const c = counts[i];
      const date = parseDay(keys[i]).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
      tip.innerHTML = `<b>${esc(date)}</b> — ${c.total} ${plural(c.total, ['задача', 'задачи', 'задач'])}` +
        (c.total ? `<br>Easy ${c.Easy} · Medium ${c.Medium} · Hard ${c.Hard}` + (c.Unknown ? ` · ? ${c.Unknown}` : '') : '');
      tip.hidden = false;
      const panel = wrap.parentElement.getBoundingClientRect();
      const rb = r.getBoundingClientRect();
      let left = rb.left - panel.left + rb.width / 2 - tip.offsetWidth / 2;
      left = Math.max(8, Math.min(left, panel.width - tip.offsetWidth - 8));
      tip.style.left = left + 'px';
      tip.style.top = (rb.top - panel.top - tip.offsetHeight + 4) + 'px';
    });
    r.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

function problemRow(p, solved) {
  const url = `${LC}/problems/${encodeURIComponent(p.slug)}/`;
  const num = p.frontId ? `<span class="num">${esc(p.frontId)}.</span>` : '';
  const att = solved
    ? `${p.attempts} ${plural(p.attempts, ['попытка', 'попытки', 'попыток'])}`
    : `${p.totalSubs} ${plural(p.totalSubs, ['отправка', 'отправки', 'отправок'])}`;
  const t = new Date((solved ? p.acTs : p.lastTs) * 1000);
  const time = solved
    ? t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const dl = p.difficulty === 'Unknown' ? '?' : p.difficulty;
  return `<div class="row">
    <a href="${url}" target="_blank" rel="noopener">${num}${esc(p.title || p.slug)}</a>
    <span class="pill ${diffClass(p.difficulty)}">${dl}</span>
    <span class="att">${att}</span>
    <span class="time">${time}</span>
  </div>`;
}

function renderList(st) {
  const keys = Object.keys(st.days).sort().reverse();
  let html = '';
  if (!keys.length) html = '<div class="empty">За этот период решённых задач нет.</div>';
  for (const k of keys) {
    const items = st.days[k];
    const c = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
    items.forEach((p) => c[p.difficulty]++);
    const pills = [...DIFFS, 'Unknown'].filter((d) => c[d])
      .map((d) => `<span class="pill ${diffClass(d)}">${d === 'Unknown' ? '?' : d} ${c[d]}</span>`).join('');
    const date = parseDay(k).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    html += `<div class="day">
      <div class="day-head"><span class="date">${esc(date)}</span>
        <span class="count">${items.length} ${plural(items.length, ['задача', 'задачи', 'задач'])}</span>${pills}</div>
      ${items.map((p) => problemRow(p, true)).join('')}
    </div>`;
  }
  if (st.unsolved.length) {
    html += `<details><summary>Пробовал, но не сдал за этот период: ${st.unsolved.length}</summary>
      ${st.unsolved.map((p) => problemRow(p, false)).join('')}</details>`;
  }
  $('#list').innerHTML = html;
}

async function renderFromCache() {
  const r = readRange();
  if (!validRange(r)) { setStatus('Проверь даты: начало позже конца.', true); return; }
  const cache = await store.get('cache', null);
  const questions = await store.get('questions', {});
  const b = rangeBounds(r);
  const st = computeStats(cache ? Object.values(cache.subs) : [], questions, b.startTs, b.endTs);
  renderCards(st);
  renderChart(st, b.start, b.end);
  renderList(st);
  return { cache, b };
}

function syncedText(cache) {
  if (!cache || !cache.syncedAt) return 'Ещё не синхронизировано.';
  const d = new Date(cache.syncedAt * 1000);
  return `${cache.username} · обновлено ${d.toLocaleDateString('ru-RU')} в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

// ───────────────────────── Управление ─────────────────────────

let syncing = false;

async function doSync() {
  if (syncing) return;
  const r = readRange();
  if (!validRange(r)) return;
  syncing = true;
  $('#sync').disabled = true;
  setStatus('Подключаюсь к LeetCode…');
  try {
    const cache = await syncFromLeetCode(rangeBounds(r).startTs);
    await renderFromCache();
    setStatus(syncedText(cache));
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  } finally {
    await releaseTab();
    syncing = false;
    $('#sync').disabled = false;
  }
}

let rangeTimer = null;
function onRangeChanged() {
  const r = readRange();
  $('#end').disabled = r.toNow;
  if (r.toNow) $('#end').value = dayKey(todayDate());
  if (!validRange(r)) { setStatus('Проверь даты: начало позже конца.', true); return; }
  store.set('range', r);
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(async () => {
    const { cache, b } = await renderFromCache();
    // Если выбранный период старше загруженной истории — догружаем.
    if (!cache || cache.coveredFrom === null || b.startTs < cache.coveredFrom) doSync();
    else setStatus(syncedText(cache));
  }, 250);
}

function applyPreset(p) {
  const t = todayDate();
  let start;
  if (p === 'month') start = new Date(t.getFullYear(), t.getMonth(), 1);
  else if (p === 'year') start = new Date(t.getFullYear(), 0, 1);
  else start = addDays(t, -(Number(p) - 1));
  applyRangeToForm({ start: dayKey(start), end: dayKey(t), toNow: true });
  onRangeChanged();
}

async function init() {
  applyRangeToForm(await store.get('range', null) || defaultRange());
  ['#start', '#end', '#toNow'].forEach((s) => $(s).addEventListener('change', onRangeChanged));
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('#sync').addEventListener('click', doSync);
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Удалить сохранённые отправки и сложности задач? Они загрузятся заново.')) return;
    await chrome.storage.local.remove(['cache', 'questions']);
    await renderFromCache();
    setStatus('Кэш очищен.');
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => chartState && renderChart(chartState.st, chartState.start, chartState.end), 150);
  });

  const res = await renderFromCache();
  const cache = res && res.cache;
  setStatus(syncedText(cache));
  const fresh = cache && cache.syncedAt && Date.now() / 1000 - cache.syncedAt < 10 * 60 && res.b.startTs >= cache.coveredFrom;
  if (!fresh) doSync();
}

init();
