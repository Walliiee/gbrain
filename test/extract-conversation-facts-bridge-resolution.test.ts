/**
 * Save-time entity resolution follows the extraction bridge.
 *
 * `extract-conversation-facts` canonicalizes every extractor-provided
 * `entity_slug` through `resolveExtractedEntitiesForSave`, which probes
 * exact-slug / alias / prefix-expansion / fuzzy STRICTLY within one source and
 * otherwise falls through to `fallback_slugify`. On a bridged route the
 * knowledge rows — and the entity pages they should point at — live in the
 * OUTPUT source; the INPUT source holds only raw conversation pages. Resolving
 * against the input source there can never hit a page, so every name becomes
 * a slugified one-off label.
 *
 * Contract under test:
 *   - bridged route: a name resolves against a page present ONLY in the
 *     output source, and a page present only in the input source is NOT
 *     consulted (the probe moves, it does not widen);
 *   - no bridge route: byte-identical to before — resolution stays in the
 *     input source and a page present only in some other source is ignored.
 *
 * Hermetic: injected `extractor` seam, PGLite, no embedding provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import type { ExtractedFact, ExtractInput } from '../src/core/facts/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const INPUT = 'transcripts';
const OUTPUT = 'default';
const SLUG = 'sessions/resolution-example';

const BODY = [
  '**Alpha Example** (2026-08-12 10:00 AM): Brian and Carol both joined.',
  '**Beta Example** (2026-08-12 10:01 AM): Noted.',
].join('\n');

/** One fact per probe subject: a name whose page is output-only, and one input-only. */
const extractedFacts: ExtractedFact[] = [
  {
    fact: 'Brian joined the call',
    kind: 'event',
    entity_slug: 'Brian',
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  },
  {
    fact: 'Carol joined the call',
    kind: 'event',
    entity_slug: 'Carol',
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  },
];

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function putPerson(slug: string, title: string, sourceId: string, alias: string): Promise<void> {
  await engine.putPage(
    slug,
    { type: 'person', title, compiled_truth: `# ${title}`, timeline: '', frontmatter: {} },
    { sourceId },
  );
  await engine.setPageAliases(slug, sourceId, [alias]);
}

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ('${INPUT}', '${INPUT}', '{"federated": false}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage(
    SLUG,
    { type: 'conversation', title: 'Resolution example', compiled_truth: BODY, timeline: '', frontmatter: {} },
    { sourceId: INPUT },
  );
  // The production shape: entity pages live in the OUTPUT source only. Carol
  // is the control — a page that exists ONLY in the input source.
  await putPerson('people/brian-example', 'Brian Example', OUTPUT, 'brian');
  await putPerson('people/carol-example', 'Carol Example', INPUT, 'carol');
});

function extractor(): (input: ExtractInput) => Promise<ExtractedFact[]> {
  let served = false;
  return async () => {
    if (served) return [];
    served = true;
    return extractedFacts.map((row) => ({ ...row }));
  };
}

async function entitySlugsIn(sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ entity_slug: string | null }>(
    `SELECT entity_slug FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND entity_slug IS NOT NULL
      ORDER BY row_num`,
    [sourceId, SLUG],
  );
  return rows.map((r) => r.entity_slug as string);
}

describe('extract-conversation-facts: entity resolution follows the bridge', () => {
  test('bridged route resolves against the OUTPUT source, not the input source', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: INPUT,
      slug: SLUG,
      types: ['conversation'],
      sleepMs: 0,
      outputSourceId: OUTPUT,
      visibility: 'world',
      extractor: extractor(),
    });
    expect(result.facts_inserted).toBe(2);
    expect(result.resolution_errors).toBe(0);
    // Brian: page exists only in OUTPUT → canonical. Carol: page exists only
    // in INPUT → not consulted → slugified.
    expect(await entitySlugsIn(OUTPUT)).toEqual(['people/brian-example', 'carol']);
    expect(result.fallback_slugify_count).toBe(1);
    expect(await entitySlugsIn(INPUT)).toEqual([]);
  });

  test('no bridge route: resolution stays in the input source (unchanged)', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: INPUT,
      slug: SLUG,
      types: ['conversation'],
      sleepMs: 0,
      extractor: extractor(),
    });
    expect(result.facts_inserted).toBe(2);
    expect(result.resolution_errors).toBe(0);
    // Brian's page lives in another source → slugified. Carol's page is in the
    // input source → canonical.
    expect(await entitySlugsIn(INPUT)).toEqual(['brian', 'people/carol-example']);
    expect(result.fallback_slugify_count).toBe(1);
    expect(await entitySlugsIn(OUTPUT)).toEqual([]);
  });
});
