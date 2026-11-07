#!/usr/bin/env node
// עדכון נתונים דו-שבועי (רץ ב-GitHub Actions, חינם, בלי מפתחות ובלי תלויות):
// 1. שער דולר-שקל  2. רכבי TH/STH חדשים  3. מחירים והיסטוריית מחירים  4. חציונים ורכבים שעולים בערך
import fs from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const DB_FILE = new URL('data/db.json', ROOT);
const REPORT_FILE = new URL('data/report.md', ROOT);
const B164 = process.env.HW164_BASE || 'https://164custom.com';
const BPG = process.env.HWPG_BASE || 'https://hwpriceguide.com';
const FX_URLS = (process.env.FX_URLS || 'https://api.frankfurter.dev/v2/rate/usd/ils,https://api.frankfurter.app/latest?from=USD&to=ILS').split(',');
const DELAY = +(process.env.DELAY_MS ?? 800);
const MAX_ITEMS = +(process.env.MAX_ITEMS ?? 3000);
const UA = 'Mozilla/5.0 (compatible; HotWheelsHunter/2.0; personal price tracker; runs twice a month)';
const TODAY = new Date().toISOString().slice(0, 10);
const NOW_Y = new Date().getUTCFullYear();
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- טקסט ---------- */
export const norm = s => (s || '').toLowerCase().replace(/[’'`"]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'hot', 'wheels']);
const toks = s => norm(s).split(' ').filter(w => w && !STOP.has(w));
export function sim(a, b) {
  const A = toks(a), B = toks(b); if (!A.length || !B.length) return 0;
  const sa = new Set(A), sb = new Set(B); let inter = 0; for (const w of sa) if (sb.has(w)) inter++;
  let s = 2 * inter / (sa.size + sb.size);
  const na = A.join(' '), nb = B.join(' ');
  const ratio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
  if (na === nb) s = 1; else if (ratio >= 0.5 && na.length > 3 && nb.length > 3 && (na.includes(nb) || nb.includes(na))) s = Math.max(s, 0.85);
  return s;
}
export const keyOf = (t, y, n) => `${t}|${y}|${norm(n)}`;
// קווים נוספים שנמכרים בחנויות (מעבר ל-TH/STH). המחירים נאספים רק כשהם מוצגים לציבור.
export const LINES = [
  ['ML', 'mainlines'], ['ZM', 'zamac'], ['RE', 'target-red-edition'], ['MM', 'mystery-models'], ['5P', '5-packs'],
  ['CC', 'car-culture'], ['BV', 'boulevard'], ['PC', 'pop-culture'], ['TT', 'car-culture-team-transport'],
  ['FP', 'fast-and-furious-premium'], ['FF', 'fast-and-furious'], ['SS', 'silver-series'], ['RLC', 'red-line-club']
];
const hash = s => { let x = 5381; for (const ch of s) x = ((x * 33) ^ ch.charCodeAt(0)) >>> 0; return x; };
const decode = s => s.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#x27;|&rsquo;|&lsquo;|&#8217;|&#8216;/g, "'").replace(/&quot;|&#8220;|&#8221;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
export const strip = s => decode(String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const rows = html => html.match(/<tr[\s>][\s\S]*?<\/tr>/gi) || [];
const cells = tr => [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1]);
const anchors = html => [...html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: decode(m[1]), text: strip(m[2]) }));
const title = s => s.split(/[-\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/* ---------- רשת ---------- */
const lastHit = {};
async function get(url, { json = false, tries = 3 } = {}) {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    const wait = (lastHit[host] || 0) + DELAY - Date.now(); if (wait > 0) await sleep(wait);
    lastHit[host] = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (r.status === 404 || r.status === 410) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(2500 * (i + 1) ** 2); continue; }
      if (!r.ok) { note(`  ! HTTP ${r.status}`, url); return null; }
      return json ? await r.json() : await r.text();
    } catch (e) { if (i === tries - 1) { note('  ! נכשל', url, e.message); return null; } await sleep(1500 * (i + 1)); }
  }
  return null;
}
async function robotsAllows(base, path) {
  const txt = await get(base + '/robots.txt'); if (!txt) return true;
  let applies = false, inGroup = false; const dis = [], allow = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!inGroup) applies = false; inGroup = true; if (v === '*') applies = true; continue; }
    inGroup = false;
    if (!applies || !v) continue;
    if (k === 'disallow') dis.push(v); else if (k === 'allow') allow.push(v);
  }
  const match = p => p.endsWith('$') ? path === p.slice(0, -1) : path.startsWith(p.split('*')[0]);
  const d = Math.max(-1, ...dis.filter(match).map(s => s.length)), a = Math.max(-1, ...allow.filter(match).map(s => s.length));
  return a >= d;
}

/* ---------- 164custom: רשימות TH/STH ---------- */
export function parse164(html, year) {
  const out = [], seen = new Set();
  for (const tr of rows(html)) {
    const as = anchors(tr);
    const car = as.find(a => /\/hotwheels\/[^/]+\/[^/]+\/[^/?#]+\.html/i.test(a.href));
    if (!car) continue;
    const m = car.href.match(/\/hotwheels\/([^/]+)\/([^/]+)\/([^/?#]+)\.html/i);
    const code = m[2].toUpperCase();
    let name = (as.find(a => /\/hotwheels\//i.test(a.href) && a.text && a.text.toUpperCase() !== code && !/^\d+$/.test(a.text)) || {}).text;
    if (!name) { const alt = (tr.match(/\balt\s*=\s*["']([^"']+)["']/i) || [])[1]; if (alt) name = decode(alt).replace(/^\d{4}\s+Hot Wheels\s+(Super\s+)?Treasure Hunts?\s*/i, '').trim(); }
    if (!name) name = title(m[1]);
    const cs = cells(tr).map(strip);
    const yc = cs.find(c => /^(19|20)\d{2}$/.test(c)); const y = yc ? +yc : year;
    const cc = cs.find(c => /^[A-Z]$/.test(c)) || '';
    const k = y + '|' + norm(name); if (seen.has(k)) continue; seen.add(k);
    const e = { y, c: cc, n: name, col: m[3] === 'n-a' ? '' : title(m[3]) };
    if (/^[A-Z]{2,4}\d{2,3}[A-Z]?$/.test(code)) e.code = code;
    out.push(e);
  }
  return out;
}
export function mergeList(list, found) {
  const added = [];
  for (const e of found) {
    const same = list.find(x => x.y === e.y && (norm(x.n) === norm(e.n) || sim(x.n, e.n) >= 0.85 || (e.code && x.code === e.code)));
    if (same) { if (!same.code && e.code) same.code = e.code; if (!same.col && e.col) same.col = e.col; if (!same.c && e.c) same.c = e.c; continue; }
    list.push(e); added.push(e);
  }
  return added;
}

/* ---------- hwpriceguide: מחירים ---------- */
export function parseSlug(slug, t) {
  const m = slug.match(/^(\d{4})-(.+)$/); if (!m) return null;
  const pre = t === 'STH' ? /^(super-treasure-hunts?|sth)-/ : /^(regular-)?(treasure-hunts?|th|rth)-/;
  if (!pre.test(m[2])) return null;
  return { y: +m[1], name: m[2].replace(pre, '').replace(/-/g, ' ') };
}
export function parseLineSlug(slug, cat) {
  const m = slug.match(/^(\d{4})-(.+)$/); if (!m) return null;
  const drop = new Set(['hot', 'wheels', 'series', ...cat.split('-'), ...cat.split('-').map(w => w.replace(/s$/, ''))]);
  const words = m[2].split('-'); while (words.length > 1 && drop.has(words[0])) words.shift();
  return { y: +m[1], name: words.join(' ') };
}
export function parseItem(html) {
  const text = strip(html);
  const gated = /upgrade to view price/i.test(text) && !/resale price of \$/i.test(text);
  const cur = gated ? null : text.match(/resale price of \$\s?([\d,]+(?:\.\d+)?)/i);
  const pts = [];
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const tr of rows(html)) {
    const cs = cells(tr).map(strip); if (cs.length < 2) continue;
    const mm = cs[0].match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})$/i); if (!mm) continue;
    const pc = cs.slice(1).reverse().find(c => /^\$\s?[\d,]+(\.\d+)?$/.test(c)); if (!pc) continue;
    const sales = cs.slice(1).find(c => /^\d+$/.test(c));
    const mon = MON.indexOf(mm[1].slice(0, 3).toLowerCase()) + 1;
    pts.push({ d: `${mm[2]}-${String(mon).padStart(2, '0')}-15`, usd: +pc.replace(/[$,\s]/g, ''), sales: sales != null ? +sales : undefined });
  }
  return { current: cur ? +cur[1].replace(/,/g, '') : null, pts: gated ? [] : pts, gated };
}
async function crawlCategory(cat, maxPages = 120) {
  const start = `${BPG}/category/${cat}/`;
  const queue = [start], seen = new Set(), items = new Map();
  const host = h => h.replace(/^www\./, '');
  while (queue.length && seen.size < maxPages) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    const html = await get(url); if (!html) continue;
    const texts = new Map();
    for (const a of anchors(html)) {
      let u; try { u = new URL(a.href, url); } catch { continue; }
      if (host(u.host) !== host(new URL(BPG).host)) continue;
      const p = u.pathname;
      const im = p.match(/^\/item\/([a-z0-9][a-z0-9-]*)\/?$/i);
      if (im) { if (a.text) texts.set(im[1].toLowerCase(), a.text); continue; }
      if (p.startsWith(`/category/${cat}/`) || p.startsWith(`/group/${cat}/`)) {
        const clean = new URL(BPG).origin + p + u.search; if (!seen.has(clean) && !queue.includes(clean)) queue.push(clean);
      }
    }
    // פריטים יכולים להופיע גם בלי קישור רגיל (רשימות בחירה, נתונים בתוך הדף)
    for (const m of html.matchAll(/\/item\/([a-z0-9][a-z0-9-]{3,})/gi)) {
      const slug = m[1].toLowerCase();
      if (!items.has(slug)) items.set(slug, { slug, url: `${new URL(BPG).origin}/item/${slug}`, text: texts.get(slug) || '' });
      else if (!items.get(slug).text && texts.get(slug)) items.get(slug).text = texts.get(slug);
    }
  }
  note(`  ${cat}: ${seen.size} עמודים, ${items.size} פריטים`);
  return [...items.values()];
}
export function addPts(db, key, pts, src) {
  const arr = db.prices[key] || (db.prices[key] = []);
  for (const p of pts) {
    if (!(p.usd > 0) || p.usd > 100000) continue;
    const rec = { d: p.d, usd: Math.round(p.usd * 100) / 100, src };
    if (p.sales != null) rec.sales = p.sales;
    const i = arr.findIndex(x => x.d === p.d); if (i >= 0) arr[i] = rec; else arr.push(rec);
  }
  arr.sort((a, b) => (a.d < b.d ? -1 : 1)); if (arr.length > 48) arr.splice(0, arr.length - 48);
}

/* ---------- סיכומים ---------- */
export function summarize(db) {
  const med = {}, groups = {};
  for (const [k, arr] of Object.entries(db.prices)) {
    if (!arr.length) continue; const [t, y] = k.split('|');
    (groups[`${t}|${y}`] ||= []).push(arr[arr.length - 1].usd);
    if (+y >= NOW_Y - 2) (groups[`${t}|recent`] ||= []).push(arr[arr.length - 1].usd);
  }
  for (const [g, v] of Object.entries(groups)) if (v.length >= 3) { v.sort((a, b) => a - b); const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; med[g] = { usd: Math.round(m * 100) / 100, n: v.length }; }
  db.medians = med;
  const movers = [];
  const all = [...db.sth.map(e => ({ ...e, t: 'STH' })), ...db.th.map(e => ({ ...e, t: 'TH' })), ...(db.other || [])];
  for (const e of all) {
    const arr = db.prices[keyOf(e.t, e.y, e.n)]; if (!arr || arr.length < 2) continue;
    const last = arr[arr.length - 1], lt = Date.parse(last.d);
    const base = [...arr].reverse().find(p => lt - Date.parse(p.d) >= 80 * 864e5); if (!base || !(base.usd > 0)) continue;
    const pct = (last.usd / base.usd - 1) * 100;
    movers.push({ t: e.t, y: e.y, n: e.n, from: base.usd, to: last.usd, since: base.d, pct: Math.round(pct * 10) / 10 });
  }
  movers.sort((a, b) => b.pct - a.pct);
  db.movers = movers.filter(m => m.pct > 0).slice(0, 25);
}
function nextUpdate(d = new Date()) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const n = day < 15 ? new Date(Date.UTC(y, m, 15)) : new Date(Date.UTC(y, m + 1, 1));
  return n.toISOString().slice(0, 10);
}

/* ---------- ריצה ---------- */
async function main() {
  const db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  const before = { sth: db.sth.length, th: db.th.length, priced: Object.keys(db.prices).length, fx: db.fx?.rate };
  const res = { fx: null, addedSTH: [], addedTH: [], priced: 0, failed: 0, matched: 0 };

  note('## שער דולר');
  for (const u of FX_URLS) {
    const j = await get(u.trim(), { json: true }); if (!j) continue;
    const rate = +(j.rate ?? j.rates?.ILS); const date = j.date || TODAY;
    if (rate > 2 && rate < 6) { db.fx = { rate: Math.round(rate * 10000) / 10000, date, src: 'frankfurter.dev (שערי הבנק האירופי)' }; res.fx = db.fx; note(`  1$ = ${rate} ₪ (${date})`); break; }
  }
  if (!res.fx) note('  ! לא עודכן, נשאר השער הקודם');

  note('## רשימות Treasure Hunt');
  if (await robotsAllows(B164, '/hot-wheels/')) {
    for (const [t, path, list, acc] of [['STH', 'super-treasure-hunt', db.sth, res.addedSTH], ['TH', 'treasure-hunt', db.th, res.addedTH]]) {
      for (const y of [NOW_Y - 1, NOW_Y, NOW_Y + 1]) {
        const html = await get(`${B164}/hot-wheels/${path}/${y}.html`);
        if (!html) { note(`  ${t} ${y}: אין עמוד`); continue; }
        const found = parse164(html, y);
        const added = mergeList(list, found); acc.push(...added);
        note(`  ${t} ${y}: ${found.length} ברשימה, ${added.length} חדשים`);
      }
    }
  } else note('  ! robots.txt לא מאפשר. דילגתי.');

  note('## מחירים וקטלוג');
  db.other ||= []; db.run = (db.run || 0) + 1;
  const res2 = { addedOther: 0, gated: 0 };
  if (await robotsAllows(BPG, '/item/')) {
    const top = [], mid = [], low = [];
    for (const [t, cat, list] of [['STH', 'super-treasure-hunt', db.sth], ['TH', 'treasure-hunt', db.th]]) {
      for (const it of await crawlCategory(cat)) {
        const p = parseSlug(it.slug, t); if (!p) continue;
        let best = null, bs = 0;
        for (const e of list) { if (e.y !== p.y) continue; const sc = Math.max(sim(e.n, p.name), it.text ? sim(e.n, it.text) : 0); if (sc > bs) { bs = sc; best = e; } }
        if (best && bs >= 0.75) { top.push({ t, e: best, url: it.url }); continue; }
        if (p.y >= NOW_Y - 1 && bs < 0.5) {
          const e = { y: p.y, c: '', n: it.text || title(p.name), col: '' }; list.push(e); (t === 'STH' ? res.addedSTH : res.addedTH).push(e); top.push({ t, e, url: it.url });
        }
      }
    }
    if (!process.env.SKIP_LINES) for (const [t, cat] of LINES) {
      const byKey = new Map(db.other.filter(e => e.t === t).map(e => [`${e.y}|${norm(e.n)}`, e]));
      for (const it of await crawlCategory(cat, 200)) {
        const p = parseLineSlug(it.slug, cat); if (!p || p.y < 1968 || p.y > NOW_Y + 1) continue;
        const name = it.text || title(p.name); const k = `${p.y}|${norm(name)}`;
        let e = byKey.get(k); if (!e) { e = { t, y: p.y, n: name }; db.other.push(e); byKey.set(k, e); res2.addedOther++; }
        e.u = it.slug;
        const job = { t, e, url: it.url };
        if (p.y >= NOW_Y - 1 || t !== 'ML') mid.push(job); else if (hash(keyOf(t, p.y, name)) % 12 === db.run % 12) low.push(job);
      }
    }
    const todo = [...top, ...mid, ...low];
    res.matched = todo.length;
    for (const job of todo.slice(0, MAX_ITEMS)) {
      const html = await get(job.url); if (!html) { res.failed++; continue; }
      const { current, pts, gated } = parseItem(html);
      if (gated) { res2.gated++; continue; }
      const key = keyOf(job.t, job.e.y, job.e.n);
      if (pts.length) addPts(db, key, pts, 'hwpriceguide.com – ממוצע חודשי');
      if (current) addPts(db, key, [{ d: TODAY, usd: current }], 'hwpriceguide.com – 30 יום אחרונים');
      if (current || pts.length) res.priced++; else res.failed++;
    }
    note(`  ${res.matched} פריטים בתור, ${Math.min(res.matched, MAX_ITEMS)} נבדקו, ${res.priced} עם מחיר ציבורי, ${res2.gated} נעולים למנויים (לא נאספו), ${res.failed} בלי מחיר`);
    note(`  קטלוג קווים נוספים: ${db.other.length} רכבים (${res2.addedOther} חדשים)`);
  } else note('  ! robots.txt לא מאפשר. דילגתי.');

  summarize(db);
  db.updated = new Date().toISOString();
  db.nextUpdate = nextUpdate();
  await fs.writeFile(DB_FILE, JSON.stringify(db));

  const fmt = e => `- ${e.y} ${e.n}${e.col ? ' · ' + e.col : ''}`;
  const rep = [
    `# דוח עדכון ${TODAY}`, '',
    `- שער דולר: ${res.fx ? res.fx.rate + ' ₪ (' + res.fx.date + ')' : 'לא עודכן (נשאר ' + before.fx + ')'}`,
    `- Super Treasure Hunt: ${before.sth} → ${db.sth.length}`,
    `- Treasure Hunt: ${before.th} → ${db.th.length}`,
    `- קטלוג קווים נוספים (בסיסית, פרימיום, ZAMAC ועוד): ${(db.other || []).length} רכבים`,
    `- רכבים עם מחיר: ${before.priced} → ${Object.keys(db.prices).length} (עודכנו בריצה הזו: ${res.priced})`,
    `- העדכון הבא: ${db.nextUpdate}`, '',
    res.addedSTH.length ? '## STH חדשים\n' + res.addedSTH.map(fmt).join('\n') + '\n' : '',
    res.addedTH.length ? '## TH חדשים\n' + res.addedTH.map(fmt).join('\n') + '\n' : '',
    db.movers.length ? '## עולים בערך (מול לפני כ-3 חודשים)\n' + db.movers.slice(0, 10).map(m => `- ${m.t} ${m.y} ${m.n}: $${m.from} → $${m.to} (${m.pct > 0 ? '+' : ''}${m.pct}%)`).join('\n') + '\n' : '',
    '## יומן', '```', ...log, '```'
  ].join('\n');
  await fs.writeFile(REPORT_FILE, rep);
  console.log('\nDONE');
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
