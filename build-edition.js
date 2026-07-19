'use strict';
// Broadsheet's printing press. One run = one edition.
//
//   node build-edition.js --slot morning            # full run -> editions/<id>.json + latest.json
//   node build-edition.js --slot morning --dry-run  # fetch+normalize only -> out/normalized.json
//   node build-edition.js --slot morning --no-claude# heuristic editor (no API key needed)
//   node build-edition.js --slot morning --fixtures # offline: canned feeds from test-fixtures/
//
// Env: ANTHROPIC_API_KEY (editor), BROADSHEET_MODEL, ALPHAVANTAGE_API_KEY (optional),
//      BROADSHEET_LAT/LON (weather), BROADSHEET_OUT (output dir, default ./editions).

const fs = require('node:fs');
const path = require('node:path');
const { SOURCES, CATEGORIES } = require('./sources');
const { fetchSource } = require('./fetchers');
const { normalize } = require('./normalize');
const { assembleEdition, validateEdition } = require('./schema');
const { runEditor, fallbackEditorOutput, editorKind, MODEL, CLI_MODEL } = require('./editor');

function parseArgs(argv) {
  const args = { slot: 'morning', dryRun: false, fixtures: false, noClaude: false, saveFixtures: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot') args.slot = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--fixtures') args.fixtures = true;
    else if (a === '--save-fixtures') args.saveFixtures = true;
    else if (a === '--no-claude') args.noClaude = true;
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!['morning', 'midday', 'evening'].includes(args.slot)) {
    console.error(`--slot must be morning|midday|evening, got "${args.slot}"`);
    process.exit(2);
  }
  return args;
}

// Local date for the edition id: editions are named for the reader's day, not
// UTC's. TZ is set in the workflow (TZ=America/New_York).
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchAll({ fixtures, saveFixtures }) {
  const fixturesDir = path.join(__dirname, 'test-fixtures');
  if (saveFixtures) fs.mkdirSync(fixturesDir, { recursive: true });
  const results = [];
  const health = [];

  await Promise.all(SOURCES.map(async (src) => {
    const fixtureFile = path.join(fixturesDir, `${src.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`);
    try {
      let out;
      if (fixtures) {
        out = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
      } else {
        out = await fetchSource(src);
        if (saveFixtures) fs.writeFileSync(fixtureFile, JSON.stringify(out, null, 2));
      }
      results.push({ source: src, items: out.items || [], data: out.data });
      health.push({ source: src.name, category: src.category, ok: true, items: (out.items || []).length });
    } catch (e) {
      // One dead feed degrades one source, never the edition.
      health.push({ source: src.name, category: src.category, ok: false, items: 0, error: String(e.message || e).slice(0, 200) });
    }
  }));

  return { results, health };
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = process.env.BROADSHEET_OUT || path.join(__dirname, 'editions');
  const date = localDate();
  const generatedAt = new Date().toISOString();

  console.log(`[press] ${date} ${args.slot} edition - fetching ${SOURCES.length} sources${args.fixtures ? ' (fixtures)' : ''}…`);
  const { results, health } = await fetchAll(args);

  for (const h of health) {
    console.log(`  ${h.ok ? '✓' : '✗'} ${h.source.padEnd(22)} ${h.ok ? `${h.items} items` : h.error}`);
  }
  const deadCount = health.filter((h) => !h.ok).length;
  if (deadCount > health.length / 2) {
    throw new Error(`${deadCount}/${health.length} sources failed - refusing to print from a dead wire`);
  }

  // Data blocks bypass editorial ranking.
  const markets = { tickers: [] };
  let weather = null;
  for (const r of results) {
    if (!r.data) continue;
    if (r.source.kind === 'coingecko' || r.source.kind === 'alphavantage') {
      markets.tickers.push(...(r.data.tickers || []));
    } else if (r.source.kind === 'open-meteo') {
      weather = r.data;
    }
  }
  // Indices before crypto in the strip.
  markets.tickers.sort((a, b) => (a.symbol === 'BTC' || a.symbol === 'ETH' ? 1 : 0) - (b.symbol === 'BTC' || b.symbol === 'ETH' ? 1 : 0));

  const storyResults = results.filter((r) => r.source.category !== '_weather');
  const items = normalize(storyResults, { slot: args.slot });
  const counts = {};
  for (const it of items) counts[it.category] = (counts[it.category] || 0) + 1;
  console.log(`[press] normalized ${items.length} items:`, JSON.stringify(counts));

  fs.mkdirSync(outDir, { recursive: true });
  if (args.dryRun) {
    const p = path.join(outDir, 'normalized.json');
    fs.writeFileSync(p, JSON.stringify({ date, slot: args.slot, counts, markets, weather, sourceHealth: health, items }, null, 2));
    console.log(`[press] dry run - wrote ${p}`);
    return;
  }

  // Editorial pass: API key (SDK) if present, else the claude CLI on
  // subscription auth, else the heuristic fallback.
  let editorOutput = null;
  let editorial = 'claude';
  const kind = args.noClaude ? 'none' : editorKind();
  if (kind === 'none') {
    if (!args.noClaude) console.warn('[press] no ANTHROPIC_API_KEY and no claude CLI - using fallback editor');
    editorial = 'fallback';
  } else {
    try {
      console.log(`[press] running the editor (${kind === 'sdk' ? MODEL : `claude CLI, model ${CLI_MODEL}`})…`);
      editorOutput = await runEditor({ items, markets, weather, slot: args.slot, date });
    } catch (e) {
      console.error(`[press] editor failed (${e.message}) - falling back to heuristic edition`);
      editorial = 'fallback';
    }
  }
  if (!editorOutput) {
    editorOutput = fallbackEditorOutput({ items, categories: CATEGORIES, slot: args.slot });
  }

  const edition = validateEdition(assembleEdition({
    editorOutput, items, categories: CATEGORIES,
    slot: args.slot, date, generatedAt, markets, weather,
    sourceHealth: health, editorial,
  }));

  const editionPath = path.join(outDir, `${edition.id}.json`);
  fs.writeFileSync(editionPath, JSON.stringify(edition, null, 2));
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(edition));
  console.log(`[press] printed ${edition.id} (${editorial}) -> ${editionPath}`);
  console.log(`[press] front page: "${edition.frontPage.lead.headline}" + ${edition.frontPage.secondaries.length} secondaries + ${edition.frontPage.briefs.length} briefs; ${edition.sections.length} sections`);
}

main().catch((e) => {
  console.error(`[press] FATAL: ${e.stack || e}`);
  process.exit(1);
});
