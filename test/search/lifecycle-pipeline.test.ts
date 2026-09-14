/** Native lifecycle policy at identity, graph, and cache seams; in-memory only. */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { applyAliasHop, _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';
import { structuralExactLookup } from '../../src/core/search/exact-lookup.ts';
import { resolveSearchLifecyclePolicy } from '../../src/core/search/lifecycle-policy.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';
import { resolveEntitySlugWithSource } from '../../src/core/entities/resolve.ts';
import { expandAnchors, hydrateChunks } from '../../src/core/search/two-pass.ts';
import { knobsHash, resolveSearchMode } from '../../src/core/search/mode.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  _resetSupersedeProbeForTests();
  await engine.setConfig('search.exclude_statuses', '["superseded"]');
});

async function page(slug: string, status?: string, extra: Record<string, unknown> = {}) {
  return engine.putPage(slug, {
    type: 'note', title: 'Synthetic identity', compiled_truth: 'Synthetic lifecycle fixture.',
    frontmatter: { ...(status === undefined ? {} : { status }), ...extra },
  });
}

async function code(slug: string, status?: string, extra: Record<string, unknown> = {}) {
  await page(slug, status, extra);
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'Synthetic code body',
    chunk_source: 'compiled_truth', symbol_name_qualified: 'sharedNeighbor' }]);
  return (await engine.getChunks(slug))[0].id;
}

test('alias eligibility precedes the three-injection cap; absence keeps historical aliases', async () => {
  for (const slug of ['notes/a-old', 'notes/b-old', 'notes/c-old', 'notes/z-current']) {
    await page(slug, slug.includes('old') ? ' SuPeRsEdEd\t' : undefined);
    await engine.setPageAliases(slug, 'default', ['synthetic identity']);
  }
  const legacy = await applyAliasHop(engine, [], 'synthetic identity', {});
  expect(legacy).toHaveLength(3);
  expect(legacy.every(row => row.slug.includes('old'))).toBe(true);
  const policy = await resolveSearchLifecyclePolicy(engine);
  const actual = await applyAliasHop(engine, [], 'synthetic identity', policy);
  expect(actual.map(row => row.slug)).toEqual(['notes/z-current']);
});

test('exact slug search applies lifecycle while explicit getPage still admits history', async () => {
  await page('notes/history', 'superseded');
  await page('notes/current');
  const policy = await resolveSearchLifecyclePolicy(engine);
  expect(await structuralExactLookup(engine, 'notes/history', policy)).toEqual([]);
  expect((await structuralExactLookup(engine, 'notes/current', policy))[0].slug).toBe('notes/current');
  expect((await engine.getPage('notes/history', { sourceId: 'default' }))?.slug).toBe('notes/history');
  expect((await structuralExactLookup(engine, 'notes/history'))[0].slug).toBe('notes/history');
  const titles = await engine.searchTitles('Synthetic identity', { limit: 1 });
  expect(titles.map(row => row.slug)).toEqual(['notes/current']);
  expect((await structuralExactLookup(engine, 'Synthetic identity', { ...policy, titleCandidates: titles }))[0].slug).toBe('notes/current');
});

test('exact slug eligibility precedes the federated source probe cap', async () => {
  const sources = Array.from({ length: 7 }, (_, i) => `scope-${i}`);
  for (const sourceId of sources) {
    await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1)', [sourceId]);
    await engine.putPage('notes/shared-identity', {
      type: 'note', title: 'Shared identity', compiled_truth: 'Synthetic',
      frontmatter: { status: sourceId === 'scope-6' ? 'active' : 'superseded' },
    }, { sourceId });
  }
  const policy = { ...await resolveSearchLifecyclePolicy(engine), sourceIds: sources };
  const hits = await structuralExactLookup(engine, 'notes/shared-identity', policy);
  expect(hits.map(row => row.source_id)).toEqual(['scope-6']);
});

test('seed prefix candidates exclude stale matches before ambiguity and LIMIT 10', async () => {
  for (let i = 0; i < 12; i++) await page(`people/seed-a${i}`, 'superseded');
  await page('people/seed-zcurrent');
  expect((await resolveEntitySlugWithSource(engine, 'default', 'Seed'))?.source).toBe('fallback_slugify');
  const policy = await resolveSearchLifecyclePolicy(engine);
  expect((await resolveEntitySlugWithSource(engine, 'default', 'Seed', policy))?.slug).toBe('people/seed-zcurrent');
  expect((await resolveEntitySlugWithSource(engine, 'default', 'people/seed-a0', policy))?.source).toBe('fallback_slugify');
});

test('relational recall excludes stale neighbors and origins before LIMIT without traversing excluded bridges', async () => {
  await page('companies/widget-co');
  await engine.setPageAliases('companies/widget-co', 'default', ['widget-co']);
  for (let i = 0; i < 5; i++) {
    const slug = `people/a-old-${i}`;
    await page(slug, 'superseded');
    await engine.addLink(slug, 'companies/widget-co', '', 'invested_in', 'manual');
  }
  await page('people/z-current');
  await engine.addLink('people/z-current', 'companies/widget-co', '', 'invested_in', 'manual');
  expect((await buildRelationalArm(engine, 'who invested in widget-co', { limit: 1 }))[0].slug).toBe('people/a-old-0');
  const policy = await resolveSearchLifecyclePolicy(engine);
  expect((await buildRelationalArm(engine, 'who invested in widget-co', { ...policy, limit: 1 })).map(row => row.slug)).toEqual(['people/z-current']);
  await page('people/a-origin-only');
  await page('notes/old-origin', 'superseded');
  await engine.addLink('people/a-origin-only', 'companies/widget-co', '', 'invested_in', 'frontmatter', 'notes/old-origin');
  await page('people/a-behind-bridge');
  await engine.addLink('people/a-behind-bridge', 'people/a-old-0', '', 'invested_in', 'manual');
  const rows = await engine.relationalFanout(['companies/widget-co'], { ...policy, depth: 2, direction: 'in', limit: 1 });
  expect(rows.map(row => row.slug)).toEqual(['people/z-current']);
});

test('configured code walk filters direct, symbolic, and near-symbol candidates before cap 50', async () => {
  const root = await code('code/root');
  for (let i = 0; i < 51; i++) {
    const id = await code(`code/a-old-${i}`, 'superseded');
    await engine.addCodeEdges([{ from_chunk_id: root, to_chunk_id: id,
      from_symbol_qualified: 'root', to_symbol_qualified: 'sharedNeighbor', edge_type: 'calls' }]);
  }
  const live = await code('code/z-current');
  const privateId = await code('code/private', undefined, { visibility: 'private' });
  const deleted = await code('code/deleted');
  await engine.softDeletePage('code/deleted');
  await engine.addCodeEdges([live, privateId, deleted].map(id => ({ from_chunk_id: root, to_chunk_id: id,
    from_symbol_qualified: 'root', to_symbol_qualified: 'sharedNeighbor', edge_type: 'calls' })));
  const anchor = (await hydrateChunks(engine, [root]))[0];
  anchor.score = 1;
  const policy = { ...await resolveSearchLifecyclePolicy(engine), sourceId: 'default', excludePrivate: true };
  const expanded = await expandAnchors(engine, [anchor], { ...policy, walkDepth: 1 });
  expect(expanded.map(row => row.chunk_id).sort()).toEqual([root, live].sort());
  const near = await expandAnchors(engine, [], { ...policy, nearSymbol: 'sharedNeighbor' });
  expect(near.map(row => row.chunk_id).sort()).toEqual([root, live].sort());
  const symbolicRoot = await code('code/symbolic-root');
  const symbolicAnchor = (await hydrateChunks(engine, [symbolicRoot]))[0];
  symbolicAnchor.score = 1;
  await engine.addCodeEdges([{ from_chunk_id: symbolicRoot, to_chunk_id: null,
    from_symbol_qualified: 'symbolicRoot', to_symbol_qualified: 'sharedNeighbor', edge_type: 'calls' }]);
  const symbolic = await expandAnchors(engine, [symbolicAnchor], { ...policy, walkDepth: 1 });
  expect(symbolic.map(row => row.chunk_id).sort()).toEqual([root, live, symbolicRoot].sort());
  expect((await hydrateChunks(engine, [root, live, privateId, deleted], policy)).map(row => row.chunk_id).sort()).toEqual([root, live].sort());
});

test('code walk preserves federated scope precedence while excluding foreign neighbors', async () => {
  await engine.executeRaw("INSERT INTO sources(id, name) VALUES ('allowed', 'allowed'), ('foreign', 'foreign')");
  const chunks: Record<string, number> = {};
  for (const sourceId of ['allowed', 'foreign']) {
    await engine.putPage('code/shared', { type: 'code', title: 'Shared code', compiled_truth: 'Synthetic' }, { sourceId });
    await engine.upsertChunks('code/shared', [{ chunk_index: 0, chunk_text: 'Synthetic', chunk_source: 'compiled_truth', symbol_name_qualified: 'sharedSymbol' }], { sourceId });
    chunks[sourceId] = (await engine.getChunks('code/shared', { sourceId }))[0].id;
  }
  const policy = { ...await resolveSearchLifecyclePolicy(engine), sourceIds: ['allowed'], sourceId: 'foreign' };
  const rows = await expandAnchors(engine, [], { ...policy, nearSymbol: 'sharedSymbol' });
  expect(rows.map(row => row.chunk_id)).toEqual([chunks.allowed]);
});

test('cache identity changes with effective lifecycle set and normalizes order/case/duplicates', () => {
  const mode = resolveSearchMode({});
  const active = knobsHash(mode, { excludeStatuses: ['superseded', 'done'] });
  expect(active).not.toBe(knobsHash(mode));
  expect(active).toBe(knobsHash(mode, { excludeStatuses: [' DONE\t', 'Superseded', 'done'] }));
  expect(knobsHash(mode, { excludeStatuses: [] })).toBe(knobsHash(mode));
});
