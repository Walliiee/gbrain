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
import { parseFactsFence, upsertFactRow } from '../../src/core/facts-fence.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
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
       VALUES ($1, $2, $3, 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', 'mcp:put_page', 0.9) RETURNING id::text AS id`,
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

  test('a DB body that is not the committed file\'s is refused inside the transaction (stale page cache); nothing written', async () => {
    await seed('Founded Acme');
    const unsynced = ALICE_DB_BODY + '\n\nSaved to the DB only.';
    const s = await run({ hooks: { beforeStamp: async () => { await engine.refreshPageBody(ALICE, SRC, unsynced, '', 'x'); } } });
    expect(s.skippedByReason.verify_failed).toBe(1);
    expect((await rows())[0]!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).toBe(unsynced);
  });

  test('a fence-less DB save that still matches the file lands before the transaction: the stamp proceeds', async () => {
    await seed('Founded Acme');
    const s = await run({ hooks: { beforeStamp: async () => { await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x'); } } });
    expect(s).toMatchObject({ rowsStamped: 1, pagesSkipped: 0 });
    expect((await rows())[0]!.row_num).not.toBeNull();
    expect(parseFactsFence((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).facts).toHaveLength(1);
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

  test('crash inside the transaction before the mirror: rolled back, nothing on disk; the next run finishes without an operator step', async () => {
    await seed('Founded Acme');
    const s1 = await run({ hooks: { beforeMirror: () => { throw new Error('injected'); } } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await rows())[0]!.row_num).toBeNull();
    expect(parseFactsFence((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).facts).toEqual([]);
    const s3 = await run();
    expect(s3).toMatchObject({ rowsAppended: 1, rowsStamped: 1, rowsRemaining: 0 });
    expect(diskFence().facts).toHaveLength(1);
  });

  test('crash after the rename, before COMMIT: DB rolled back and the committed preimage restored; the next run finishes', async () => {
    await seed('Founded Acme');
    let seen = '';
    const s1 = await run({ hooks: { beforeCommit: () => { seen = readFileSync(join(repo, ALICE_MD), 'utf-8'); throw new Error('injected before COMMIT'); } } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(parseFactsFence(seen).facts).toHaveLength(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect(git('status', '--porcelain', '--', ALICE_MD)).toBe('');
    expect((await rows())[0]!.row_num).toBeNull();
    expect(parseFactsFence((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).facts).toEqual([]);
    const s3 = await run();
    expect(s3).toMatchObject({ rowsAppended: 1, rowsStamped: 1, rowsRemaining: 0 });
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

  test('crash after the first UPDATE inside the stamp transaction rolls every row back and writes no file; the next run stamps with 2 appends', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ hooks: { afterFirstStampUpdate: () => { throw new Error('injected mid-stamp'); } } });
    expect(s1.skippedByReason.error).toBe(1);
    expect((await rows()).every(r => r.row_num === null && r.source_markdown_slug === null)).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    const s3 = await run();
    expect(s3).toMatchObject({ rowsAppended: 2, rowsStamped: 2, rowsRemaining: 0 });
    expect((await rows()).map(r => r.row_num).sort()).toEqual(diskFence().facts.map(f => f.rowNum).sort());
  });

  test('a forget between the plan and the stamp is caught by the locked per-row re-check (row_changed); nothing written; the forget stands and the full cycle leaves no active copy', async () => {
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
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect(parseFactsFence((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).facts).toEqual([]);
    const x = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(x.guardTriggered).toBe(false);
    expect(x.factsInserted).toBe(0);
    const after = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND fact = 'Founded Acme' AND expired_at IS NULL`, [SRC]);
    expect(Number(after[0]!.n)).toBe(0);
  });

  test('existing-fence reuse: a committed on-disk row without the typed columns is rewritten in place and the rebuilt row keeps them after a destructive reconcile', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 4, claim: 'MRR is 50000', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll();
    const synced = parseMarkdown(body, `${ALICE}.md`);
    await engine.refreshPageBody(ALICE, SRC, synced.compiled_truth, synced.timeline, 'synced');
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                          claim_metric, claim_value, claim_unit, claim_period)
       VALUES ($1, $2, 'MRR is 50000', 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', 'mcp:put_page', 0.9, 'mrr', 50000, 'USD', 'monthly')`, [SRC, ALICE]);
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 0, rowsRewritten: 1, pagesSkipped: 0 });
    expect(diskFence().facts[0]).toMatchObject({ rowNum: 4, claimMetric: 'mrr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'monthly' });
    // Force the wipe + reinsert: a stale fence-owned row.
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ($1, $2, 'Stale', 'fact', 'private', 'medium', now(), 'mcp:put_page', 1.0, 99, $2)`, [SRC, ALICE]);
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsDeleted).toBe(2);
    expect(r.factsInserted).toBe(1);
    const db = await engine.executeRaw<{ claim_metric: string; claim_value: number; claim_unit: string; claim_period: string; row_num: number }>(
      `SELECT claim_metric, claim_value::float8 AS claim_value, claim_unit, claim_period, row_num FROM facts WHERE source_id = $1 AND fact = 'MRR is 50000'`, [SRC]);
    expect(db).toHaveLength(1);
    expect(db[0]).toEqual({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly', row_num: 4 });
  });

  test('typed-claim columns ride into the fence and survive the reconcile; canonical fact/source are written on the stamp', async () => {
    const r0 = await engine.executeRaw<{ id: string }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                          claim_metric, claim_value, claim_unit, claim_period)
       VALUES ($1, $2, '  MRR is 50000 ', 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', '', 0.9, 'mrr', 50000, 'USD', 'monthly')
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

  // ── Two real connections, real row locks, barriers on pg_stat_activity ──
  // The stamp runs on `engine`; the competitor runs on its own instance pool
  // (`rival`); a third pool (`observer`) watches pg_stat_activity so the test
  // proceeds only once the competitor is OBSERVED blocked (or the stamp is),
  // never on a sleep.
  describe('competing transactions (review 2, findings 1 + 3)', () => {
    let rival: PostgresEngine;
    let observer: PostgresEngine;

    beforeAll(async () => {
      rival = new PostgresEngine();
      await rival.connect({ database_url: databaseUrl!, poolSize: 4 });
      observer = new PostgresEngine();
      await observer.connect({ database_url: databaseUrl!, poolSize: 2 });
    }, 60_000);
    afterAll(async () => {
      await rival?.disconnect();
      await observer?.disconnect();
    });

    /** Barrier: poll an observable condition (bounded); the assertions never depend on timing. */
    async function waitUntil(what: string, cond: () => Promise<boolean>, tries = 400): Promise<void> {
      for (let i = 0; i < tries; i++) {
        if (await cond()) return;
        await new Promise(r => setTimeout(r, 25));
      }
      throw new Error(`barrier timed out: ${what}`);
    }
    const blockedOn = (fragment: string) => async () => {
      const r = await observer.executeRaw<{ n: string }>(
        `SELECT COUNT(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      return Number(r[0]!.n) > 0;
    };

    test('a forget that starts while the stamp holds the row locks BLOCKS, then takes the fence path after the commit: the row is stamped AND struck, no active copy anywhere', () => withEnv({ GBRAIN_HOME: home }, async () => {
      const a = await seed('Founded Acme');
      let forget: Promise<Awaited<ReturnType<typeof forgetFactInFence>>> | undefined;
      const s = await repairLegacyRowsForSource(engine, {
        sourceId: SRC, lockTimeoutMs: 2_000,
        hooks: {
          afterRowLock: async () => {
            // Started on the SECOND connection while our transaction holds
            // `FOR UPDATE` on the row: its conditional legacy expire must wait.
            forget = forgetFactInFence(rival, Number(a), { reason: 'raced' });
            await waitUntil('forget blocked on the stamped row', blockedOn('UPDATE facts SET expired_at = now()'));
            // Still legacy from every other connection's point of view.
            const r = await observer.executeRaw<{ row_num: number | null; expired_at: unknown }>(`SELECT row_num, expired_at FROM facts WHERE id = $1`, [Number(a)]);
            expect(r[0]).toEqual({ row_num: null, expired_at: null });
          },
        },
      });
      expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 1, pagesSkipped: 0 });
      const f = await forget!;
      // The legacy expire found 0 rows (the row moved), the routing re-ran and
      // took the fence path: struck on disk, expired in the DB, still fence-owned.
      expect(f).toMatchObject({ ok: true, path: 'fence' });
      const disk = diskFence();
      expect(disk.facts).toHaveLength(1);
      expect(disk.facts[0]!.active).toBe(false);
      expect(disk.facts[0]!.forgotten).toBe(true);
      const row = (await rows()).find(r => r.id === a)!;
      expect(row.row_num).toBe(disk.facts[0]!.rowNum);
      const exp = await engine.executeRaw<{ expired_at: unknown }>(`SELECT expired_at FROM facts WHERE id = $1`, [Number(a)]);
      expect(exp[0]!.expired_at).not.toBeNull();
      // The cycle afterwards: the DB body (mirrored active) differs from the
      // struck file, so the destructive path is refused and the forget holds.
      const x = await runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] });
      expect(x.factsInserted).toBe(0);
      const active = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND fact = 'Founded Acme' AND expired_at IS NULL`, [SRC]);
      expect(Number(active[0]!.n)).toBe(0);
    }), 30_000);

    test('a competing transaction that already holds the row (a supersession-style valid_until change) makes the stamp WAIT; once it commits, the locked re-check refuses (row_changed) and nothing is written', async () => {
      const a = await seed('Founded Acme');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const rowLocked = new Promise<void>(resolve => { locked = resolve; });
      // Competitor: takes the row lock and holds it until released.
      const competitor = rival.transaction(async (tx) => {
        await tx.executeRaw(`UPDATE facts SET valid_until = '2026-12-31T12:00:00Z' WHERE id = $1`, [Number(a)]);
        locked();
        await gate;
      });
      await rowLocked;
      // The stamp now runs into that lock inside its own transaction…
      const stamp = withEnv({ GBRAIN_HOME: home }, () => repairLegacyRowsForSource(engine, { sourceId: SRC, lockTimeoutMs: 2_000 }));
      await waitUntil('stamp blocked on the competitor\'s row lock', blockedOn('FROM facts WHERE id = ANY($1::bigint[]) AND source_id = $2 FOR UPDATE'));
      // …and nothing has been written while it waits.
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
      release();
      await competitor;
      const s = await stamp;
      expect(s.skippedByReason.row_changed).toBe(1);
      expect(s.skippedDetails[0]).toContain('validUntil');
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
      expect(parseFactsFence((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).facts).toEqual([]);
      const r = await engine.executeRaw<{ row_num: number | null; valid_until: Date | string | null }>(`SELECT row_num, valid_until FROM facts WHERE id = $1`, [Number(a)]);
      expect(r[0]!.row_num).toBeNull();
      expect(r[0]!.valid_until).not.toBeNull();
      // The competitor's change is preserved and carried on the next run.
      const s2 = await run();
      expect(s2).toMatchObject({ rowsStamped: 1, rowsAppended: 1 });
      expect(diskFence().facts[0]!.validUntil).toBe('2026-12-31');
    }, 30_000);

    test('a second connection cannot see a stamped row before the file carries its fence: read from the rival inside the transaction, after the rename', async () => {
      const a = await seed('Founded Acme');
      let seenByRival: { row_num: number | null } | undefined;
      let fileAtCommit = '';
      const s = await withEnv({ GBRAIN_HOME: home }, () => repairLegacyRowsForSource(engine, {
        sourceId: SRC, lockTimeoutMs: 2_000,
        hooks: {
          beforeCommit: async () => {
            fileAtCommit = readFileSync(join(repo, ALICE_MD), 'utf-8');
            seenByRival = (await rival.executeRaw<{ row_num: number | null }>(`SELECT row_num FROM facts WHERE id = $1`, [Number(a)]))[0];
          },
        },
      }));
      expect(s.rowsStamped).toBe(1);
      expect(parseFactsFence(fileAtCommit).facts).toHaveLength(1);   // file already carried the fence…
      expect(seenByRival).toEqual({ row_num: null });                 // …while the stamp was still invisible to others
      expect((await rows()).find(r => r.id === a)!.row_num).not.toBeNull();
    }, 30_000);
  });
});
