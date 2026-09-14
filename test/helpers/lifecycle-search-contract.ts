import { beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { SearchOpts, SearchResult } from '../../src/core/types.ts';
import { embeddingDims } from './ef-search-fixture.ts';
import { lifecycleFilterFragment } from '../../src/core/search/lifecycle-policy.ts';

const QUERY = 'lifecyclequokka';
const ALPHA = 'lifecycle-alpha';
const BETA = 'lifecycle-beta';
const STATUS_KEY = 'search.exclude_statuses';
const ACTIVE = ['notes/lifecycle-active', 'notes/lifecycle-missing'];
const OLD = 'notes/lifecycle-old-0';
const PRIVATE = 'notes/lifecycle-private';
const FOREIGN = 'notes/lifecycle-foreign';
const DELETED = 'notes/lifecycle-deleted';
const slugs = (rows: SearchResult[]) => rows.map(row => row.slug).sort();

function vector(dim: number, old = false): Float32Array {
  const result = new Float32Array(dim);
  result[0] = 1;
  result[1] = old ? 0 : 0.2;
  return result;
}

/** Synthetic evidence shared verbatim by the PGLite and Postgres contracts. */
export async function seedLifecycleCorpus(engine: BrainEngine): Promise<void> {
  const dim = await embeddingDims(engine);
  for (const source of [ALPHA, BETA]) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
  }
  const fixtures: Array<{ slug: string; status?: string; old?: boolean; private?: boolean; source?: string }> = [
    ...Array.from({ length: 8 }, (_, i) => ({ slug: `notes/lifecycle-old-${i}`, status: i % 2 ? ' SUPERSEDED\t' : 'superseded', old: true })),
    { slug: 'notes/lifecycle-archived', status: 'Archived', old: true },
    { slug: ACTIVE[0]!, status: 'ACTIVE' },
    { slug: ACTIVE[1]! },
    { slug: PRIVATE, status: 'active', private: true },
    { slug: FOREIGN, status: 'active', source: BETA },
    { slug: DELETED, status: 'active' },
  ];
  for (const fixture of fixtures) {
    const sourceId = fixture.source ?? ALPHA;
    const text = `${Array(fixture.old ? 24 : 1).fill(QUERY).join(' ')} 生命周期 ${fixture.slug}`;
    await engine.putPage(fixture.slug, {
      type: 'note',
      title: `${Array(fixture.old ? 12 : 1).fill(QUERY).join(' ')} ${fixture.slug}`,
      compiled_truth: text,
      frontmatter: {
        ...(fixture.status === undefined ? {} : { status: fixture.status }),
        ...(fixture.private ? { visibility: 'private' } : {}),
      },
    }, { sourceId });
    await engine.upsertChunks(fixture.slug, [{
      chunk_index: 0,
      chunk_source: 'compiled_truth',
      chunk_text: text,
      embedding: vector(dim, fixture.old),
      token_count: 30,
    }], { sourceId });
  }
  // These synthetic fragments contain no protected fences. Seal them as the
  // safe current chunk generation so private-page tests exercise the intended
  // page filter instead of all failing the separate legacy-chunk safeguard.
  await engine.executeRaw('UPDATE pages SET chunker_version = 4 WHERE source_id = ANY($1::text[])', [[ALPHA, BETA]]);
  await engine.softDeletePage(DELETED, { sourceId: ALPHA });
}

function context(engine: BrainEngine, remote: boolean, federated = false): OperationContext {
  return {
    engine, config: { engine: 'pglite' }, remote, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    sourceId: ALPHA,
    ...(federated ? { auth: { token: 'synthetic', clientId: 'lifecycle-client', scopes: ['read'], sourceId: ALPHA, allowedSources: [ALPHA] } } : {}),
  };
}

export function lifecycleSearchContract(getEngine: () => BrainEngine): void {
  beforeEach(async () => {
    const engine = getEngine();
    await engine.setConfig(STATUS_KEY, '["superseded", "archived"]');
    await engine.setConfig('search.mode', 'conservative');
    await engine.setConfig('search.mcp_keyword_only', 'false');
  });

  const legs: Array<[string, (engine: BrainEngine, opts: SearchOpts) => Promise<SearchResult[]>]> = [
    ['keyword', (engine, opts) => engine.searchKeyword(QUERY, opts)],
    ['keyword chunks', (engine, opts) => engine.searchKeywordChunks(QUERY, opts)],
    ['titles', (engine, opts) => engine.searchTitles(QUERY, opts)],
    ['vector', async (engine, opts) => engine.searchVector(vector(await embeddingDims(engine), true), opts)],
  ];
  for (const [name, search] of legs) {
    describe(name, () => {
      const scope: SearchOpts = { sourceId: ALPHA, excludePrivate: true, limit: 100 };

      test('configured statuses exclude mixed-case history but retain active and missing status', async () => {
        expect(slugs(await search(getEngine(), scope))).toEqual(ACTIVE);
      });

      test('exclusions happen before top-k, so stronger historical rows cannot starve active results', async () => {
        const engine = getEngine();
        await engine.executeRaw('DELETE FROM config WHERE key = $1', [STATUS_KEY]);
        const baseline = await search(engine, { ...scope, limit: 1 });
        expect(baseline).toHaveLength(1);
        expect(baseline[0]!.slug).toMatch(/^notes\/lifecycle-(?:old|archived)/);
        await engine.setConfig(STATUS_KEY, '["superseded", "archived"]');
        const filtered = await search(engine, { ...scope, limit: 2 });
        expect(slugs(filtered)).toEqual(ACTIVE);
        expect(slugs(await search(engine, { ...scope, limit: 1, offset: 1 }))).toHaveLength(1);
      });

      test('absent and empty optional config preserve historical search behavior', async () => {
        const engine = getEngine();
        await engine.executeRaw('DELETE FROM config WHERE key = $1', [STATUS_KEY]);
        const absent = slugs(await search(engine, scope));
        expect(absent).toContain(OLD);
        expect(absent).toContain('notes/lifecycle-archived');
        expect(absent).toContain(ACTIVE[0]!);
        expect(absent).toContain(ACTIVE[1]!);
        await engine.setConfig(STATUS_KEY, '[]');
        expect(slugs(await search(engine, scope))).toEqual(absent);
      });

      test('source, private-page and soft-delete containment still apply with lifecycle enabled', async () => {
        const engine = getEngine();
        const control = slugs(await search(engine, { limit: 100 }));
        expect(control).toContain(FOREIGN);
        expect(control).toContain(PRIVATE);
        expect(control).not.toContain(DELETED);
        const granted = await search(engine, { sourceIds: [ALPHA], excludePrivate: true, limit: 100 });
        expect(slugs(granted)).toEqual(ACTIVE);
        expect(granted.every(row => row.source_id === ALPHA)).toBe(true);
      });

      test('malformed configured policy fails closed instead of silently serving history', async () => {
        await getEngine().setConfig(STATUS_KEY, '{"superseded":true}');
        await expect(search(getEngine(), scope)).rejects.toThrow('search.exclude_statuses');
      });
    });
  }

  test('SQL status normalization retains non-string metadata and safely quotes configured values', async () => {
    const statuses: unknown[] = [undefined, null, false, 1, ['superseded'], { name: 'superseded' }, 'active', ' \tSuPeRsEdEd\r\n\f\v', "owner's-old"];
    const payloads = statuses.map(status => JSON.stringify(status === undefined ? {} : { status }));
    const rows = await getEngine().executeRaw<{ frontmatter: { status?: unknown } }>(
      `SELECT frontmatter FROM (SELECT value::jsonb AS frontmatter FROM unnest($1::text[]) AS value) p
        WHERE ${lifecycleFilterFragment('p', ['superseded', "owner's-old"])}`,
      [payloads],
    );
    expect(rows.map(row => row.frontmatter)).toEqual(payloads.slice(0, 7).map(payload => JSON.parse(payload)));
  });

  test('indexed vector search finds a distant active page behind more than 100 excluded neighbors', async () => {
    const engine = getEngine();
    const sourceId = 'lifecycle-dense';
    const dim = await embeddingDims(engine);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [sourceId]);
    for (const [slug, status] of [['notes/dense-history', 'superseded'], ['notes/dense-active', 'active']] as const) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, frontmatter: { status } }, { sourceId });
      await engine.upsertChunks(slug, Array.from({ length: status === 'superseded' ? 180 : 1 }, (_, i) => {
        const embedding = new Float32Array(dim);
        embedding[0] = 1;
        embedding[1] = status === 'superseded' ? (i + 1) / 100_000 : 2;
        return { chunk_index: i, chunk_source: 'compiled_truth' as const, chunk_text: `${slug} ${i}`, embedding };
      }), { sourceId });
    }
    const queryVector = vector(dim, true);
    await engine.executeRaw('SET enable_seqscan = off');
    try {
      const plan = await engine.executeRaw('EXPLAIN (FORMAT JSON) SELECT id FROM content_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 100', [`[${Array.from(queryVector).join(',')}]`]);
      expect(JSON.stringify(plan)).toContain('idx_chunks_embedding');
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [STATUS_KEY]);
      expect(slugs(await engine.searchVector(queryVector, { sourceId, limit: 1 }))).toEqual(['notes/dense-history']);
      await engine.setConfig(STATUS_KEY, '["superseded"]');
      expect(slugs(await engine.searchVector(queryVector, { sourceId, limit: 1 }))).toEqual(['notes/dense-active']);
    } finally {
      await engine.executeRaw('RESET enable_seqscan');
    }
  });

  for (const name of ['searchKeyword', 'searchKeywordChunks'] as const) {
    test(`${name}: CJK fallback keeps lifecycle, source and visibility filters`, async () => {
      const engine = getEngine();
      const scoped = { sourceId: ALPHA, excludePrivate: true, limit: 100 };
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [STATUS_KEY]);
      expect(slugs(await engine[name]('生命周期', scoped))).toContain(OLD);
      await engine.setConfig(STATUS_KEY, '["superseded", "archived"]');
      expect(slugs(await engine[name]('生命周期', scoped))).toEqual(ACTIVE);
    });
  }

  describe('shared CLI/MCP operations', () => {
    for (const name of ['search', 'query']) {
      test(`${name}: local and remote calls enforce the same configured lifecycle policy`, async () => {
        const engine = getEngine();
        const op = operations.find(operation => operation.name === name)!;
        const params = { query: QUERY, limit: 100, expansion: false, rerank: false };
        const local = await op.handler(context(engine, false), params) as SearchResult[];
        const remote = await op.handler(context(engine, true), params) as SearchResult[];
        // Local policy retains its pre-existing right to read private pages.
        expect(slugs(local)).toEqual([...ACTIVE, PRIVATE].sort());
        expect(slugs(remote)).toEqual(ACTIVE);
        const granted = await op.handler(context(engine, true, true), {
          ...params, source_id: '__all__', exclude_statuses: [], include_historical: true,
        }) as SearchResult[];
        expect(slugs(granted)).toEqual(ACTIVE);
        await expect(op.handler(context(engine, true, true), { ...params, source_id: BETA })).rejects.toMatchObject({ code: 'permission_denied' });
      });
    }

    test('search keyword-only configuration also applies lifecycle before LIMIT', async () => {
      const engine = getEngine();
      await engine.setConfig('search.mcp_keyword_only', 'true');
      const op = operations.find(operation => operation.name === 'search')!;
      expect(slugs(await op.handler(context(engine, true), { query: QUERY, limit: 2 }) as SearchResult[])).toEqual(ACTIVE);
    });

    test('explicit historical get_page remains possible without widening other read protections', async () => {
      const engine = getEngine();
      const op = operations.find(operation => operation.name === 'get_page')!;
      expect(await op.handler(context(engine, true), { slug: OLD })).toMatchObject({ slug: OLD });
      for (const slug of [PRIVATE, FOREIGN, DELETED]) {
        await expect(op.handler(context(engine, true), { slug })).rejects.toMatchObject({ code: 'page_not_found' });
      }
    });
  });
}
