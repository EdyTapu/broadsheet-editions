'use strict';
// Declarative source registry. Adding a source is one line here; fetchers.js
// knows how to fetch each `kind`. Weight (1-10) feeds the fallback ranking and
// hints importance to the editor. Every source is free; endpoints verified
// live 2026-07-18 (see plan). Dead-do-not-reintroduce: Reddit .json, Stooq CSV,
// TikTok Creative Center JSON, AP/Reuters public RSS.

const SOURCES = [
  // ---- Tech ----
  { category: 'tech', name: 'MacRumors', weight: 7, kind: 'rss', url: 'https://feeds.macrumors.com/MacRumors-All' },
  { category: 'tech', name: '9to5Mac', weight: 6, kind: 'rss', url: 'https://9to5mac.com/feed/' },
  { category: 'tech', name: 'Ars Technica', weight: 7, kind: 'rss', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { category: 'tech', name: 'Hacker News', weight: 8, kind: 'hn-front' },
  { category: 'tech', name: 'GitHub Trending', weight: 6, kind: 'github-trending', url: 'https://github.com/trending?since=daily' },

  // ---- AI ----
  // Blogs/labs publish daily-to-weekly, not hourly: give them a 48h window so
  // the AI section never starves between posts (the slot window would drop them).
  { category: 'ai', name: 'Simon Willison', weight: 8, kind: 'rss', url: 'https://simonwillison.net/atom/everything/', windowHours: 48 },
  { category: 'ai', name: 'Import AI', weight: 7, kind: 'rss', url: 'https://importai.substack.com/feed', windowHours: 72 },
  { category: 'ai', name: 'OpenAI', weight: 8, kind: 'rss', url: 'https://openai.com/news/rss.xml', windowHours: 48 },
  { category: 'ai', name: 'Anthropic', weight: 8, kind: 'rss', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml', windowHours: 48 },
  { category: 'ai', name: 'Google DeepMind', weight: 7, kind: 'rss', url: 'https://deepmind.google/blog/rss.xml', windowHours: 48 },
  { category: 'ai', name: 'Hugging Face', weight: 6, kind: 'rss', url: 'https://huggingface.co/blog/feed.xml', windowHours: 48 },
  { category: 'ai', name: 'HN · AI', weight: 7, kind: 'hn-search', query: 'AI' },
  { category: 'ai', name: 'arXiv cs.AI', weight: 4, kind: 'rss', url: 'https://export.arxiv.org/rss/cs.AI', windowHours: 36 },

  // ---- News / Politics ----
  { category: 'news', name: 'NPR', weight: 8, kind: 'rss', url: 'https://feeds.npr.org/1001/rss.xml' },
  { category: 'news', name: 'BBC News', weight: 8, kind: 'rss', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { category: 'news', name: 'The Guardian', weight: 7, kind: 'rss', url: 'https://www.theguardian.com/world/rss' },
  { category: 'news', name: 'Google News', weight: 7, kind: 'rss', url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en' },

  // ---- Sports (ESPN unofficial JSON: news + live scores) ----
  { category: 'sports', name: 'ESPN NFL', weight: 7, kind: 'espn-news', sport: 'football', league: 'nfl' },
  { category: 'sports', name: 'ESPN NBA', weight: 7, kind: 'espn-news', sport: 'basketball', league: 'nba' },
  { category: 'sports', name: 'ESPN MLB', weight: 7, kind: 'espn-news', sport: 'baseball', league: 'mlb' },
  { category: 'sports', name: 'ESPN Soccer', weight: 6, kind: 'espn-news', sport: 'soccer', league: 'eng.1' },
  { category: 'sports', name: 'MLB scores', weight: 8, kind: 'espn-scores', sport: 'baseball', league: 'mlb', label: 'MLB' },
  { category: 'sports', name: 'MLS scores', weight: 5, kind: 'espn-scores', sport: 'soccer', league: 'usa.1', label: 'MLS' },
  { category: 'sports', name: 'NBA scores', weight: 7, kind: 'espn-scores', sport: 'basketball', league: 'nba', label: 'NBA' },
  { category: 'sports', name: 'NFL scores', weight: 8, kind: 'espn-scores', sport: 'football', league: 'nfl', label: 'NFL' },

  // ---- TikTok trends (composite; weakest category by design) ----
  { category: 'tiktok', name: 'Tokchart', weight: 6, kind: 'tokchart', url: 'https://tokchart.com/' },
  { category: 'tiktok', name: 'Google News · TikTok', weight: 5, kind: 'rss', url: 'https://news.google.com/rss/search?q=tiktok+trend+OR+viral&hl=en-US&gl=US&ceid=US:en' },
  { category: 'tiktok', name: 'Dexerto', weight: 4, kind: 'rss', url: 'https://www.dexerto.com/feed/' },

  // ---- Internet culture / memes ----
  { category: 'internet', name: 'r/OutOfTheLoop', weight: 7, kind: 'reddit-rss', sub: 'OutOfTheLoop', sort: 'top', t: 'day' },
  { category: 'internet', name: 'r/all', weight: 6, kind: 'reddit-rss', sub: 'all', sort: 'top', t: 'day' },
  { category: 'internet', name: 'Know Your Meme', weight: 6, kind: 'rss', url: 'https://knowyourmeme.com/newsfeed.rss', windowHours: 48 },

  // ---- Markets (data block + a couple of stories) ----
  // Market analysis pieces land every day or two, not hourly - widen the window.
  { category: 'markets', name: 'CNBC Markets', weight: 6, kind: 'rss', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', windowHours: 48 },
  { category: 'markets', name: 'CoinGecko', weight: 8, kind: 'coingecko' },
  { category: 'markets', name: 'Alpha Vantage', weight: 8, kind: 'alphavantage' },

  // ---- Gaming ----
  { category: 'gaming', name: 'Steam Most Played', weight: 7, kind: 'steam-charts' },
  { category: 'gaming', name: 'Steam Top Sellers', weight: 6, kind: 'steam-topsellers' },
  { category: 'gaming', name: 'r/Games', weight: 6, kind: 'reddit-rss', sub: 'Games', sort: 'top', t: 'day' },
  { category: 'gaming', name: 'IGN', weight: 6, kind: 'rss', url: 'https://feeds.ign.com/ign/all' },
  { category: 'gaming', name: 'Polygon', weight: 6, kind: 'rss', url: 'https://www.polygon.com/rss/index.xml' },

  // ---- Music / culture ----
  { category: 'music', name: 'Apple Music Top 25', weight: 7, kind: 'apple-music', url: 'https://rss.marketingtools.apple.com/api/v2/us/music/most-played/25/songs.json' },
  { category: 'music', name: 'Pitchfork', weight: 6, kind: 'rss', url: 'https://pitchfork.com/feed/feed-news/rss' },
  { category: 'music', name: 'Stereogum', weight: 5, kind: 'rss', url: 'https://www.stereogum.com/feed/' },

  // ---- Masthead data (not stories) ----
  { category: '_weather', name: 'Open-Meteo', weight: 0, kind: 'open-meteo' },
];

const CATEGORIES = [
  { key: 'tiktok', title: 'TikTok Trends' },
  { key: 'sports', title: 'Sports' },
  { key: 'ai', title: 'Artificial Intelligence' },
  { key: 'news', title: 'News & Politics' },
  { key: 'internet', title: 'Internet Culture' },
  { key: 'markets', title: 'Markets' },
  { key: 'gaming', title: 'Gaming' },
  { key: 'music', title: 'Music & Culture' },
  { key: 'tech', title: 'Technology' },
];

module.exports = { SOURCES, CATEGORIES };
