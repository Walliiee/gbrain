/**
 * A halted extract_facts phase must surface as a DEAD phase, not a warning.
 *
 * 2026-09-13: the empty-fence guard (legacy v0.31 rows pending the v0.32.2
 * fence backfill) returned `status: 'warn'`. The cycle report said 'partial',
 * but the human report rendered the phase as `! extract_facts …`, and the
 * only dead-phase signal the nightly wrapper reads is a `✗` glyph — so fact
 * extraction sat halted on two sources behind a "cycled OK". This pins:
 *
 *   1. the guard returns `status: 'fail'` with `error.class === 'Halted'`
 *      (distinct from an errored phase, whose class comes from
 *      makeErrorFromException) and `details.halted === true`;
 *   2. the cycle-level status is not a success status;
 *   3. printHuman renders `✗ extract_facts` — the exact token the wrapper's
 *      `grep -F '✗' | awk` dead-phase detector keys on;
 *   4. the non-guard path is untouched (control).
 *
 * GBRAIN_HOME is isolated because the PGLite cycle path takes a file lock at
 * ~/.gbrain/cycle.lock (see cycle-last-full-cycle-at.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle, type CycleReport } from '../src/core/cycle.ts';
import { __testing as dreamTesting } from '../src/commands/dream.ts';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

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
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-xf-halt-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-xf-halt-home-'));
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(join(brainDir, 'people', 'alice.md'), '# Alice\n\nA person.\n');
  // A registered source WITH a local_path (the guard only counts rows the
  // v0.32.2 Phase B could fence, which requires one) and a LIVE page for
  // the legacy row's entity_slug (the #2484 live-page requirement).
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [brainDir],
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ('people/alice', 'wiki', 'person', 'Alice', '# Alice\n\nA person.', '')`,
  );
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

async function seedLegacyRow(): Promise<void> {
  // Pre-v0.32.2 shape: entity_slug set, row_num NULL (never fenced).
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ('wiki', 'people/alice', 'Founded Acme', 'fact', 'private', 'medium',
             now(), 'mcp:put_page', 1.0)`,
  );
}

function captureHuman(report: CycleReport): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    dreamTesting.printHuman(report);
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('extract_facts empty-fence guard → dead phase, not a warning', () => {
  test('guard halt is status=fail with error.class=Halted and a non-success cycle status', async () => {
    await seedLegacyRow();
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract_facts'] }));

    const xf = report.phases.find(p => p.phase === 'extract_facts');
    expect(xf).toBeDefined();
    expect(xf!.status).toBe('fail');
    expect(xf!.details.halted).toBe(true);
    expect(xf!.details.legacyRowsPending).toBe(1);
    expect(xf!.summary).toContain('halted');
    // Halted, not errored: nothing threw, the phase refused to run.
    expect(xf!.error).toBeDefined();
    expect(xf!.error!.class).toBe('Halted');
    expect(xf!.error!.code).toBe('FENCE_BACKFILL_PENDING');
    expect(xf!.error!.hint).toContain('apply-migrations --force-retry 0.32.2');
    // The drain advice names THIS source so the operator never has to
    // commit every repo clean at once (the --source scoping in v0_32_2).
    expect(xf!.error!.hint).toContain('--source wiki');
    expect(xf!.error!.message).toContain('"wiki"');

    // The run-level status must not read as success.
    expect(['ok', 'clean']).not.toContain(report.status);

    // The legacy row is untouched — the guard reports, it does not drain.
    const rows = await engine.executeRaw<{ row_num: number | null }>(
      `SELECT row_num FROM facts WHERE source_id = 'wiki'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].row_num).toBeNull();
  });

  test('printHuman renders the halted phase as `✗ extract_facts` (the nightly wrapper contract)', async () => {
    await seedLegacyRow();
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract_facts'] }));

    const lines = captureHuman(report);
    // Same shape ~/.gbrain/dream-all.sh's dead-phase detector parses:
    //   grep -F '✗' | awk '{for(i=1;i<=NF;i++) if($i=="✗"){print $(i+1)}}'
    const dead = lines
      .filter(l => l.includes('✗'))
      .map(l => { const t = l.trim().split(/\s+/); return t[t.indexOf('✗') + 1]; });
    expect(dead).toContain('extract_facts');
    expect(lines.some(l => /^\s*!\s+extract_facts/.test(l))).toBe(false);
    // The halt is named as such on the error line, so a reader can tell it
    // from a phase that ran and crashed.
    expect(lines.some(l => l.includes('[Halted/FENCE_BACKFILL_PENDING]'))).toBe(true);
  });

  test('control: with no legacy rows the phase is ok and carries no error', async () => {
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir, sourceId: 'wiki', phases: ['extract_facts'] }));
    const xf = report.phases.find(p => p.phase === 'extract_facts');
    expect(xf!.status).toBe('ok');
    expect(xf!.error).toBeUndefined();
    expect(xf!.details.halted).toBeUndefined();
    expect(captureHuman(report).some(l => l.includes('✗'))).toBe(false);
  });
});
