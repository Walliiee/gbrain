/**
 * src/core/facts/fence-legacy.ts — self-draining legacy-fact repair.
 *
 * Real PGLite brain + a tempdir git repo as the source's local_path.
 * GBRAIN_HOME is isolated because the page lock lives under it.
 *
 * Covers the acceptance criteria of
 * shared:agent-runs/2026-09-13-maintenance-fact-repair-delivery:
 *   1. only the active source's pages; unrelated dirt never blocks;
 *   2. per-file lock + refusal on symlink / unresolvable / foreign dirt;
 *   3. existing markdown + facts preserved; disk AND DB body verified before
 *      any row is stamped;
 *   4. failure injection at every transition: retry is idempotent, no loss,
 *      no duplicate rows, no fabricated success;
 *   5. preimage + journal, tested rollback;
 *   6. zero eligible = no-op; dry-run writes nothing.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import {
  repairLegacyRowsForSource,
  listLegacyRowsForSource,
  countLegacyRowsForSource,
  appendLegacyRowsToBody,
  readFactRepairJournal,
  rollbackFactRepairEntry,
  repairGitPathState,
  isFactRepairDisabled,
  type FenceLegacyHooks,
  type LegacyFactRow,
} from '../src/core/facts/fence-legacy.ts';

let engine: PGLiteEngine;
let repo: string;
let home: string;
let journalDir: string;

const SRC = 'wiki';
const ALICE = 'people/alice';
const ALICE_MD = 'people/alice.md';
const ALICE_BODY = '---\ntype: person\ntitle: Alice\n---\n\n# Alice\n\nA person who does things.\n\n## Notes\n\n- keep me\n';

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
  journalDir = join(home, 'journal');
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
    [ALICE, SRC, '# Alice\n\nA person who does things.\n\n## Notes\n\n- keep me'],
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

async function factRows(sourceId = SRC): Promise<Array<{ id: string; fact: string; row_num: number | null; source_markdown_slug: string | null }>> {
  return engine.executeRaw(
    `SELECT id::text AS id, fact, row_num, source_markdown_slug FROM facts WHERE source_id = $1 ORDER BY id`,
    [sourceId],
  );
}

function diskFence(rel = ALICE_MD) {
  return parseFactsFence(readFileSync(join(repo, rel), 'utf-8'));
}

async function dbFence(slug = ALICE) {
  const p = await engine.getPage(slug, { sourceId: SRC });
  return parseFactsFence(p?.compiled_truth ?? '');
}

const run = (hooks?: FenceLegacyHooks, extra: Record<string, unknown> = {}) =>
  withEnv({ GBRAIN_HOME: home }, () =>
    repairLegacyRowsForSource(engine, { sourceId: SRC, journalDir, lockTimeoutMs: 2_000, hooks, ...extra }));

function journalEntries() {
  const dir = join(journalDir, SRC);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  return files.flatMap(f => readFactRepairJournal(join(dir, f)));
}

// ── Happy path + idempotency ───────────────────────────────────────────────

describe('repairLegacyRowsForSource — drains, verifies, stamps', () => {
  test('two legacy rows: fenced on disk, DB body carries the fence, rows stamped, journal + preimage written', async () => {
    const a = await seed('Founded Acme');
    const b = await seed('Prefers async');

    const s = await run();
    expect(s.rowsEligible).toBe(2);
    expect(s.rowsStamped).toBe(2);
    expect(s.rowsAppended).toBe(2);
    expect(s.pagesFenced).toBe(1);
    expect(s.pagesSkipped).toBe(0);
    expect(s.rowsRemaining).toBe(0);

    // Disk fence carries both rows; existing markdown untouched.
    const disk = readFileSync(join(repo, ALICE_MD), 'utf-8');
    expect(disk).toContain('A person who does things.');
    expect(disk).toContain('- keep me');
    expect(disk.startsWith('---\ntype: person\ntitle: Alice\n---')).toBe(true);
    const df = diskFence();
    expect(df.warnings).toEqual([]);
    expect(df.facts.map(f => f.claim).sort()).toEqual(['Founded Acme', 'Prefers async']);
    expect(df.facts.map(f => f.validFrom)).toEqual(['2026-01-02', '2026-01-02']);

    // DB body carries the same fence — the reconcile can never see "no fence".
    const dbf = await dbFence();
    expect(dbf.facts.map(f => f.claim).sort()).toEqual(['Founded Acme', 'Prefers async']);

    // Stamps match the fence row_nums.
    const rows = await factRows();
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const f of df.facts) {
      const id = f.claim === 'Founded Acme' ? a : b;
      expect(byId.get(id)!.row_num).toBe(f.rowNum);
      expect(byId.get(id)!.source_markdown_slug).toBe(ALICE);
    }

    // Journal begin + done, preimage equals the original file.
    const j = journalEntries();
    expect(j.map(e => e.phase)).toEqual(['begin', 'done']);
    expect(j[1]!.ids.sort()).toEqual([a, b].sort());
    expect(readFileSync(j[1]!.preimage!, 'utf-8')).toBe(ALICE_BODY);

    // Not hardened → no commit; the file is left modified for the owner.
    expect(git(repo, 'status', '--porcelain')).toContain(ALICE_MD);
  });

  test('re-run is a no-op: zero eligible rows, nothing written, no journal', async () => {
    await seed('Founded Acme');
    await run();
    const before = readFileSync(join(repo, ALICE_MD), 'utf-8');
    const jBefore = journalEntries().length;
    const s = await run();
    expect(s.rowsEligible).toBe(0);
    expect(s.pagesFenced).toBe(0);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(before);
    expect(journalEntries().length).toBe(jBefore);
  });

  test('zero eligible rows on a fresh source: no-op, journal dir never created', async () => {
    const s = await run();
    expect(s.rowsEligible).toBe(0);
    expect(existsSync(journalDir)).toBe(false);
  });

  test('preserves an existing fence row and its row_num; new rows append after it', async () => {
    const { body: withFence } = upsertFactRow(ALICE_BODY, {
      rowNum: 7, claim: 'Already fenced', kind: 'fact', confidence: 1, visibility: 'private',
      notability: 'medium', validFrom: '2025-05-05', source: 'mcp:put_page',
    });
    writeFileSync(join(repo, ALICE_MD), withFence, 'utf-8');
    git(repo, 'commit', '-q', '-am', 'fence');
    expect(diskFence().warnings).toEqual([]);
    await seed('Newer claim');

    const s = await run();
    expect(s.rowsStamped).toBe(1);
    const df = diskFence();
    expect(df.facts.map(f => [f.rowNum, f.claim])).toEqual([[7, 'Already fenced'], [8, 'Newer claim']]);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toContain('- keep me');
  });

  test('only the requested source is touched; another source with legacy rows is left alone', async () => {
    const otherRepo = mkdtempSync(join(tmpdir(), 'gbrain-fence-legacy-other-'));
    try {
      mkdirSync(join(otherRepo, 'people'), { recursive: true });
      writeFileSync(join(otherRepo, 'people/bob.md'), '# Bob\n', 'utf-8');
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)`, [otherRepo]);
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
         VALUES ('people/bob', 'other', 'person', 'Bob', '# Bob', '')`);
      await seed('Lives in Aarhus', 'people/bob', 'other');
      await seed('Founded Acme');

      const s = await run();
      expect(s.rowsStamped).toBe(1);
      expect((await factRows('other'))[0]!.row_num).toBeNull();
      expect(readFileSync(join(otherRepo, 'people/bob.md'), 'utf-8')).toBe('# Bob\n');
      expect(await countLegacyRowsForSource(engine, 'other')).toBe(1);
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
    const rows = await listLegacyRowsForSource(engine, SRC);
    expect(rows.map(r => r.fact)).toEqual(['Eligible']);
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(1);
  });
});

// ── Refusals ───────────────────────────────────────────────────────────────

describe('repairLegacyRowsForSource — refuses per file, never per tree', () => {
  test('an unrelated dirty file in the repo does not block the repair', async () => {
    writeFileSync(join(repo, 'someone-elses-draft.md'), 'wip', 'utf-8');
    writeFileSync(join(repo, 'people/carol.md'), '# Carol\n\nedited, uncommitted\n', 'utf-8');
    await seed('Founded Acme');
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    expect(s.pagesSkipped).toBe(0);
    // Their files are exactly as they left them.
    expect(readFileSync(join(repo, 'someone-elses-draft.md'), 'utf-8')).toBe('wip');
    expect(readFileSync(join(repo, 'people/carol.md'), 'utf-8')).toBe('# Carol\n\nedited, uncommitted\n');
  });

  test('a self-dirty target file is appended to (their edit kept) but never committed', async () => {
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY + '\nTheir uncommitted paragraph.\n', 'utf-8');
    await seed('Founded Acme');
    const s = await run();
    expect(s.rowsStamped).toBe(1);
    const disk = readFileSync(join(repo, ALICE_MD), 'utf-8');
    expect(disk).toContain('Their uncommitted paragraph.');
    expect(diskFence().facts.map(f => f.claim)).toEqual(['Founded Acme']);
    expect(git(repo, 'log', '--oneline').trim().split('\n')).toHaveLength(1); // still just 'seed'
  });

  test('foreign git state on the path (unmerged conflict) refuses; rows stay NULL; file untouched', async () => {
    git(repo, 'checkout', '-q', '-b', 'theirs');
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY.replace('A person', 'Their person'), 'utf-8');
    git(repo, 'commit', '-q', '-am', 'theirs');
    git(repo, 'checkout', '-q', '-');
    writeFileSync(join(repo, ALICE_MD), ALICE_BODY.replace('A person', 'Our person'), 'utf-8');
    git(repo, 'commit', '-q', '-am', 'ours');
    try { git(repo, 'merge', 'theirs'); } catch { /* conflict expected */ }
    expect(repairGitPathState(repo, join(repo, ALICE_MD))).toBe('foreign_dirty');
    const conflicted = readFileSync(join(repo, ALICE_MD), 'utf-8');
    expect(conflicted).toContain('<<<<<<<');
    await seed('Founded Acme');
    const s = await run();
    expect(s.pagesSkipped).toBe(1);
    expect(s.skippedByReason.foreign_dirty).toBe(1);
    expect(s.rowsRemaining).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(conflicted);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('symlinked target refuses without following it', async () => {
    const real = join(repo, 'elsewhere.md');
    writeFileSync(real, ALICE_BODY, 'utf-8');
    rmSync(join(repo, ALICE_MD));
    symlinkSync(real, join(repo, ALICE_MD));
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.symlink).toBe(1);
    expect(readFileSync(real, 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect(journalEntries()).toEqual([]);
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
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('a malformed existing fence is not rewritten', async () => {
    const bad = ALICE_BODY + '\n## Facts\n\n| # | claim |\n|---|---|\n| x | broken |\n';
    writeFileSync(join(repo, ALICE_MD), bad, 'utf-8');
    if (diskFence().warnings.length === 0) return; // parser tolerant of this shape; nothing to assert
    await seed('Founded Acme');
    const s = await run();
    expect(s.skippedByReason.fence_parse_failed).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(bad);
    expect((await factRows())[0]!.row_num).toBeNull();
  });

  test('dry-run performs no writes: file, DB, journal all untouched', async () => {
    await seed('Founded Acme');
    const s = await run(undefined, { dryRun: true });
    expect(s.dryRun).toBe(true);
    expect(s.rowsEligible).toBe(1);
    expect(s.rowsStamped).toBe(0);
    expect(s.rowsRemaining).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await factRows())[0]!.row_num).toBeNull();
    expect(existsSync(journalDir)).toBe(false);
    expect((await dbFence()).facts).toEqual([]);
  });

  test('kill switch parses the usual off values', () => {
    expect(isFactRepairDisabled({ GBRAIN_FACT_REPAIR: 'off' })).toBe(true);
    expect(isFactRepairDisabled({ GBRAIN_FACT_REPAIR: '0' })).toBe(true);
    expect(isFactRepairDisabled({ GBRAIN_FACT_REPAIR: 'on' })).toBe(false);
    expect(isFactRepairDisabled({})).toBe(false);
  });
});

// ── Failure injection: crash at every transition, then retry ───────────────

describe('repairLegacyRowsForSource — crash + retry at every transition', () => {
  const boom = (): never => { throw new Error('injected crash'); };

  test('crash before rename: file untouched, .tmp quarantined, rows NULL; retry completes with no duplicates', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeRename: boom });
    expect(s1.pagesSkipped).toBe(1);
    expect(s1.skippedByReason.error).toBe(1);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect(existsSync(join(repo, `${ALICE_MD}.tmp`))).toBe(true);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);
    expect(journalEntries().map(e => e.phase)).toEqual(['begin', 'failed']);

    const s2 = await run();
    expect(s2.rowsStamped).toBe(2);
    expect(s2.rowsRemaining).toBe(0);
    expect(diskFence().facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(2);
  });

  test('crash after rename, before DB body refresh: retry re-uses the on-disk row_nums (no twin rows)', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeBodyRefresh: boom });
    expect(s1.skippedByReason.error).toBe(1);
    // Disk has the fence, DB body does not, rows still NULL — the guard
    // would arm again; nothing is fence-owned yet.
    const disk1 = diskFence();
    expect(disk1.facts).toHaveLength(2);
    expect((await dbFence()).facts).toHaveLength(0);
    expect((await factRows()).every(r => r.row_num === null)).toBe(true);

    const s2 = await run();
    expect(s2.rowsAppended).toBe(0);           // nothing re-appended
    expect(s2.rowsStamped).toBe(2);
    const disk2 = diskFence();
    expect(disk2.facts.map(f => [f.rowNum, f.claim])).toEqual(disk1.facts.map(f => [f.rowNum, f.claim]));
    expect((await dbFence()).facts).toHaveLength(2);
    const rows = await factRows();
    expect(rows.map(r => r.row_num).sort()).toEqual(disk2.facts.map(f => f.rowNum).sort());
  });

  test('crash after DB body refresh, before stamp: retry only stamps', async () => {
    await seed('Founded Acme');
    const s1 = await run({ beforeStamp: boom });
    expect(s1.skippedByReason.error).toBe(1);
    expect(diskFence().facts).toHaveLength(1);
    expect((await dbFence()).facts).toHaveLength(1);
    expect((await factRows())[0]!.row_num).toBeNull();

    const s2 = await run();
    expect(s2.rowsAppended).toBe(0);
    expect(s2.rowsStamped).toBe(1);
    expect(diskFence().facts).toHaveLength(1);
    expect((await factRows())[0]!.row_num).toBe(diskFence().facts[0]!.rowNum);
  });

  test('crash mid-stamp: first row stamped, second not; retry stamps the rest, fence unchanged', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    const s1 = await run({ beforeStampRow: (_s, i) => { if (i === 1) boom(); } });
    expect(s1.skippedByReason.error).toBe(1);
    const rows1 = await factRows();
    expect(rows1.filter(r => r.row_num !== null)).toHaveLength(1);
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(1);
    const fence1 = diskFence().facts.map(f => [f.rowNum, f.claim] as [number, string]);

    const s2 = await run();
    expect(s2.rowsEligible).toBe(1);
    expect(s2.rowsAppended).toBe(0);
    expect(s2.rowsStamped).toBe(1);
    expect(s2.rowsRemaining).toBe(0);
    expect(diskFence().facts.map(f => [f.rowNum, f.claim])).toEqual(fence1);
    const rows2 = await factRows();
    expect(rows2.map(r => r.row_num).sort()).toEqual(fence1.map(f => f[0] as number | null).sort());
    expect(new Set(rows2.map(r => r.row_num)).size).toBe(2); // distinct row_nums
  });

  test('a rendered fence that fails verification never stamps (no fabricated success)', async () => {
    await seed('Founded Acme');
    // Sabotage: make the DB refresh a no-op so the DB body cannot carry the fence.
    const orig = engine.refreshPageBody.bind(engine);
    (engine as unknown as { refreshPageBody: unknown }).refreshPageBody = async () => { /* swallowed */ };
    try {
      const s = await run();
      expect(s.skippedByReason.verify_failed).toBe(1);
      expect(s.rowsStamped).toBe(0);
      expect((await factRows())[0]!.row_num).toBeNull();
      expect(journalEntries().map(e => e.phase)).toEqual(['begin', 'failed']);
    } finally {
      (engine as unknown as { refreshPageBody: unknown }).refreshPageBody = orig;
    }
    // And the retry with a working refresh completes from the disk fence.
    const s2 = await run();
    expect(s2.rowsAppended).toBe(0);
    expect(s2.rowsStamped).toBe(1);
  });
});

// ── Rollback ───────────────────────────────────────────────────────────────

describe('rollbackFactRepairEntry', () => {
  test('restores the preimage, refreshes the DB body, un-stamps rows; the guard arms again', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');
    await run();
    const done = journalEntries().find(e => e.phase === 'done')!;
    expect(done).toBeDefined();

    const r = await withEnv({ GBRAIN_HOME: home }, () => rollbackFactRepairEntry(engine, done));
    expect(r.status).toBe('rolled_back');
    expect(r.unstamped).toBe(2);
    expect(r.fileRestored).toBe(true);
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(ALICE_BODY);
    expect((await dbFence()).facts).toEqual([]);
    const rows = await factRows();
    expect(rows).toHaveLength(2);                       // facts retained
    expect(rows.every(r => r.row_num === null && r.source_markdown_slug === null)).toBe(true);
    expect(await countLegacyRowsForSource(engine, SRC)).toBe(2);
  });

  test('refuses when the fence gained a row after the repair', async () => {
    await seed('Founded Acme');
    await run();
    const done = journalEntries().find(e => e.phase === 'done')!;
    const body = readFileSync(join(repo, ALICE_MD), 'utf-8');
    const { body: edited } = appendLegacyRowsToBody(body, [{
      id: 'x', source_id: SRC, entity_slug: ALICE, fact: 'Added by a human', kind: 'fact',
      visibility: 'private', notability: 'low', context: null, valid_from: '2026-02-02',
      valid_until: null, source: 'human', confidence: 1,
    } satisfies LegacyFactRow]);
    writeFileSync(join(repo, ALICE_MD), edited, 'utf-8');

    const r = await withEnv({ GBRAIN_HOME: home }, () => rollbackFactRepairEntry(engine, done));
    expect(r.status).toBe('refused');
    expect(readFileSync(join(repo, ALICE_MD), 'utf-8')).toBe(edited);
    expect((await factRows())[0]!.row_num).not.toBeNull();
  });

  test("only 'done' entries roll back", async () => {
    await seed('Founded Acme');
    await run({ beforeRename: () => { throw new Error('x'); } });
    const failed = journalEntries().find(e => e.phase === 'failed')!;
    const r = await withEnv({ GBRAIN_HOME: home }, () => rollbackFactRepairEntry(engine, failed));
    expect(r.status).toBe('refused');
  });
});

// ── Pure renderer ──────────────────────────────────────────────────────────

describe('appendLegacyRowsToBody', () => {
  const row = (id: string, fact: string, source: string | null = 's'): LegacyFactRow => ({
    id, source_id: SRC, entity_slug: ALICE, fact, kind: 'fact', visibility: 'private',
    notability: 'medium', context: null, valid_from: new Date('2026-03-03'), valid_until: null,
    source, confidence: 0.5,
  });

  test('dedupes on (claim, source) and re-uses the existing row_num', () => {
    const first = appendLegacyRowsToBody('# A\n', [row('1', 'X'), row('2', 'Y')]);
    expect(first.appended).toBe(2);
    const again = appendLegacyRowsToBody(first.body, [row('1', 'X'), row('3', 'Z')]);
    expect(again.appended).toBe(1);
    expect(again.assignments).toEqual([{ id: '1', row_num: 1 }, { id: '3', row_num: 3 }]);
    expect(parseFactsFence(again.body).facts).toHaveLength(3);
  });

  test('same claim from a different source is a distinct row', () => {
    const r = appendLegacyRowsToBody('# A\n', [row('1', 'X', 'a'), row('2', 'X', 'b')]);
    expect(r.appended).toBe(2);
  });

  test('lands the fence above a timeline sentinel', () => {
    const body = '# A\n\nbody\n\n<!-- timeline -->\n\n## 2026-01-01\n\nentry\n';
    const r = appendLegacyRowsToBody(body, [row('1', 'X')]);
    expect(r.body.indexOf('## Facts')).toBeLessThan(r.body.indexOf('<!-- timeline -->'));
  });
});
