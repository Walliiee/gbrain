/**
 * v0.32.2 fence backfill — `--source <id>` scoping (2026-09-13).
 *
 * Before: phase B walked `row_num IS NULL` brain-wide and refused if ANY
 * source holding a legacy row had a dirty working tree, so draining one
 * source's backlog required every repo committed clean at the same
 * moment. `--source` was accepted by the CLI and silently ignored.
 *
 * Pins: scoped phase B touches only that source's rows and file tree,
 * checks only that source's git state, names what is still pending
 * elsewhere, and the orchestrator reports `partial` (not `complete`)
 * while other sources hold fenceable rows. Phase C verifies only the
 * scoped source. Without `--source` nothing changes (the sibling
 * migrations-v0_32_2.test.ts is the brain-wide contract).
 *
 * Real PGLite + real tempdir git repos. `TMPDIR` must sit outside any git
 * checkout or the dirty-tree probe reads the enclosing repo.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { v0_32_2, __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { __testing as applyTesting } from '../src/commands/apply-migrations.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let cleanDir: string;   // source 'default' — clean git repo
let dirtyDir: string;   // source 'other'   — git repo with an uncommitted file

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

function gitInit(dir: string): void {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
}

beforeEach(async () => {
  cleanDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-scope-clean-'));
  dirtyDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-scope-dirty-'));
  gitInit(cleanDir);
  gitInit(dirtyDir);
  writeFileSync(join(dirtyDir, 'uncommitted.md'), 'dirty', 'utf-8');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [cleanDir]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [dirtyDir],
  );
});

afterEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`DELETE FROM sources WHERE id = 'other'`);
  rmSync(cleanDir, { recursive: true, force: true });
  rmSync(dirtyDir, { recursive: true, force: true });
});

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const scoped = (sourceId: string) => ({ ...OPTS, sourceId });

async function seedLegacyFact(sourceId: string, entitySlug: string | null, fact: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ($1, $2, $3, 'fact', 'private', 'medium', now(), 'mcp:put_page', 1.0)`,
    [sourceId, entitySlug, fact],
  );
}

async function rowNums(sourceId: string): Promise<Array<number | null>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `SELECT row_num FROM facts WHERE source_id = $1 ORDER BY id`, [sourceId],
  );
  return r.rows.map((x: { row_num: number | null }) => x.row_num);
}

describe('apply-migrations --source plumbing', () => {
  test('parseArgs reads --source and orchestratorOptsFrom passes it through', () => {
    const a = applyTesting.parseArgs(['--yes', '--source', 'shared']);
    expect(a.sourceId).toBe('shared');
    expect(applyTesting.orchestratorOptsFrom(a).sourceId).toBe('shared');
  });

  test('no --source → sourceId undefined (brain-wide, unchanged)', () => {
    const a = applyTesting.parseArgs(['--yes']);
    expect(a.sourceId).toBeUndefined();
    expect(applyTesting.orchestratorOptsFrom(a).sourceId).toBeUndefined();
  });
});

describe('phaseBFenceFacts — scoped to one source', () => {
  test('fences only the scoped source; a dirty UNSCOPED source with legacy rows does not block', async () => {
    await seedLegacyFact('default', 'people/alice', 'Founded Acme');
    await seedLegacyFact('default', 'people/alice', 'Prefers async');
    await seedLegacyFact('other', 'people/bob', 'Lives in Aarhus');

    const r = await __testing.phaseBFenceFacts(engine, scoped('default'));
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('scanned=2');
    expect(r.detail).toContain('fenced=2');
    expect(r.detail).toContain('[scope=default');
    expect(r.detail).toContain('still pending elsewhere: other=1');
    expect(r.pending_elsewhere).toEqual([{ source_id: 'other', n: 1 }]);

    // Scoped source: fenced on disk + stamped in the DB.
    const body = readFileSync(join(cleanDir, 'people/alice.md'), 'utf-8');
    expect(parseFactsFence(body).facts.map(f => f.claim).sort()).toEqual(['Founded Acme', 'Prefers async']);
    expect(await rowNums('default')).toEqual([1, 2]);

    // Unscoped source: no file, no DB change, its dirty tree never consulted.
    expect(existsSync(join(dirtyDir, 'people/bob.md'))).toBe(false);
    expect(await rowNums('other')).toEqual([null]);
  });

  test('scoped to the dirty source → refuses, naming only that source', async () => {
    await seedLegacyFact('default', 'people/alice', 'Founded Acme');
    await seedLegacyFact('other', 'people/bob', 'Lives in Aarhus');

    const r = await __testing.phaseBFenceFacts(engine, scoped('other'));
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('"other"');
    expect(r.detail).toContain('uncommitted changes');
    // Nothing fenced anywhere: the clean source was out of scope.
    expect(await rowNums('default')).toEqual([null]);
    expect(await rowNums('other')).toEqual([null]);
    expect(existsSync(join(cleanDir, 'people/alice.md'))).toBe(false);
  });

  test('unknown --source fails loudly instead of reporting an empty backlog', async () => {
    await seedLegacyFact('default', 'people/alice', 'Founded Acme');
    const r = await __testing.phaseBFenceFacts(engine, scoped('nope'));
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('unknown source "nope"');
    expect(await rowNums('default')).toEqual([null]);
  });

  test('dry-run counts only the scoped source', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    await seedLegacyFact('default', null, 'unparented');
    await seedLegacyFact('other', 'people/bob', 'B');
    await seedLegacyFact('other', 'people/bob', 'B2');

    const r = await __testing.phaseBFenceFacts(engine, { ...scoped('default'), dryRun: true });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('would fence 1 rows');
    expect(r.detail).toContain('1 unfenceable');
    expect(r.detail).toContain('[scope=default]');
  });

  test('scoped and nothing pending elsewhere → no partial marker', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    const r = await __testing.phaseBFenceFacts(engine, scoped('default'));
    expect(r.status).toBe('complete');
    expect(r.pending_elsewhere).toEqual([]);
    expect(r.detail).toContain('[scope=default]');
    expect(r.detail).not.toContain('pending elsewhere');
  });

  test('pending-elsewhere ignores rows a brain-wide run would skip too (NULL entity_slug, no local_path)', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    await seedLegacyFact('other', null, 'unparented');           // skipped_no_entity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO sources (id, name, local_path) VALUES ('pathless', 'pathless', NULL)`,
    );
    try {
      await seedLegacyFact('pathless', 'people/carol', 'C');    // skipped_no_local_path
      const r = await __testing.phaseBFenceFacts(engine, scoped('default'));
      expect(r.status).toBe('complete');
      expect(r.pending_elsewhere).toEqual([]);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM facts WHERE source_id = 'pathless'`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`DELETE FROM sources WHERE id = 'pathless'`);
    }
  });

  test('without --source the walk is still brain-wide and the dirty source still blocks', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    await seedLegacyFact('other', 'people/bob', 'B');
    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('"other"');
    expect(r.pending_elsewhere).toBeUndefined();
  });
});

describe('phaseCVerify — scoped to one source', () => {
  test('drift in an unscoped source does not fail a scoped verify', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    expect((await __testing.phaseBFenceFacts(engine, scoped('default'))).status).toBe('complete');

    // Fence the other source by hand and then make its file drift.
    execFileSync('git', ['-C', dirtyDir, 'add', '-A']);
    execFileSync('git', ['-C', dirtyDir, 'commit', '-q', '-m', 'seed']);
    await seedLegacyFact('other', 'people/bob', 'B');
    expect((await __testing.phaseBFenceFacts(engine, scoped('other'))).status).toBe('complete');
    const bobPath = join(dirtyDir, 'people/bob.md');
    writeFileSync(bobPath, readFileSync(bobPath, 'utf-8').replace(
      '<!--- gbrain:facts:end -->',
      '| 99 | extra | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->',
    ), 'utf-8');

    const scopedVerify = await __testing.phaseCVerify(engine, scoped('default'));
    expect(scopedVerify.status).toBe('complete');
    expect(scopedVerify.detail).toContain('pages_checked=1');

    // Brain-wide verify still sees the drift (unchanged contract).
    const wide = await __testing.phaseCVerify(engine, OPTS);
    expect(wide.status).toBe('failed');
    expect(wide.detail).toContain('people/bob');
  });
});

describe('orchestrator — scoped runs', () => {
  test('reports partial while fenceable rows remain in another source; ledger phases carry no extra keys', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    await seedLegacyFact('other', 'people/bob', 'B');

    const result = await v0_32_2.orchestrator(scoped('default'));
    expect(result.status).toBe('partial');
    expect(result.phases.map(p => p.name)).toEqual(['schema', 'fence_facts', 'verify']);
    expect(result.phases.every(p => p.status === 'complete')).toBe(true);
    for (const p of result.phases) expect('pending_elsewhere' in p).toBe(false);
    expect(await rowNums('default')).toEqual([1]);
    expect(await rowNums('other')).toEqual([null]);
  });

  test('reports complete when the scoped source was the last one holding rows', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    const result = await v0_32_2.orchestrator(scoped('default'));
    expect(result.status).toBe('complete');
  });

  test('unscoped orchestrator run is unchanged: refuses on the dirty source', async () => {
    await seedLegacyFact('default', 'people/alice', 'A');
    await seedLegacyFact('other', 'people/bob', 'B');
    const result = await v0_32_2.orchestrator(OPTS);
    expect(result.status).toBe('failed');
    expect(result.phases.find(p => p.name === 'fence_facts')?.detail).toContain('"other"');
  });
});
