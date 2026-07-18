'use strict';
// Single source of truth for the editorial contract.
//  - EDITOR_OUTPUT_SCHEMA: what Claude returns (selections by storyId + prose).
//  - assembleEdition(): joins the editor's picks back to the real fetched
//    records, so URLs/sources/dates/images can never be hallucinated - the
//    model contributes judgment and prose, the feeds contribute facts.
//  - validateEdition(): sanity gate before an edition is published.

const SLOT_TITLES = { morning: 'Morning Edition', midday: 'Midday Edition', evening: 'Evening Edition' };

const storyRef = (withBlurb) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    storyId: { type: 'string', description: 'id of a story from the input list - never invent one' },
    headline: { type: 'string', description: 'Rewritten newspaper headline, tight and concrete' },
    ...(withBlurb ? { blurb: { type: 'string', description: '1-2 sentence newspaper blurb' } } : {}),
    kicker: { type: 'string', description: 'Category label shown above the headline, e.g. "AI", "Sports"' },
  },
  required: withBlurb ? ['storyId', 'headline', 'blurb', 'kicker'] : ['storyId', 'headline', 'kicker'],
});

const EDITOR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tagline: { type: 'string', description: 'One wry line for the masthead, may reference the weather' },
    frontPage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lead: storyRef(true),
        secondaries: { type: 'array', items: storyRef(true), description: '3-4 stories' },
        briefs: { type: 'array', items: storyRef(false), description: '6-10 headline-only briefs' },
      },
      required: ['lead', 'secondaries', 'briefs'],
    },
    marketsNote: { type: 'string', description: 'One sentence on the tape, plain and dry' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', description: 'One of the input category keys' },
          stories: {
            type: 'array',
            description: '5-8 stories, most important first',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                storyId: { type: 'string' },
                headline: { type: 'string' },
                blurb: { type: 'string' },
                importance: { type: 'integer', description: '0-100' },
              },
              required: ['storyId', 'headline', 'blurb', 'importance'],
            },
          },
        },
        required: ['category', 'stories'],
      },
    },
  },
  required: ['tagline', 'frontPage', 'marketsNote', 'sections'],
};

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampImportance = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
};

// Join one editor pick back to its fetched record. Returns null (drop) when
// the editor invented an id.
function joinRef(ref, itemsById, withBlurb) {
  const item = ref && itemsById.get(ref.storyId);
  if (!item) return null;
  const out = {
    storyId: item.id,
    headline: str(ref.headline, 160) || item.title,
    kicker: str(ref.kicker, 24) || item.category,
  };
  if (withBlurb) out.blurb = str(ref.blurb, 400) || item.summary;
  return out;
}

function assembleEdition({ editorOutput, items, categories, slot, date, generatedAt, markets, weather, sourceHealth, editorial }) {
  const itemsById = new Map(items.map((it) => [it.id, it]));
  const eo = editorOutput;

  const lead = joinRef(eo.frontPage.lead, itemsById, true);
  if (!lead) throw new Error('editor lead storyId does not exist in input');
  const secondaries = (eo.frontPage.secondaries || []).map((r) => joinRef(r, itemsById, true)).filter(Boolean).slice(0, 4);
  const briefs = (eo.frontPage.briefs || []).map((r) => joinRef(r, itemsById, false)).filter(Boolean).slice(0, 10);

  const validKeys = new Set(categories.map((c) => c.key));
  const sections = [];
  for (const cat of categories) {
    const sec = (eo.sections || []).find((s) => s.category === cat.key);
    const stories = [];
    for (const s of (sec && sec.stories) || []) {
      const item = itemsById.get(s.storyId);
      if (!item || item.category !== cat.key) continue; // no cross-filing, no invented ids
      stories.push({
        id: item.id,
        headline: str(s.headline, 160) || item.title,
        blurb: str(s.blurb, 400) || item.summary,
        source: item.source,
        url: item.url,
        publishedAt: item.publishedAt,
        importance: clampImportance(s.importance),
        imageUrl: item.imageUrl,
      });
    }
    stories.sort((a, b) => b.importance - a.importance);
    if (stories.length) sections.push({ category: cat.key, title: cat.title, stories: stories.slice(0, 8) });
  }
  void validKeys;

  return {
    schemaVersion: 1,
    id: `${date}-${slot}`,
    date,
    slot,
    slotTitle: SLOT_TITLES[slot] || slot,
    generatedAt,
    editorial,
    masthead: {
      tagline: str(eo.tagline, 140),
      weather: weather || null,
    },
    frontPage: { lead, secondaries, briefs },
    markets: {
      asOf: generatedAt,
      tickers: (markets && markets.tickers) || [],
      note: str(eo.marketsNote, 200),
    },
    sections,
    sourceHealth,
  };
}

// Publication gate: throw rather than publish a malformed paper.
function validateEdition(ed) {
  const fail = (msg) => { throw new Error(`edition validation: ${msg}`); };
  if (ed.schemaVersion !== 1) fail('schemaVersion');
  if (!/^\d{4}-\d{2}-\d{2}-(morning|midday|evening)$/.test(ed.id)) fail(`bad id ${ed.id}`);
  if (!ed.frontPage || !ed.frontPage.lead || !ed.frontPage.lead.headline) fail('missing lead');
  if (!Array.isArray(ed.sections) || ed.sections.length < 3) fail(`only ${(ed.sections || []).length} sections`);
  for (const sec of ed.sections) {
    for (const s of sec.stories) {
      if (!/^https?:\/\//.test(s.url)) fail(`bad url in ${sec.category}`);
      if (!s.headline) fail(`empty headline in ${sec.category}`);
    }
  }
  const kickers = new Set([ed.frontPage.lead.kicker, ...ed.frontPage.secondaries.map((s) => s.kicker), ...ed.frontPage.briefs.map((b) => b.kicker)]);
  if (kickers.size < 3) fail('front page does not span categories');
  return ed;
}

module.exports = { EDITOR_OUTPUT_SCHEMA, assembleEdition, validateEdition, SLOT_TITLES };
