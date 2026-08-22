/**
 * XSRC (fork patch, 2026-08-22) — cross-source link edges must be WRITABLE and TRAVERSABLE.
 *
 * Two independent gaps, both at the operation layer, both measured against a
 * real multi-source brain on 2026-08-22:
 *
 *  GAP 1 (write): `add_link` hard-coded fromSourceId = toSourceId = ctx.sourceId
 *    ("cross-source link creation is out of scope for this wave"), so
 *    `gbrain link` / MCP `add_link` failed with
 *    `addLink failed: page "X" (source=S) or "Y" (source=S) not found`
 *    whenever the endpoints lived in different sources — even though BOTH
 *    engines have accepted independent endpoint sources since v0.18.
 *
 *  GAP 2 (traverse): `traverse_graph` used the generic `sourceScopeOpts`, whose
 *    scalar branch pins seed + step + SELECT joins to ONE source id. Every
 *    cross-source edge already in the table was invisible through the graph API
 *    (128 of them in the measured brain; 0 reachable).
 *
 * The #861 remote-leak seal is NOT relaxed: a remote caller still cannot walk
 * or write outside its grant. Only the trusted-local UNQUALIFIED case widens,
 * to the same federated floor `federatedSearchScope` already uses — which
 * excludes unfederated (parked) and archived (retired) sources by construction.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localFederatedSourceIds } from '../src/core/source-resolver.ts';
import {
  graphTraversalScopeOpts,
  resolveLinkEndpointSource,
  operations,
  type OperationContext,
} from '../src/core/operations.ts';

let engine: PGLiteEngine;
const addLink = operations.find((o) => o.name === 'add_link')!;
const removeLink = operations.find((o) => o.name === 'remove_link')!;
const traverse = operations.find((o) => o.name === 'traverse_graph')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'alpha',
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // alpha + beta   — federated (the floor)
  // parked         — explicitly unfederated (`sources unfederate`)
  // retired        — federated but archived
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('alpha','alpha','/tmp/alpha','{"federated": true}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('beta','beta','/tmp/beta','{"federated": true}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('parked','parked','/tmp/parked','{"federated": false}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived) VALUES ('retired','retired','/tmp/retired','{"federated": true}'::jsonb, true)`,
  );
  const pages: Array<[string, string]> = [
    ['people/casper', 'alpha'],
    ['decisions/dashboard', 'beta'],
    ['notes/parked-note', 'parked'],
    ['notes/retired-note', 'retired'],
  ];
  for (const [slug, sourceId] of pages) {
    await engine.putPage(slug, {
      type: 'note', title: slug, compiled_truth: `body of ${slug}`, frontmatter: {},
    }, { sourceId });
  }
});

afterAll(async () => { await engine.close?.(); });

describe('GAP 1 — cross-source edges are writable through add_link', () => {
  test('pre-fix shape: same-source defaults still work when both params omitted', async () => {
    await engine.putPage('people/other', { type: 'note', title: 'o', compiled_truth: 'o', frontmatter: {} }, { sourceId: 'alpha' });
    await addLink.handler(ctxOf(), { from: 'people/casper', to: 'people/other', link_type: 'knows' });
    const rows = await engine.executeRaw<any>(
      `SELECT f.source_id fs, t.source_id ts FROM links l
         JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_type='knows'`);
    expect(rows.length).toBe(1);
    expect(rows[0].fs).toBe('alpha');
    expect(rows[0].ts).toBe('alpha');
  });

  test('alpha -> beta edge is created when to_source_id names the far source', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'decisions/dashboard',
      link_type: 'wants', context: 'cross-source', to_source_id: 'beta',
    });
    const rows = await engine.executeRaw<any>(
      `SELECT f.source_id fs, f.slug fslug, t.source_id ts, t.slug tslug FROM links l
         JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_type='wants'`);
    expect(rows.length).toBe(1);
    expect(`${rows[0].fs}:${rows[0].fslug}`).toBe('alpha:people/casper');
    expect(`${rows[0].ts}:${rows[0].tslug}`).toBe('beta:decisions/dashboard');
  });

  test('without to_source_id the same call still fails — the default is unchanged', async () => {
    await expect(
      addLink.handler(ctxOf(), { from: 'people/casper', to: 'decisions/dashboard', link_type: 'regress' }),
    ).rejects.toThrow(/not found/);
  });

  test('remove_link deletes what add_link created, cross-source', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'decisions/dashboard', link_type: 'temp', to_source_id: 'beta',
    });
    await removeLink.handler(ctxOf(), {
      from: 'people/casper', to: 'decisions/dashboard', link_type: 'temp', to_source_id: 'beta',
    });
    const rows = await engine.executeRaw<any>(`SELECT 1 FROM links WHERE link_type='temp'`);
    expect(rows.length).toBe(0);
  });
});

describe('GAP 1 — endpoint resolution is fail-closed for untrusted callers', () => {
  test('omitted endpoint source falls back to ctx.sourceId', () => {
    expect(resolveLinkEndpointSource(ctxOf(), undefined, 'to_source_id', 'add_link')).toBe('alpha');
  });

  test('trusted local caller may name any source', () => {
    expect(resolveLinkEndpointSource(ctxOf(), 'beta', 'to_source_id', 'add_link')).toBe('beta');
  });

  test('remote caller with no grant cannot leave its own source', () => {
    expect(() => resolveLinkEndpointSource(ctxOf({ remote: true }), 'beta', 'to_source_id', 'add_link'))
      .toThrow(/outside your granted sources/);
  });

  test('remote caller with a grant containing the source may use it', () => {
    const ctx = ctxOf({ remote: true, auth: { allowedSources: ['alpha', 'beta'] } as any });
    expect(resolveLinkEndpointSource(ctx, 'beta', 'to_source_id', 'add_link')).toBe('beta');
  });

  test('remote caller with a grant NOT containing the source is denied', () => {
    const ctx = ctxOf({ remote: true, auth: { allowedSources: ['alpha'] } as any });
    expect(() => resolveLinkEndpointSource(ctx, 'parked', 'to_source_id', 'add_link'))
      .toThrow(/outside your granted sources/);
  });

  test('__all__ is rejected — a write names exactly one source', () => {
    expect(() => resolveLinkEndpointSource(ctxOf(), '__all__', 'to_source_id', 'add_link'))
      .toThrow(/cannot be '__all__'/);
  });
});

describe('GAP 2 — cross-source edges are traversable', () => {
  test('scalar scope alone does NOT reach the far endpoint (the pre-fix behavior)', async () => {
    const paths: any = await traverse.handler(ctxOf(), { slug: 'people/casper', depth: 1, direction: 'out' });
    expect(paths.some((p: any) => p.to_slug === 'decisions/dashboard')).toBe(false);
  });

  test('with the federated floor on ctx, the alpha -> beta edge is returned', async () => {
    const floor = await localFederatedSourceIds(engine as any, 'alpha', 'local_path');
    // seeded 'default' is federated too; what matters is that beta joined.
    expect(floor).toContain('alpha');
    expect(floor).toContain('beta');
    const ctx = ctxOf({ localFederatedSourceIds: floor });
    const paths: any = await traverse.handler(ctx, { slug: 'people/casper', depth: 1, direction: 'out' });
    const hit = paths.find((p: any) => p.to_slug === 'decisions/dashboard');
    expect(hit).toBeDefined();
    expect(hit.link_type).toBe('wants');
  });

  test('a remote caller is unchanged — the #861 seal still applies', () => {
    const remote = ctxOf({ remote: true, localFederatedSourceIds: undefined });
    expect(graphTraversalScopeOpts(remote)).toEqual({ sourceId: 'alpha' });
    const granted = ctxOf({ remote: true, auth: { allowedSources: ['alpha'] } as any, localFederatedSourceIds: ['alpha', 'beta'] });
    // A federated GRANT array governs and is never widened by the local floor.
    expect(graphTraversalScopeOpts(granted)).toEqual({ sourceIds: ['alpha'] });
  });
});

describe('GAP 2 — parked and retired sources stay unreachable', () => {
  test('the federated floor excludes an unfederated and an archived source', async () => {
    const floor = await localFederatedSourceIds(engine as any, 'alpha', 'local_path');
    expect(floor).not.toContain('parked');
    expect(floor).not.toContain('retired');
  });

  test('an unfederated anchor keeps scalar scope and cannot hop out', async () => {
    expect(await localFederatedSourceIds(engine as any, 'parked', 'local_path')).toBeUndefined();
    await addLink.handler(ctxOf({ sourceId: 'parked' }), {
      from: 'notes/parked-note', to: 'people/casper', link_type: 'leak_probe', to_source_id: 'alpha',
    });
    const ctx = ctxOf({ sourceId: 'parked' }); // no floor — localFederatedSourceIds undefined
    const paths: any = await traverse.handler(ctx, { slug: 'notes/parked-note', depth: 1, direction: 'out' });
    expect(paths.some((p: any) => p.to_slug === 'people/casper')).toBe(false);
  });

  test('an edge INTO a parked source is not traversable from the federated floor', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'notes/parked-note', link_type: 'into_parked', to_source_id: 'parked',
    });
    const floor = await localFederatedSourceIds(engine as any, 'alpha', 'local_path');
    const paths: any = await traverse.handler(ctxOf({ localFederatedSourceIds: floor }), {
      slug: 'people/casper', depth: 1, direction: 'out',
    });
    expect(paths.some((p: any) => p.to_slug === 'notes/parked-note')).toBe(false);
  });

  test('an edge INTO a retired (archived) source is not traversable either', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'notes/retired-note', link_type: 'into_retired', to_source_id: 'retired',
    });
    const floor = await localFederatedSourceIds(engine as any, 'alpha', 'local_path');
    const paths: any = await traverse.handler(ctxOf({ localFederatedSourceIds: floor }), {
      slug: 'people/casper', depth: 1, direction: 'out',
    });
    expect(paths.some((p: any) => p.to_slug === 'notes/retired-note')).toBe(false);
  });
});
