'use strict';
// Raw fetcher output -> NormalizedItem[]:
//   { id, title, summary, url, source, category, weight, publishedAt, imageUrl, isChart }
// Strips HTML, clamps lengths, windows by edition slot, dedupes across sources
// (wire stories syndicate everywhere), and caps volume so the editorial prompt
// stays ~350 items.

const crypto = require('node:crypto');

const MAX_SUMMARY = 500;      // chart items carry top-10 lists; leave them room
const MAX_TITLE = 200;
const PER_CATEGORY_CAP = 40;
const TOTAL_CAP = 350;

// Hours of lookback per slot: each edition covers everything since the
// previous drop (evening 7pm -> morning 8am, etc.), with slack for feeds that
// timestamp lazily.
const SLOT_WINDOW_HOURS = { morning: 15, midday: 7, evening: 8 };

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&#8217;': '’', '&#8216;': '‘',
  '&#8220;': '“', '&#8221;': '”', '&#8230;': '…', '&mdash;': '—', '&ndash;': '–',
};

function cleanText(s, max) {
  if (!s) return '';
  let t = String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 31 && n < 65536 ? String.fromCharCode(n) : ' ';
    })
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e] || ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t;
}

// Google News wraps every link in a redirect and suffixes " - Source" onto
// titles; unwrap what we can so dedupe catches the syndicated copies.
function canonicalURL(url) {
  try {
    const u = new URL(url);
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'CMP']) {
      u.searchParams.delete(p);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

const fuzzyTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 64);

function normalize(perSourceResults, { slot, now = new Date() } = {}) {
  const windowHours = SLOT_WINDOW_HOURS[slot] || 15;
  const cutoff = now.getTime() - windowHours * 3_600_000;

  const byId = new Map();
  const byTitle = new Set();

  for (const { source, items } of perSourceResults) {
    for (const raw of items) {
      const title = cleanText(raw.title, MAX_TITLE);
      const url = canonicalURL(String(raw.url || '').trim());
      if (!title || !/^https?:\/\//.test(url)) continue;

      // Window: drop stale items. A source can widen its own window (low-
      // frequency blogs); chart/synthetic and undated items pass through -
      // the fetch itself is the freshness signal for those.
      if (raw.publishedAt && !raw.isChart) {
        const t = new Date(raw.publishedAt).getTime();
        const sourceCutoff = source.windowHours
          ? Math.min(cutoff, now.getTime() - source.windowHours * 3_600_000)
          : cutoff;
        if (Number.isFinite(t) && t < sourceCutoff) continue;
      }

      const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
      const ft = fuzzyTitle(title);
      if (byId.has(id) || (ft.length >= 16 && byTitle.has(ft))) continue;
      byTitle.add(ft);

      byId.set(id, {
        id,
        title,
        summary: cleanText(raw.summary, MAX_SUMMARY),
        url,
        source: source.name,
        category: source.category,
        weight: source.weight,
        publishedAt: raw.publishedAt || null,
        imageUrl: raw.imageUrl && /^https?:\/\//.test(raw.imageUrl) ? raw.imageUrl : null,
        isChart: Boolean(raw.isChart),
      });
    }
  }

  // Rank within category by source weight + recency, then cap.
  const score = (it) => {
    const ageH = it.publishedAt ? (now.getTime() - new Date(it.publishedAt).getTime()) / 3_600_000 : windowHours / 2;
    return it.weight * 10 - Math.max(0, ageH);
  };

  const byCategory = new Map();
  for (const it of byId.values()) {
    if (!byCategory.has(it.category)) byCategory.set(it.category, []);
    byCategory.get(it.category).push(it);
  }

  let all = [];
  for (const items of byCategory.values()) {
    items.sort((a, b) => score(b) - score(a));
    all = all.concat(items.slice(0, PER_CATEGORY_CAP));
  }
  if (all.length > TOTAL_CAP) {
    all.sort((a, b) => score(b) - score(a));
    all = all.slice(0, TOTAL_CAP);
  }
  // Stable order: category, then score - keeps the editorial prompt readable.
  all.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : score(b) - score(a)));
  return all;
}

module.exports = { normalize, SLOT_WINDOW_HOURS };
