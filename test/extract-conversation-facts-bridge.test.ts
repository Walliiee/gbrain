/**
 * One-way extraction bridge for extract-conversation-facts
 * (src/core/facts/conversation-bridge.ts + the route threading in
 * src/commands/extract-conversation-facts.ts).
 *
 * Contract under test:
 *   - default route (no output source, no visibility) is byte-for-byte the
 *     historical behavior: same source, `cli:extract-conversation-facts`,
 *     private rows, terminal row beside them;
 *   - bridged route: knowledge rows land in the OUTPUT source with the
 *     requested visibility and a bridge `source` tag naming the input source,
 *     and entity resolution runs against the OUTPUT source (where the rows
 *     and their entity pages live), while pages, checkpoints and the terminal
 *     audit row stay in the INPUT source;
 *   - rerun is idempotent (fresh terminal outcome in the input source skips
 *     the page; nothing duplicates in the output source);
 *   - --force replays delete-first on BOTH sides and never touches rows the
 *     pair does not own (same-slug rows of an output page survive; bridged
 *     rows append after them);
 *   - legacy same-source rows in the input source are cleaned by the replay;
 *   - the visibility ladder (explicit > facts.default_visibility > private);
 *   - an unknown / malformed output source fails before any extractor call;
 *   - the autopilot phase threads its two config keys into the core.
 *
 * Hermetic: the injected `extractor` seam replaces the LLM; no embedding
 * provider is configured so rows insert with NULL embeddings.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import * as ecf from '../src/commands/extract-conversation-facts.ts';
import {
  extractConversationFactsFingerprint,
  PER_SEGMENT_SOURCE_PREFIX,
  runExtractConversationFactsCore,
  TERMINAL_AUDIT_SOURCE,
} from '../src/commands/extract-conversation-facts.ts';
import {
  BRIDGE_SOURCE_PREFIX,
  bridgedFactSource,
  parseVisibilityToken,
} from '../src/core/facts/conversation-bridge.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';
import type { ExtractedFact, ExtractInput } from '../src/core/facts/extract.ts';
import { loadOpCheckpoint } from '../src/core/op-checkpoint.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const INPUT = 'transcripts';
const OUTPUT = 'default';
const SLUG = 'sessions/example';
const BRIDGE_SOURCE = bridgedFactSource(INPUT);

function message(name: string, date: string, time: string, body: string): string {
  return `**${name}** (${date} ${time}): ${body}`;
}

const ONE_SEGMENT_BODY = [
  message('Alpha Example', '2026-08-12', '10:00 AM', 'The role was accepted.'),
  message('Beta Example', '2026-08-12', '10:01 AM', 'Congratulations.'),
].join('\n');

const extractedFacts: ExtractedFact[] = [
  {
    fact: 'Brian accepted the role',
    kind: 'event',
    entity_slug: 'Brian',
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  },
  {
    fact: 'An unlisted person attended',
    kind: 'event',
    entity_slug: 'Unlisted Person',
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  },
  {
    fact: 'The weather was clear',
    kind: 'fact',
    entity_slug: null,
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'low',
  },
];

interface FactProbe {
  source_id: string;
  source: string;
  source_session: string | null;
  visibility: string;
  row_num: number | null;
  entity_slug: string | null;
  fact: string;
  context: string | null;
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  // A second, non-federated source holding the raw conversation page — the
  // shape the bridge exists for.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ('${INPUT}', '${INPUT}', '{"federated": false}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage(
    SLUG,
    {
      type: 'conversation',
      title: 'Example conversation',
      compiled_truth: ONE_SEGMENT_BODY,
      timeline: '',
      frontmatter: {},
    },
    { sourceId: INPUT },
  );
  // Entity page + alias live in the OUTPUT source, where the knowledge rows
  // land: a bridged run resolves entities there (the input source holds only
  // raw conversation pages). See extract-conversation-facts-bridge-resolution.test.ts
  // for the input-only / output-only discrimination.
  await engine.putPage(
    'people/brian-example',
    {
      type: 'person',
      title: 'Brian Example',
      compiled_truth: '# Brian Example',
      timeline: '',
      frontmatter: {},
    },
    { sourceId: OUTPUT },
  );
  await engine.setPageAliases('people/brian-example', OUTPUT, ['brian']);
});

type CountingExtractor = ((input: ExtractInput) => Promise<ExtractedFact[]>) & { calls: number };

/** Injected extractor: one batch per segment; counts invocations. */
function extractorFor(...batches: ExtractedFact[][]): CountingExtractor {
  let index = 0;
  const fn = (async (): Promise<ExtractedFact[]> => {
    fn.calls++;
    return (batches[index++] ?? []).map((row) => ({ ...row }));
  }) as unknown as CountingExtractor;
  fn.calls = 0;
  return fn;
}

async function factsFor(sourceId: string, slug = SLUG): Promise<FactProbe[]> {
  return engine.executeRaw<FactProbe>(
    `SELECT source_id, source, source_session, visibility, row_num, entity_slug, fact, context
       FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2
      ORDER BY row_num`,
    [sourceId, slug],
  );
}

function knowledgeRows(rows: FactProbe[]): FactProbe[] {
  return rows.filter((r) => r.source !== TERMINAL_AUDIT_SOURCE);
}

function terminalRows(rows: FactProbe[]): FactProbe[] {
  return rows.filter((r) => r.source === TERMINAL_AUDIT_SOURCE);
}

async function checkpointEntries(sourceId: string): Promise<string[]> {
  return loadOpCheckpoint(engine, {
    op: 'extract-conversation-facts',
    fingerprint: extractConversationFactsFingerprint({ sourceId }),
  });
}

async function bridged(overrides: Partial<Parameters<typeof runExtractConversationFactsCore>[1]> = {}) {
  return runExtractConversationFactsCore(engine, {
    sourceId: INPUT,
    slug: SLUG,
    types: ['conversation'],
    sleepMs: 0,
    outputSourceId: OUTPUT,
    visibility: 'world',
    extractor: extractorFor(extractedFacts),
    ...overrides,
  });
}

describe('conversation-bridge helpers', () => {
  test('bridge source tag never matches the same-source LIKE prefix and still starts with cli:', () => {
    expect(BRIDGE_SOURCE).toBe('cli:conversation-facts-bridge:transcripts');
    expect(BRIDGE_SOURCE.startsWith('cli:extract-conversation-facts')).toBeFalse();
    expect(BRIDGE_SOURCE.startsWith('cli:')).toBeTrue();
    expect(BRIDGE_SOURCE_PREFIX).toBe('cli:conversation-facts-bridge');
  });

  test('parseVisibilityToken accepts world/private, treats unset as undefined, rejects garbage', () => {
    expect(parseVisibilityToken('world')).toBe('world');
    expect(parseVisibilityToken(' Private ')).toBe('private');
    expect(parseVisibilityToken(undefined)).toBeUndefined();
    expect(parseVisibilityToken(null)).toBeUndefined();
    expect(parseVisibilityToken('')).toBeUndefined();
    expect(() => parseVisibilityToken('public')).toThrow(/world.*private/);
  });
});

describe('extract-conversation-facts one-way bridge', () => {
  test('default route is unchanged: same source, same-source prefix, private rows, terminal beside them', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: INPUT,
      slug: SLUG,
      types: ['conversation'],
      sleepMs: 0,
      extractor: extractorFor(extractedFacts),
    });
    expect(result.facts_inserted).toBe(3);
    expect(result.pages_processed).toBe(1);

    const rows = await factsFor(INPUT);
    const knowledge = knowledgeRows(rows);
    expect(knowledge).toHaveLength(3);
    for (const r of knowledge) {
      expect(r.source).toBe(PER_SEGMENT_SOURCE_PREFIX);
      expect(r.source_session).toBe(`${PER_SEGMENT_SOURCE_PREFIX}:${SLUG}`);
      expect(r.visibility).toBe('private');
      expect(r.context).toMatch(new RegExp(`^from ${SLUG} segment `));
    }
    expect(knowledge.map((r) => r.row_num)).toEqual([0, 1, 2]);
    expect(terminalRows(rows)).toHaveLength(1);
    expect(terminalRows(rows)[0].row_num).toBe(3);
    expect(await factsFor(OUTPUT)).toEqual([]);
  });

  test('bridged route splits knowledge rows + resolution (output, world) from pages, checkpoint and terminal (input)', async () => {
    const result = await bridged();
    expect(result.facts_extracted).toBe(3);
    expect(result.facts_inserted).toBe(3);
    expect(result.pages_processed).toBe(1);
    expect(result.pages_failed).toBe(0);

    // Output source: exactly the three knowledge rows, world-visible, bridge-tagged.
    const out = await factsFor(OUTPUT);
    expect(out).toHaveLength(3);
    expect(terminalRows(out)).toHaveLength(0);
    for (const r of out) {
      expect(r.source_id).toBe(OUTPUT);
      expect(r.source).toBe(BRIDGE_SOURCE);
      expect(r.source_session).toBe(`${BRIDGE_SOURCE}:${SLUG}`);
      expect(r.visibility).toBe('world');
      expect(r.context).toMatch(new RegExp(`^from ${INPUT}:${SLUG} segment `));
    }
    expect(out.map((r) => r.row_num)).toEqual([0, 1, 2]);
    // Entity resolution ran against the OUTPUT source's alias table.
    expect(out.map((r) => r.entity_slug)).toEqual(['people/brian-example', 'unlisted-person', null]);

    // Input source: no knowledge rows, one route-visible terminal audit row.
    const inp = await factsFor(INPUT);
    expect(knowledgeRows(inp)).toHaveLength(0);
    const terminal = terminalRows(inp);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].visibility).toBe('world');
    expect(terminal[0].row_num).toBe(0);
    expect(terminal[0].source_session).toMatch(
      new RegExp(`^${TERMINAL_AUDIT_SOURCE}:${SLUG}:route=${OUTPUT}:world:page-`),
    );

    // Checkpoint is keyed to the input source.
    expect(await checkpointEntries(INPUT)).toContain(`${INPUT}|${SLUG}|2026-08-12T10:01:00Z`);
    expect(await checkpointEntries(OUTPUT)).toEqual([]);
  });

  test('rerun is idempotent: fresh terminal in the input source skips the page, output rows do not duplicate', async () => {
    await bridged();
    const extractor = extractorFor(extractedFacts);
    const second = await bridged({ extractor });

    expect(extractor.calls).toBe(0);
    expect(second.pages_skipped_completed).toBe(1);
    expect(second.pages_processed).toBe(0);
    expect(second.facts_inserted).toBe(0);
    expect(second.orphan_facts_cleaned).toBe(0);
    expect(await factsFor(OUTPUT)).toHaveLength(3);
    expect(terminalRows(await factsFor(INPUT))).toHaveLength(1);
  });

  test('route or visibility changes invalidate completion and migrate owned rows', async () => {
    await bridged({ visibility: 'private' });
    const outputB = 'shared-output';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
      [outputB],
    );

    const extractor = extractorFor(extractedFacts);
    const replay = await bridged({ outputSourceId: outputB, visibility: 'world', extractor });
    expect(extractor.calls).toBe(1);
    expect(replay.pages_skipped_completed).toBe(0);
    expect(await factsFor(OUTPUT)).toEqual([]);
    const migrated = await factsFor(outputB);
    expect(migrated).toHaveLength(3);
    expect(migrated.every((row) => row.visibility === 'world')).toBeTrue();
  });

  test('partial ON CONFLICT result fails without terminal/checkpoint and retries cleanly', async () => {
    const original = engine.insertFacts.bind(engine);
    let partialOnce = true;
    const spy = spyOn(engine, 'insertFacts').mockImplementation(async (rows, opts) => {
      const result = await original(rows, opts);
      if (partialOnce && rows.length === extractedFacts.length && opts?.source_id === OUTPUT) {
        partialOnce = false;
        return { ...result, inserted: result.inserted - 1 };
      }
      return result;
    });
    try {
      await expect(bridged()).rejects.toThrow(/partial fact insert/);
      expect(terminalRows(await factsFor(INPUT))).toHaveLength(0);
      expect(await checkpointEntries(INPUT)).toEqual([]);

      const retry = await bridged();
      expect(retry.facts_inserted).toBe(3);
      expect(await factsFor(OUTPUT)).toHaveLength(3);
      expect(terminalRows(await factsFor(INPUT))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('force replays delete-first on both sides without duplicating', async () => {
    await bridged();
    const extractor = extractorFor(extractedFacts);
    const replay = await bridged({ force: true, extractor });

    expect(extractor.calls).toBe(1);
    // 3 bridged rows in the output + 1 terminal row in the input.
    expect(replay.orphan_facts_cleaned).toBe(4);
    expect(replay.facts_inserted).toBe(3);
    const out = await factsFor(OUTPUT);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.row_num)).toEqual([0, 1, 2]);
    expect(terminalRows(await factsFor(INPUT))).toHaveLength(1);
  });

  test('legacy same-source private rows in the input source are cleaned by the bridged replay', async () => {
    // The pre-bridge defect shape: knowledge rows written same-source + private
    // into the non-federated input source, with no fresh terminal (so the page
    // is still selected).
    await engine.insertFacts(
      [
        {
          fact: 'stranded private fact',
          kind: 'fact',
          source: PER_SEGMENT_SOURCE_PREFIX,
          source_session: `${PER_SEGMENT_SOURCE_PREFIX}:${SLUG}`,
          row_num: 0,
          source_markdown_slug: SLUG,
        },
      ],
      { source_id: INPUT },
    );
    expect(knowledgeRows(await factsFor(INPUT))).toHaveLength(1);

    const result = await bridged();
    expect(result.orphan_facts_cleaned).toBe(1);
    expect(result.facts_inserted).toBe(3);
    expect(knowledgeRows(await factsFor(INPUT))).toHaveLength(0);
    expect(terminalRows(await factsFor(INPUT))).toHaveLength(1);
    expect(await factsFor(OUTPUT)).toHaveLength(3);
  });

  test('bridged rows append after rows a same-slug output page already owns, and replay never touches them', async () => {
    // A same-slug page in the OUTPUT source extracted same-source earlier.
    await engine.insertFacts(
      [
        { fact: 'output-owned row 0', kind: 'fact', source: PER_SEGMENT_SOURCE_PREFIX, row_num: 0, source_markdown_slug: SLUG },
        { fact: 'output-owned row 1', kind: 'fact', source: PER_SEGMENT_SOURCE_PREFIX, row_num: 1, source_markdown_slug: SLUG },
      ],
      { source_id: OUTPUT },
    );

    const first = await bridged();
    expect(first.facts_inserted).toBe(3);
    let out = await factsFor(OUTPUT);
    expect(out).toHaveLength(5);
    expect(out.filter((r) => r.source === PER_SEGMENT_SOURCE_PREFIX).map((r) => r.row_num)).toEqual([0, 1]);
    expect(out.filter((r) => r.source === BRIDGE_SOURCE).map((r) => r.row_num)).toEqual([2, 3, 4]);

    const replay = await bridged({ force: true });
    // Only the pair's own rows are cleaned: 3 bridged + 1 input terminal.
    expect(replay.orphan_facts_cleaned).toBe(4);
    expect(replay.facts_inserted).toBe(3);
    out = await factsFor(OUTPUT);
    expect(out).toHaveLength(5);
    expect(out.filter((r) => r.source === PER_SEGMENT_SOURCE_PREFIX).map((r) => r.fact)).toEqual([
      'output-owned row 0',
      'output-owned row 1',
    ]);
    expect(out.filter((r) => r.source === BRIDGE_SOURCE).map((r) => r.row_num)).toEqual([2, 3, 4]);
  });

  test('same-source run with an explicit visibility stamps it without bridging', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: INPUT,
      slug: SLUG,
      types: ['conversation'],
      sleepMs: 0,
      visibility: 'world',
      extractor: extractorFor(extractedFacts),
    });
    expect(result.facts_inserted).toBe(3);
    const rows = await factsFor(INPUT);
    expect(knowledgeRows(rows).every((r) => r.source === PER_SEGMENT_SOURCE_PREFIX && r.visibility === 'world')).toBeTrue();
    expect(terminalRows(rows)[0].visibility).toBe('world');
    expect(await factsFor(OUTPUT)).toEqual([]);
  });

  test('visibility ladder: facts.default_visibility applies when unset; an explicit private wins over it', async () => {
    await engine.setConfig('facts.default_visibility', 'world');
    await runExtractConversationFactsCore(engine, {
      sourceId: INPUT,
      slug: SLUG,
      types: ['conversation'],
      sleepMs: 0,
      extractor: extractorFor(extractedFacts),
    });
    expect(knowledgeRows(await factsFor(INPUT)).map((r) => r.visibility)).toEqual(['world', 'world', 'world']);

    await runExtractConversationFactsCore(engine, {
      sourceId: INPUT,
      slug: SLUG,
      types: ['conversation'],
      sleepMs: 0,
      force: true,
      visibility: 'private',
      extractor: extractorFor(extractedFacts),
    });
    expect(knowledgeRows(await factsFor(INPUT)).map((r) => r.visibility)).toEqual(['private', 'private', 'private']);
  });

  test('bridged dry-run writes nothing anywhere', async () => {
    const result = await bridged({ dryRun: true });
    expect(result.pages_processed).toBe(1);
    expect(result.facts_extracted).toBe(3);
    expect(result.facts_inserted).toBe(0);
    expect(await factsFor(OUTPUT)).toEqual([]);
    expect(await factsFor(INPUT)).toEqual([]);
    expect(await checkpointEntries(INPUT)).toEqual([]);
  });

  test('an unregistered or malformed output source fails before any extractor call', async () => {
    const extractor = extractorFor(extractedFacts);
    await expect(bridged({ outputSourceId: 'nope', extractor })).rejects.toThrow(/not registered/);
    await expect(bridged({ outputSourceId: 'Bad_Source', extractor })).rejects.toThrow(/Invalid source_id/);
    expect(extractor.calls).toBe(0);
    expect(await factsFor(OUTPUT)).toEqual([]);
    expect(await factsFor(INPUT)).toEqual([]);
  });

  test('an archived output source is refused', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config, archived) VALUES ('parked', 'parked', '{}'::jsonb, true)`);
    const extractor = extractorFor(extractedFacts);
    await expect(bridged({ outputSourceId: 'parked', extractor })).rejects.toThrow(/archived/);
    expect(extractor.calls).toBe(0);
  });

  test('a garbage visibility value is rejected by the core', async () => {
    const extractor = extractorFor(extractedFacts);
    await expect(
      bridged({ visibility: 'public' as unknown as 'world', extractor }),
    ).rejects.toThrow(/visibility must be/);
    expect(extractor.calls).toBe(0);
  });

  test('autopilot phase threads output_source_id + visibility config into the core', async () => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    await engine.setConfig('cycle.conversation_facts_backfill.output_source_id', OUTPUT);
    await engine.setConfig('cycle.conversation_facts_backfill.visibility', 'world');
    await engine.setConfig('cycle.conversation_facts_backfill.input_source_id', INPUT);
    const seen: Array<{ sourceId: string; outputSourceId?: string; visibility?: string }> = [];
    const spy = spyOn(ecf, 'runExtractConversationFactsCore').mockImplementation(async (_engine, opts) => {
      seen.push({ sourceId: opts.sourceId, outputSourceId: opts.outputSourceId, visibility: opts.visibility });
      return {
        pages_considered: 0,
        pages_processed: 0,
        pages_skipped: 0,
        pages_skipped_too_large: 0,
        pages_skipped_disappeared: 0,
        pages_skipped_completed: 0,
        pages_skipped_non_extractable: 0,
        pages_marked_non_extractable: 0,
        pages_skipped_unrecognized_speaker: 0,
        pages_failed: 0,
        pages_llm_fallback: 0,
        pages_lock_skipped: 0,
        orphan_facts_cleaned: 0,
        segments_processed: 0,
        facts_extracted: 0,
        facts_inserted: 0,
        fallback_slugify_count: 0,
        resolution_errors: 0,
      };
    });
    try {
      const phase = await runPhaseConversationFactsBackfill(engine, {});
      expect(phase.status).toBe('ok');
      expect(phase.details.output_source_id).toBe(OUTPUT);
      expect(phase.details.visibility).toBe('world');
      const ids = seen.map((s) => s.sourceId);
      expect(ids).toEqual([INPUT]);
      for (const s of seen) {
        expect(s.outputSourceId).toBe(OUTPUT);
        expect(s.visibility).toBe('world');
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('cycle refuses bridge visibility without an intended input source', async () => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    await engine.setConfig('cycle.conversation_facts_backfill.output_source_id', OUTPUT);
    await engine.setConfig('cycle.conversation_facts_backfill.visibility', 'world');
    const phase = await runPhaseConversationFactsBackfill(engine, {});
    expect(phase.status).toBe('fail');
    expect(phase.details.error).toBe('bridge_input_source_required');
  });
});
