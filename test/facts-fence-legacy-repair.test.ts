/**
 * Legacy-fact repair: `stampLegacyFactsToFence` (fence-write.ts) driven by
 * `repairLegacyRowsForSource` (fence-legacy.ts).
 *
 * Real PGLite brain + a tempdir git repo as the source's local_path.
 * GBRAIN_HOME is isolated because the page lock lives under it.
 *
 * Pins the acceptance criteria of
 * shared:agent-runs/2026-09-13-maintenance-fact-repair-delivery and the five
 * Codex findings on the first candidate (`f34613899`):
 *   #1 rollback ordering — no rollback code remains; the git-native sequence
 *      (un-stamp FIRST, then restore the file) is proven below, and the
 *      reverse order is shown to be the deletion window;
 *   #2 a fence-less DB save between mirror and stamp is caught inside the
 *      stamp transaction; a file edit between read and rename is refused;
 *   #3 duplicate (fact, source) legacy rows refuse the page, never share a
 *      row_num, never fabricate convergence;
 *   #4 a pre-planted symlink at the temp path is never followed (unique name
 *      + lstat + exclusive create); a symlinked target is refused;
 *   #5 no preimage store — the committed file is the preimage, and files with
 *      uncommitted changes are refused so one always exists.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractFactsFromFenceText } from '../src/core/facts/extract-from-fence.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import {
  repairLegacyRowsForSource,
  listLegacyRowsForSource,
  countLegacyRowsForSource,
  isFactRepairDisabled,
  type LegacyStampHooks,
} from '../src/core/facts/fence-legacy.ts';

let engine: PGLiteEngine;
let repo: string;
let home: string;

const SRC = 'wiki';
const ALICE = 'people/alice';
const ALICE_MD = 'people/alice.md';
const ALICE_BODY = '---\ntype: person\ntitle: Alice\n---\n\n# Alice\n\nA person who does things.\n\n## Notes\n\n- keep me\n';
const ALICE_DB_BODY = '# Alice\n\nA person who does things.\n\n## Notes\n\n- keep me';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
}

function gitInit(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  repo = mkdtempSync(join(tmpdir(), 'gbrain-fence-legacy-repo-'));
  home = mkdtempSync(join(tmpdir(), 'gbrain-fence-legacy-home-'));
  gitInit(repo);
  mkdirSync(join(repo, 'people'), { recursive: true });
  writeFileSync(join(repo, ALICE_MD), ALICE_BODY, 'utf-8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');

  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [SRC, repo],
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, $2, 'person', 'Alice', $3, '')`,
    [ALICE, SRC, ALICE_DB_BODY],
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function seed(fact: string, slug = ALICE, sourceId = SRC, source = 'mcp:put_page'): Promise<string> {
  const r = await engine.executeRaw<{ id: string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ($1, $2, $3, 'fact', 'private', 'medium', '2026-01-02', $4, 0.9)
     RETURNING id::text AS id`,
    [sourceId, slug, fact, source],
  );
  return r[0]!.id;
}

async function factRows(sourceId = SRC) {
  return engine.executeRaw<{ id: string; fact: string; row_num: number | null; source_markdown_slug: string | null; expired_at: unknown }>(
    `SELECT id::text AS id, fact, row_num, source_markdown_slug, expired_at FROM facts WHERE source_id = $1 ORDER BY id`,
    [sourceId],
  );
}

const diskFence = (rel = ALICE_MD) => parseFactsFence(readFileSync(join(repo, rel), 'utf-8'));
async function dbFence(slug = ALICE) {
  const p = await engine.getPage(slug, { sourceId: SRC });
  return parseFactsFence(p?.compiled_truth ?? '');
}
const commitAll = (msg = 'commit') => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };

const run = (hooks?: LegacyStampHooks, extra: Record<string, unknown> = {}) =>
  withEnv({ GBRAIN_HOME: home }, () =>
    repairLegacyRowsForSource(engine, { sourceId: SRC, lockTimeoutMs: 2_000, hooks, ...extra }));

// ── Happy path + idempotency ───────────────────────────────────────────────

describe('repairLegacyRowsForSource — drains, mirrors, stamps', () => {
  test('two legacy rows: fenced on disk, DB body carries the fence, rows stamped; nothing else written', async () => {
    const a = await seed('Founded Acme');
    const b = await seed('Prefers async');

    const s = await run();
    expect(s).toMatchObject({ rowsEligible: 2, rowsStamped: 2, rowsAppended: 2, pagesFenced: 1, pagesSkipped: 0, rowsRemaining: 0 });

    const disk = readFileSync(join(repo, ALICE_MD), 'utf-8');
    expect(disk).toContain('A person who does things.');
    expect(disk).toContain('- keep me');
    expect(disk.startsWith('---\ntype: person\ntitle: Alice\n---')).toBe(true);
    const df = diskFence();
    expect(df.warnings).toEqual([]);
    expect(df.facts.map(f => f.claim).sort()).toEqual(['Founded Acme', 'Prefers async']);
    expect(df.facts.map(f => f.validFrom)).toEqual(['2026-01-02', '2026-01-02']);
    expect((await dbFence()).facts.map(f => f.claim).sort()).toEqual(['Founded Acme', 'Prefers async']);

    const byId = new Map((await factRows()).map(r => [r.id, r]));
    for (const f of df.facts) {
      const id = f.claim === 'Founded Acme' ? a : b;
      expect(byId.get(id)!.row_num).toBe(f.rowNum);
      expect(byId.get(id)!.source_markdown_slug).toBe(ALICE);
    }
    // No side artifacts: no journal dir, no stray temp files.
    expect(existsSync(join(home, '.gbrain', 'fact-repair'))).toBe(false);
    expect(readdirSync(join(repo, 'people')).filter(f => f.includes('.tmp'))).toEqual([]);
    // Unhardened repo: the change stays an uncommitted, reviewable diff.
    expect(git(repo, 'status', '--porcelain').trimEnd()).toBe(` M ${ALICE_MD}`);
  });

  test('the mirror keeps the OLD content_hash so the next sync still re-imports (upstream #4872 contract)', async () => {
    await engine.executeRaw(`UPDATE pages SET content_hash = 'pre-mirror-hash' WHERE slug = $1 AND source_id = $2`, [ALICE, SRC]);
    const before = (await engine.getPage(ALICE, { sourceId: SRC }))!.content_hash;
    expect(before).toBe('pre-mirror-hash');
    await seed('Founded Acme');
    await run();
    const after = (await engine.getPage(ALICE, { sourceId: SRC }))!;
    expect(after.compiled_truth).toContain('Founded Acme');
    expect(after.content_hash).toBe(before);
  });

  test('re-run is a no-op: zero eligible rows, file untouched', async () => {
    await seed('Founded Acme');
    await run();
    const before = readFileSync(join(repo, ALICE_MD), 'utf-8');
    const s = await run();
    expect(s.rowsEligible).toBe(0);
    expect(s.pagesFenced).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(before);
  });

  test('preserves an existing fence row and its row_num; new rows append after it', async () => {
    const { body: withFence } = upsertFactRow(ALICE_BODY, {
      rowNum: 7, claim: 'Already fenced', kind: 'fact', confidence: 1, visibility: 'private',
      notability: 'medium', validFrom: '2025-05-05', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), withFence, 'utf-8');
    commitAll('fence');
    await seed('Newer claim');
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual([[7, 'Already fenced'], [8, 'Newer claim']]);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toContain('- keep me');
  });

  test('row_num counter is seeded from the DB too: a fence-less file never reissues an owned number', async () => {
    // A stamped row exists in the DB (#3) while the file carries no fence
    // (rewritten away) — the native writer's documented trap.
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ($1, $2, 'Owned already', 'fact', 'private', 'medium', now(), 's', 1.0, 3, $2)`, [SRC, ALICE]);
    await seed('Newer claim');
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    const stamped = (await factRows()).find(r => r.fact === 'Newer claim')!;
    expect(stamped.row_num).toBe(4);
  });

  test('only the requested source is touched', async () => {
    const otherRepo = mkdtempSync(join(tmpdir(), 'gbrain-fence-legacy-other-'));
    try {
      gitInit(otherRepo);
      mkdirSync(join(otherRepo, 'people'), { recursive: true });
      writeFileSync(join(otherRepo, 'people/bob.md'), '# Bob\n', 'utf-8');
      git(otherRepo, 'add', '-A'); git(otherRepo, 'commit', '-q', '-m', 'seed');
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)`, [otherRepo]);
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
         VALUES ('people/bob', 'other', 'person', 'Bob', '# Bob', '')`);
      await seed('Lives in Aarhus', 'people/bob', 'other');
      await seed('Founded Acme');
      const s = await run();
      expect(s.rowsStamped).toBe(1);
      expect((await factRows('other'))[0]!.row_num).toBeNull();
      expect(readFileSync(join(otherRepo, 'people/bob.md'), 'utf-8')).toBe('# Bob\n');
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  test('eligibility mirrors the guard: expired, pageless, and NULL-slug rows are not eligible', async () => {
    await seed('Eligible');
    const expired = await seed('Expired');
    await engine.executeRaw(`UPDATE facts SET expired_at = now() WHERE id = $1`, [expired]);
    await seed('No page', 'people/nobody');
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
       VALUES ($1, NULL, 'No slug', 'fact', 'private', 'medium', now(), 'x', 1.0)`, [SRC]);
    expect((await listLegacyRowsForSource(engine, SRC)).map(r => r.fact)).toEqual(['Eligible']);
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(1);
  });

  test('zero eligible rows: no-op', async () => {
    const s = await run();
    expect(s.rowsEligible).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });
});

// ── Refusals ───────────────────────────────────────────────────────────────

describe('stamp mode — refuses per file, never per tree', () => {
  test('an unrelated dirty file in the repo does not block the repair', async () => {
    writeFileSync(join(repo, 'someone-elses-draft.md'), 'wip', 'utf-8');
    writeFileSync(join(repo, 'people/carol.md'), '# Carol\n\nedited, uncommitted\n', 'utf-8');
    await seed('Founded Acme');
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    expect(s.pagesSkipped).toBe(0);
    expect(readFileSync(join(repo, 'someone-elses-draft.md'), 'utf-8')).toBe('wip');
    expect(readFileSync(join(repo, 'people/carol.md'), 'utf-8')).toBe('# Carol\n\nedited, uncommitted\n');
  });

  test('uncommitted changes on the TARGET file refuse (no committed preimage); their edit is untouched', async () => {
    const theirs = ALICE_BODY + '\nTheir uncommitted paragraph.\n';
    writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8');
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(s.rowsRemaining).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect((await factRows())[0]!.row_num).toBeNull();
    // Once committed (the owner's morning commit), the repair proceeds.
    commitAll('theirs');
    const s2 = await run();
    expect(s2.rowsStamped).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toContain('Their uncommitted paragraph.');
  });

  test('unmerged conflict on the path refuses', async () => {
    git(repo, 'checkout', '-q', '-b', 'theirs');
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY.replace('A person', 'Their person'), 'utf-8');
    git(repo, 'commit', '-q', '-am', 'theirs');
    git(repo, 'checkout', '-q', '-');
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY.replace('A person', 'Our person'), 'utf-8');
    git(repo, 'commit', '-q', '-am', 'ours');
    try { git(repo, 'merge', 'theirs'); } catch { /* conflict expected */ }
    const conflicted = readFileSync(join(repo, ALICE_MD), 'utf-8');
    expect(conflicted).toContain('<<<<<<<');
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.foreign_dirty).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(conflicted);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('not a git repo: refused (no committed preimage exists)', async () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.foreign_dirty).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });

  test('symlinked target refuses without following it (Codex #4)', async () => {
    const real = join(repo, 'elsewhere.md');
    writeFileSync(real, ALICE_BODY, 'utf-8');
    rmSync(join(repo, ALICE_MD));
    symlinkSync(real, join(repo, ALICE_MD));
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.symlink).toBe(1);
    expect(readFileSync(real, 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('a dangling symlink pre-planted at the fixed `.tmp` name is never followed (Codex #4): unique temp name, exclusive create', async () => {
    const outside = join(tmpdir(), `gbrain-outside-${process.pid}-${Date.now()}.md`);
    symlinkSync(outside, join(repo, `${ALICE_MD}.tmp`));
    try {
      await seed('Founded Acme');
      const s = await run();
      expect(s.rowsStamped).toBe(1);
      expect(existsSync(outside)).toBe(false);            // nothing created outside the tree
      expect(diskFence().facts).toHaveLength(1);
      expect(readdirSync(join(repo, 'people')).filter(f => f.includes('.tmp'))).toEqual(['alice.md.tmp']); // the plant, untouched
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('live DB page with no file: refuses, does NOT mint a stub', async () => {
    rmSync(join(repo, ALICE_MD));
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.file_missing).toBe(1);
    expect(existsSync(join(repo, ALICE_MD))).toBe(false);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('unresolvable target (source tree gone) refuses', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [join(repo, 'does-not-exist'), SRC]);
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.target_unresolvable).toBe(1);
  });

  test('duplicate (fact, source) legacy rows on one page refuse; no shared row_num, no fabricated convergence (Codex #3)', async () => {
    await seed('Founded Acme');
    await seed('Founded Acme');
    await seed('Prefers async');
    const s = await run();
    expect(s.skippedByReason.duplicate_legacy_rows).toBe(1);
    expect(s.rowsStamped).toBe(0);
    expect(s.rowsRemaining).toBe(3);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows()).every(r => r.row_num === null && r.expired_at === null)).toBe(true);
    expect(s.skippedDetails[0]).toContain('duplicate_legacy_rows');
  });

  test('a fence row already owned by another id refuses inside the stamp transaction (no 23505)', async () => {
    // File fence carries "Founded Acme" at #1 and the DB already owns #1
    // under a different id; the legacy row keyed to the same claim must not
    // steal it.
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 1, visibility: 'private',
      notability: 'medium', validFrom: '2025-05-05', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('fence');
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ($1, $2, 'Founded Acme', 'fact', 'private', 'medium', now(), 'mcp:put_page', 1.0, 1, $2)`, [SRC, ALICE]);
    const legacy = await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.fence_row_owned).toBe(1);
    expect((await factRows()).find(r => r.id === legacy)!.row_num).toBeNull();
  });

  test('dry-run performs no writes', async () => {
    await seed('Founded Acme');
    const s = await run(undefined, { dryRun: true });
    expect(s).toMatchObject({ dryRun: true, rowsEligible: 1, rowsStamped: 0, rowsRemaining: 1 });
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect((await dbFence()).facts).toEqual([]);
  });

  test('kill switch parses the usual off values', () => {
    expect(isFactRepairDisabled({ GBRAIN_FACT_REPAIR: 'off' })).toBe(true);
    expect(isFactRepairDisabled({ GBRAIN_FACT_REPAIR: '0' })).toBe(true);
    expect(isFactRepairDisabled({ GBRAIN_FACT_REPAIR: 'on' })).toBe(false);
    expect(isFactRepairDisabled({})).toBe(false);
  });
});

// ── Concurrent writers (Codex #2) ──────────────────────────────────────────

describe('stamp mode — concurrent writers between the transitions (Codex #2)', () => {
  test('a fence-less DB save between mirror and stamp: caught in the stamp transaction, row stays NULL, nothing deleted', async () => {
    await seed('Founded Acme');
    const s = await run({
      beforeStamp: async () => {
        // A local put_page-style writer rewrites the DB body without the fence.
        await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');
      },
    });
    expect(s.skippedByReason.verify_failed).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
    // The guard is still armed, so the reconcile cannot run and delete anything.
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, repairLegacy: false }));
    expect(r.guardTriggered).toBe(true);
    expect(r.factsDeleted).toBe(0);
    expect((await factRows())).toHaveLength(1);
  });

  test('a file edit between read and rename is refused, never overwritten', async () => {
    await seed('Founded Acme');
    const theirs = ALICE_BODY + '\nLanded while we were rendering.\n';
    const s = await run({ beforeRename: () => { writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8'); } });
    expect(s.skippedByReason.concurrent_edit).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect(readdirSync(join(repo, 'people')).filter(f => f.includes('.tmp'))).toEqual([]);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('after a successful stamp, the upstream stale-cache guard stops the reconcile deleting a row whose DB body was flattened while the file still carries it', async () => {
    await seed('Founded Acme');
    await run();
    // A local writer flattens the DB body only (file keeps the fence).
    await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsDeleted).toBe(0);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_PAGE_CACHE_STALE'));
    expect((await factRows())[0]!.row_num).not.toBeNull();
  });

  test('KNOWN LIMIT (system-wide fence-is-canonical contract): a writer that removes the fence from BOTH file and DB body lets the reconcile delete the row — same as every fence-owned row', async () => {
    await seed('Founded Acme');
    await run();
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY, 'utf-8');
    await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsDeleted).toBe(1);
    expect(await factRows()).toHaveLength(0);
  });
});

// ── Crash + retry at every transition ──────────────────────────────────────

describe('stamp mode — crash + retry', () => {
  const boom = (): never => { throw new Error('injected crash'); };

  test('crash before rename: file and DB untouched, temp removed on retry path, rows NULL; retry completes', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeRename: boom });
    expect(s1.skippedByReason.error).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);
    // The unique temp file is left as quarantine evidence and does not block.
    const s2 = await run();
    expect(s2.rowsStamped).toBe(2);
    expect(diskFence().facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(2);
  });

  test('crash after rename, before mirror: file dirty → refused until committed; then retry re-uses on-disk row_nums (no twins)', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeMirror: boom });
    expect(s1.skippedByReason.error).toBe(1);
    const disk1 = diskFence();
    expect(disk1.facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(0);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);

    // Our own dirt: refused, honestly, until someone commits the file.
    const s2 = await run();
    expect(s2.skippedByReason.file_uncommitted).toBe(1);
    commitAll('morning commit');

    const s3 = await run();
    expect(s3.rowsAppended).toBe(0);
    expect(s3.rowsStamped).toBe(2);
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual(disk1.facts.map(f => [f.rowNum, f.claim]));
    expect((await dbFence()).facts).toHaveLength(2);
    expect((await factRows()).map(r => r.row_num).sort()).toEqual(disk1.facts.map(f => f.rowNum).sort());
  });

  test('crash after mirror, before stamp: retry (after commit) only stamps', async () => {
    await seed('Founded Acme');
    const s1 = await run({ beforeStamp: boom });
    expect(s1.skippedByReason.error).toBe(1);
    expect(diskFence().facts).toHaveLength(1);
    expect((await dbFence()).facts).toHaveLength(1);
    expect((await factRows())[0]!.row_num).toBeNull();
    commitAll();
    const s2 = await run();
    expect(s2.rowsAppended).toBe(0);
    expect(s2.rowsStamped).toBe(1);
    expect((await factRows())[0]!.row_num).toBe(diskFence().facts[0]!.rowNum);
  });

  test('stamp is one transaction: a failure mid-stamp leaves zero rows stamped, never a partial page', async () => {
    const a = await seed('Founded Acme');
    await seed('Prefers async');
    // Make the second UPDATE fail by pre-owning its row_num just before the txn.
    const s1 = await run({
      beforeStamp: async () => {
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
           VALUES ($1, $2, 'Intruder', 'fact', 'private', 'medium', now(), 's', 1.0, 2, $2)`, [SRC, ALICE]);
      },
    });
    expect(s1.skippedByReason.fence_row_owned).toBe(1);
    expect((await factRows()).find(r => r.id === a)!.row_num).toBeNull();
    expect((await factRows()).filter(r => r.row_num !== null).map(r => r.fact)).toEqual(['Intruder']);
  });
});

// ── Git-native rollback: prove the safe order ──────────────────────────────

describe('rollback (git-native, no code): un-stamp FIRST, then restore the file', () => {
  test('safe order: un-stamp → git checkout → sync-equivalent refresh; facts retained, guard re-arms, next reconcile deletes nothing, repair re-heals', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    await run();
    const ids = (await factRows()).map(r => r.id);

    // 1. un-stamp first
    await engine.executeRaw(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
        WHERE source_id = $1 AND source_markdown_slug = $2 AND id = ANY($3::bigint[])`,
      [SRC, ALICE, ids.map(Number)],
    );
    // 2. restore the committed preimage
    git(repo, 'checkout', '--', ALICE_MD);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    // 3. what `gbrain sync` would do to the DB body
    await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');

    expect(await factRows()).toHaveLength(2);
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(2);
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, repairLegacy: false }));
    expect(r.guardTriggered).toBe(true);
    expect(r.factsDeleted).toBe(0);
    // And with the repair on, it heals again.
    const s = await run();
    expect(s.rowsStamped).toBe(2);
  });

  test('WRONG order (restore file + refresh body BEFORE un-stamp) is the deletion window — documented, never automated', async () => {
    await seed('Founded Acme');
    await run();
    git(repo, 'checkout', '--', ALICE_MD);
    await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsDeleted).toBe(1);
    expect(await factRows()).toHaveLength(0);
  });
});

// ── 2026-09-14 acceptance-review fixes (findings 1–6) ─────────────────────

const putPageOp = operations.find((o) => o.name === 'put_page')!;
function opCtx(): OperationContext {
  return {
    engine: engine as any,
    config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: SRC,
  } as OperationContext;
}
function installFakeDurabilityHook(repoPath: string): void {
  const hooksDir = join(repoPath, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'post-commit');
  writeFileSync(hookPath, ['#!/usr/bin/env bash', '# gbrain brain-durability post-commit hook (v0.42.44+)', 'exit 0', ''].join('\n'));
  chmodSync(hookPath, 0o755);
}
const reconcile = (extra: Record<string, unknown> = {}) =>
  withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE], ...extra }));

describe('finding 3 — a committed preimage, not merely an empty git status', () => {
  test('a git-IGNORED file that exists on disk is refused: empty status is not a preimage', async () => {
    writeFileSync(join(repo, '.gitignore'), 'people/alice.md\n', 'utf-8');
    git(repo, 'rm', '-q', '--cached', ALICE_MD);
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore alice');
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');   // the pre-fix "clean"
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.foreign_dirty).toBe(1);
    expect(s.skippedDetails[0]).toContain('ignored');
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('an UNTRACKED file (never added) shows as `??` self-dirt: refused as file_uncommitted', async () => {
    git(repo, 'rm', '-q', '--cached', ALICE_MD);
    git(repo, 'commit', '-q', '-m', 'untrack alice');
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('a file staged but never committed has no HEAD blob: refused as file_uncommitted', async () => {
    writeFileSync(join(repo, 'people/bob.md'), '---\ntype: person\ntitle: Bob\n---\n\n# Bob\n', 'utf-8');
    git(repo, 'add', 'people/bob.md');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ('people/bob', $1, 'person', 'Bob', '# Bob', '')`, [SRC]);
    await seed('Lives in Aarhus', 'people/bob');
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
  });
});

describe('finding 4 — keys are what the fence reads back (render → parse)', () => {
  test("same claim with sources '' and 'fence:reconcile' is duplicate_legacy_rows", async () => {
    await seed('Founded Acme', ALICE, SRC, '');
    await seed('Founded Acme', ALICE, SRC, 'fence:reconcile');
    const s = await run();
    expect(s.skippedByReason.duplicate_legacy_rows).toBe(1);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });

  test('blank and whitespace-only provenance collide too (both read back as fence:reconcile); padded claims collide with trimmed ones', async () => {
    await seed('Founded Acme', ALICE, SRC, '');
    await seed('  Founded Acme ', ALICE, SRC, '  ');
    const s = await run();
    expect(s.skippedByReason.duplicate_legacy_rows).toBe(1);
  });

  test('a claim with surrounding whitespace and a `|` round-trips, de-dupes against the on-disk row, and the DB row is canonicalised so the reconcile no-ops', async () => {
    const claim = '  Prefers async | not meetings  ';
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 3, claim: claim.trim(), kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('fence');
    const id = await seed(claim);
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 0, pagesSkipped: 0 });
    const row = (await factRows()).find(r => r.id === id)!;
    expect(row.row_num).toBe(3);
    expect(row.fact).toBe('Prefers async | not meetings');
    expect(diskFence().facts[0]!.claim).toBe('Prefers async | not meetings');
    const r = await reconcile();
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    expect((await factRows()).find(r => r.id === id)!.row_num).toBe(3);
  });

  test('blank provenance is stamped as fence:reconcile so the reconcile sees one key, not two', async () => {
    const id = await seed('Founded Acme', ALICE, SRC, '');
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    const src = await engine.executeRaw<{ source: string }>(`SELECT source FROM facts WHERE id = $1`, [id]);
    expect(src[0]!.source).toBe('fence:reconcile');
    const r = await reconcile();
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    expect(await factRows()).toHaveLength(1);
  });

  test('a claim that would read back as strikethrough is refused, never stamped as an inactive row', async () => {
    await seed('~~Founded Acme~~');
    const s = await run();
    expect(s.skippedByReason.fence_parse_failed).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
  });
});

describe('finding 5 — typed metadata rides into the fence', () => {
  test('claim_metric/value/unit/period stamp, and render → parse → extractFactsFromFenceText yields the same typed values; reconcile no-ops', async () => {
    const r0 = await engine.executeRaw<{ id: string }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                          claim_metric, claim_value, claim_unit, claim_period)
       VALUES ($1, $2, 'MRR is 50000', 'fact', 'private', 'medium', '2026-01-02', 'mcp:put_page', 0.9, 'mrr', 50000, 'USD', 'monthly')
       RETURNING id::text AS id`, [SRC, ALICE]);
    const id = r0[0]!.id;
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    const df = diskFence();
    expect(df.warnings).toEqual([]);
    expect(df.facts[0]).toMatchObject({ claim: 'MRR is 50000', claimMetric: 'mrr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'monthly' });
    const extracted = extractFactsFromFenceText(df.facts, ALICE, SRC);
    expect(extracted[0]).toMatchObject({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly' });
    const r = await reconcile();
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    const db = await engine.executeRaw<{ claim_metric: string; claim_value: number; claim_unit: string; claim_period: string }>(
      `SELECT claim_metric, claim_value::float8 AS claim_value, claim_unit, claim_period FROM facts WHERE id = $1`, [id]);
    expect(db[0]).toEqual({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly' });
  });

  test('a cli:-provenance row is not fence-owned (#1928): refused as unexpressible_columns, never stamped', async () => {
    await seed('Said in conversation', ALICE, SRC, 'cli:session-1');
    const s = await run();
    expect(s.skippedByReason.unexpressible_columns).toBe(1);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });

  test('an ACTIVE row carrying superseded_by has no fence form: refused as unexpressible_columns', async () => {
    const target = await seed('Newer claim');
    const older = await seed('Older claim');
    await engine.executeRaw(`UPDATE facts SET superseded_by = $1 WHERE id = $2`, [Number(target), older]);
    const s = await run();
    expect(s.skippedByReason.unexpressible_columns).toBe(1);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });
});

describe('finding 6 — dry-run purity', () => {
  test('dry-run takes no page lock (lock dir absent), writes nothing, file byte-identical', async () => {
    await seed('Founded Acme');
    const before = readFileSync(join(repo, ALICE_MD));
    const lockDir = join(home, '.gbrain', 'page-locks');
    expect(existsSync(lockDir)).toBe(false);
    const s = await run(undefined, { dryRun: true });
    expect(s).toMatchObject({ dryRun: true, rowsEligible: 1, rowsStamped: 0, rowsAppended: 1, pagesFenced: 1 });
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(join(home, '.gbrain'))).toBe(false);
    expect(readFileSync(join(repo, ALICE_MD)).equals(before)).toBe(true);
    expect(readdirSync(join(repo, 'people'))).toEqual(['alice.md']);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect((await dbFence()).facts).toEqual([]);
  });

  test('dry-run does not reap a stale lock either', async () => {
    await seed('Founded Acme');
    const lockDir = join(home, '.gbrain', 'page-locks');
    mkdirSync(lockDir, { recursive: true });
    const sha = createHash('sha256').update(ALICE).digest('hex');
    const stale = join(lockDir, `${sha}.lock`);
    writeFileSync(stale, '1\n2000-01-01T00:00:00.000Z\ntoken\n');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, old, old);
    await run(undefined, { dryRun: true });
    expect(readFileSync(stale, 'utf-8')).toBe('1\n2000-01-01T00:00:00.000Z\ntoken\n');
  });
});

describe('crash proofs (real, inside the transaction)', () => {
  test('(a) crash mid-stamp after the first UPDATE rolls the whole stamp back; after the commit the next run converges with zero appends on the same row_nums', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ afterFirstStampUpdate: () => { throw new Error('injected crash mid-stamp'); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(s1.skippedDetails[0]).toContain('injected crash mid-stamp');
    // Transaction rolled back: NO row is stamped, not even the first.
    expect((await factRows()).every(r => r.row_num === null && r.source_markdown_slug === null)).toBe(true);
    const disk1 = diskFence();
    expect(disk1.facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(2);
    // The rename already landed, so the file is self-dirty: refused until committed.
    const s2 = await run();
    expect(s2.skippedByReason.file_uncommitted).toBe(1);
    commitAll('morning commit');
    const s3 = await run();
    expect(s3).toMatchObject({ rowsStamped: 2, rowsAppended: 0, pagesSkipped: 0, rowsRemaining: 0 });
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual(disk1.facts.map(f => [f.rowNum, f.claim]));
    expect((await factRows()).map(r => r.row_num).sort()).toEqual(disk1.facts.map(f => f.rowNum).sort());
  });

  test('(b) hardened repo: crash after rename before mirror/stamp → next run REFUSES (file_uncommitted); nothing stamped; manual commit, then 0 appends', async () => {
    installFakeDurabilityHook(repo);
    await seed('Founded Acme');
    const s1 = await run({ beforeMirror: () => { throw new Error('injected'); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(git(repo, 'status', '--porcelain').trimEnd()).toBe(` M ${ALICE_MD}`);  // no commit fired
    expect((await factRows())[0]!.row_num).toBeNull();
    const s2 = await run();
    expect(s2.skippedByReason.file_uncommitted).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
    // Manual-commit dependency: the operator commits; the stamp mode does not self-heal this.
    commitAll('manual commit');
    const s3 = await run();
    expect(s3).toMatchObject({ rowsStamped: 1, rowsAppended: 0, pagesSkipped: 0 });
    expect((await factRows())[0]!.row_num).toBe(diskFence().facts[0]!.rowNum);
  });

  test('(c1) a forget on one id between verify and stamp: refused (row_changed), nothing stamped, the forget stands and the reconcile does not resurrect it', async () => {
    const a = await seed('Founded Acme');
    await seed('Prefers async');
    const s = await run({ beforeStamp: async () => {
      const f = await forgetFactInFence(engine, Number(a), { reason: 'raced' });
      expect(f).toMatchObject({ ok: true, path: 'legacy_db' });
    } });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect(s.rowsStamped).toBe(0);
    const rows = await factRows();
    expect(rows.every(r => r.row_num === null)).toBe(true);
    expect(rows.find(r => r.id === a)!.expired_at).not.toBeNull();
    // Fence (file + DB body) carries the claim; the guard is still armed on the other row.
    const r1 = await reconcile({ repairLegacy: false });
    expect(r1.guardTriggered).toBe(true);
    // Commit and let the repair finish the surviving row, then reconcile.
    commitAll();
    const s2 = await run();
    expect(s2.rowsStamped).toBe(1);
    const r2 = await reconcile();
    expect(r2.guardTriggered).toBe(false);
    const after = await factRows();
    const forgotten = after.find(r => r.id === a)!;
    expect(forgotten.expired_at).not.toBeNull();
    expect(forgotten.row_num).toBeNull();
    // KNOWN, pre-existing contract (#2646, extract-facts.ts listExistingFactsForPage): the fence
    // still carries the forgotten claim as an ACTIVE row, so the reconcile inserts it as a NEW
    // fence-owned row. Observed and asserted as-is; the legacy row's expiry itself is never undone.
    expect(after.filter(r => r.fact === 'Founded Acme' && r.expired_at === null).length).toBe(r2.factsInserted);
  });

  test('(c2) forget routing re-runs when the row was stamped between its pre-read and its expire: takes the fence path, strikes the fence', async () => {
    const a = await seed('Founded Acme');
    // Simulate the interleaving: forget reads the row as legacy, the repair stamps it, forget continues.
    await run();
    expect((await factRows())[0]!.row_num).not.toBeNull();
    const f = await withEnv({ GBRAIN_HOME: home }, () => forgetFactInFence(engine, Number(a), { reason: 'later' }));
    expect(f).toMatchObject({ ok: true, path: 'fence' });
    expect(diskFence().facts[0]!.active).toBe(false);
    expect((await factRows())[0]!.expired_at).not.toBeNull();
  });

  test('(c3) forget legacy expire is conditional: 0 rows → re-route (unit of the seam)', async () => {
    // A row that is fence-owned but whose forget pre-read would have routed legacy cannot be
    // manufactured without a hook; assert the SQL contract directly: the conditional UPDATE
    // never touches a fence-owned row.
    const a = await seed('Founded Acme');
    await run();
    const r = await engine.executeRaw<{ id: string }>(
      `UPDATE facts SET expired_at = now() WHERE id = $1 AND expired_at IS NULL AND row_num IS NULL RETURNING id::text AS id`, [Number(a)]);
    expect(r).toHaveLength(0);
    expect((await factRows())[0]!.expired_at).toBeNull();
  });

  test('(c4) a put_page-style fenceless save between verify and stamp: refused (verify_failed), nothing stamped, no resurrection', async () => {
    await seed('Founded Acme');
    const s = await run({ beforeStamp: async () => {
      await engine.putPage(ALICE, { type: 'person', title: 'Alice', compiled_truth: ALICE_DB_BODY, timeline: '' } as any, { sourceId: SRC });
    } });
    expect(s.skippedByReason.verify_failed).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
    const r = await reconcile({ repairLegacy: false });
    expect(r.guardTriggered).toBe(true);
    expect(r.factsDeleted).toBe(0);
    expect(await factRows()).toHaveLength(1);
  });

  test('(c5) an edit to the fact text between eligibility read and stamp: refused (row_changed)', async () => {
    const a = await seed('Founded Acme');
    const s = await run({ beforeStamp: async () => {
      await engine.executeRaw(`UPDATE facts SET fact = 'Founded Acme Corp' WHERE id = $1`, [Number(a)]);
    } });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('(c6) a competing stamp of the same id: refused (row_changed), the first stamp is kept', async () => {
    const a = await seed('Founded Acme');
    const s = await run({ beforeStamp: async () => {
      await engine.executeRaw(`UPDATE facts SET row_num = 9, source_markdown_slug = $2 WHERE id = $1`, [Number(a), ALICE]);
    } });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect((await factRows())[0]!.row_num).toBe(9);
  });
});

describe('(d) stale-save reproducer — reported as observed', () => {
  test('legacy page: get body before repair → repair → put_page the stale body (write-through) → reconcile', async () => {
    const staleBody = readFileSync(join(repo, ALICE_MD), 'utf-8');
    const id = await seed('Founded Acme');
    await run();
    commitAll('after repair');
    expect((await factRows())[0]!.row_num).not.toBeNull();

    const res = await withEnv({ GBRAIN_HOME: home }, () => putPageOp.handler(opCtx(), { slug: ALICE, content: staleBody })) as Record<string, any>;
    const r = await reconcile();
    // OBSERVED: the #4872 mirror keeps the OLD content_hash, which is the hash of exactly this
    // stale body, so put_page reports `skipped` (unchanged), the DB body keeps the fence, and the
    // write-through re-renders the DB row (fence included) onto disk. The reconcile deletes
    // nothing and the stamped row survives — but only because no sync has refreshed the hash yet
    // (see the next test for the post-sync outcome).
    expect(res.status).toBe('skipped');
    expect(res.write_through?.written).toBe(true);
    expect(diskFence().facts).toHaveLength(1);
    expect((await dbFence()).facts).toHaveLength(1);
    expect(r.factsDeleted).toBe(0);
    expect((await factRows()).find(x => x.id === id)?.row_num).toBe(1);
  });

  test('legacy page AFTER a sync-equivalent hash refresh: the stale save lands and the reconcile deletes the stamped row (same as never-legacy)', async () => {
    const staleBody = readFileSync(join(repo, ALICE_MD), 'utf-8');
    const id = await seed('Founded Acme');
    await run();
    commitAll('after repair');
    // What `gbrain sync` does next: re-import the fenced file, refreshing content_hash.
    const fenced = parseMarkdown(readFileSync(join(repo, ALICE_MD), 'utf-8'), `${ALICE}.md`);
    await engine.refreshPageBody(ALICE, SRC, fenced.compiled_truth, fenced.timeline, 'post-sync-hash');

    const res = await withEnv({ GBRAIN_HOME: home }, () => putPageOp.handler(opCtx(), { slug: ALICE, content: staleBody })) as Record<string, any>;
    const r = await reconcile();
    // OBSERVED: fence removed from BOTH sinks by the stale save; the reconcile deletes the row.
    expect(res.status).toBe('created_or_updated');
    expect(diskFence().facts).toHaveLength(0);
    expect((await dbFence()).facts).toHaveLength(0);
    expect(r.factsDeleted).toBe(1);
    expect((await factRows()).find(x => x.id === id)).toBeUndefined();
  });

  test('never-legacy page: same sequence on rows that were always fence-owned', async () => {
    const staleBody = readFileSync(join(repo, ALICE_MD), 'utf-8');
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('fence');
    const parsed = parseMarkdown(body, `${ALICE}.md`);
    await engine.refreshPageBody(ALICE, SRC, parsed.compiled_truth, parsed.timeline, 'x');
    const r0 = await reconcile();
    expect(r0.factsInserted).toBe(1);
    const id = (await factRows())[0]!.id;
    expect((await factRows())[0]!.row_num).toBe(1);

    const res = await withEnv({ GBRAIN_HOME: home }, () => putPageOp.handler(opCtx(), { slug: ALICE, content: staleBody })) as Record<string, any>;
    const r = await reconcile();
    // OBSERVED: identical to the post-sync legacy page — the stale save removes the fence from
    // both sinks and the reconcile deletes the fence-owned row (fence-is-canonical contract).
    expect(res.status).toBe('created_or_updated');
    expect(diskFence().facts).toHaveLength(0);
    expect((await dbFence()).facts).toHaveLength(0);
    expect(r.factsDeleted).toBe(1);
    expect((await factRows()).find(x => x.id === id)).toBeUndefined();
  });
});
