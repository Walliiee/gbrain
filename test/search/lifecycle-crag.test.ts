import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.mode', 'conservative');
  await engine.setConfig('search.crag_think', 'true');
  await engine.putPage('notes/lifecycle-history', {
    type: 'note', title: 'Historical page', compiled_truth: 'Historical decision evidence.',
    frontmatter: { status: 'superseded' },
  });
  await engine.executeRaw("UPDATE pages SET effective_date = '2026-09-01' WHERE slug = 'notes/lifecycle-history'");
});
afterAll(async () => { await engine.disconnect(); });

async function weakQuery() {
  let metadata: Record<string, unknown> | undefined;
  const ctx: OperationContext = {
    engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false,
    dryRun: false, logger: { info() {}, warn() {}, error() {} },
    emitResponseMeta(_key, value) { metadata = value as Record<string, unknown>; },
  };
  const op = operations.find(operation => operation.name === 'query')!;
  const rows = await op.handler(ctx, {
    query: 'unmatchedchronicle', expand: false,
    since: '2026-01-01', until: '2026-12-31',
  });
  return { rows, crag: metadata?.crag as Record<string, unknown> };
}

test('configured lifecycle policy skips automatic think and names the coverage limit', async () => {
  await engine.setConfig('search.exclude_statuses', '["superseded"]');
  const takes = spyOn(engine, 'searchTakes');
  const floor = spyOn(engine, 'listPages');
  try {
    const { rows, crag } = await weakQuery();
    expect(rows).toEqual([]);
    expect(crag.confidence).toBe('weak');
    expect(crag.think_skipped).toBe('lifecycle_policy');
    expect(crag.think).toBeUndefined();
    expect(takes).not.toHaveBeenCalled();
    expect(floor).not.toHaveBeenCalled();
  } finally {
    takes.mockRestore();
    floor.mockRestore();
  }
});

test('absent policy retains the existing opted-in keyless think gather', async () => {
  await engine.executeRaw('DELETE FROM config WHERE key = $1', ['search.exclude_statuses']);
  const takes = spyOn(engine, 'searchTakes');
  const floor = spyOn(engine, 'listPages');
  try {
    const { rows, crag } = await weakQuery();
    expect(rows).toEqual([]);
    expect(crag.think_skipped).toBeUndefined();
    expect(takes).toHaveBeenCalled();
    expect(floor).toHaveBeenCalled();
    expect(crag.think).toMatchObject({ synthesis_status: 'no_llm' });
  } finally {
    takes.mockRestore();
    floor.mockRestore();
  }
});
