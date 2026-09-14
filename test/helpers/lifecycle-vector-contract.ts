import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { embeddingDims, prngUnitVector } from './ef-search-fixture.ts';

const STATUS_KEY = 'search.exclude_statuses';
const SOURCE = 'lifecycle-ann';
const FOREIGN = 'lifecycle-ann-foreign';
const NORMAL = Array.from({ length: 24 }, (_, i) => `notes/ann-normal-${i}`);
const FAR = Array.from({ length: 6 }, (_, i) => `notes/ann-far-${i}`);
const NEAR = 'notes/ann-near-dense';
const HISTORY = 'notes/ann-history-wall';

interface ObservedVectorQuery {
  sql: string;
  params: unknown[];
  plan: unknown;
  rows: SearchResult[];
}

type TransactionCallback = (tx: object) => Promise<unknown>;
type TransactionMethod = (...args: unknown[]) => Promise<unknown>;

/** Observe real SQL and its real plan without replacing database execution. */
async function observeVectorQueries(
  engine: BrainEngine,
  run: () => Promise<SearchResult[]>,
): Promise<{ rows: SearchResult[]; queries: ObservedVectorQuery[] }> {
  const queries: ObservedVectorQuery[] = [];
  const wrap = (tx: object): object => new Proxy(tx, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      if (key !== 'query' && key !== 'unsafe') return value.bind(target);
      return async (sql: string, params: unknown[] = []) => {
        if (!sql.includes('WITH hnsw_candidates AS')) return value.call(target, sql, params);
        const bound = [...params]; // the bounded retry loop mutates its parameter array
        const plan = await value.call(target, `EXPLAIN (FORMAT JSON) ${sql}`, bound);
        const result = await value.call(target, sql, params);
        const rows = Array.isArray(result) ? result : result.rows;
        queries.push({ sql, params: bound, plan, rows });
        return result;
      };
    },
  });
  const state = engine as unknown as {
    _db?: { transaction: TransactionMethod };
    withScopedReadTransaction?: TransactionMethod;
  };
  // PGLite's transaction owns query(); Postgres uses a callable transaction
  // whose unsafe() method receives the final vector statement. Proxying that
  // handle retains the real connection, SET LOCALs, parameters and execution.
  const owner = state._db ?? state;
  const method = state._db ? 'transaction' : 'withScopedReadTransaction';
  const callbackIndex = state._db ? 0 : 2;
  const record = owner as unknown as Record<string, TransactionMethod>;
  const original = record[method]!;
  record[method] = async (...args: unknown[]) => {
    const callback = args[callbackIndex] as TransactionCallback;
    args[callbackIndex] = (tx: object) => callback(wrap(tx));
    return original.apply(owner, args);
  };
  try {
    return { rows: await run(), queries };
  } finally {
    record[method] = original;
  }
}

function exact(query: ObservedVectorQuery): boolean {
  return /ORDER BY\s+\(cc\.[^\n]+<=>[^\n]+\)\s*\+\s*0/.test(query.sql);
}

function embedded(dim: number, distance: number, lane = 0, index = 0): Float32Array {
  const result = prngUnitVector(index, dim);
  for (let i = 0; i < result.length; i++) result[i] *= 0.001;
  result[lane] = 1;
  result[lane + 1] = distance;
  return result;
}

async function put(
  engine: BrainEngine,
  dim: number,
  slug: string,
  distance: number,
  opts: { chunks?: number; lane?: number; status?: string; private?: boolean; sourceId?: string } = {},
): Promise<void> {
  const sourceId = opts.sourceId ?? SOURCE;
  await engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: slug,
    frontmatter: { status: opts.status ?? 'active', ...(opts.private ? { visibility: 'private' } : {}) },
  }, { sourceId });
  await engine.upsertChunks(slug, Array.from({ length: opts.chunks ?? 1 }, (_, i) => ({
    chunk_index: i, chunk_source: 'compiled_truth' as const, chunk_text: `${slug} ${i}`,
    embedding: embedded(dim, distance + i / 1_000_000, opts.lane ?? 0, i),
  })), { sourceId });
  await engine.executeRaw('UPDATE pages SET chunker_version = 4 WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
}

const normalSeeded = new WeakSet<BrainEngine>();
async function seedNormal(engine: BrainEngine): Promise<number> {
  const dim = await embeddingDims(engine);
  if (normalSeeded.has(engine)) return dim;
  for (const sourceId of [SOURCE, FOREIGN]) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [sourceId]);
  }
  for (const [i, slug] of NORMAL.entries()) await put(engine, dim, slug, 0.1 + i / 100, { lane: 4 });
  // Closer candidates test every pass's containment, independently of status.
  await put(engine, dim, 'notes/ann-normal-private', 0.001, { lane: 4, private: true });
  await put(engine, dim, 'notes/ann-normal-foreign', 0.001, { lane: 4, sourceId: FOREIGN });
  await put(engine, dim, 'notes/ann-normal-deleted', 0.001, { lane: 4 });
  await engine.softDeletePage('notes/ann-normal-deleted', { sourceId: SOURCE });
  normalSeeded.add(engine);
  return dim;
}

const denseSeeded = new WeakSet<BrainEngine>();
async function seedDense(engine: BrainEngine): Promise<number> {
  const dim = await seedNormal(engine);
  if (denseSeeded.has(engine)) return dim;
  // More excluded nearest neighbors than the ef_search ceiling, plus a dense
  // eligible page whose many chunks cannot count as distinct result pages.
  await put(engine, dim, HISTORY, 0.02, { status: 'superseded', chunks: 1_200 });
  await put(engine, dim, NEAR, 0.001, { chunks: 1_100 });
  for (const [i, slug] of FAR.entries()) await put(engine, dim, slug, 1 + i / 10);
  await put(engine, dim, 'notes/ann-private', 0.0001, { private: true });
  await put(engine, dim, 'notes/ann-foreign', 0.0001, { sourceId: FOREIGN });
  await put(engine, dim, 'notes/ann-deleted', 0.0001);
  await engine.softDeletePage('notes/ann-deleted', { sourceId: SOURCE });
  denseSeeded.add(engine);
  return dim;
}

async function underIndexPlan<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  await engine.executeRaw('SET enable_seqscan = off');
  await engine.executeRaw('SET enable_sort = off');
  await engine.executeRaw('SET enable_bitmapscan = off');
  await engine.executeRaw('SET hnsw.iterative_scan = off');
  try { return await run(); } finally {
    await engine.executeRaw('RESET enable_seqscan');
    await engine.executeRaw('RESET enable_sort');
    await engine.executeRaw('RESET enable_bitmapscan');
    await engine.executeRaw('RESET hnsw.iterative_scan');
  }
}

function assertContained(queries: ObservedVectorQuery[], allowed: string[]): void {
  for (const query of queries) {
    for (const row of query.rows) {
      expect(row.source_id).toBe(SOURCE);
      expect(allowed).toContain(row.slug);
    }
  }
}

function reportPhases(queries: ObservedVectorQuery[]): void {
  console.info('Lifecycle vector phases:', queries.map(query => ({
    phase: exact(query) ? 'exact' : 'ANN',
    hnsw: JSON.stringify(query.plan).includes('idx_chunks_embedding'),
    rows: query.rows.length,
    unlimitedEligiblePool: query.params.includes(null),
  })));
}

/** Shared real-engine evidence: ANN first, bounded exact fallback when needed. */
export function lifecycleVectorContract(getEngine: () => BrainEngine): void {
  const scope = { sourceId: FOREIGN, sourceIds: [SOURCE], excludePrivate: true, detail: 'high' as const };

  test('configured nonmatching exclusions retain the actual HNSW engine plan without exact fallback', async () => {
    const engine = getEngine();
    const dim = await seedNormal(engine);
    await engine.setConfig(STATUS_KEY, '["status-not-present"]');
    const query = new Float32Array(dim); query[4] = 1;
    const observed = await underIndexPlan(engine, () => observeVectorQueries(engine, () =>
      engine.searchVector(query, { ...scope, limit: 10 })));
    reportPhases(observed.queries);
    expect(observed.rows).toHaveLength(10);
    expect(observed.queries.length).toBeGreaterThan(0);
    expect(observed.queries.every(q => !exact(q))).toBe(true);
    expect(observed.queries.some(q => JSON.stringify(q.plan).includes('idx_chunks_embedding'))).toBe(true);
    assertContained(observed.queries, NORMAL);
  }, 120_000);

  test('zero eligible ANN hits trigger bounded exact fallback without source/private/deleted escape', async () => {
    const engine = getEngine();
    const dim = await seedDense(engine);
    await engine.executeRaw("UPDATE pages SET frontmatter = jsonb_build_object('status', 'superseded') WHERE source_id = $1 AND slug = $2", [SOURCE, NEAR]);
    await engine.setConfig(STATUS_KEY, '["superseded"]');
    const query = new Float32Array(dim); query[0] = 1;
    const observed = await underIndexPlan(engine, () => observeVectorQueries(engine, () =>
      engine.searchVector(query, { ...scope, limit: 2 })));
    reportPhases(observed.queries);
    const ann = observed.queries.filter(q => !exact(q));
    expect(ann.length).toBeGreaterThan(0);
    expect(ann.length).toBeLessThanOrEqual(4);
    expect(ann.every(q => q.rows.length === 0)).toBe(true);
    expect(ann.some(q => JSON.stringify(q.plan).includes('idx_chunks_embedding'))).toBe(true);
    expect(observed.queries.filter(exact)).toHaveLength(1);
    expect(observed.rows.map(row => row.slug)).toEqual(FAR.slice(0, 2));
    assertContained(observed.queries, [...FAR, ...NORMAL]);
  }, 120_000);

  test('short ANN pools retry then exact fallback counts eligible pages rather than dense chunks', async () => {
    const engine = getEngine();
    const dim = await seedDense(engine);
    await engine.executeRaw("UPDATE pages SET frontmatter = jsonb_build_object('status', 'active') WHERE source_id = $1 AND slug = $2", [SOURCE, NEAR]);
    await engine.setConfig(STATUS_KEY, '["superseded"]');
    const query = new Float32Array(dim); query[0] = 1;
    const observed = await underIndexPlan(engine, () => observeVectorQueries(engine, () =>
      engine.searchVector(query, { ...scope, limit: 3 })));
    reportPhases(observed.queries);
    const ann = observed.queries.filter(q => !exact(q));
    expect(ann.length).toBeGreaterThan(0);
    expect(ann.length).toBeLessThanOrEqual(4);
    // ANN may discover the eligible dense page only after its first bounded
    // retry. Pin a real short nonempty phase without demanding perfect recall.
    expect(ann.some(q => q.rows.length === 1 && q.rows[0]!.slug === NEAR)).toBe(true);
    expect(ann.every(q => q.rows.length <= 1 && q.rows.every(row => row.slug === NEAR))).toBe(true);
    expect(observed.queries.filter(exact)).toHaveLength(1);
    expect(observed.rows.map(row => row.slug)).toEqual([NEAR, ...FAR.slice(0, 2)]);
    assertContained(observed.queries, [NEAR, ...FAR, ...NORMAL]);
  }, 120_000);

  test('exact fallback satisfies offset plus limit distinct pages behind dense eligible chunks', async () => {
    const engine = getEngine();
    const dim = await seedDense(engine);
    await engine.executeRaw("UPDATE pages SET frontmatter = jsonb_build_object('status', 'active') WHERE source_id = $1 AND slug = $2", [SOURCE, NEAR]);
    await engine.setConfig(STATUS_KEY, '["superseded"]');
    const query = new Float32Array(dim); query[0] = 1;
    const observed = await underIndexPlan(engine, () => observeVectorQueries(engine, () =>
      engine.searchVector(query, { ...scope, offset: 2, limit: 3 })));
    reportPhases(observed.queries);
    expect(observed.queries.filter(exact)).toHaveLength(1);
    expect(observed.rows.map(row => row.slug)).toEqual(FAR.slice(1, 4));
    expect(new Set(observed.rows.map(row => `${row.source_id}:${row.slug}`)).size).toBe(3);
    assertContained(observed.queries, [NEAR, ...FAR, ...NORMAL]);
  }, 120_000);
}
