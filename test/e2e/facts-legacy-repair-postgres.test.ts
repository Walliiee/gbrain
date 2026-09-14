/**
 * Postgres parity for the legacy-fact stamp mode (fence-write.ts
 * `stampLegacyFactsToFence` via fence-legacy.ts `repairLegacyRowsForSource`).
 *
 * The unit suite (test/facts-fence-legacy-repair.test.ts) runs on PGLite.
 * These re-run the engine-touching transitions on a real Postgres: the
 * `engine.transaction` stamp with in-txn re-verify, `ANY($n::int[])` /
 * `ANY($n::text[])` params, `RETURNING id::text`, `refreshPageBody`, the
 * partial UNIQUE index `idx_facts_fence_key`, the `FOR UPDATE` page-row + fact-row
 * locks inside the stamp transaction, the mid-stamp rollback, and the reconcile after repair.
 *
 * Skipped unless DATABASE_URL names a test database (db-guard).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { repairLegacyRowsForSource, countLegacyRowsForSource } from '../../src/core/facts/fence-legacy.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
if (skip) test.skip('legacy-fact repair Postgres parity skipped (DATABASE_URL unset)', () => {});

const SRC = 'repair-pg';
const ALICE = 'people/alice-repair-pg';
const ALICE_MD = `${ALICE}.md`;
const ALICE_BODY = '---\ntype: person\ntitle: Alice\n---\n\n# Alice\n\nA person.\n';
const ALICE_DB_BODY = '# Alice\n\nA person.';

describe.skipIf(skip)('legacy-fact repair on Postgres', () => {
  let engine: PostgresEngine;
  let repo: string;
  let home: string;

  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  const commitAll = () => { git('add', '-A'); git('commit', '-q', '-m', 'c'); };
  const diskFence = () => parseFactsFence(readFileSync(join(repo, ALICE_MD), 'utf-8'));
  const run = (extra: Record<string, unknown> = {}) =>
    withEnv({ GBRAIN_HOME: home }, () => repairLegacyRowsForSource(engine, { sourceId: SRC, lockTimeoutMs: 2_000, ...extra }));

  async function seed(fact: string): Promise<string> {
    const r = await engine.executeRaw<{ id: string }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
       VALUES ($1, $2, $3, 'fact', 'private', 'medium', '2026-01-02', 'mcp:put_page', 0.9) RETURNING id::text AS id`,
      [SRC, ALICE, fact],
    );
    return r[0]!.id;
  }
  async function rows() {
    return engine.executeRaw<{ id: string; fact: string; row_num: number | null; source_markdown_slug: string | null }>(
      `SELECT id::text AS id, fact, row_num, source_markdown_slug FROM facts WHERE source_id = $1 ORDER BY id`, [SRC]);
  }
  async function cleanup() {
    await engine.executeRaw(`DELETE FROM facts WHERE source_id = $1`, [SRC]);
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [SRC]);
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [SRC]);
  }

  beforeAll(async () => {
    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl!);
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) { await cleanup(); await engine.disconnect(); }
  });

  beforeEach(async () => {
    await cleanup();
    repo = mkdtempSync(join(tmpdir(), 'gbrain-repair-pg-repo-'));
    home = mkdtempSync(join(tmpdir(), 'gbrain-repair-pg-home-'));
    git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'people'), { recursive: true });
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY, 'utf-8');
    commitAll();
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)`, [SRC, repo]);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, content_hash)
       VALUES ($1, $2, 'person', 'Alice', $3, '', 'pre-mirror-hash')`, [ALICE, SRC, ALICE_DB_BODY]);
  });

  test('happy path: file fenced, DB body mirrored with the old hash kept, rows stamped, reconcile keeps them', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s = await run();
    expect(s).toMatchObject({ rowsEligible: 2, rowsStamped: 2, rowsAppended: 2, pagesSkipped: 0, rowsRemaining: 0 });
    const page = (await engine.getPage(ALICE, { sourceId: SRC }))!;
    expect(page.compiled_truth).toContain('Founded Acme');
    expect(page.content_hash).toBe('pre-mirror-hash');
    const df = diskFence();
    expect((await rows()).map(r => r.row_num).sort()).toEqual(df.facts.map(f => f.rowNum).sort());

    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.guardTriggered).toBe(false);
    expect(r.factsDeleted).toBe(0);
    expect((await rows()).map(r => r.fact).sort()).toEqual(['Founded Acme', 'Prefers async']);
  });

  test('fence-less DB save between mirror and stamp is caught inside the transaction', async () => {
    await seed('Founded Acme');
    const s = await run({ hooks: { beforeStamp: async () => { await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x'); } } });
    expect(s.skippedByReason.verify_failed).toBe(1);
    expect((await rows())[0]!.row_num).toBeNull();
  });

  test('duplicate (fact, source) rows refuse; no 23505, no shared row_num', async () => {
    await seed('Founded Acme');
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.duplicate_legacy_rows).toBe(1);
    expect((await rows()).every(r => r.row_num === null)).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });

  test('an assigned row_num already owned by another id refuses inside the transaction (idx_facts_fence_key never trips)', async () => {
    await seed('Founded Acme');
    const s = await run({
      hooks: {
        beforeStamp: async () => {
          await engine.executeRaw(
            `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
             VALUES ($1, $2, 'Intruder', 'fact', 'private', 'medium', now(), 's', 1.0, 1, $2)`, [SRC, ALICE]);
        },
      },
    });
    expect(s.skippedByReason.fence_row_owned).toBe(1);
    expect((await rows()).find(r => r.fact === 'Founded Acme')!.row_num).toBeNull();
  });

  test('crash after rename: refused as file_uncommitted until committed, then only the stamp remains', async () => {
    await seed('Founded Acme');
    const s1 = await run({ hooks: { beforeMirror: () => { throw new Error('injected'); } } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(diskFence().facts).toHaveLength(1);
    expect((await rows())[0]!.row_num).toBeNull();
    const s2 = await run();
    expect(s2.skippedByReason.file_uncommitted).toBe(1);
    commitAll();
    const s3 = await run();
    expect(s3).toMatchObject({ rowsAppended: 0, rowsStamped: 1, rowsRemaining: 0 });
    expect(diskFence().facts).toHaveLength(1);
  });

  test('rollback, safe order: un-stamp first, then restore the file; facts retained, guard re-arms', async () => {
    await seed('Founded Acme');
    await run();
    const ids = (await rows()).map(r => Number(r.id));
    await engine.executeRaw(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
        WHERE source_id = $1 AND source_markdown_slug = $2 AND id = ANY($3::bigint[])`, [SRC, ALICE, ids]);
    git('checkout', '--', ALICE_MD);
    await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(1);
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, repairLegacy: false }));
    expect(r.guardTriggered).toBe(true);
    expect(r.factsDeleted).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  test('crash after the first UPDATE inside the stamp transaction rolls every row back; after the commit the next run stamps with 0 appends', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ hooks: { afterFirstStampUpdate: () => { throw new Error('injected mid-stamp'); } } });
    expect(s1.skippedByReason.error).toBe(1);
    expect((await rows()).every(r => r.row_num === null && r.source_markdown_slug === null)).toBe(true);
    expect(diskFence().facts).toHaveLength(2);
    commitAll();
    const s3 = await run();
    expect(s3).toMatchObject({ rowsAppended: 0, rowsStamped: 2, rowsRemaining: 0 });
    expect((await rows()).map(r => r.row_num).sort()).toEqual(diskFence().facts.map(f => f.rowNum).sort());
  });

  test('a forget between verify and stamp is caught by the locked per-row re-check (row_changed); the forget stands', async () => {
    const a = await seed('Founded Acme');
    const s = await run({ hooks: { beforeStamp: async () => {
      const f = await forgetFactInFence(engine, Number(a), { reason: 'raced' });
      expect(f).toMatchObject({ ok: true, path: 'legacy_db' });
    } } });
    expect(s.skippedByReason.row_changed).toBe(1);
    const r = await engine.executeRaw<{ row_num: number | null; expired_at: unknown }>(
      `SELECT row_num, expired_at FROM facts WHERE id = $1`, [Number(a)]);
    expect(r[0]!.row_num).toBeNull();
    expect(r[0]!.expired_at).not.toBeNull();
  });

  test('typed-claim columns ride into the fence and survive the reconcile; canonical fact/source are written on the stamp', async () => {
    const r0 = await engine.executeRaw<{ id: string }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                          claim_metric, claim_value, claim_unit, claim_period)
       VALUES ($1, $2, '  MRR is 50000 ', 'fact', 'private', 'medium', '2026-01-02', '', 0.9, 'mrr', 50000, 'USD', 'monthly')
       RETURNING id::text AS id`, [SRC, ALICE]);
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    expect(diskFence().facts[0]).toMatchObject({ claim: 'MRR is 50000', claimMetric: 'mrr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'monthly' });
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    const db = await engine.executeRaw<{ fact: string; source: string; claim_metric: string; claim_value: number }>(
      `SELECT fact, source, claim_metric, claim_value::float8 AS claim_value FROM facts WHERE id = $1`, [Number(r0[0]!.id)]);
    expect(db[0]).toEqual({ fact: 'MRR is 50000', source: 'fence:reconcile', claim_metric: 'mrr', claim_value: 50000 });
  });

  test('dry-run acquires no page lock and writes nothing', async () => {
    await seed('Founded Acme');
    const s = await run({ dryRun: true });
    expect(s).toMatchObject({ dryRun: true, rowsStamped: 0, rowsAppended: 1 });
    expect(existsSync(join(home, '.gbrain'))).toBe(false);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });
});
