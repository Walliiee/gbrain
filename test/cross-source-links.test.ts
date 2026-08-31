/**
 * XSRC (fork patch, 2026-08-22) — cross-source link edges must be WRITABLE and TRAVERSABLE.
 *
 * Two independent gaps, both at the operation layer, both measured against a
 * real multi-source brain on 2026-08-22:
 *
 *  GAP 1 (write): `add_link` hard-coded fromSourceId = toSourceId = ctx.sourceId
 *    ("cross-source link creation is out of scope for this wave"), so
 *    `gbrain link` / MCP `add_link` failed with
 *    `addLink failed: to page "X" (source=S) not found` whenever the endpoints
 *    lived in different sources — even though BOTH engines have resolved
 *    endpoint sources independently since v0.18.
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
 *
 * The #4109 same-source preflight (`requireWritablePage`) is preserved and made
 * PER-ENDPOINT: each endpoint is checked against the source it resolved to, so
 * a legitimate cross-source edge is not rejected before the engine sees it,
 * while a wrong endpoint source still produces #4109's exact envelope.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localFederatedSourceIds } from '../src/core/source-resolver.ts';
import {
  graphTraversalScopeOpts,
  resolveLinkEndpointSource,
  operations,
  type AuthInfo,
  type OperationContext,
} from '../src/core/operations.ts';

let engine: PGLiteEngine;
const addLink = operations.find((o) => o.name === 'add_link')!;
const removeLink = operations.find((o) => o.name === 'remove_link')!;
const traverse = operations.find((o) => o.name === 'traverse_graph')!;

type Edge = { fs: string; fslug: string; ts: string; tslug: string };
type Path = { from_slug: string; to_slug: string; link_type: string };

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: false,
    remote: false,
    sourceId: 'alpha',
    ...overrides,
  } as unknown as OperationContext;
}

function grant(allowedSources: string[]): AuthInfo {
  return { token: 'test-token', clientId: 'test-client', scopes: [], allowedSources };
}

async function edgesOfType(linkType: string): Promise<Edge[]> {
  return engine.executeRaw<Edge>(
    `SELECT f.source_id fs, f.slug fslug, t.source_id ts, t.slug tslug FROM links l
       JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_type = $1`,
    [linkType],
  );
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
}, 120_000); // full PGLite schema init can exceed the default hook timeout under suite load

afterAll(async () => { await engine.disconnect(); }, 30_000);

describe('GAP 1 — cross-source edges are writable through add_link', () => {
  test('pre-fix shape: same-source defaults still work when both params omitted', async () => {
    await engine.putPage('people/other', { type: 'note', title: 'o', compiled_truth: 'o', frontmatter: {} }, { sourceId: 'alpha' });
    await addLink.handler(ctxOf(), { from: 'people/casper', to: 'people/other', link_type: 'knows' });
    const rows = await edgesOfType('knows');
    expect(rows.length).toBe(1);
    expect(rows[0].fs).toBe('alpha');
    expect(rows[0].ts).toBe('alpha');
  });

  test('alpha -> beta edge is created when to_source_id names the far source', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'decisions/dashboard',
      link_type: 'wants', context: 'cross-source', to_source_id: 'beta',
    });
    const rows = await edgesOfType('wants');
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
    // #4527: the removal count is the proof the far endpoint was targeted —
    // a scalar-scoped delete would report 0 here.
    const result = await removeLink.handler(ctxOf(), {
      from: 'people/casper', to: 'decisions/dashboard', link_type: 'temp', to_source_id: 'beta',
    });
    expect(result).toMatchObject({ status: 'ok', removed: 1 });
    expect(await edgesOfType('temp')).toEqual([]);
  });
});

describe('GAP 1 — the #4109 preflight follows the resolved endpoint source', () => {
  test('a cross-source endpoint is preflighted against ITS source, not the ambient one', async () => {
    // Pre-port, requireWritablePage always used ctx.sourceId, so this legitimate
    // edge died at the preflight with permission_denied before the engine ran.
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'decisions/dashboard', link_type: 'preflight_ok', to_source_id: 'beta',
    });
    expect((await edgesOfType('preflight_ok')).length).toBe(1);
  });

  test('a WRONG endpoint source still produces the #4109 boundary envelope', async () => {
    // `decisions/dashboard` lives in beta; naming `parked` is readable-nowhere
    // for this caller's write source, so #4109's page_not_found stands.
    await expect(
      addLink.handler(ctxOf(), {
        from: 'people/casper', to: 'decisions/dashboard', link_type: 'wrong_src', to_source_id: 'parked',
      }),
    ).rejects.toThrow(/add_link to page "decisions\/dashboard" was not found in writable source "parked"/);
    expect(await edgesOfType('wrong_src')).toEqual([]);
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
    const ctx = ctxOf({ remote: true, auth: grant(['alpha', 'beta']) });
    expect(resolveLinkEndpointSource(ctx, 'beta', 'to_source_id', 'add_link')).toBe('beta');
  });

  test('remote caller with a grant NOT containing the source is denied', () => {
    const ctx = ctxOf({ remote: true, auth: grant(['alpha']) });
    expect(() => resolveLinkEndpointSource(ctx, 'parked', 'to_source_id', 'add_link'))
      .toThrow(/outside your granted sources/);
  });

  test('__all__ is rejected — a write names exactly one source', () => {
    expect(() => resolveLinkEndpointSource(ctxOf(), '__all__', 'to_source_id', 'add_link'))
      .toThrow(/cannot be '__all__'/);
  });

  test('a malformed endpoint source is rejected loudly, never silently dropped (#4329)', () => {
    expect(() => resolveLinkEndpointSource(ctxOf(), 'Not A Source', 'to_source_id', 'add_link'))
      .toThrow(/invalid source_id/);
    expect(() => resolveLinkEndpointSource(ctxOf(), 42, 'from_source_id', 'add_link'))
      .toThrow(/invalid source_id/);
  });
});

describe('GAP 2 — cross-source edges are traversable', () => {
  test('scalar scope alone does NOT reach the far endpoint (the pre-fix behavior)', async () => {
    const paths = await traverse.handler(ctxOf(), { slug: 'people/casper', depth: 1, direction: 'out' }) as Path[];
    expect(paths.some((p) => p.to_slug === 'decisions/dashboard')).toBe(false);
  });

  test('with the federated floor on ctx, the alpha -> beta edge is returned', async () => {
    const floor = await localFederatedSourceIds(engine, 'alpha', 'local_path');
    // seeded 'default' is federated too; what matters is that beta joined.
    expect(floor).toContain('alpha');
    expect(floor).toContain('beta');
    const ctx = ctxOf({ localFederatedSourceIds: floor });
    const paths = await traverse.handler(ctx, { slug: 'people/casper', depth: 1, direction: 'out' }) as Path[];
    const hit = paths.find((p) => p.to_slug === 'decisions/dashboard' && p.link_type === 'wants');
    expect(hit).toBeDefined();
  });

  test('a remote caller is unchanged — the #861 seal still applies', () => {
    const remote = ctxOf({ remote: true, localFederatedSourceIds: undefined });
    expect(graphTraversalScopeOpts(remote)).toEqual({ sourceId: 'alpha' });
    const granted = ctxOf({ remote: true, auth: grant(['alpha']), localFederatedSourceIds: ['alpha', 'beta'] });
    // A federated GRANT array governs and is never widened by the local floor.
    expect(graphTraversalScopeOpts(granted)).toEqual({ sourceIds: ['alpha'] });
  });

  test('an empty grant array never widens either — [] is not "no filter"', () => {
    // sourceScopeOpts refuses to read [] as unscoped; the floor must not
    // reintroduce the widening that guard exists to prevent.
    const empty = ctxOf({ remote: true, auth: grant([]), localFederatedSourceIds: ['alpha', 'beta'] });
    expect(graphTraversalScopeOpts(empty)).toEqual({ sourceId: 'alpha' });
  });

  test('an explicit --source binding stays scalar (no floor on ctx), as with search', () => {
    // Tier flag/env/dotfile → localFederatedSourceIds is never populated.
    expect(graphTraversalScopeOpts(ctxOf())).toEqual({ sourceId: 'alpha' });
  });
});

describe('GAP 2 — parked and retired sources stay unreachable', () => {
  test('the federated floor excludes an unfederated and an archived source', async () => {
    const floor = await localFederatedSourceIds(engine, 'alpha', 'local_path');
    expect(floor).not.toContain('parked');
    expect(floor).not.toContain('retired');
  });

  test('an unfederated anchor keeps scalar scope and cannot hop out', async () => {
    expect(await localFederatedSourceIds(engine, 'parked', 'local_path')).toBeUndefined();
    await addLink.handler(ctxOf({ sourceId: 'parked' }), {
      from: 'notes/parked-note', to: 'people/casper', link_type: 'leak_probe', to_source_id: 'alpha',
    });
    const ctx = ctxOf({ sourceId: 'parked' }); // no floor — localFederatedSourceIds undefined
    const paths = await traverse.handler(ctx, { slug: 'notes/parked-note', depth: 1, direction: 'out' }) as Path[];
    expect(paths.some((p) => p.to_slug === 'people/casper')).toBe(false);
  });

  test('an edge INTO a parked source is not traversable from the federated floor', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'notes/parked-note', link_type: 'into_parked', to_source_id: 'parked',
    });
    const floor = await localFederatedSourceIds(engine, 'alpha', 'local_path');
    const paths = await traverse.handler(ctxOf({ localFederatedSourceIds: floor }), {
      slug: 'people/casper', depth: 1, direction: 'out',
    }) as Path[];
    expect(paths.some((p) => p.to_slug === 'notes/parked-note')).toBe(false);
  });

  test('an edge INTO a retired (archived) source is not traversable either', async () => {
    await addLink.handler(ctxOf(), {
      from: 'people/casper', to: 'notes/retired-note', link_type: 'into_retired', to_source_id: 'retired',
    });
    const floor = await localFederatedSourceIds(engine, 'alpha', 'local_path');
    const paths = await traverse.handler(ctxOf({ localFederatedSourceIds: floor }), {
      slug: 'people/casper', depth: 1, direction: 'out',
    }) as Path[];
    expect(paths.some((p) => p.to_slug === 'notes/retired-note')).toBe(false);
  });
});
