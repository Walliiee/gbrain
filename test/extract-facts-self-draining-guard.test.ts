/**
 * extract_facts self-draining guard (2026-09-13).
 *
 * The empty-fence guard still arms on legacy rows; the phase now heals the
 * rows it armed on and reconciles in the same run. When a page cannot be
 * repaired safely the halt is exactly the 2026-09-13 `Halted /
 * FENCE_BACKFILL_PENDING` shape, with the refusal named.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runCycle } from '../src/core/cycle.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;
let home: string;

const SRC = 'wiki';
const ALICE_BODY = '---\ntype: person\ntitle: Alice\n---\n\n# Alice\n\nA person.\n';

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
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-xf-drain-'));
  home = mkdtempSync(join(tmpdir(), 'gbrain-xf-drain-home-'));
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(join(brainDir, 'people/alice.md'), ALICE_BODY, 'utf-8');
  // The stamp mode refuses files without a committed preimage: a git repo
  // with the page committed is the real shape of every live source.
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false'); git('add', '-A'); git('commit', '-q', '-m', 'seed');
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [SRC, brainDir],
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ('people/alice', $1, 'person', 'Alice', '# Alice\n\nA person.', '')`,
    [SRC],
  );
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync('git', ['-C', brainDir, ...args], { encoding: 'utf-8' });
}

async function seed(fact: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ($1, 'people/alice', $2, 'fact', 'private', 'medium', '2026-01-02', 'mcp:put_page', 1.0)`,
    [SRC, fact],
  );
}

async function activeRows() {
  return engine.executeRaw<{ fact: string; row_num: number | null; source_markdown_slug: string | null }>(
    `SELECT fact, row_num, source_markdown_slug FROM facts
      WHERE source_id = $1 AND expired_at IS NULL ORDER BY fact`,
    [SRC],
  );
}

describe('runExtractFacts — the guard heals what it arms on', () => {
  test('legacy rows are fenced, stamped, and reconciled in one run; no fact is lost', async () => {
    await seed('Founded Acme');
    await seed('Prefers async');

    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir }));

    expect(r.guardTriggered).toBe(false);
    expect(r.legacyRowsPending).toBe(0);
    expect(r.legacyRowsRepaired).toBe(2);
    expect(r.legacyRepair?.pagesFenced).toBe(1);
    expect(r.legacyRepair?.pagesSkipped).toBe(0);
    // The reconcile actually ran after the repair.
    expect(r.pagesScanned).toBeGreaterThan(0);

    // Both facts are still in the DB, fence-owned, and mirror the file.
    const rows = await activeRows();
    expect(rows.map(x => x.fact)).toEqual(['Founded Acme', 'Prefers async']);
    expect(rows.every(x => x.row_num !== null && x.source_markdown_slug === 'people/alice')).toBe(true);
    const disk = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(disk.facts.map(f => f.claim).sort()).toEqual(['Founded Acme', 'Prefers async']);
    expect(rows.map(x => x.row_num).sort()).toEqual(disk.facts.map(f => f.rowNum).sort());

    // A second run: guard does not arm, nothing to repair, reconcile is a no-op.
    const r2 = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir }));
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRowsRepaired).toBe(0);
    expect(r2.legacyRepair).toBeUndefined();
    expect(r2.factsDeleted).toBe(0);
    expect((await activeRows()).map(x => x.fact)).toEqual(['Founded Acme', 'Prefers async']);
  });

  test('a page the repair must refuse (symlink) still halts, with the refusal named and the row retained', async () => {
    const real = join(brainDir, 'elsewhere.md');
    writeFileSync(real, ALICE_BODY, 'utf-8');
    rmSync(join(brainDir, 'people/alice.md'));
    symlinkSync(real, join(brainDir, 'people/alice.md'));
    await seed('Founded Acme');

    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir }));

    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.legacyRowsRepaired).toBe(0);
    expect(r.legacyRepair?.skippedByReason.symlink).toBe(1);
    expect(r.warnings.some(w => w.includes('symlink=1') && w.includes('people/alice'))).toBe(true);
    expect(r.warnings.some(w => w.includes('pending fence backfill'))).toBe(true);
    expect(readFileSync(real, 'utf-8')).toBe(ALICE_BODY);
    expect((await activeRows())[0]!.row_num).toBeNull();
  });

  test('GBRAIN_FACT_REPAIR=off restores the pure halt: nothing written', async () => {
    await seed('Founded Acme');
    const r = await withEnv({ GBRAIN_HOME: home, GBRAIN_FACT_REPAIR: 'off' }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir }));
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRepair).toBeUndefined();
    expect(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8')).toBe(ALICE_BODY);
    expect((await activeRows())[0]!.row_num).toBeNull();
  });

  test('dry-run never repairs: guard reports, file/DB untouched', async () => {
    await seed('Founded Acme');
    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir, dryRun: true }));
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRepair).toBeUndefined();
    expect(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8')).toBe(ALICE_BODY);
    expect((await activeRows())[0]!.row_num).toBeNull();
  });

  test('no brainDir (no disk access) → no repair, halt as before', async () => {
    await seed('Founded Acme');
    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC }));
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRepair).toBeUndefined();
    expect(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8')).toBe(ALICE_BODY);
  });

  test('repairLegacy: false opts out explicitly even with disk access', async () => {
    await seed('Founded Acme');
    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir, repairLegacy: false }));
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRepair).toBeUndefined();
  });

  test('a crash inside the repair leaves the guard armed and loud, never a fabricated success', async () => {
    await seed('Founded Acme');
    const r = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, {
        sourceId: SRC, brainDir,
        repairHooks: { beforeStamp: () => { throw new Error('injected'); } },
      }));
    expect(r.guardTriggered).toBe(true);
    expect(r.legacyRowsPending).toBe(1);
    expect(r.legacyRepair?.skippedByReason.error).toBe(1);
    // The disk + DB body already carry the fence; the row is NOT fence-owned
    // yet, so the reconcile did not run and could not have deleted it.
    expect((await activeRows())[0]!.row_num).toBeNull();
    expect(r.factsDeleted).toBe(0);

    // The file now carries our uncommitted fence: refused, named, until it is
    // committed (the owner's morning commit); then the next run finishes.
    const r1b = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir }));
    expect(r1b.guardTriggered).toBe(true);
    expect(r1b.legacyRepair?.skippedByReason.file_uncommitted).toBe(1);
    git('commit', '-q', '-am', 'morning commit');
    const r2 = await withEnv({ GBRAIN_HOME: home }, () =>
      runExtractFacts(engine, { sourceId: SRC, brainDir }));
    expect(r2.guardTriggered).toBe(false);
    expect(r2.legacyRowsRepaired).toBe(1);
    expect((await activeRows()).map(x => x.fact)).toEqual(['Founded Acme']);
  });
});

describe('runCycle — extract_facts phase surfaces the repair', () => {
  test('repairable backlog: phase ok, summary names the fenced count, details carry the repair summary', async () => {
    await seed('Founded Acme');
    const report = await withEnv({ GBRAIN_HOME: home }, () =>
      runCycle(engine, { brainDir, sourceId: SRC, phases: ['extract_facts'] }));
    const xf = report.phases.find(p => p.phase === 'extract_facts')!;
    expect(xf.status).toBe('ok');
    expect(xf.error).toBeUndefined();
    expect(xf.summary).toContain('1 legacy fact(s) fenced in place');
    expect(xf.details.legacy_rows_repaired).toBe(1);
    expect((xf.details.legacy_repair as { pagesFenced: number }).pagesFenced).toBe(1);
  });

  test('unrepairable backlog: still the Halted/FENCE_BACKFILL_PENDING dead phase, with the refusal in the summary', async () => {
    rmSync(join(brainDir, 'people/alice.md')); // live page, no file → file_missing
    await seed('Founded Acme');
    const report = await withEnv({ GBRAIN_HOME: home }, () =>
      runCycle(engine, { brainDir, sourceId: SRC, phases: ['extract_facts'] }));
    const xf = report.phases.find(p => p.phase === 'extract_facts')!;
    expect(xf.status).toBe('fail');
    expect(xf.error?.class).toBe('Halted');
    expect(xf.error?.code).toBe('FENCE_BACKFILL_PENDING');
    expect(xf.summary).toContain('1 page(s) refused');
    expect(xf.details.legacy_rows_repaired).toBe(0);
    expect((xf.details.legacy_repair as { skippedByReason: Record<string, number> }).skippedByReason.file_missing).toBe(1);
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false); // no stub minted
  });
});
