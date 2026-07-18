# Broadsheet Press

The printing press behind **Broadsheet**, a personal anti-doomscroll daily paper.
Three times a day a GitHub Actions cron fetches ~40 free sources (RSS, ESPN, Hacker News, Reddit `.rss`, Steam, Apple Music charts, CoinGecko, Open-Meteo, …), normalizes them, and runs one Claude structured-output call that acts as editor-in-chief: it picks the front page, writes the blurbs, and files each section.
The result is a static `editions/<date>-<slot>.json` (plus `editions/latest.json`) committed to this repo, which the Broadsheet app (SwiftUI, iPhone/iPad/Mac) reads.

## Run locally

```sh
npm install
node build-edition.js --slot morning --dry-run     # fetch + normalize only -> editions/normalized.json
node build-edition.js --slot morning --no-claude   # full edition, heuristic editor (no key needed)
ANTHROPIC_API_KEY=sk-ant-... node build-edition.js --slot morning
```

Flags: `--slot morning|midday|evening`, `--dry-run`, `--no-claude`, `--fixtures` (replay canned feeds from `test-fixtures/`), `--save-fixtures`.

Env: `ANTHROPIC_API_KEY` (the editor; falls back to heuristic ranking without it), `BROADSHEET_MODEL` (default `claude-opus-4-8`), `ALPHAVANTAGE_API_KEY` (optional index quotes), `BROADSHEET_LAT`/`BROADSHEET_LON` (masthead weather), `BROADSHEET_OUT` (output dir).

## Design rules

- **Editions, not feeds.** Finite content per drop; the app has no pull-to-refresh and no infinite scroll.
- **Blurbs from the model, facts from the feeds.** The editor selects stories only by `id`; URLs, sources, dates and images are joined back from fetched data, so links can never be hallucinated.
- **The paper always lands.** Per-source failures degrade one section; an editor failure degrades to a heuristic edition (`"editorial": "fallback"`); the build refuses to print only if most of the wire is dead.
- **Feed etiquette.** Descriptive User-Agent, gentle pacing (Reddit fetches are serialized), one run per edition.
