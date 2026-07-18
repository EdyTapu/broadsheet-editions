'use strict';
// One fetcher per source `kind`. Every fetcher returns
//   { items: RawItem[], data?: object }
// where RawItem = { title, summary?, url, publishedAt?, imageUrl? } and `data`
// carries structured non-story payloads (market tickers, weather) that bypass
// the editorial ranking. All fetchers throw on failure; build-edition.js
// catches per-source so one dead feed never kills the edition.

const { XMLParser } = require('fast-xml-parser');

// Several of the sources in this registry died silently for people who fetched
// anonymously (Reddit .json, Stooq). Stable descriptive UA + gentle cadence is
// the etiquette that keeps the rest alive.
const USER_AGENT = 'BroadsheetPress/1.0 (personal daily news digest; contact: alessiopag2005@gmail.com)';
const FETCH_TIMEOUT_MS = 15_000;

async function get(url, { as = 'text', headers = {} } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return as === 'json' ? res.json() : res.text();
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feeds routinely carry CDATA titles and namespaced tags; keep text intact.
  cdataPropName: '__cdata',
  processEntities: true,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// fast-xml-parser text nodes come back as strings, numbers, or {__cdata}/#text
// wrappers depending on the feed's markup; flatten them all to a string.
function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    if (node.__cdata != null) return text(node.__cdata);
    if (node['#text'] != null) return text(node['#text']);
  }
  return '';
}

function parseDate(v) {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- RSS 2.0 + Atom (covers every plain-feed source incl. Reddit .rss) ----

function firstImage(item) {
  const enc = item['media:content'] || item['media:thumbnail'] || item.enclosure;
  for (const cand of asArray(enc)) {
    const u = cand && (cand['@_url'] || cand['@_href']);
    if (u && /^https?:/.test(u)) return u;
  }
  return null;
}

function parseFeed(xmlText) {
  const doc = xml.parse(xmlText);
  if (doc.rss && doc.rss.channel) {
    return asArray(doc.rss.channel.item).map((it) => ({
      title: text(it.title),
      summary: text(it.description),
      url: text(it.link) || text(it.guid),
      publishedAt: parseDate(it.pubDate || it['dc:date']),
      imageUrl: firstImage(it),
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((it) => {
      const links = asArray(it.link);
      const alt = links.find((l) => l['@_rel'] === 'alternate') || links[0];
      return {
        title: text(it.title),
        summary: text(it.summary) || text(it.content),
        url: (alt && alt['@_href']) || text(it.id),
        publishedAt: parseDate(it.published || it.updated),
        imageUrl: firstImage(it),
      };
    });
  }
  throw new Error('Unrecognized feed format');
}

async function fetchRSS(src) {
  return { items: parseFeed(await get(src.url)) };
}

// Reddit killed unauthenticated .json in 2025; .rss still works when fetched
// gently with a real UA - but concurrent hits from one IP get 429'd, so all
// Reddit fetches share a serial queue with spacing. Never move this to .json.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let redditQueue = Promise.resolve();

async function fetchRedditRSS(src) {
  const t = src.t ? `?t=${src.t}` : '';
  const url = `https://www.reddit.com/r/${src.sub}/${src.sort || 'hot'}/.rss${t}`;
  const run = redditQueue.then(async () => {
    try {
      return await get(url);
    } catch (e) {
      if (!/HTTP 429/.test(String(e.message))) throw e;
      await sleep(45_000); // one patient retry on rate-limit; a cron job can wait
      // `return await`, not `return`: with the pending finally-sleep below, a
      // bare returned promise sits unadopted and its rejection crashes Node.
      return await get(url);
    } finally {
      await sleep(10_000); // spacing before the next subreddit
    }
  });
  redditQueue = run.catch(() => {});
  const items = parseFeed(await run);
  // Reddit Atom "summary" is a blob of comment/link HTML; not a useful blurb.
  return { items: items.map((it) => ({ ...it, summary: '' })) };
}

// ---- Hacker News (Algolia, keyless) ----

async function fetchHNFront() {
  const data = await get('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30', { as: 'json' });
  return { items: (data.hits || []).map(hnHit) };
}

async function fetchHNSearch(src) {
  const q = encodeURIComponent(src.query);
  const since = Math.floor(Date.now() / 1000) - 36 * 3600;
  const data = await get(
    `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=story&numericFilters=points%3E50,created_at_i%3E${since}&hitsPerPage=20`,
    { as: 'json' },
  );
  return { items: (data.hits || []).map(hnHit) };
}

function hnHit(h) {
  return {
    title: h.title || '',
    summary: `${h.points} points, ${h.num_comments} comments on Hacker News`,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    publishedAt: h.created_at || null,
    imageUrl: null,
  };
}

// ---- ESPN unofficial JSON (site.api.espn.com - alive as of 2026-07) ----

async function fetchESPNNews(src) {
  const data = await get(
    `https://site.api.espn.com/apis/site/v2/sports/${src.sport}/${src.league}/news`,
    { as: 'json' },
  );
  return {
    items: (data.articles || []).map((a) => ({
      title: a.headline || '',
      summary: a.description || '',
      url: (a.links && a.links.web && a.links.web.href) || '',
      publishedAt: parseDate(a.published),
      imageUrl: (a.images && a.images[0] && a.images[0].url) || null,
    })),
  };
}

// Yesterday's/today's finals condensed into one synthetic scores item per
// league - box-score data, not an article, so the URL points at the scoreboard.
async function fetchESPNScores(src) {
  const data = await get(
    `https://site.api.espn.com/apis/site/v2/sports/${src.sport}/${src.league}/scoreboard`,
    { as: 'json' },
  );
  const lines = [];
  for (const ev of (data.events || []).slice(0, 16)) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    // 'pre' = not started: a wall of scheduled 0-0 games is noise, skip them.
    if (ev.status && ev.status.type && ev.status.type.state === 'pre') continue;
    const done = ev.status && ev.status.type && ev.status.type.completed;
    const state = ev.status && ev.status.type && ev.status.type.shortDetail;
    const sides = (comp.competitors || [])
      .map((c) => `${c.team ? c.team.abbreviation || c.team.shortDisplayName : '?'} ${c.score ?? ''}`.trim())
      .join(' – ');
    if (sides) lines.push(done ? `${sides} (F)` : `${sides} (${state || 'sched'})`);
  }
  if (!lines.length) return { items: [] }; // off-season: no games is not an error
  return {
    items: [{
      title: `${src.label} scoreboard`,
      summary: lines.join('; '),
      url: `https://www.espn.com/${src.sport === 'soccer' ? 'soccer' : src.league}/scoreboard`,
      publishedAt: new Date().toISOString(),
      imageUrl: null,
      isChart: true,
    }],
  };
}

// ---- Steam (keyless) ----

async function fetchSteamCharts() {
  const data = await get('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/', { as: 'json' });
  const ranks = ((data.response && data.response.ranks) || []).slice(0, 10);
  const named = [];
  for (const r of ranks) {
    // appdetails is one appid per call; 10 sequential lookups is gentle enough.
    try {
      const d = await get(`https://store.steampowered.com/api/appdetails?appids=${r.appid}&filters=basic`, { as: 'json' });
      const entry = d[r.appid];
      const name = entry && entry.success && entry.data && entry.data.name;
      named.push(`${r.rank}. ${name || `app ${r.appid}`} (${Number(r.peak_in_game).toLocaleString('en-US')} peak)`);
    } catch {
      named.push(`${r.rank}. app ${r.appid}`);
    }
  }
  return {
    items: [{
      title: 'Steam most played today',
      summary: named.join('; '),
      url: 'https://store.steampowered.com/charts/mostplayed',
      publishedAt: new Date().toISOString(),
      imageUrl: null,
      isChart: true,
    }],
  };
}

async function fetchSteamTopSellers() {
  const data = await get('https://store.steampowered.com/api/featuredcategories?cc=US&l=en', { as: 'json' });
  const seen = new Set();
  const names = [];
  for (const it of (data.top_sellers && data.top_sellers.items) || []) {
    if (it.name && !seen.has(it.name)) { seen.add(it.name); names.push(it.name); }
    if (names.length >= 10) break;
  }
  if (!names.length) throw new Error('empty top_sellers');
  return {
    items: [{
      title: 'Steam top sellers',
      summary: names.map((n, i) => `${i + 1}. ${n}`).join('; '),
      url: 'https://store.steampowered.com/charts/topselling',
      publishedAt: new Date().toISOString(),
      imageUrl: null,
      isChart: true,
    }],
  };
}

// ---- Apple Music official chart JSON (keyless) ----

async function fetchAppleMusic(src) {
  const data = await get(src.url, { as: 'json' });
  const results = (data.feed && data.feed.results) || [];
  if (!results.length) throw new Error('empty chart');
  const list = results.slice(0, 15).map((s, i) => `${i + 1}. ${s.artistName} – ${s.name}`);
  return {
    items: [{
      title: 'Apple Music Top Songs (US)',
      summary: list.join('; '),
      url: 'https://music.apple.com/us/room/6459306033',
      publishedAt: new Date().toISOString(),
      imageUrl: (results[0] && results[0].artworkUrl100) || null,
      isChart: true,
    }],
  };
}

// ---- Tokchart (plain-HTML scrape; best-effort TikTok sound signal) ----

async function fetchTokchart(src) {
  const html = await get(src.url);
  // Each chart row: <a href="…/dashboard/tiktok-sound/<id>">creator</a>
  // followed by <span class="max-w-…">sound title</span> (verified 2026-07-18).
  const names = [];
  const seen = new Set();
  const re = /href="[^"]*\/tiktok-sound\/(\d+)"\s*>\s*([^<]+?)\s*<\/a>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/g;
  let m;
  while ((m = re.exec(html)) && names.length < 12) {
    const [, id, creator, title] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = `${title.replace(/\s+/g, ' ').trim()} (${creator.replace(/\s+/g, ' ').trim()})`;
    if (t.length > 3) names.push(t);
  }
  if (!names.length) throw new Error('no sounds parsed (page layout changed?)');
  return {
    items: [{
      title: 'Trending TikTok sounds',
      summary: names.map((n, i) => `${i + 1}. ${n}`).join('; '),
      url: 'https://tokchart.com/',
      publishedAt: new Date().toISOString(),
      imageUrl: null,
      isChart: true,
    }],
  };
}

// ---- GitHub trending (HTML scrape; no official API) ----

async function fetchGitHubTrending(src) {
  const html = await get(src.url);
  const items = [];
  // Repo headings: <h2 class="h3 lh-condensed"> … <a href="/owner/repo" …>.
  const re = /<h2 class="h3 lh-condensed">[\s\S]*?href="\/([^"\/]+\/[^"\/]+)"/g;
  let m;
  while ((m = re.exec(html)) && items.length < 8) {
    const repo = m[1];
    // Description is the first <p …> after the heading block.
    const tail = html.slice(m.index, m.index + 3000);
    const dm = tail.match(/<p class="col-9[^"]*">\s*([\s\S]*?)<\/p>/);
    const desc = dm ? dm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    items.push({
      title: `Trending on GitHub: ${repo}`,
      summary: desc,
      url: `https://github.com/${repo}`,
      publishedAt: new Date().toISOString(),
      imageUrl: null,
    });
  }
  if (!items.length) throw new Error('no repos parsed (page layout changed?)');
  return { items };
}

// ---- Markets data blocks (bypass editorial ranking) ----

async function fetchCoinGecko() {
  const data = await get(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
    { as: 'json' },
  );
  const tickers = [];
  if (data.bitcoin) tickers.push({ symbol: 'BTC', name: 'Bitcoin', price: data.bitcoin.usd, changePct: round2(data.bitcoin.usd_24h_change) });
  if (data.ethereum) tickers.push({ symbol: 'ETH', name: 'Ethereum', price: data.ethereum.usd, changePct: round2(data.ethereum.usd_24h_change) });
  if (!tickers.length) throw new Error('empty response');
  return { items: [], data: { tickers } };
}

// Free key, 25 calls/day: 3 quotes x 3 editions = 9. Skipped cleanly when the
// key isn't configured so local runs work without it.
async function fetchAlphaVantage() {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) return { items: [], data: { tickers: [], skipped: 'no ALPHAVANTAGE_API_KEY' } };
  const symbols = [
    { symbol: 'SPY', name: 'S&P 500 (SPY)' },
    { symbol: 'QQQ', name: 'Nasdaq 100 (QQQ)' },
    { symbol: 'DIA', name: 'Dow Jones (DIA)' },
  ];
  const tickers = [];
  for (const s of symbols) {
    const data = await get(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${s.symbol}&apikey=${key}`,
      { as: 'json' },
    );
    const q = data['Global Quote'];
    if (q && q['05. price']) {
      tickers.push({
        symbol: s.symbol,
        name: s.name,
        price: round2(Number(q['05. price'])),
        changePct: round2(parseFloat(String(q['10. change percent']).replace('%', ''))),
      });
    }
  }
  if (!tickers.length) throw new Error('no quotes (rate limit?)');
  return { items: [], data: { tickers } };
}

// ---- Weather one-liner for the masthead (Open-Meteo, keyless) ----

const WEATHER_CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow', 80: 'showers', 81: 'showers',
  82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorms',
  96: 'thunderstorms', 99: 'thunderstorms',
};

async function fetchOpenMeteo() {
  const lat = process.env.BROADSHEET_LAT || '33.95';   // Marietta, GA default
  const lon = process.env.BROADSHEET_LON || '-84.55';
  const data = await get(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&temperature_unit=fahrenheit&timezone=auto&forecast_days=1',
    { as: 'json' },
  );
  const cur = data.current || {};
  const daily = data.daily || {};
  return {
    items: [],
    data: {
      tempF: Math.round(cur.temperature_2m),
      condition: WEATHER_CODES[cur.weather_code] || 'unsettled',
      highF: Math.round((daily.temperature_2m_max || [])[0]),
      lowF: Math.round((daily.temperature_2m_min || [])[0]),
      precipPct: (daily.precipitation_probability_max || [])[0] ?? null,
    },
  };
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const FETCHERS = {
  'rss': fetchRSS,
  'reddit-rss': fetchRedditRSS,
  'hn-front': fetchHNFront,
  'hn-search': fetchHNSearch,
  'espn-news': fetchESPNNews,
  'espn-scores': fetchESPNScores,
  'steam-charts': fetchSteamCharts,
  'steam-topsellers': fetchSteamTopSellers,
  'apple-music': fetchAppleMusic,
  'tokchart': fetchTokchart,
  'github-trending': fetchGitHubTrending,
  'coingecko': fetchCoinGecko,
  'alphavantage': fetchAlphaVantage,
  'open-meteo': fetchOpenMeteo,
};

async function fetchSource(src) {
  const fn = FETCHERS[src.kind];
  if (!fn) throw new Error(`Unknown source kind: ${src.kind}`);
  try {
    return await fn(src);
  } catch (e) {
    // One retry for transient failures (timeouts, resets, 5xx). Hard 4xx and
    // parse failures won't heal in two seconds - don't hammer.
    const msg = String(e.message || e);
    const transient = /timeout|aborted|ECONNRESET|EAI_AGAIN|fetch failed|HTTP 5\d\d/i.test(msg);
    if (!transient || src.kind === 'reddit-rss') throw e; // reddit does its own retry
    await new Promise((r) => setTimeout(r, 2_000));
    return await fn(src);
  }
}

module.exports = { fetchSource, USER_AGENT };
