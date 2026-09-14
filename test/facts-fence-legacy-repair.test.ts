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
import { dirname, join } from 'node:path';
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

/**
 * Legacy rows are seeded as the API writes them: `insertFact` binds a JS Date,
 * so a fence day `2026-01-02` is the UTC-midnight INSTANT `2026-01-02T00:00:00Z`.
 * A bare `'2026-01-02'` literal would be the SESSION's midnight — bun test pins
 * TZ to UTC, so the two only coincide here by accident; the calendar-day tests
 * below set the session zone explicitly.
 */
async function seed(fact: string, slug = ALICE, sourceId = SRC, source = 'mcp:put_page'): Promise<string> {
  const r = await engine.executeRaw<{ id: string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ($1, $2, $3, 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', $4, 0.9)
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
/**
 * What `gbrain sync` does to the pages cache after a file changes on disk: the
 * stamp mode refuses to mirror over a DB body that is not the committed file's
 * (review 2, finding 1 — the reconcile's own stale-cache rule), so fixtures
 * that pre-write a fence to the file must sync it into the DB body like
 * production does.
 */
async function syncBody(slug = ALICE, rel = ALICE_MD): Promise<void> {
  const parsed = parseMarkdown(readFileSync(join(repo, rel), 'utf-8'), `${slug}.md`);
  await engine.refreshPageBody(slug, SRC, parsed.compiled_truth, parsed.timeline, 'synced');
}

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
    await syncBody();
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
    // Committed (the owner's morning commit) but not yet synced: the DB body is
    // still the OLD file's, so the stamp refuses inside its transaction rather
    // than mirror file-derived content over a cache it cannot vouch for.
    commitAll('theirs');
    const s1b = await run();
    expect(s1b.skippedByReason.verify_failed).toBe(1);
    expect(s1b.skippedDetails[0]).toContain('stale page cache');
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).toBe(ALICE_DB_BODY);
    // Once synced (what the cycle's sync phase does before extract_facts), it proceeds.
    await syncBody();
    const s2 = await run();
    expect(s2.rowsStamped).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toContain('Their uncommitted paragraph.');
    expect((await dbFence()).facts.map(f => f.claim)).toEqual(['Founded Acme']);
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
    // File fence carries "Founded Acme" at #1 (identical to the legacy row on
    // every column, so the plan re-uses #1) and the DB already owns #1 under
    // a different id; the legacy row must not steal it.
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('fence');
    await syncBody();
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ($1, $2, 'Founded Acme', 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', 'mcp:put_page', 0.9, 1, $2)`, [SRC, ALICE]);
    const legacy = await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.fence_row_owned).toBe(1);
    expect((await factRows()).find(r => r.id === legacy)!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
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
  test('a fence-less DB save that still matches the file, landing before the transaction: the stamp proceeds (nothing to lose), both sinks carry the fence', async () => {
    await seed('Founded Acme');
    const s = await run({
      beforeStamp: async () => {
        // A sync-style writer rewrites the DB body from the (fence-less) file.
        await engine.refreshPageBody(ALICE, SRC, ALICE_DB_BODY, '', 'x');
      },
    });
    expect(s).toMatchObject({ rowsStamped: 1, pagesSkipped: 0, rowsRemaining: 0 });
    expect((await factRows())[0]!.row_num).not.toBeNull();
    expect((await dbFence()).facts).toHaveLength(1);
    expect(diskFence().facts).toHaveLength(1);
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
  });

  test('a DB body that is NOT the file\'s (a save whose write-through never landed) is refused inside the transaction: nothing written, nothing mirrored over', async () => {
    await seed('Founded Acme');
    const unsynced = ALICE_DB_BODY + '\n\nSaved to the DB only.';
    const s = await run({
      beforeStamp: async () => { await engine.refreshPageBody(ALICE, SRC, unsynced, '', 'x'); },
    });
    expect(s.skippedByReason.verify_failed).toBe(1);
    expect(s.skippedDetails[0]).toContain('stale page cache');
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).toBe(unsynced);
    expect((await factRows())[0]!.row_num).toBeNull();
    // The guard is still armed, so the reconcile cannot run and delete anything.
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, brainDir: repo, repairLegacy: false }));
    expect(r.guardTriggered).toBe(true);
    expect(r.factsDeleted).toBe(0);
    expect((await factRows())).toHaveLength(1);
  });

  test('a file edit between read and rename is refused, never overwritten; the DB rolls back with it', async () => {
    await seed('Founded Acme');
    const theirs = ALICE_BODY + '\nLanded while we were rendering.\n';
    const s = await run({ beforeRename: () => { writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8'); } });
    expect(s.skippedByReason.concurrent_edit).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect(readdirSync(join(repo, 'people')).filter(f => f.includes('.tmp'))).toEqual([]);
    expect((await factRows())[0]!.row_num).toBeNull();
    // The mirror + stamp ran inside the same transaction: both rolled back.
    expect((await dbFence()).facts).toEqual([]);
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

describe('stamp mode — crash + retry (every seam before COMMIT leaves both stores untouched)', () => {
  const boom = (): never => { throw new Error('injected crash'); };

  const untouched = async () => {
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    expect((await factRows()).every(r => r.row_num === null && r.source_markdown_slug === null)).toBe(true);
    expect(readdirSync(join(repo, 'people')).filter(f => f.includes('.tmp'))).toEqual([]);
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');
  };

  test('crash before the transaction (beforeStamp): nothing written; retry completes', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeStamp: boom });
    expect(s1.skippedByReason.error).toBe(1);
    await untouched();
    const s2 = await run();
    expect(s2).toMatchObject({ rowsStamped: 2, rowsAppended: 2, pagesSkipped: 0 });
    expect(diskFence().facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(2);
  });

  test('crash after the row locks, before the mirror: transaction rolled back, nothing written; retry completes', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeMirror: boom });
    expect(s1.skippedByReason.error).toBe(1);
    await untouched();
    const s2 = await run();
    expect(s2).toMatchObject({ rowsStamped: 2, rowsAppended: 2 });
  });

  test('crash after the mirror + stamps, before the rename: transaction rolled back, nothing written; retry completes', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeRename: boom });
    expect(s1.skippedByReason.error).toBe(1);
    await untouched();
    const s2 = await run();
    expect(s2.rowsStamped).toBe(2);
    expect(diskFence().facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(2);
  });

  test('crash after the rename, before COMMIT: DB rolled back AND the committed preimage restored (our bytes only); retry completes', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    let seen = '';
    const s1 = await run({ beforeCommit: () => { seen = readFileSync(join(repo, ALICE_MD), 'utf-8'); boom(); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(parseFactsFence(seen).facts).toHaveLength(2);   // the rename had landed
    await untouched();                                       // and was undone
    const s2 = await run();
    expect(s2).toMatchObject({ rowsStamped: 2, rowsAppended: 2 });
  });

  test('crash after the rename when the file was ALSO edited outside the lock: DB rolled back, the foreign edit is left alone (audited), next run refuses file_uncommitted', async () => {
    await seed('Founded Acme');
    const theirs = ALICE_BODY + '\nEdited outside the lock, after the rename.\n';
    const s1 = await run({ beforeCommit: () => { writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8'); boom(); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect((await dbFence()).facts).toEqual([]);
    expect(readFileSync(join(home, '.gbrain', 'facts.write_failures.jsonl'), 'utf-8')).toContain('stamp_rollback_file_changed_outside_lock');
    const s2 = await run();
    expect(s2.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
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
    await syncBody();
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
       VALUES ($1, $2, 'MRR is 50000', 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', 'mcp:put_page', 0.9, 'mrr', 50000, 'USD', 'monthly')
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
  test('(a) crash mid-stamp after the first UPDATE rolls the whole stamp back — nothing on disk, nothing in the DB body, no row stamped; the next run converges without any commit', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ afterFirstStampUpdate: () => { throw new Error('injected crash mid-stamp'); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(s1.skippedDetails[0]).toContain('injected crash mid-stamp');
    // Transaction rolled back: NO row is stamped, not even the first — and the
    // file was never renamed (the rename is the last step before COMMIT).
    expect((await factRows()).every(r => r.row_num === null && r.source_markdown_slug === null)).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');
    const s3 = await run();
    expect(s3).toMatchObject({ rowsStamped: 2, rowsAppended: 2, pagesSkipped: 0, rowsRemaining: 0 });
    expect((await factRows()).map(r => r.row_num).sort()).toEqual(diskFence().facts.map(f => f.rowNum).sort());
  });

  test('(b) hardened repo: crash inside the transaction → no commit fired, nothing written; the next run stamps AND commits, no operator step', async () => {
    installFakeDurabilityHook(repo);
    await seed('Founded Acme');
    const s1 = await run({ beforeMirror: () => { throw new Error('injected'); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(git(repo, 'status', '--porcelain').trimEnd()).toBe('');   // nothing dirty, no commit fired
    expect((await factRows())[0]!.row_num).toBeNull();
    const s3 = await run();
    expect(s3).toMatchObject({ rowsStamped: 1, rowsAppended: 1, pagesSkipped: 0 });
    expect(s3.pagesFenced).toBe(1);
    expect(git(repo, 'status', '--porcelain').trimEnd()).toBe('');   // path-limited commit landed
    expect(git(repo, 'log', '--oneline').split('\n').filter(Boolean)).toHaveLength(2);
    expect((await factRows())[0]!.row_num).toBe(diskFence().facts[0]!.rowNum);
  });

  test('(c1) a forget on one id between the plan and the stamp: refused (row_changed), NOTHING written, and after the repair/recount/reconcile cycle there is NO active copy of the forgotten claim', async () => {
    const a = await seed('Founded Acme');
    await seed('Prefers async');
    const s = await run({ beforeStamp: async () => {
      const f = await forgetFactInFence(engine, Number(a), { reason: 'raced' });
      expect(f).toMatchObject({ ok: true, path: 'legacy_db' });
    } });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect(s.skippedDetails[0]).toContain('expired since eligibility was read');
    expect(s.rowsStamped).toBe(0);
    const rows = await factRows();
    expect(rows.every(r => r.row_num === null)).toBe(true);
    expect(rows.find(r => r.id === a)!.expired_at).not.toBeNull();
    // Neither sink carries the forgotten claim: the refusal happened before any write.
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    // The whole cycle, as production runs it: guard arms on the survivor, the
    // repair stamps it, the recount is zero, the reconcile runs.
    const r2 = await reconcile();
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRowsRepaired).toBe(1);
    expect(r2.factsInserted).toBe(0);
    expect(r2.factsDeleted).toBe(0);
    const after = await factRows();
    expect(after.filter(r => r.fact === 'Founded Acme')).toHaveLength(1);
    expect(after.filter(r => r.fact === 'Founded Acme' && r.expired_at === null)).toHaveLength(0);
    expect(after.find(r => r.fact === 'Prefers async')!.row_num).not.toBeNull();
    expect(diskFence().facts.map(f => f.claim)).toEqual(['Prefers async']);
    expect((await dbFence()).facts.map(f => f.claim)).toEqual(['Prefers async']);
  });

  test('(c1b) the LAST eligible row forgotten between the plan and the stamp: refused, the recount is zero, the reconcile runs — and inserts nothing', async () => {
    const a = await seed('Founded Acme');
    const r = await reconcile({ repairHooks: { beforeStamp: async () => {
      const f = await forgetFactInFence(engine, Number(a), { reason: 'raced' });
      expect(f).toMatchObject({ ok: true, path: 'legacy_db' });
    } } });
    expect(r.legacyRepair?.skippedByReason.row_changed).toBe(1);
    expect(r.legacyRowsPending).toBe(0);
    expect(r.guardTriggered).toBe(false);          // the recount is zero, so the reconcile ran…
    expect(r.factsInserted).toBe(0);               // …and had nothing to resurrect
    expect(r.factsDeleted).toBe(0);
    const after = await factRows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: a, row_num: null });
    expect(after[0]!.expired_at).not.toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    // And the next cycle stays quiet.
    const r2 = await reconcile();
    expect(r2.factsInserted).toBe(0);
    expect(await factRows()).toHaveLength(1);
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

  test('(c4) a put_page-style save of the SAME (fence-less) content before the transaction: the stamp proceeds — nothing is lost, nothing deleted, no resurrection', async () => {
    await seed('Founded Acme');
    const s = await run({ beforeStamp: async () => {
      await engine.putPage(ALICE, { type: 'person', title: 'Alice', compiled_truth: ALICE_DB_BODY, timeline: '' } as any, { sourceId: SRC });
    } });
    expect(s).toMatchObject({ rowsStamped: 1, pagesSkipped: 0 });
    expect((await factRows())[0]!.row_num).not.toBeNull();
    expect((await dbFence()).facts).toHaveLength(1);
    const r = await reconcile();
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    expect(await factRows()).toHaveLength(1);
  });

  test('(c5) an edit to the fact text between eligibility read and stamp: refused (row_changed), nothing written', async () => {
    const a = await seed('Founded Acme');
    const s = await run({ beforeStamp: async () => {
      await engine.executeRaw(`UPDATE facts SET fact = 'Founded Acme Corp' WHERE id = $1`, [Number(a)]);
    } });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
  });

  test('(c6) a competing stamp of the same id: refused (row_changed), the first stamp is kept, nothing written', async () => {
    const a = await seed('Founded Acme');
    const s = await run({ beforeStamp: async () => {
      await engine.executeRaw(`UPDATE facts SET row_num = 9, source_markdown_slug = $2 WHERE id = $1`, [Number(a), ALICE]);
    } });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect((await factRows())[0]!.row_num).toBe(9);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });
});

// ── 2026-09-14 second review (Codex review 2) ─────────────────────────────

describe('finding 3 (review 2) — the locked re-check covers every fence column, not only fact/source/expiry', () => {
  const changed = async (label: string, mutate: (id: number) => Promise<void>, detail: string) => {
    const a = await seed(`Claim for ${label}`);
    const s = await run({ beforeStamp: () => mutate(Number(a)) });
    expect(s.skippedByReason.row_changed).toBe(1);
    expect(s.skippedDetails[0]).toContain(detail);
    expect((await factRows()).find(r => r.id === a)!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
  };

  test('valid_until set concurrently (a supersession-style expiry) → row_changed', () =>
    changed('valid_until', id => engine.executeRaw(`UPDATE facts SET valid_until = '2026-12-31' WHERE id = $1`, [id]).then(() => {}), 'validUntil'));

  test('superseded_by set concurrently → row_changed', async () => {
    const target = await seed('Newer claim');
    await engine.executeRaw(`UPDATE facts SET entity_slug = 'people/elsewhere' WHERE id = $1`, [Number(target)]); // keep it out of this page's rows
    await changed('superseded_by', id => engine.executeRaw(`UPDATE facts SET superseded_by = $2 WHERE id = $1`, [id, Number(target)]).then(() => {}), 'superseded');
  });

  test('kind edited concurrently → row_changed', () =>
    changed('kind', id => engine.executeRaw(`UPDATE facts SET kind = 'belief' WHERE id = $1`, [id]).then(() => {}), 'kind'));

  test('context edited concurrently → row_changed', () =>
    changed('context', id => engine.executeRaw(`UPDATE facts SET context = 'said on a call' WHERE id = $1`, [id]).then(() => {}), 'context'));

  test('valid_from edited concurrently → row_changed', () =>
    changed('valid_from', id => engine.executeRaw(`UPDATE facts SET valid_from = '2020-01-01' WHERE id = $1`, [id]).then(() => {}), 'validFrom'));

  test('moved to another page (entity_slug) → row_changed', () =>
    changed('entity_slug', id => engine.executeRaw(`UPDATE facts SET entity_slug = 'people/bob' WHERE id = $1`, [id]).then(() => {}), 'moved to page'));

  test('a typed column set concurrently → row_changed', () =>
    changed('claim_value', id => engine.executeRaw(`UPDATE facts SET claim_metric = 'mrr', claim_value = 1 WHERE id = $1`, [id]).then(() => {}), 'claimMetric'));
});

describe('finding 2 (review 2) — re-using an existing fence row never stamps a lossy representation', () => {
  async function seedTyped(fact = 'MRR is 50000'): Promise<string> {
    const r = await engine.executeRaw<{ id: string }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                          claim_metric, claim_value, claim_unit, claim_period)
       VALUES ($1, $2, $3, 'fact', 'private', 'medium', '2026-01-02T00:00:00Z', 'mcp:put_page', 0.9, 'mrr', 50000, 'USD', 'monthly')
       RETURNING id::text AS id`, [SRC, ALICE, fact]);
    return r[0]!.id;
  }
  async function typedColumns(id: string) {
    const db = await engine.executeRaw<{ claim_metric: string | null; claim_value: number | null; claim_unit: string | null; claim_period: string | null }>(
      `SELECT claim_metric, claim_value::float8 AS claim_value, claim_unit, claim_period FROM facts WHERE id = $1`, [id]);
    return db[0]!;
  }
  /** Force the reconcile's wipe + reinsert on the page: plant a stale fence-owned row. */
  async function destructiveReconcile() {
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ($1, $2, 'Stale row no longer on the fence', 'fact', 'private', 'medium', now(), 'mcp:put_page', 1.0, 99, $2)`, [SRC, ALICE]);
    const r = await reconcile();
    expect(r.factsDeleted).toBeGreaterThan(0);
    expect(r.factsInserted).toBeGreaterThan(0);
    return r;
  }

  test('fresh path: typed columns render into the fence and survive a later destructive reconcile', async () => {
    await seedTyped();
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 1, rowsRewritten: 0 });
    await destructiveReconcile();
    const rows = await factRows();
    const rebuilt = rows.find(r => r.fact === 'MRR is 50000')!;
    expect(rebuilt.row_num).toBe(1);
    expect(await typedColumns(rebuilt.id)).toEqual({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly' });
  });

  test('reuse path: an on-disk row with the same key but WITHOUT the typed columns is rewritten in place (rewritten 1, appended 0); the rebuilt row keeps metric/value/unit/period', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 4, claim: 'MRR is 50000', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('narrow fence');
    await syncBody();
    const id = await seedTyped();
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 0, rowsRewritten: 1, pagesSkipped: 0 });
    const disk = diskFence();
    expect(disk.warnings).toEqual([]);
    expect(disk.facts).toHaveLength(1);
    expect(disk.facts[0]).toMatchObject({ rowNum: 4, claim: 'MRR is 50000', claimMetric: 'mrr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'monthly', validFrom: '2026-01-02' });
    expect((await dbFence()).facts[0]).toMatchObject({ rowNum: 4, claimMetric: 'mrr', claimValue: 50000 });
    expect((await factRows()).find(r => r.id === id)!.row_num).toBe(4);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toContain('- keep me');
    // Idempotent: the next reconcile is a no-op…
    const r = await reconcile();
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    // …and a destructive one rebuilds the row from the fence WITH its typed columns.
    await destructiveReconcile();
    const rebuilt = (await factRows()).find(x => x.fact === 'MRR is 50000')!;
    expect(rebuilt.row_num).toBe(4);
    expect(await typedColumns(rebuilt.id)).toEqual({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly' });
  });

  test('reuse path: an on-disk row that already carries everything (or more) is reused as-is, nothing rewritten', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 2, claim: 'MRR is 50000', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page', context: 'from the board deck',
      claimMetric: 'mrr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'monthly',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('wide fence');
    await syncBody();
    const before = readFileSync(join(repo, ALICE_MD), 'utf-8');
    await seedTyped();
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 0, rowsRewritten: 0 });
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(before);
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');
  });

  test('reuse path: a CONFLICTING on-disk value (different metric) refuses the page — never silently stamped, nothing written', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 2, claim: 'MRR is 50000', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
      claimMetric: 'arr', claimValue: 50000, claimUnit: 'USD', claimPeriod: 'annual',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('conflicting fence');
    await syncBody();
    const id = await seedTyped();
    const s = await run();
    expect(s.skippedByReason.fence_row_mismatch).toBe(1);
    expect(s.skippedDetails[0]).toContain('claimMetric');
    expect((await factRows()).find(r => r.id === id)!.row_num).toBeNull();
    // Both sinks still hold exactly the synced preimage: the conflicting
    // committed row (arr/annual) on disk AND in the DB body, untouched.
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
    expect((await dbFence()).facts).toEqual(parseFactsFence(body).facts);
    expect((await dbFence()).facts[0]).toMatchObject({ rowNum: 2, claimMetric: 'arr', claimPeriod: 'annual' });
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');
    expect(await typedColumns(id)).toEqual({ claim_metric: 'mrr', claim_value: 50000, claim_unit: 'USD', claim_period: 'monthly' });
  });

  test('reuse path: a different confidence or validFrom on disk is a conflict too', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 2, claim: 'Founded Acme', kind: 'fact', confidence: 0.5, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('other confidence');
    await syncBody();
    await seed('Founded Acme');   // confidence 0.9
    const s = await run();
    expect(s.skippedByReason.fence_row_mismatch).toBe(1);
    expect(s.skippedDetails[0]).toContain('confidence');
    expect((await factRows())[0]!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
    expect((await dbFence()).facts).toEqual(parseFactsFence(body).facts);
  });

  test('reuse path: the same claim STRUCK on disk while the DB row is active refuses (stamping it would let the reconcile expire the row)', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 2, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', validUntil: '2026-02-02', source: 'mcp:put_page',
      context: 'forgotten: user asked', active: false,
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('struck fence');
    await syncBody();
    expect(diskFence().facts[0]!.active).toBe(false);
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.fence_row_mismatch).toBe(1);
    expect(s.skippedDetails[0]).toContain('struck');
    expect((await factRows())[0]!.row_num).toBeNull();
    expect((await factRows())[0]!.expired_at).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
    expect((await dbFence()).facts).toEqual(parseFactsFence(body).facts);
  });

  test('dry-run reports the in-place rewrite it would make without touching the file', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 4, claim: 'MRR is 50000', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('narrow fence');
    await syncBody();
    await seedTyped();
    const s = await run(undefined, { dryRun: true });
    expect(s).toMatchObject({ dryRun: true, rowsStamped: 0, rowsAppended: 0, rowsRewritten: 1, pagesFenced: 1 });
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
  });
});

describe('finding 1 (review 2) — process-death residue: the committed preimage plus a crashed run\'s own appends', () => {
  /** What a run that died between the rename and COMMIT leaves behind (rendered through the same renderer). */
  function plantResidue(claims: string[]): string {
    let body = ALICE_BODY;
    claims.forEach((claim, i) => {
      body = upsertFactRow(body, {
        rowNum: i + 1, claim, kind: 'fact', confidence: 0.9, visibility: 'private',
        notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
      }).body;
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8');
    expect(git(repo, 'status', '--porcelain').trimEnd()).toBe(` M ${ALICE_MD}`);
    return body;
  }

  test('residue is recognised: the preimage is restored, the run re-plans from it, and stamps', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    plantResidue(['Founded Acme', 'Prefers async']);
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 2, rowsAppended: 2, pagesSkipped: 0, rowsRemaining: 0 });
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual([[1, 'Founded Acme'], [2, 'Prefers async']]);
    expect((await dbFence()).facts).toHaveLength(2);
    expect((await factRows()).map(r => r.row_num).sort()).toEqual([1, 2]);
  });

  test('residue + a row forgotten after the crash: the forgotten claim is NOT re-appended, and the whole cycle leaves no active copy', async () => {
    const a = await seed('Founded Acme');
    await seed('Prefers async');
    plantResidue(['Founded Acme', 'Prefers async']);
    const f = await forgetFactInFence(engine, Number(a), { reason: 'after the crash' });
    expect(f).toMatchObject({ ok: true, path: 'legacy_db' });
    const r = await reconcile();
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsRepaired).toBe(1);
    expect(r.legacyRepair?.rowsAppended).toBe(1);
    expect(r.factsInserted).toBe(0);
    expect(diskFence().facts.map(f => f.claim)).toEqual(['Prefers async']);
    expect((await dbFence()).facts.map(f => f.claim)).toEqual(['Prefers async']);
    const after = await factRows();
    expect(after.filter(x => x.fact === 'Founded Acme')).toHaveLength(1);
    expect(after.find(x => x.fact === 'Founded Acme')!.expired_at).not.toBeNull();
    expect(after.filter(x => x.fact === 'Founded Acme' && x.expired_at === null)).toHaveLength(0);
  });

  test('residue plus someone else\'s edit is NOT residue: refused file_uncommitted, file untouched', async () => {
    await seed('Founded Acme');
    const body = plantResidue(['Founded Acme']) ;
    const theirs = body + '\nA paragraph a human added below the fence.\n';
    writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8');
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('an uncommitted fence row that matches NO DB row of the page is a human\'s addition, not residue: refused, untouched', async () => {
    await seed('Founded Acme');
    const body = plantResidue(['Founded Acme', 'Hand-written by a human']);
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('a struck uncommitted row is never treated as residue', async () => {
    await seed('Founded Acme');
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page', context: 'forgotten: x', active: false,
    }).body;
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8');
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
  });

  test('dry-run does not heal residue (read-only): reports file_uncommitted, file untouched', async () => {
    await seed('Founded Acme');
    const body = plantResidue(['Founded Acme']);
    const s = await run(undefined, { dryRun: true });
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
  });
});

describe('finding 5 (review 2) — a source registered in a git SUBDIRECTORY', () => {
  let root: string;
  const BRAIN = 'brain';
  const gitRoot = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' });

  beforeEach(async () => {
    // The enclosing repo owns .git; the source's local_path is repo/brain.
    root = mkdtempSync(join(tmpdir(), 'gbrain-fence-legacy-root-'));
    gitInit(root);
    mkdirSync(join(root, BRAIN, 'people'), { recursive: true });
    writeFileSync(join(root, BRAIN, ALICE_MD), ALICE_BODY, 'utf-8');
    writeFileSync(join(root, 'README.md'), '# workspace\n', 'utf-8');
    gitRoot('add', '-A'); gitRoot('commit', '-q', '-m', 'seed');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [join(root, BRAIN), SRC]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const subFence = () => parseFactsFence(readFileSync(join(root, BRAIN, ALICE_MD), 'utf-8'));

  test('a committed page under the subdirectory is recognised as tracked at HEAD and stamped', async () => {
    await seed('Founded Acme');
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 1, pagesSkipped: 0 });
    expect(subFence().facts.map(f => f.claim)).toEqual(['Founded Acme']);
    expect(gitRoot('status', '--porcelain').trimEnd()).toBe(` M ${BRAIN}/${ALICE_MD}`);
  });

  test('self-dirt on the subdirectory page is attributed to the file (file_uncommitted), not misread as foreign dirt', async () => {
    writeFileSync(join(root, BRAIN, ALICE_MD), ALICE_BODY + '\nUncommitted.\n', 'utf-8');
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(s.skippedByReason.foreign_dirty).toBeUndefined();
  });

  test('crash residue under the subdirectory is healed the same way', async () => {
    await seed('Founded Acme');
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body;
    writeFileSync(join(root, BRAIN, ALICE_MD), body, 'utf-8');
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 1, pagesSkipped: 0 });
    expect(subFence().facts).toHaveLength(1);
  });

  test('ignored, untracked and staged-only pages under the subdirectory are refused', async () => {
    // ignored
    writeFileSync(join(root, '.gitignore'), `${BRAIN}/people/carol.md\n`, 'utf-8');
    writeFileSync(join(root, BRAIN, 'people/carol.md'), '---\ntype: person\ntitle: Carol\n---\n\n# Carol\n', 'utf-8');
    // untracked
    writeFileSync(join(root, BRAIN, 'people/dave.md'), '---\ntype: person\ntitle: Dave\n---\n\n# Dave\n', 'utf-8');
    // staged, never committed
    writeFileSync(join(root, BRAIN, 'people/erin.md'), '---\ntype: person\ntitle: Erin\n---\n\n# Erin\n', 'utf-8');
    gitRoot('add', '.gitignore', `${BRAIN}/people/erin.md`);
    for (const [slug, title] of [['people/carol', 'Carol'], ['people/dave', 'Dave'], ['people/erin', 'Erin']] as const) {
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ($1, $2, 'person', $3, $4, '')`,
        [slug, SRC, title, `# ${title}`]);
      await seed(`${title} claim`, slug);
    }
    const s = await run();
    expect(s.rowsStamped).toBe(0);
    expect(s.skippedByReason.foreign_dirty).toBe(1);       // carol: ignored
    expect(s.skippedByReason.file_uncommitted).toBe(2);    // dave: untracked, erin: staged-only
    expect(s.skippedDetails.some(d => d.includes('people/carol') && d.includes('foreign_dirty') && d.includes('ignored'))).toBe(true);
    expect(s.skippedDetails.some(d => d.includes('people/dave') && d.includes('file_uncommitted'))).toBe(true);
    expect(s.skippedDetails.some(d => d.includes('people/erin') && d.includes('file_uncommitted'))).toBe(true);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);
    for (const rel of ['people/carol.md', 'people/dave.md', 'people/erin.md']) {
      expect(parseFactsFence(readFileSync(join(root, BRAIN, rel), 'utf-8')).facts).toEqual([]);
    }
  });
});

// ── Codex acceptance of 2d5c08f90 (2026-09-14 final): five reproduced findings ──

describe('acceptance finding 1 — an unreadable COMMIT outcome is indeterminate: the fenced file is never restored over a possibly committed stamp', () => {
  const failures = () => {
    const p = join(home, '.gbrain', 'facts.write_failures.jsonl');
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  };

  test('COMMIT landed, acknowledgement lost, verification unavailable: file left fenced, stamp stands, a sync-equivalent refresh + reconcile deletes nothing', async () => {
    const a = await seed('Founded Acme');
    const s = await run({
      afterCommit: () => { throw new Error('acknowledgement lost'); },
      beforeVerifyLanded: () => { throw new Error('verification unavailable'); },
    });
    expect(s.skippedByReason.error).toBe(1);
    expect(s.skippedDetails[0]).toContain('commit outcome unknown');
    expect(s.skippedDetails[0]).toContain('file left fenced');
    expect(failures()).toContain('stamp_commit_outcome_unknown_file_left_fenced');
    // The transaction had committed: row stamped, DB body fenced — and the
    // file, the only backing of that stamp, still carries the fence.
    expect((await factRows()).find(r => r.id === a)!.row_num).toBe(1);
    expect((await dbFence()).facts.map(f => f.claim)).toEqual(['Founded Acme']);
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual([[1, 'Founded Acme']]);
    // What a sync + the reconcile do next: nothing is deleted, nothing inserted.
    await syncBody();
    const r = await reconcile();
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(0);
    expect((await factRows()).find(r => r.id === a)!.row_num).toBe(1);
    // Nothing eligible remains; the page is consistent (self-dirty until committed).
    const s2 = await run();
    expect(s2.rowsEligible).toBe(0);
    expect(git(repo, 'status', '--porcelain').trimEnd()).toBe(` M ${ALICE_MD}`);
  });

  test('COMMIT landed, acknowledgement lost, verification readable: reported stamped, file kept', async () => {
    const a = await seed('Founded Acme');
    const s = await run({ afterCommit: () => { throw new Error('acknowledgement lost'); } });
    expect(s).toMatchObject({ rowsStamped: 1, pagesSkipped: 0, rowsRemaining: 0 });
    expect((await factRows()).find(r => r.id === a)!.row_num).toBe(1);
    expect(diskFence().facts).toHaveLength(1);
  });

  test('COMMIT rolled back, verification unavailable: still indeterminate — file left fenced, nothing restored; the next run recognises its own residue, re-plans and stamps', async () => {
    const a = await seed('Founded Acme');
    const s1 = await run({
      beforeCommit: () => { throw new Error('crash before COMMIT'); },
      beforeVerifyLanded: () => { throw new Error('verification unavailable'); },
    });
    expect(s1.skippedByReason.error).toBe(1);
    expect(s1.skippedDetails[0]).toContain('commit outcome unknown');
    expect((await factRows()).find(r => r.id === a)!.row_num).toBeNull();     // rolled back
    expect((await dbFence()).facts).toEqual([]);
    expect(diskFence().facts).toHaveLength(1);                                // left in place
    const s2 = await run();
    expect(s2).toMatchObject({ rowsStamped: 1, rowsAppended: 1, pagesSkipped: 0 });
    expect(s2.skippedDetails).toEqual([]);
    expect((await factRows()).find(r => r.id === a)!.row_num).toBe(1);
    expect(diskFence().facts).toHaveLength(1);
  });

  test('COMMIT rolled back, verification readable: the preimage is restored (unchanged contract)', async () => {
    await seed('Founded Acme');
    const s1 = await run({ beforeCommit: () => { throw new Error('crash before COMMIT'); } });
    expect(s1.skippedByReason.error).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');
  });
});

describe('acceptance finding 2 — crash recovery recognises only this repair\'s exact bytes, never a human addition that shares the key', () => {
  const plant = (row: Partial<Parameters<typeof upsertFactRow>[1]>): string => {
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page', ...row,
    }).body;
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8');
    return body;
  };

  test('an uncommitted row with the legacy claim/source but a human note and typed columns is NOT residue: refused file_uncommitted, every byte kept', async () => {
    await seed('Founded Acme');
    const body = plant({ context: 'human note from the board call', claimMetric: 'mrr', claimValue: 60000, claimUnit: 'USD', claimPeriod: 'monthly' });
    const s = await run();
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(s.rowsStamped).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
    expect(diskFence().facts[0]).toMatchObject({ context: 'human note from the board call', claimMetric: 'mrr', claimValue: 60000, claimUnit: 'USD', claimPeriod: 'monthly' });
    expect((await factRows())[0]!.row_num).toBeNull();
    expect((await dbFence()).facts).toEqual([]);
  });

  test('a different date, confidence or provenance detail on the uncommitted row is not residue either', async () => {
    await seed('Founded Acme');
    for (const variant of [{ validFrom: '2025-01-01' }, { confidence: 0.5 }, { validUntil: '2026-12-31' }] as const) {
      const body = plant(variant);
      const s = await run();
      expect(s.skippedByReason.file_uncommitted).toBe(1);
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
      expect((await factRows())[0]!.row_num).toBeNull();
    }
  });

  test('the exact bytes this repair renders ARE residue: restored and re-planned (control)', async () => {
    await seed('Founded Acme');
    plant({});
    const s = await run();
    expect(s).toMatchObject({ rowsStamped: 1, rowsAppended: 1, pagesSkipped: 0 });
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual([[1, 'Founded Acme']]);
  });
});

describe('acceptance finding 3 — residue on a page whose ONLY never-fenced row was forgotten: the residue-only sweep restores the preimage before the reconcile', () => {
  const plantResidue = () => {
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body;
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8');
    return body;
  };
  const noActiveCopy = async () => {
    const rows = await factRows();
    expect(rows.filter(r => r.fact === 'Founded Acme')).toHaveLength(1);
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[0]!.row_num).toBeNull();
  };

  test('forgotten after the crash, no sync yet: the sweep runs with the guard unarmed, restores HEAD, the reconcile inserts nothing', async () => {
    const a = await seed('Founded Acme');
    plantResidue();
    expect(await forgetFactInFence(engine, Number(a), { reason: 'after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(0);              // the guard would not arm
    const r = await reconcile();
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRepair).toMatchObject({ rowsEligible: 0, residuePagesChecked: 1, residuePagesHealed: 1 });
    expect(r.warnings).toContainEqual(expect.stringContaining('restored the committed preimage'));
    expect(r.factsInserted).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect(git(repo, 'status', '--porcelain', '--', ALICE_MD)).toBe('');
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
    // Next cycle: clean page, quiet run.
    const r2 = await reconcile();
    expect(r2.factsInserted).toBe(0);
    expect(r2.legacyRepair).toBeUndefined();
    await noActiveCopy();
  });

  test('forgotten after the crash AND a sync already imported the residue into the cache: the sweep restores file AND cache, the reconcile still inserts nothing', async () => {
    const a = await seed('Founded Acme');
    plantResidue();
    expect(await forgetFactInFence(engine, Number(a), { reason: 'after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();                                                         // the worst ordering
    expect((await dbFence()).facts).toHaveLength(1);
    const r = await reconcile();
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1 });
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    expect((await engine.getPage(ALICE, { sourceId: SRC }))!.content_hash).toBe('synced');   // hash kept: the next sync re-imports
    await noActiveCopy();
    // A later sync of the restored file changes nothing.
    await syncBody();
    const r2 = await reconcile();
    expect(r2.factsInserted).toBe(0);
    await noActiveCopy();
  });

  test('a residue-only page carrying a HUMAN edit is left alone by the sweep (checked, not healed) AND the reconcile leaves it alone too — the forgotten claim is not resurrected from the human\'s file', async () => {
    const a = await seed('Founded Acme');
    const theirs = plantResidue() + '\nA paragraph a human added.\n';
    writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();                                                         // the residue + the note are in the cache: file and cache agree
    const r = await reconcile();
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 0 });
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: undefined }]);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect(r.factsInserted).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    await noActiveCopy();
    // Blocked, not stuck: once the human COMMITS the file, the fence row is a
    // committed, human-authored row and the fence-is-canonical contract inserts
    // it — the block lifts because the file is clean, not because time passed.
    const r2 = await reconcile();
    expect(r2.factsInserted).toBe(0);
    await noActiveCopy();
    commitAll('the human keeps the row');
    const r3 = await reconcile();
    expect(r3.legacyRepair).toBeUndefined();
    expect(r3.factsInserted).toBe(1);
  });

  test('a residue-only page whose file is clean costs nothing: not counted, summary omitted', async () => {
    const a = await seed('Founded Acme');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'plain forget' })).toMatchObject({ ok: true, path: 'legacy_db' });
    const r = await reconcile();
    expect(r.legacyRepair).toBeUndefined();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });

  test('a dry-run never sweeps', async () => {
    const a = await seed('Founded Acme');
    const body = plantResidue();
    expect(await forgetFactInFence(engine, Number(a), { reason: 'after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    const r = await reconcile({ dryRun: true });
    expect(r.legacyRepair).toBeUndefined();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
  });
});

describe('acceptance round 3 (2026-09-14) — recovery never overwrites a concurrent edit, and reconciliation stays blocked until file AND cache are proven safe', () => {
  const plantResidue = () => {
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body;
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8');
    return body;
  };
  const noActiveCopy = async () => {
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[0]!.row_num).toBeNull();
  };
  /** Residue on disk whose only DB row has since been forgotten — the sole-forgotten-fact shape. */
  async function forgottenResidue(): Promise<string> {
    const a = await seed('Founded Acme');
    const body = plantResidue();
    expect(await forgetFactInFence(engine, Number(a), { reason: 'after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    return body;
  }

  test('P1: a human paragraph saved WHILE recovery awaits its DB read is never overwritten — refused as not_residue, blocked, nothing inserted', async () => {
    await forgottenResidue();
    await syncBody();
    const theirs = readFileSync(join(repo, ALICE_MD), 'utf-8') + '\nHuman note written while recovery reads DB.\n';
    const raw = engine.executeRaw;
    let humanWrite = false;
    // The healer's one await between reading the file and replacing it.
    engine.executeRaw = (async function (this: PGLiteEngine, ...args: Parameters<typeof raw>) {
      const rows = await raw.apply(this, args);
      if (!humanWrite && String(args[0]).includes('FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL')) {
        humanWrite = true;
        writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8');
      }
      return rows;
    }) as typeof raw;
    let r;
    try { r = await reconcile(); } finally { engine.executeRaw = raw; }
    expect(humanWrite).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 0 });
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: undefined }]);
    expect(r.warnings).not.toContainEqual(expect.stringContaining('restored the committed preimage'));
    expect(r.factsInserted).toBe(0);
    await noActiveCopy();
  });

  test('P1: a transient cache-refresh failure is NOT healed — the file is restored, the page reports cache_unsafe and stays blocked, nothing is inserted; a later sync clears it', async () => {
    await forgottenResidue();
    await syncBody();
    const refresh = engine.refreshPageBody;
    let failures = 0;
    engine.refreshPageBody = (async function (this: PGLiteEngine, ...args: Parameters<typeof refresh>) {
      failures += 1;
      if (failures === 1) throw new Error('transient refresh failure');
      return refresh.apply(this, args);
    }) as typeof refresh;
    let r;
    try { r = await reconcile(); } finally { engine.refreshPageBody = refresh; }
    expect(failures).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);        // the file IS restored
    expect((await dbFence()).facts).toHaveLength(1);                             // the cache still carries the residue
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 0 });
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'cache_unsafe', detail: undefined }]);
    expect(r.warnings).not.toContainEqual(expect.stringContaining('restored the committed preimage'));
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect(r.factsInserted).toBe(0);
    await noActiveCopy();
    // Next cycle, sync still pending: the file is clean so the sweep has nothing
    // to say, and the reconcile's own stale-cache rule holds the insert.
    const r2 = await reconcile();
    expect(r2.legacyRepair).toBeUndefined();
    expect(r2.warnings).toContainEqual(expect.stringContaining('FACTS_PAGE_CACHE_STALE'));
    expect(r2.factsInserted).toBe(0);
    await noActiveCopy();
    await syncBody();
    const r3 = await reconcile();
    expect(r3.factsInserted).toBe(0);
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
  });

  test('P1: a cache that is neither the residue nor the preimage (residue plus a cache-only paragraph) is cache_unsafe — blocked, nothing inserted, and a sync of the restored file clears it', async () => {
    await forgottenResidue();
    const disk = parseMarkdown(readFileSync(join(repo, ALICE_MD), 'utf-8'), `${ALICE}.md`);
    await engine.refreshPageBody(ALICE, SRC, disk.compiled_truth + '\n\nCache-only human note.', disk.timeline, 'synced');
    const r = await reconcile();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toHaveLength(1);
    expect((await engine.getPage(ALICE, { sourceId: SRC }))!.compiled_truth).toContain('Cache-only human note.');   // never touched
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'cache_unsafe', detail: undefined }]);
    expect(r.factsInserted).toBe(0);
    await noActiveCopy();
    await syncBody();
    const r2 = await reconcile();
    expect(r2.factsInserted).toBe(0);
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
  });

  test('a residue page the per-pass cap leaves unvisited is blocked as unswept, never silently left for the reconcile', async () => {
    await forgottenResidue();
    const s = await run(undefined, { maxPages: 0 });
    expect(s.residuePagesChecked).toBe(0);
    expect(s.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'unswept', detail: 'per-pass page cap reached' }]);
  });

  test('a healed page reports no block and the cache is read back as the preimage (control)', async () => {
    await forgottenResidue();
    await syncBody();
    const r = await reconcile();
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1, residuePagesBlocked: [] });
    expect(r.warnings).not.toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
  });
});

describe('acceptance round 4 (2026-09-14) — a repair that cannot complete fails closed: no reconcile, nothing resurrected, every block kept', () => {
  // Codex acceptance round 3, P1: a repair-wide query failure (listing the
  // eligible rows, listing the residue-only pages, or the final recount) was
  // caught and read as "nothing to block". With the source's only legacy row
  // already forgotten, legacyCount stayed 0, blockedResidueSlugs stayed empty,
  // and the reconcile re-inserted the forgotten claim from the crashed
  // repair's residue on disk and in the cache. A failed recount even discarded
  // a `not_residue` block it had already collected. These pin the fix: the
  // repair returns its partial summary with `failure` set, the phase halts
  // BEFORE the reconcile (guardTriggered + repairFailed), and the next run
  // retries.
  const noActiveCopy = async () => {
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[0]!.row_num).toBeNull();
  };
  /**
   * Residue as the real writer leaves it: the run dies after the rename and
   * before COMMIT, cannot verify (indeterminate, so the fenced file stays),
   * then the sole row is forgotten and a sync imports the file into the cache.
   */
  async function forgottenResidueFromRealWriter(humanNote = ''): Promise<string> {
    const a = await seed('Founded Acme');
    const crashed = await run({
      beforeCommit: () => { throw new Error('crash before COMMIT'); },
      beforeVerifyLanded: () => { throw new Error('verification unavailable'); },
    });
    expect(crashed.rowsStamped).toBe(0);
    expect(diskFence().facts).toHaveLength(1);
    if (humanNote) writeFileSync(join(repo, ALICE_MD), readFileSync(join(repo, ALICE_MD), 'utf-8') + humanNote, 'utf-8');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forget after crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(0);                // the guard does not arm
    expect((await dbFence()).facts).toHaveLength(1);                            // the cache carries the residue too
    return readFileSync(join(repo, ALICE_MD), 'utf-8');
  }
  /** Throw once from the `nth` executeRaw whose SQL contains `needle`; everything else passes through. */
  function failOnce(needle: string, nth = 1) {
    const raw = engine.executeRaw;
    const state = { seen: 0, injected: false, restore: () => { engine.executeRaw = raw; } };
    engine.executeRaw = (async function (this: PGLiteEngine, ...args: Parameters<typeof raw>) {
      if (String(args[0]).includes(needle) && !state.injected && ++state.seen === nth) {
        state.injected = true;
        throw new Error(`one-shot ${needle.slice(0, 24)}`);
      }
      return raw.apply(this, args);
    }) as typeof raw;
    return state;
  }
  const haltedRollup = async () => (await engine.executeRaw<{ halt_count: number; round_completed_count: number }>(
    `SELECT halt_count, round_completed_count FROM extract_rollup_7d WHERE kind = 'facts.fence' AND source_id = $1`, [SRC],
  ))[0];

  async function expectFailedClosed(r: Awaited<ReturnType<typeof reconcile>>, step: string, residue: string) {
    expect(r.guardTriggered).toBe(true);
    expect(r.repairFailed).toContain(step);
    expect(r.legacyRepair?.failure).toContain(step);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_REPAIR_INCOMPLETE'));
    expect(r.warnings).not.toContainEqual(expect.stringContaining('legacy repair failed'));
    expect(r.factsInserted).toBe(0);
    expect(r.factsDeleted).toBe(0);
    expect(r.pagesScanned).toBe(0);                                               // the reconcile never started
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(residue);          // untouched, not restored
    expect((await dbFence()).facts).toHaveLength(1);
    await noActiveCopy();
    expect(await haltedRollup()).toMatchObject({ halt_count: 1, round_completed_count: 0 });
  }

  test('the initial legacy-list query fails once: halted before the reconcile, no active copy; the next run heals', async () => {
    const residue = await forgottenResidueFromRealWriter();
    const seam = failOnce('SELECT f.id::text AS id, f.source_id');
    let r;
    try { r = await reconcile(); } finally { seam.restore(); }
    expect(seam.injected).toBe(true);
    await expectFailedClosed(r, 'listing eligible legacy rows', residue);
    expect(r.legacyRepair).toMatchObject({ rowsEligible: 0, residuePagesChecked: 0, residuePagesBlocked: [] });
    // Next run, no failure: the sweep restores the preimage and nothing is inserted.
    const r2 = await reconcile();
    expect(r2.guardTriggered).toBe(false);
    expect(r2.repairFailed).toBeUndefined();
    expect(r2.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1, residuePagesBlocked: [] });
    expect(r2.factsInserted).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
  });

  test('the sweep\'s residue-list query fails once (the guard\'s own pre-check passed): halted, no active copy; the next run heals', async () => {
    const residue = await forgottenResidueFromRealWriter();
    const seam = failOnce('SELECT DISTINCT f.entity_slug', 2);                    // 1st: residuePagesPending; 2nd: the sweep
    let r;
    try { r = await reconcile(); } finally { seam.restore(); }
    expect(seam.injected).toBe(true);
    expect(seam.seen).toBe(2);
    await expectFailedClosed(r, 'listing residue-only pages', residue);
    const r2 = await reconcile();
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRepair).toMatchObject({ residuePagesHealed: 1 });
    expect(r2.factsInserted).toBe(0);
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
  });

  test('the final recount fails after a human-edit refusal: the not_residue block already collected is KEPT, halted, the human\'s file untouched', async () => {
    const residue = await forgottenResidueFromRealWriter('\nHuman note, preserve this.\n');
    const seam = failOnce('SELECT COUNT(*) AS n FROM facts f');                   // the recount's one-line form; the guard's COUNT is multi-line
    let r;
    try { r = await reconcile(); } finally { seam.restore(); }
    expect(seam.injected).toBe(true);
    await expectFailedClosed(r, 're-counting eligible legacy rows', residue);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 0 });
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: undefined }]);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toContain('Human note, preserve this.');
    // Next run, no failure: still blocked (the human's edit is not residue), still nothing inserted.
    const r2 = await reconcile();
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: undefined }]);
    expect(r2.factsInserted).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(residue);
    await noActiveCopy();
  });

  test('a recount failure AFTER stamps landed keeps the stamp counters: the halt reports what was fenced, nothing is reconciled, the next run is quiet', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const seam = failOnce('SELECT COUNT(*) AS n FROM facts f');
    let r;
    try { r = await reconcile(); } finally { seam.restore(); }
    expect(seam.injected).toBe(true);
    expect(r.guardTriggered).toBe(true);
    expect(r.repairFailed).toContain('re-counting eligible legacy rows');
    expect(r.legacyRowsRepaired).toBe(2);
    expect(r.legacyRepair).toMatchObject({ rowsEligible: 2, rowsStamped: 2, pagesFenced: 1, failure: expect.stringContaining('re-counting') });
    expect(r.legacyRowsPending).toBe(2);                                          // the pre-repair count stands: not a fresh recount
    expect(r.factsInserted).toBe(0);
    expect((await factRows()).map(x => x.row_num).sort()).toEqual([1, 2]);        // the stamps are real
    expect(diskFence().facts.map(f => f.claim)).toEqual(['Founded Acme', 'Prefers async']);
    const r2 = await reconcile();
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRepair).toBeUndefined();
    expect(r2.factsInserted).toBe(0);
    expect((await factRows()).map(x => x.row_num).sort()).toEqual([1, 2]);
  });

  test('repairLegacyRowsForSource never throws: each repair-wide query failure returns the partial summary with `failure` set', async () => {
    await seed('Founded Acme');
    let seam = failOnce('SELECT f.id::text AS id, f.source_id');
    let s;
    try { s = await run(); } finally { seam.restore(); }
    expect(s).toMatchObject({ rowsEligible: 0, rowsStamped: 0, rowsRemaining: 0, failure: expect.stringContaining('listing eligible legacy rows') });
    expect((await factRows())[0]!.row_num).toBeNull();

    seam = failOnce('SELECT DISTINCT f.entity_slug');
    try { s = await run(); } finally { seam.restore(); }
    expect(s).toMatchObject({ rowsEligible: 1, rowsStamped: 1, pagesFenced: 1, failure: expect.stringContaining('listing residue-only pages') });
    expect(s.rowsRemaining).toBe(0);                                              // never re-counted: the initial value, not a claim
    expect((await factRows())[0]!.row_num).toBe(1);

    // A completed pass carries no `failure`.
    const s3 = await run();
    expect(s3.failure).toBeUndefined();
    expect(s3).toMatchObject({ rowsEligible: 0, rowsRemaining: 0 });
  });

  test('a dry-run never reaches the repair, so a failing query cannot halt it', async () => {
    const residue = await forgottenResidueFromRealWriter();
    const seam = failOnce('SELECT f.id::text AS id, f.source_id');
    let r;
    try { r = await reconcile({ dryRun: true }); } finally { seam.restore(); }
    expect(seam.injected).toBe(false);
    expect(r.guardTriggered).toBe(false);
    expect(r.repairFailed).toBeUndefined();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(residue);
  });
});

describe('acceptance round 5 (2026-09-14) — only a PROVEN clean file reads as clean, in any filename; a page the writer cannot resolve is its own refusal', () => {
  // Codex acceptance round 4. P1: `gitPathState` compared git's porcelain path
  // literally, but `core.quotePath` (default true) prints any non-ASCII byte
  // C-quoted — `"people/\303\251lise.md"` — so the crashed repair's own dirt on
  // an ordinary é/æ/ø/å filename read as `foreign_dirty`, which the residue
  // sweep then read as CLEAN: no block, and the reconcile re-inserted the
  // forgotten claim. P2: `resolvePageWriteTarget` ran outside the writer's
  // catch, so a DB fault on the second page threw through the repair and the
  // pass's summary (first page already stamped) was lost.
  const ELISE = 'people/élise';                                                  // NFC: one code point
  const ELISE_MD = 'people/élise.md';
  const NFD_ELISE_MD = ELISE_MD.normalize('NFD');                                // e + combining acute
  const noActiveCopy = async () => {
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[0]!.row_num).toBeNull();
  };
  async function addPage(slug: string, rel: string): Promise<void> {
    writeFileSync(join(repo, rel), ALICE_BODY, 'utf-8');
    git(repo, 'add', '--', rel);
    git(repo, 'commit', '-q', '-m', `add ${rel}`);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ($1, $2, 'person', 'Élise', $3, '')`,
      [slug, SRC, ALICE_DB_BODY],
    );
  }
  const plantResidue = (rel: string) => {
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body;
    writeFileSync(join(repo, rel), body, 'utf-8');
    return body;
  };

  test('P1: a non-ASCII filename under Git\'s default core.quotePath — the real writer\'s crash residue is recognised as its own dirt, the preimage restored, nothing inserted', async () => {
    git(repo, 'config', 'core.quotePath', 'true');                              // git's default, pinned against any global override
    await addPage(ELISE, ELISE_MD);
    const a = await seed('Founded Acme', ELISE);
    const crashed = await run({
      beforeCommit: () => { throw new Error('crash before COMMIT'); },
      beforeVerifyLanded: () => { throw new Error('verification unavailable'); },
    });
    expect(crashed.rowsStamped).toBe(0);
    expect(diskFence(ELISE_MD).facts).toHaveLength(1);                           // the residue is on disk
    // The shape that bypassed the sweep: git's own porcelain output for this
    // path is the C-quoted, octal-escaped form, not the filename.
    expect(git(repo, 'status', '--porcelain=v1', '--', ELISE_MD)).toBe(' M "people/\\303\\251lise.md"\n');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forget after crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody(ELISE, ELISE_MD);
    expect((await dbFence(ELISE)).facts).toHaveLength(1);
    const r = await reconcile({ slugs: [ELISE] });
    expect(r.factsInserted).toBe(0);                                             // pre-fix: 1 — the forgotten claim came back
    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1, residuePagesBlocked: [] });
    expect(readFileSync(join(repo, ELISE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect(git(repo, 'status', '--porcelain=v1', '--', ELISE_MD)).toBe('');
    expect((await dbFence(ELISE)).facts).toEqual([]);
    await noActiveCopy();
  });

  test('P1: the index holds the path in NFD while the DB names it in NFC (core.precomposeunicode=false): still recognised — the sweep asks git for every form and HEAD is found under the form it holds', async () => {
    if (process.platform !== 'darwin') return;                                  // needs a normalization-insensitive filesystem
    git(repo, 'config', 'core.precomposeunicode', 'false');
    await addPage(ELISE, NFD_ELISE_MD);                                          // created and committed under the NFD name
    expect(git(repo, 'ls-files', '-z').split('\0')).toContain(NFD_ELISE_MD);
    // The NFC pathspec matches NOTHING in this index — an empty status that
    // used to read as clean.
    expect(git(repo, 'status', '--porcelain=v1', '--', ELISE_MD)).toBe('');
    const a = await seed('Founded Acme', ELISE);
    plantResidue(ELISE_MD);                                                      // the same file, reached under its NFC name
    expect(git(repo, 'status', '--porcelain=v1', '--', ELISE_MD)).toBe('');     // still invisible to the NFC pathspec
    expect(git(repo, 'status', '--porcelain=v1', '-z', '--', NFD_ELISE_MD)).toBe(` M ${NFD_ELISE_MD}\0`);
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forget after crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody(ELISE, ELISE_MD);
    const r = await reconcile({ slugs: [ELISE] });
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1, residuePagesBlocked: [] });
    expect(readFileSync(join(repo, ELISE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence(ELISE)).facts).toEqual([]);
    await noActiveCopy();
  });

  test('P1: an unmerged file is not clean — the residue-only sweep hands it back not_residue and the reconcile leaves the page alone', async () => {
    // Two branches each commit a different fence row at the same spot: the
    // merge leaves `UU people/alice.md` — dirt the parse must not attribute to
    // the repair, and must not read as clean either.
    const theirs = plantResidue(ALICE_MD); commitAll('theirs');
    git(repo, 'branch', 'theirs');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(repo, ALICE_MD), upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme Corp', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body, 'utf-8');
    commitAll('ours');
    expect(() => git(repo, 'merge', 'theirs')).toThrow();
    expect(git(repo, 'status', '--porcelain=v1', '--', ALICE_MD)).toBe(`UU ${ALICE_MD}\n`);
    const conflicted = readFileSync(join(repo, ALICE_MD), 'utf-8');
    expect(conflicted).toContain('<<<<<<<');
    const a = await seed('Founded Acme');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forgotten' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();                                                            // a sync imported the conflicted file as-is
    expect((await dbFence()).facts.length).toBeGreaterThan(0);
    const r = await reconcile();
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 0 });
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: expect.stringContaining('foreign_dirty') }]);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect(r.factsInserted).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(conflicted);         // untouched
    await noActiveCopy();
    expect(theirs).not.toBe(conflicted);
  });

  test('P1: a source directory that is not a git repository is not clean either — blocked `error`, never read as clean', async () => {
    const a = await seed('Founded Acme');
    const body = plantResidue(ALICE_MD);
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forgotten' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    // The tempdir may itself sit inside an unrelated repository (a TMPDIR
    // under a checked-out home); the ceiling keeps git's discovery from
    // climbing into it, so this fixture is "no repository" everywhere.
    const r = await withEnv({ GBRAIN_HOME: home, GIT_CEILING_DIRECTORIES: dirname(repo) }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE] }));
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'error', detail: expect.stringContaining('git state unknown') }]);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 0, residuePagesHealed: 0 });
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(body);
    await noActiveCopy();
  });

  test('P1: an empty status is not a proof — a source nested in an unrelated repository that git-ignores it has no committed preimage: blocked not_residue, never read as clean', async () => {
    // `repo` stays the enclosing repository; the source lives in an ignored
    // subdirectory of it and is not a repository of its own. `git status` for
    // the file is empty (ignored paths are not listed), which used to read as
    // clean — the same shape as the stamp path's "ignored is not a preimage".
    writeFileSync(join(repo, '.gitignore'), 'brain/\n', 'utf-8');
    commitAll('ignore the nested brain');
    const brain = join(repo, 'brain');
    mkdirSync(join(brain, 'people'), { recursive: true });
    await engine.executeRaw(`UPDATE sources SET local_path = $2 WHERE id = $1`, [SRC, brain]);
    const a = await seed('Founded Acme');
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body;
    writeFileSync(join(brain, ALICE_MD), body, 'utf-8');
    expect(git(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--', `brain/${ALICE_MD}`)).toBe('');
    expect(git(repo, 'check-ignore', `brain/${ALICE_MD}`).trim()).toBe(`brain/${ALICE_MD}`);
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forgotten' })).toMatchObject({ ok: true, path: 'legacy_db' });
    const parsed = parseMarkdown(body, `${ALICE}.md`);
    await engine.refreshPageBody(ALICE, SRC, parsed.compiled_truth, parsed.timeline, 'synced');
    const r = await reconcile();
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: expect.stringContaining('ignored: no committed preimage') }]);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect(readFileSync(join(brain, ALICE_MD), 'utf-8')).toBe(body);
    await noActiveCopy();
  });

  test('P2: a target-resolution query that throws for the second page is that page\'s `error` refusal — the first stamp stands, the summary comes back with every counter, nothing throws', async () => {
    const BOB = 'people/bob';
    await addPage(BOB, 'people/bob.md');
    await seed('Fact for alice');
    await seed('Fact for bob', BOB);
    const raw = engine.executeRaw;
    let injected = false;
    engine.executeRaw = (async function (this: PGLiteEngine, ...args: Parameters<typeof raw>) {
      if (String(args[0]).includes('SELECT source_path, source_uri FROM pages') && (args[1] as unknown[])?.[1] === BOB) {
        injected = true;
        throw new Error('bob target query unavailable');
      }
      return raw.apply(this, args);
    }) as typeof raw;
    let s;
    try { s = await run(); } finally { engine.executeRaw = raw; }
    expect(injected).toBe(true);
    expect(s.failure).toBeUndefined();                                             // the pass COMPLETED; one page refused
    expect(s).toMatchObject({ rowsEligible: 2, rowsStamped: 1, rowsAppended: 1, pagesFenced: 1, pagesSkipped: 1, rowsRemaining: 1 });
    expect(s.skippedByReason).toEqual({ error: 1 });
    expect(s.skippedDetails).toEqual(['people/bob (error: bob target query unavailable)']);
    const rows = await factRows();
    expect(rows.map(x => [x.fact, x.row_num])).toEqual([['Fact for alice', 1], ['Fact for bob', null]]);
    expect(diskFence().facts.map(f => f.claim)).toEqual(['Fact for alice']);
    expect(diskFence('people/bob.md').facts).toEqual([]);

    // Through the phase: the guard halts on bob's row with the partial repair
    // reported (stamped 1, 1 page refused), not as an incomplete repair.
    engine.executeRaw = (async function (this: PGLiteEngine, ...args: Parameters<typeof raw>) {
      if (String(args[0]).includes('SELECT source_path, source_uri FROM pages') && (args[1] as unknown[])?.[1] === BOB) throw new Error('bob target query unavailable');
      return raw.apply(this, args);
    }) as typeof raw;
    let r;
    try { r = await reconcile({ slugs: [ALICE, BOB] }); } finally { engine.executeRaw = raw; }
    expect(r.guardTriggered).toBe(true);
    expect(r.repairFailed).toBeUndefined();
    expect(r.legacyRowsRepaired).toBe(0);                                          // alice was stamped by the pass above; nothing new
    expect(r.legacyRowsPending).toBe(1);
    expect(r.legacyRepair).toMatchObject({ rowsEligible: 1, rowsStamped: 0, pagesSkipped: 1, skippedByReason: { error: 1 }, rowsRemaining: 1 });
    expect(r.warnings).toContainEqual(expect.stringContaining('legacy repair left 1 page(s) unfenced'));
    expect(r.warnings).not.toContainEqual(expect.stringContaining('FACTS_REPAIR_INCOMPLETE'));
    expect(r.factsInserted).toBe(0);
    // The fault clears: the next run stamps bob and reconciles.
    const r2 = await reconcile({ slugs: [ALICE, BOB] });
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRowsRepaired).toBe(1);
    expect((await factRows()).map(x => x.row_num)).toEqual([1, 1]);
  });

  test('P2: the pre-lock write-through switch read throwing is the same per-page `error` refusal; a dry-run never throws either', async () => {
    await seed('Founded Acme');
    const raw = engine.executeRaw;
    const failing = (async function (this: PGLiteEngine, ...args: Parameters<typeof raw>) {
      if (String(args[0]).includes('SELECT source_path, source_uri FROM pages')) throw new Error('target query unavailable');
      return raw.apply(this, args);
    }) as typeof raw;
    engine.executeRaw = failing;
    let s, d;
    try {
      s = await run();
      d = await run(undefined, { dryRun: true });
    } finally { engine.executeRaw = raw; }
    expect(s).toMatchObject({ rowsStamped: 0, pagesSkipped: 1, skippedByReason: { error: 1 }, rowsRemaining: 1 });
    expect(d).toMatchObject({ dryRun: true, rowsStamped: 0, pagesSkipped: 1, skippedByReason: { error: 1 } });
    expect((await factRows())[0]!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });
});

describe('acceptance round 6 (2026-09-14) — clean is a byte proof against HEAD, and no entry point reconciles unprotected', () => {
  // P1 (reviewer, reproduced by the parent with plain git): the sweep's
  // `proven()` read "empty `git status` + tracked at HEAD" as clean and never
  // compared the file's bytes to the committed blob. `git update-index
  // --assume-unchanged` and `--skip-worktree` keep status EMPTY for a tracked
  // path whose working bytes differ, so a residue-carrying file was called
  // clean, the sweep supplied no block, and the forgotten claim came back.
  // The proof is now content-based (`gitCleanAtHead`: `git hash-object
  // <file>` must equal the blob at `HEAD:./<file>`); status is only the
  // pre-filter. Bytes that differ behind an empty status are the file's own
  // dirt and go to the recognizer, which heals exactly a crashed run's
  // appends and refuses anything else. The stamp path uses the same proof.
  // P1: a direct `runExtractFacts` with neither `brainDir` nor `repairLegacy`
  // reconciled unprotected — the repair now defaults on for every caller, and
  // an explicit opt-out BLOCKS residue candidates instead of reconciling them.
  const plantResidue = () => {
    const body = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    }).body;
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8');
    return body;
  };
  const noActiveCopy = async () => {
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[0]!.row_num).toBeNull();
  };
  /** Residue planted, its only row forgotten, the residue already synced into the cache: the worst ordering. */
  const forgottenResidueInCache = async (): Promise<string> => {
    const a = await seed('Founded Acme');
    const body = plantResidue();
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forgotten after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();
    expect((await dbFence()).facts).toHaveLength(1);
    return body;
  };
  const statusIsEmpty = () =>
    expect(git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ALICE_MD)).toBe('');
  const headBlob = () => git(repo, 'show', `HEAD:./${ALICE_MD}`);

  for (const flag of ['--assume-unchanged', '--skip-worktree'] as const) {
    test(`P1: ${flag} hides a crashed repair's residue from git status — the sweep proves the bytes against HEAD anyway, heals, and the reconcile inserts nothing`, async () => {
      const residue = await forgottenResidueInCache();
      git(repo, 'update-index', flag, '--', ALICE_MD);
      statusIsEmpty();                                                          // the misleading shape, verbatim
      expect(git(repo, 'ls-files', '--error-unmatch', '--', ALICE_MD).trim()).toBe(ALICE_MD);
      expect(headBlob()).toBe(ALICE_BODY);
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(residue);        // ...while the disk differs from HEAD
      const r = await reconcile();
      expect(r.factsInserted).toBe(0);
      expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1, residuePagesBlocked: [] });
      expect(r.warnings).toContainEqual(expect.stringContaining('restored the committed preimage'));
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
      expect((await dbFence()).facts).toEqual([]);
      await noActiveCopy();
      // The index bit is the operator's and stays; the file simply IS HEAD now.
      const r2 = await reconcile();
      expect(r2.factsInserted).toBe(0);
      expect(r2.legacyRepair).toBeUndefined();
      await noActiveCopy();
    });
  }

  test('P1: bytes that differ from HEAD behind an empty status but are NOT residue (a human paragraph under --assume-unchanged) are blocked not_residue, every byte kept, nothing inserted', async () => {
    const a = await seed('Founded Acme');
    const theirs = plantResidue() + '\nA paragraph a human added.\n';
    writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'forgotten after the crash' })).toMatchObject({ ok: true, path: 'legacy_db' });
    await syncBody();
    git(repo, 'update-index', '--assume-unchanged', '--', ALICE_MD);
    statusIsEmpty();
    const r = await reconcile();
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 0 });
    expect(r.legacyRepair!.residuePagesBlocked).toEqual([{ slug: ALICE, reason: 'not_residue', detail: undefined }]);
    expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNRESOLVED'));
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    await noActiveCopy();
  });

  test('P1 (stamp path, same proof): an --assume-unchanged file carrying an uncommitted human edit is refused file_uncommitted — never stamped over', async () => {
    await seed('Founded Acme');
    const theirs = ALICE_BODY + '\nA paragraph a human added but never committed.\n';
    writeFileSync(join(repo, ALICE_MD), theirs, 'utf-8');
    await syncBody();                                                            // a sync imported the working tree, as production does
    git(repo, 'update-index', '--assume-unchanged', '--', ALICE_MD);
    statusIsEmpty();
    const s = await run();
    expect(s.rowsStamped).toBe(0);
    expect(s.skippedByReason.file_uncommitted).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(theirs);
    expect(headBlob()).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('control: a tracked file whose bytes ARE the committed blob is clean, even with --assume-unchanged set — nothing to heal, nothing blocked, quiet run', async () => {
    const a = await seed('Founded Acme');
    expect(await forgetFactInFence(engine, Number(a), { reason: 'plain forget' })).toMatchObject({ ok: true, path: 'legacy_db' });
    git(repo, 'update-index', '--assume-unchanged', '--', ALICE_MD);
    const r = await reconcile();
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair).toBeUndefined();
    expect(r.warnings.filter(w => w.includes('RESIDUE'))).toEqual([]);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });

  test('P1: the headless entry point — a direct runExtractFacts with neither brainDir nor repairLegacy — is protected: the residue sweep runs, restores the preimage, nothing is inserted', async () => {
    await forgottenResidueInCache();
    const r = await withEnv({ GBRAIN_HOME: home }, () => runExtractFacts(engine, { sourceId: SRC, slugs: [ALICE] }));
    expect(r.guardTriggered).toBe(false);
    expect(r.factsInserted).toBe(0);
    expect(r.legacyRepair).toMatchObject({ residuePagesChecked: 1, residuePagesHealed: 1 });
    expect(r.warnings).toContainEqual(expect.stringContaining('restored the committed preimage'));
    expect(r.phantomsScanned).toBe(0);                                          // brainDir still gates only the phantom pass
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    await noActiveCopy();
  });

  const optedOut = (label: string, extra: Record<string, unknown>, env: Record<string, string>) =>
    test(`P1: with the repair opted out (${label}) a residue-only page is BLOCKED from the reconcile (FACTS_RESIDUE_UNSWEPT) — never reconciled unprotected; the next enabled run heals it`, async () => {
      const residue = await forgottenResidueInCache();
      const r = await withEnv({ GBRAIN_HOME: home, ...env }, () =>
        runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE], ...extra }));
      expect(r.guardTriggered).toBe(false);
      expect(r.factsInserted).toBe(0);
      expect(r.legacyRepair).toBeUndefined();                                   // the opt-out ran nothing
      expect(r.warnings).toContainEqual(expect.stringContaining('FACTS_RESIDUE_UNSWEPT'));
      expect(r.warnings).toContainEqual(expect.stringContaining(ALICE));
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(residue);        // and wrote nothing
      expect((await dbFence()).facts).toHaveLength(1);
      await noActiveCopy();
      const r2 = await reconcile();
      expect(r2.factsInserted).toBe(0);
      expect(r2.legacyRepair).toMatchObject({ residuePagesHealed: 1 });
      expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
      await noActiveCopy();
    });
  optedOut('repairLegacy: false', { repairLegacy: false }, {});
  optedOut('GBRAIN_FACT_REPAIR=off', {}, { GBRAIN_FACT_REPAIR: 'off' });

  test('opt-out with the guard armed still halts before any reconcile (unchanged): legacy rows pending, nothing written, no residue warning needed', async () => {
    await seed('Founded Acme');
    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir: repo, slugs: [ALICE], repairLegacy: false }));
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.factsInserted).toBe(0);
    expect(r.warnings.filter(w => w.includes('FACTS_RESIDUE_UNSWEPT'))).toEqual([]);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
  });
});

describe('acceptance round 3 (2026-09-14) — calendar days are the UTC day the API wrote, whatever the DB session zone', () => {
  // The normal input path: the fence mapper / `remember` bind UTC-midnight
  // Dates. Rendering the SESSION's day (the 2d5c08f90 form) shifts these back
  // a day under any negative offset; rendering the UTC day round-trips.
  for (const zone of ['Europe/Copenhagen', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    test(`${zone}: a legacy row at UTC midnight 2026-01-02..2026-12-31 stamps as 2026-01-02..2026-12-31, and the reconcile after a sync keeps the instants`, async () => {
      await engine.executeRaw(`SET TIME ZONE '${zone}'`);
      try {
        const mapped = extractFactsFromFenceText([{
          rowNum: 1, claim: 'Calendar fact', kind: 'fact', visibility: 'private', notability: 'medium',
          confidence: 0.9, validFrom: '2026-01-02', validUntil: '2026-12-31', source: 'mcp:put_page', active: true,
        }], ALICE, SRC)[0]!;
        expect(mapped.valid_from!.toISOString()).toBe('2026-01-02T00:00:00.000Z');
        const { id } = await engine.insertFact(mapped, { source_id: SRC });   // insertFact writes no row_num: a legacy row
        expect((await factRows())[0]!.row_num).toBeNull();

        const s = await run();
        expect(s).toMatchObject({ rowsStamped: 1, rowsRemaining: 0 });
        const f = diskFence().facts[0]!;
        expect([f.validFrom, f.validUntil]).toEqual(['2026-01-02', '2026-12-31']);
        expect((await dbFence()).facts[0]!.validFrom).toBe('2026-01-02');

        // A wipe + reinsert from the fence must land on the same instants.
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
           VALUES ($1, $2, 'Stale unrelated row', 'fact', 'private', 'medium', now(), 'mcp:put_page', 0.9, 99, $2)`, [SRC, ALICE]);
        const r = await reconcile();
        expect(r.factsDeleted).toBe(2);
        expect(r.factsInserted).toBe(1);
        const dates = await engine.executeRaw<{ vf: string; vu: string }>(
          `SELECT to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS vf, to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS vu
             FROM facts WHERE source_id = $1 AND fact = 'Calendar fact'`, [SRC]);
        expect(dates).toEqual([{ vf: '2026-01-02 00:00', vu: '2026-12-31 00:00' }]);
        expect(id).toBeGreaterThan(0);
      } finally {
        await engine.executeRaw(`RESET TIME ZONE`);
      }
    });
  }

  test('America/Los_Angeles: the in-transaction re-check renders the same UTC day as the eligibility read, so a negative offset is not mistaken for an edit', async () => {
    await engine.executeRaw(`SET TIME ZONE 'America/Los_Angeles'`);
    try {
      await engine.insertFact({ entity_slug: ALICE, fact: 'Founded Acme', kind: 'fact', visibility: 'private', notability: 'medium',
        confidence: 0.9, valid_from: new Date('2026-01-02'), source: 'mcp:put_page' }, { source_id: SRC });
      const s = await run();
      expect(s.skippedByReason).toEqual({});
      expect(s.rowsStamped).toBe(1);
      expect(diskFence().facts[0]!.validFrom).toBe('2026-01-02');
    } finally {
      await engine.executeRaw(`RESET TIME ZONE`);
    }
  });
});

describe('acceptance finding 5 — existing-fence reuse revalidates the file before the stamp', () => {
  test('a foreign edit that removes the matching fence between the plan and the rename: refused concurrent_edit, nothing stamped, the edit stands, the DB body rolled back', async () => {
    const { body } = upsertFactRow(ALICE_BODY, {
      rowNum: 1, claim: 'Founded Acme', kind: 'fact', confidence: 0.9, visibility: 'private',
      notability: 'medium', validFrom: '2026-01-02', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), body, 'utf-8'); commitAll('fence');
    await syncBody();
    await seed('Founded Acme');
    const s = await run({ beforeRename: () => { writeFileSync(join(repo, ALICE_MD), ALICE_BODY, 'utf-8'); } });
    expect(s.skippedByReason.concurrent_edit).toBe(1);
    expect(s.rowsStamped).toBe(0);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual(parseFactsFence(body).facts);
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
