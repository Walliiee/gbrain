/** Stronger fail-closed contract for the twelve independently reproduced repair defects.
 * Original /private/tmp probes and earlier acceptance assertions are unchanged.
 * All fixtures are isolated PGLite + temporary Git repositories; no providers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { repairLegacyRowsForSource, type LegacyStampHooks } from '../src/core/facts/fence-legacy.ts';
import { healResidueOnlyPage } from '../src/core/facts/fence-write.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import type { CapabilityReport } from '../src/core/capability.ts';

const SOURCE = 'repair-fixture';
const SLUG = 'people/example-person';
const ORIGINAL = '---\ntype: person\ntitle: Example\n---\n\n# Example\n\nKeep every byte.\n';
let engine: PGLiteEngine;
let root: string;
let repo: string;
let home: string;
let file: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const isolated = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const repair = (hooks?: LegacyStampHooks) => isolated(() => repairLegacyRowsForSource(engine, { sourceId: SOURCE, hooks }));
const extract = (options = {}) => isolated(() => runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG], ...options }));

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'facts-repair-safety-'));
  repo = join(root, 'repo'); home = join(root, 'home'); file = join(repo, `${SLUG}.md`);
  mkdirSync(join(repo, 'people'), { recursive: true });
  writeFileSync(file, ORIGINAL);
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'fixture');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, repo]);
  await page(SLUG, ORIGINAL);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function page(slug: string, body: string) {
  const parsed = parseMarkdown(body, `${slug}.md`);
  await engine.executeRaw(`INSERT INTO pages(slug,source_id,type,title,compiled_truth,timeline)
    VALUES($1,$2,'person','Example',$3,$4)`, [slug, SOURCE, parsed.compiled_truth, parsed.timeline]);
}
async function sync(slug = SLUG, path = file) {
  const parsed = parseMarkdown(readFileSync(path, 'utf8'), `${slug}.md`);
  await engine.refreshPageBody(slug, SOURCE, parsed.compiled_truth, parsed.timeline, 'fixture-sync');
}
async function seed(claim = 'Keep this fact', slug = SLUG) {
  const rows = await engine.executeRaw<{ id: string }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,confidence)
    VALUES($1,$2,$3,'fact','private','medium','2026-01-02T00:00:00Z','api:fixture',0.9) RETURNING id::text`, [SOURCE, slug, claim]);
  return rows[0]!.id;
}
async function rows() {
  return engine.executeRaw<{ snapshot: string }>('SELECT to_jsonb(f)::text AS snapshot FROM facts f WHERE source_id=$1 ORDER BY id', [SOURCE]);
}
async function onlyExpired(id: string) {
  const facts = await engine.executeRaw<{ id: string; row_num: number | null; expired: boolean }>(
    'SELECT id::text, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1', [SOURCE]);
  expect(facts).toEqual([{ id, row_num: null, expired: true }]);
}
function fence(body = ORIGINAL, claim = 'Keep this fact', rowNum = 1) {
  return upsertFactRow(body, { rowNum, claim, kind: 'fact', confidence: 0.9, visibility: 'private', notability: 'medium', validFrom: '2026-01-02', source: 'api:fixture' }).body;
}
async function crashAndForget(slug = SLUG, path = file) {
  const id = await seed('Keep this fact', slug);
  const failed = await repair({ beforeCommit: () => { throw new Error('crash after append'); } });
  expect(failed.rowsStamped).toBe(0);
  expect(parseFactsFence(readFileSync(path, 'utf8')).facts).toHaveLength(1);
  await forgetFactInFence(engine, Number(id));
  await sync(slug, path);
  return id;
}

test('useful safe path: append all legacy facts, preserve inode/mode/prose and IDs, then no-op', async () => {
  const one = await seed(); const two = await seed('Second fact');
  const before = statSync(file);
  const head = git('rev-parse', 'HEAD');
  const result = await repair();
  expect(result).toMatchObject({ rowsStamped: 2, rowsAppended: 2, rowsRemaining: 0 });
  expect(readFileSync(file).subarray(0, Buffer.byteLength(ORIGINAL))).toEqual(Buffer.from(ORIGINAL));
  expect(statSync(file).ino).toBe(before.ino);
  expect(statSync(file).mode).toBe(before.mode);
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect((await engine.executeRaw<{ id: string; row_num: number }>('SELECT id::text,row_num FROM facts WHERE source_id=$1 ORDER BY id', [SOURCE])))
    .toEqual([{ id: one, row_num: 1 }, { id: two, row_num: 2 }]);
  expect((await extract()).factsDeleted).toBe(0);
  expect((await repair()).rowsStamped).toBe(0);
});

test('reuse a complete committed fence; append a later row in a second canonical fence without rewriting prior bytes', async () => {
  const id = await seed();
  writeFileSync(file, fence()); git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'reviewed fence'); await sync();
  expect(await repair()).toMatchObject({ rowsStamped: 1, rowsAppended: 0 });
  const later = await seed('New legacy fact');
  const bytes = readFileSync(file);
  expect(await repair()).toMatchObject({ rowsStamped: 1, rowsAppended: 1, skippedByReason: {} });
  expect(readFileSync(file).subarray(0, bytes.length)).toEqual(bytes);
  expect(parseFactsFence(readFileSync(file, 'utf8')).facts.map(f => f.claim)).toEqual(['Keep this fact', 'New legacy fact']);
  expect((await extract()).guardTriggered).toBe(false);
  const ids = (await rows()).map(r => JSON.parse(r.snapshot).id);
  expect(ids).toEqual([Number(id), Number(later)]);
});

test('A/FILTER: raw committed blob comparison rejects a clean-filter/assume-unchanged disguise', async () => {
  const filter = join(repo, '.git', 'filter.py');
  writeFileSync(filter, 'import sys\nsys.stdout.write(sys.stdin.read().split("\\n## Facts")[0].rstrip()+"\\n")\n');
  git('config', 'filter.nofacts.clean', `python3 ${filter}`);
  writeFileSync(join(repo, '.gitattributes'), '*.md filter=nofacts\n');
  git('add', '--', '.gitattributes'); git('commit', '-qm', 'fixture filter');
  const id = await seed(); await forgetFactInFence(engine, Number(id));
  writeFileSync(file, fence()); await sync(); git('update-index', '--assume-unchanged', `${SLUG}.md`);
  expect(git('status', '--porcelain=v1', '--', `${SLUG}.md`)).toBe('');
  expect(git('hash-object', '--', `${SLUG}.md`).trim()).toBe(git('rev-parse', `HEAD:${SLUG}.md`).trim());
  const before = readFileSync(file);
  const r = await extract(); expect(r.factsInserted).toBe(0); expect(r.legacyRepair?.residuePagesBlocked).toHaveLength(1);
  expect(readFileSync(file)).toEqual(before); await onlyExpired(id);
});

test('A/COMMIT: a successful append never commits another writer\'s later draft', async () => {
  const hook = join(repo, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n'); chmodSync(hook, 0o755);
  await seed(); const head = git('rev-parse', 'HEAD');
  const r = await repair({ afterCommit: () => { writeFileSync(file, readFileSync(file, 'utf8') + '\nHuman draft.\n'); } });
  expect(r.rowsStamped).toBe(1); expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(git('show', `HEAD:${SLUG}.md`)).toBe(ORIGINAL);
  expect(readFileSync(file, 'utf8')).toContain('Human draft.'); expect(git('status', '--porcelain=v1')).not.toBe('');
});

test('A/BYTES: non-UTF8 unrelated prose is refused without any row or byte mutation', async () => {
  const bytes = Buffer.concat([Buffer.from(ORIGINAL), Buffer.from([255, 10])]);
  writeFileSync(file, bytes); git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'binary prose fixture'); await sync();
  await seed(); const before = await rows();
  const r = await repair(); expect(r.rowsStamped).toBe(0); expect(r.pagesSkipped).toBe(1);
  expect(readFileSync(file)).toEqual(bytes); expect(await rows()).toEqual(before);
});

test('A/OWNERSHIP: no prior repair, matching human draft, no automatic deletion or resurrection', async () => {
  const id = await seed(); await forgetFactInFence(engine, Number(id));
  const draft = fence(); writeFileSync(file, draft); await sync();
  const inspection = await isolated(() => healResidueOnlyPage(engine, { sourceId: SOURCE, slug: SLUG }));
  expect(inspection.outcome).toBe('not_residue');
  expect((await extract()).factsInserted).toBe(0); expect(readFileSync(file, 'utf8')).toBe(draft); await onlyExpired(id);
});

test('A/SYMLINK: swap parent at beforeRename; no outside mutation and no stamp', async () => {
  await seed(); const before = await rows();
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'example-person.md'), ORIGINAL);
  const r = await repair({ beforeRename: () => { renameSync(join(repo, 'people'), join(repo, 'old-people')); symlinkSync(outside, join(repo, 'people')); } });
  expect(r.rowsStamped).toBe(0); expect(await rows()).toEqual(before);
  expect(readFileSync(join(outside, 'example-person.md'), 'utf8')).toBe(ORIGINAL);
  expect(readFileSync(join(repo, 'old-people', 'example-person.md'), 'utf8')).toBe(ORIGINAL);
});

for (const mode of ['missing', 'symlink', 'write-through-off', 'no-local-path', 'repair-optout', 'repair-off'] as const) {
  test(`B: actual crash + forget + ${mode} preserves tombstone and refuses resurrection`, async () => {
    const id = await crashAndForget();
    const bytes = readFileSync(file);
    if (mode === 'missing') rmSync(file);
    if (mode === 'symlink') { renameSync(file, file + '.retained'); symlinkSync(file + '.retained', file); }
    if (mode === 'write-through-off') await engine.setConfig('sync.write_through', 'off');
    if (mode === 'no-local-path') await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [SOURCE]);
    const r = mode === 'repair-off' ? await withEnv({ GBRAIN_FACT_REPAIR: 'off' }, () => extract())
      : await extract(mode === 'repair-optout' ? { repairLegacy: false } : {});
    expect(r.factsInserted).toBe(0); expect(r.factsDeleted).toBe(0); expect(r.warnings.length).toBeGreaterThan(0);
    await onlyExpired(id);
    if (mode !== 'missing') expect(readFileSync(file)).toEqual(bytes);
  });
}

test('C: forget after eligibility, refused stamp, fresh residue discovery still blocks', async () => {
  const id = await seed(); let injected = false;
  const r = await extract({ repairHooks: { beforeStamp: async () => {
    injected = true; await forgetFactInFence(engine, Number(id)); writeFileSync(file, fence() + '\nHuman note.\n'); await sync();
  } } });
  expect(injected).toBe(true); expect(r.legacyRepair?.rowsRemaining).toBe(0);
  expect(r.legacyRepair?.residuePagesBlocked).toHaveLength(1); expect(r.factsInserted).toBe(0);
  expect(readFileSync(file, 'utf8')).toContain('Human note.'); await onlyExpired(id);
});

for (const destinationBlocked of [false, true]) {
  test(`D: phantom ${destinationBlocked ? 'destination' : 'origin'} block precedes all destination writes`, async () => {
    const phantom = 'example'; const phantomFile = join(repo, 'example.md'); const body = '# Example\n';
    writeFileSync(phantomFile, body); await page(phantom, body);
    git('add', '--', 'example.md'); git('commit', '-qm', 'phantom fixture');
    const id = await seed('Keep this fact', destinationBlocked ? SLUG : phantom);
    await forgetFactInFence(engine, Number(id));
    writeFileSync(phantomFile, fence(body)); await sync(phantom, phantomFile);
    const before = readFileSync(file); const dbBefore = await rows();
    const r = await extract({ brainDir: repo, slugs: [phantom, SLUG], repairLegacy: false });
    expect(r.phantomsRedirected).toBe(0); expect(r.factsInserted).toBe(0);
    expect(readFileSync(file)).toEqual(before); expect(await rows()).toEqual(dbBefore);
    // Direct caller must respect BOTH endpoints as well.
    const p = (await engine.getPage(phantom, { sourceId: SOURCE }))!;
    const direct = await isolated(() => tryRedirectPhantom(engine, p, SOURCE, repo, false));
    expect(direct.outcome).toBe('drift'); expect(readFileSync(file)).toEqual(before); expect(await rows()).toEqual(dbBefore);
  });
}

for (const column of ['source_session', 'event_type', 'dimension', 'value', 'value_hash', 'dim_status', 'consolidated_at', 'consolidated_into']) {
  test(`E: non-reconstructible ${column} refuses the entire conversion without metadata loss`, async () => {
    const id = await seed(); await seed('Second fact');
    const value = column === 'consolidated_at' ? '2026-01-02T00:00:00Z' : column === 'consolidated_into' ? '99' : 'fixture';
    await engine.executeRaw(`UPDATE facts SET ${column}=$1 WHERE id=$2`, [value, id]);
    const before = await rows(); const bytes = readFileSync(file);
    const r = await repair(); expect(r.rowsStamped).toBe(0); expect(r.skippedByReason.unexpressible_columns).toBe(1);
    expect((await extract()).guardTriggered).toBe(true); expect(await rows()).toEqual(before); expect(readFileSync(file)).toEqual(bytes);
  });
}

for (const assignment of ["confidence=0.987", "valid_from='2026-01-02T00:00:00.000001Z'", "valid_until='2026-01-02T12:00:00Z'"]) {
  test(`E: original precision retained, refuse ${assignment}`, async () => {
    const id = await seed(); await engine.executeRaw(`UPDATE facts SET ${assignment} WHERE id=$1`, [id]);
    const before = await rows(); expect((await repair()).rowsStamped).toBe(0);
    expect(await rows()).toEqual(before); expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });
}

test('E: metadata introduced after eligibility is revalidated under the transaction', async () => {
  const id = await seed(); let afterEdit: Awaited<ReturnType<typeof rows>>;
  const r = await repair({ beforeStamp: async () => {
    await engine.executeRaw('UPDATE facts SET source_session=$1 WHERE id=$2', ['later-session', id]); afterEdit = await rows();
  } });
  expect(r.rowsStamped).toBe(0); expect(r.skippedByReason.row_changed).toBe(1);
  expect(await rows()).toEqual(afterEdit!); expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
});

test('E: original created_at including microseconds survives unrelated fence reconciliation', async () => {
  const id = await seed(); await seed('Second fact');
  await engine.executeRaw("UPDATE facts SET created_at='2025-01-02T03:04:05.123456Z' WHERE id=$1", [id]);
  const original = await engine.executeRaw('SELECT created_at::text FROM facts WHERE id=$1', [id]);
  expect((await repair()).rowsStamped).toBe(2);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Second fact', 'Edited second fact')); await sync();
  expect((await extract()).factsInserted).toBe(2);
  expect(await engine.executeRaw('SELECT created_at::text FROM facts WHERE source_id=$1 AND fact=$2', [SOURCE, 'Keep this fact'])).toEqual(original);
});

for (const seam of ['beforeStamp', 'afterFirstStampUpdate'] as const) {
test(`rollback drain: disable at ${seam}, await in-flight repair, then every entry point refuses`, async () => {
  await seed(); const before = await rows();
  let reached!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pending = repair({ [seam]: async () => { reached(); await barrier; } });
  await ready;
  await withEnv({ GBRAIN_FACT_REPAIR: 'off' }, async () => {
    release(); const drained = await pending; expect(drained.rowsStamped).toBe(0);
    expect((await repair()).failure).toContain('disabled'); expect((await extract()).guardTriggered).toBe(true);
    expect(await rows()).toEqual(before); expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });
});
}

for (const reuse of [false, true]) {
  for (const outcome of ['landed', 'unknown', 'rolled_back'] as const) {
    test(`COMMIT acknowledgement: ${reuse ? 'reuse' : 'append'} / ${outcome} reports actual ownership without restoring bytes`, async () => {
      const id = await seed();
      if (reuse) {
        writeFileSync(file, fence()); git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'reviewed fence'); await sync();
      }
      let attempts = 0;
      const crash = () => { throw new Error('injected lost acknowledgement'); };
      const result = await repair({
        ...(outcome === 'rolled_back' ? { beforeCommit: crash } : { afterCommit: crash }),
        beforeVerifyLanded: () => { attempts++; if (outcome === 'unknown') throw new Error('verification unavailable'); },
      });
      expect(attempts).toBe(outcome === 'unknown' ? 3 : 1);
      const actual = await engine.executeRaw<{ row_num: number | null; source_markdown_slug: string | null }>(
        'SELECT row_num,source_markdown_slug FROM facts WHERE id=$1', [id]);
      expect(actual).toEqual([{ row_num: outcome === 'rolled_back' ? null : 1, source_markdown_slug: outcome === 'rolled_back' ? null : SLUG }]);
      expect(result.rowsStamped).toBe(outcome === 'landed' ? 1 : 0);
      if (outcome === 'unknown') expect(result.skippedDetails.join(' ')).toContain('commit outcome unknown');
      if (outcome === 'rolled_back') expect(result.skippedDetails.join(' ')).toContain('injected lost acknowledgement');
      expect(readFileSync(file, 'utf8')).toBe(fence());
      expect((await rows())).toHaveLength(1);
    });
  }
}

test('E/ROLLBACK: disabled and drained throughout unstamp -> interruption -> reviewed restore; later human edits survive', async () => {
  await seed(); expect((await repair()).rowsStamped).toBe(1);
  // Quiescence: the only fixture writer completed above. Real rollback must
  // stop every writer process, not just set an environment variable elsewhere.
  await withEnv({ GBRAIN_FACT_REPAIR: 'off' }, async () => {
    await engine.executeRaw('UPDATE facts SET row_num=NULL,source_markdown_slug=NULL WHERE source_id=$1', [SOURCE]);
    const afterUnstamp = await rows();
    expect((await repair()).rowsStamped).toBe(0); expect((await extract()).factsDeleted).toBe(0);
    expect(await rows()).toEqual(afterUnstamp);
    writeFileSync(file, readFileSync(file, 'utf8') + '\nLater human paragraph.\n');
    const human = readFileSync(file);
    expect((await extract()).guardTriggered).toBe(true); expect(readFileSync(file)).toEqual(human);
    // Operator-reviewed merge, not an automatic git checkout over later edits.
    writeFileSync(file, ORIGINAL + '\nLater human paragraph.\n'); await sync();
    expect((await extract()).factsDeleted).toBe(0); expect(await rows()).toEqual(afterUnstamp);
    expect(readFileSync(file, 'utf8')).toContain('Later human paragraph.');
  });
});

for (const off of [false, true]) {
  test(`F: sweep reports ${off ? 'disabled' : 'blocked'} reconciliation and preserves every byte`, async () => {
    const id = await crashAndForget(); const bytes = readFileSync(file); const messages: string[] = [];
    const sweep = () => isolated(() => runMaintenanceSweep(engine, { sourceId: SOURCE, log: line => messages.push(line),
      capabilities: { extraction: { available: false } } as CapabilityReport }));
    const r = off ? await withEnv({ GBRAIN_FACT_REPAIR: 'off' }, sweep) : await sweep();
    expect(r.factsReconciled).toBe(0); expect(r.skipped.some(s => s.reason === 'facts_fence_degraded')).toBe(true);
    expect(messages.some(s => s.includes(off ? 'FACTS_REPAIR_DISABLED' : 'FACTS_RESIDUE_UNRESOLVED'))).toBe(true);
    expect(readFileSync(file)).toEqual(bytes); await onlyExpired(id);
  });
}
