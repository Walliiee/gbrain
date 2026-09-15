/** Round 8 corrective contracts. Isolated engines/files; no providers.
 * The full later-arrival lifecycle is deliberately retained as a required
 * outcome even while the append-only repair cannot safely fulfil it. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { repairLegacyRowsForSource, type LegacyStampHooks } from '../src/core/facts/fence-legacy.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { __testing as migration } from '../src/commands/migrations/v0_32_2.ts';

const SOURCE = 'repair-fixture'; const SLUG = 'people/example-person';
const ORIGINAL = '---\ntype: person\ntitle: Example\n---\n\n# Example\n\nKeep every byte.\n';
let engine: PGLiteEngine; let root: string; let repo: string; let home: string; let file: string;
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const isolated = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const repair = (hooks?: LegacyStampHooks) => isolated(() => repairLegacyRowsForSource(engine, { sourceId: SOURCE, hooks }));
const extract = (o = {}) => isolated(() => runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG], ...o }));
const ctx = (remote: boolean) => ({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: SOURCE }) as unknown as OperationContext;
const op = (name: string) => operations.find(o => o.name === name)!;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'facts-repair-lifecycle-')); repo = join(root, 'repo'); home = join(root, 'home'); file = join(repo, `${SLUG}.md`);
  mkdirSync(join(repo, 'people'), { recursive: true }); writeFileSync(file, ORIGINAL);
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'fixture');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, repo]);
  await isolated(() => importFromContent(engine, SLUG, ORIGINAL, { sourceId: SOURCE, noEmbed: true }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function seed(claim = 'Keep this fact', visibility: 'private' | 'world' = 'private', slug = SLUG) {
  const r = await engine.executeRaw<{ id: string }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,confidence)
    VALUES($1,$2,$3,'fact',$4,'medium','2026-01-02T00:00:00Z','api:fixture',0.9) RETURNING id::text`, [SOURCE, slug, claim, visibility]);
  return r[0]!.id;
}
const rows = () => engine.executeRaw<{ id: string; row_num: number | null; expired: boolean; fact: string }>('SELECT id::text, row_num, expired_at IS NOT NULL AS expired, fact FROM facts WHERE source_id=$1 ORDER BY id', [SOURCE]);
async function sync(slug = SLUG, path = file) { const p = parseMarkdown(readFileSync(path, 'utf8'), `${slug}.md`); await engine.refreshPageBody(slug, SOURCE, p.compiled_truth, p.timeline, 'fixture-sync'); }
const chunkHits = (needle: string) => engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 AND cc.chunk_text LIKE $2`, [SOURCE, `%${needle}%`]);

// R7-1 — fails on 9e028dabc (put succeeds, factsDeleted 1)
for (const remote of [false, true]) test(`R7-1 queued get/put after row lock is a conflict, remote=${remote}: fact and fence survive, nothing overwritten`, async () => {
  const id = await seed('Keep this fact', 'world');
  await isolated(async () => {
    const fetched = await op('get_page').handler(ctx(remote), { slug: SLUG, include_content: true }) as { content: string; revision: string };
    expect(typeof fetched.revision).toBe('string');
    let pending!: Promise<unknown>;
    const r = await repairLegacyRowsForSource(engine, { sourceId: SOURCE, hooks: { afterRowLock: async () => {
      pending = op('put_page').handler(ctx(remote), { slug: SLUG, content: fetched.content + '\nHuman prose save.\n' }).catch(error => error);
      await new Promise(res => setTimeout(res, 50));
    } } });
    expect(r.rowsStamped).toBe(1);
    expect(await pending).toMatchObject({ code: 'conflict' });
    expect(readFileSync(file, 'utf8')).not.toContain('Human prose save.');
    expect(parseFactsFence(readFileSync(file, 'utf8')).facts).toHaveLength(1);
    const rec = await runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG] });
    expect(rec.factsDeleted).toBe(0);
    expect(await rows()).toMatchObject([{ id, row_num: 1, expired: false }]);
    // The caller re-reads and re-applies: the save lands with the fence intact.
    const again = await op('get_page').handler(ctx(remote), { slug: SLUG, include_content: true }) as { content: string; revision: string };
    const saved = await op('put_page').handler(ctx(remote), { slug: SLUG, content: again.content.replace('Keep every byte.', 'Keep every byte.\n\nHuman prose save.'), base_revision: again.revision }) as { status: string };
    expect(saved.status).toBe('created_or_updated');
    expect(readFileSync(file, 'utf8')).toContain('Human prose save.');
    expect((await runExtractFacts(engine, { sourceId: SOURCE, slugs: [SLUG] })).factsDeleted).toBe(0);
  });
});

test('R7-1 base_revision proves a deliberate drop: rows are deleted explicitly by put_page, never inferred later', async () => {
  await seed('Keep this fact', 'world'); expect((await repair()).rowsStamped).toBe(1);
  await isolated(async () => {
    const current = await op('get_page').handler(ctx(false), { slug: SLUG, include_content: true }) as { revision: string };
    const saved = await op('put_page').handler(ctx(false), { slug: SLUG, content: ORIGINAL + '\nDeliberate rewrite without facts.\n', base_revision: current.revision }) as { status: string };
    expect(saved).toMatchObject({ status: 'created_or_updated' });
    expect(await rows()).toHaveLength(0);
    const stale = op('put_page').handler(ctx(false), { slug: SLUG, content: ORIGINAL, base_revision: current.revision });
    await expect(stale).rejects.toMatchObject({ code: 'conflict' });
  });
});

test('R7-1 human replacement after the final verify: the reconcile refuses to delete never-published rows and says so', async () => {  // fails on 9e028dabc (factsDeleted 1)
  const id = await seed(); const original = engine.transaction.bind(engine); let replaced = false;
  engine.transaction = (async (fn: any) => original(async (tx: any) => { const out = await fn(tx); if (!replaced) { replaced = true; renameSync(file, file + '.old'); writeFileSync(file, ORIGINAL + '\nLate human edit.\n'); } return out; })) as typeof engine.transaction;
  let r; try { r = await repair(); } finally { engine.transaction = original; }
  expect(r.rowsStamped).toBe(1); await sync();
  const rec = await extract();
  expect(rec.factsDeleted).toBe(0);
  expect(rec.warnings.some(w => w.includes('FACTS_FENCE_UNPUBLISHED_CONFLICT'))).toBe(true);
  expect(await rows()).toMatchObject([{ id, row_num: 1, expired: false }]);
  expect(readFileSync(file, 'utf8')).toBe(ORIGINAL + '\nLate human edit.\n');
  // A forget is the explicit resolution: the expired row is then deletable as before.
  await forgetFactInFence(engine, Number(id));
  expect((await extract()).factsDeleted).toBe(1); expect(await rows()).toHaveLength(0);
});

test('R7-1 HEAD publication alone cannot prove a file edit read the repaired row', async () => {
  await seed(); expect((await repair()).rowsStamped).toBe(1);
  git('add', '--', `${SLUG}.md`); git('commit', '-qm', 'published');
  writeFileSync(file, ORIGINAL); await sync();
  const rec = await extract(); expect(rec.factsDeleted).toBe(0);
  expect(rec.warnings.some(w => w.includes('FACTS_FENCE_UNPUBLISHED_CONFLICT'))).toBe(true);
  expect(await rows()).toHaveLength(1);
});

// R7-2 — fails on 9e028dabc (factsInserted 1, ID 1 gone)
test('R7-2 phantom redirect vs a concurrent forget: expired original identity retained at the canonical, no active replacement', async () => {
  const phantom = 'example'; const ppath = join(repo, 'example.md'); writeFileSync(ppath, '# Example\n');
  await isolated(() => importFromContent(engine, phantom, '# Example\n', { sourceId: SOURCE, noEmbed: true }));
  git('add', '--', 'example.md'); git('commit', '-qm', 'phantom fixture');
  const id = await seed('Keep this fact', 'private', phantom); expect((await repair()).rowsStamped).toBe(1);
  const raw = engine.executeRaw; let forget: Promise<any> | undefined;
  engine.executeRaw = (async function (this: any, sql: string, args: any[]) {
    const out = await raw.call(this, sql, args);
    if (!forget && sql.includes('AND (entity_slug = $2 OR entity_slug = $3)')) forget = forgetFactInFence(engine, Number(id)); // races under the locks, never awaited inside
    return out;
  }) as typeof engine.executeRaw;
  let rec; try { rec = await isolated(() => runExtractFacts(engine, { sourceId: SOURCE, brainDir: repo, slugs: [phantom, SLUG] })); } finally { engine.executeRaw = raw; }
  const f = await forget!;
  expect(f).toMatchObject({ ok: true, path: 'fence' });          // re-routed to the canonical after the transfer
  expect(rec.phantomsRedirected).toBe(1);
  const final = await rows();
  expect(final).toHaveLength(1); expect(final[0]).toMatchObject({ id, expired: true }); // identity retained, no ID 2
  expect(parseFactsFence(readFileSync(file, 'utf8')).facts.map(x => x.active)).toEqual([false]);
  expect((await extract()).factsInserted).toBe(0);
});

test('R7-2 a forget that lands BEFORE the redirect travels as a struck row with its identity', async () => {
  const phantom = 'example'; writeFileSync(join(repo, 'example.md'), '# Example\n');
  await isolated(() => importFromContent(engine, phantom, '# Example\n', { sourceId: SOURCE, noEmbed: true }));
  git('add', '--', 'example.md'); git('commit', '-qm', 'phantom fixture');
  const id = await seed('Keep this fact', 'private', phantom); expect((await repair()).rowsStamped).toBe(1);
  expect(await forgetFactInFence(engine, Number(id))).toMatchObject({ ok: true, path: 'fence' });
  await sync(phantom, join(repo, 'example.md'));
  const rec = await isolated(() => runExtractFacts(engine, { sourceId: SOURCE, brainDir: repo, slugs: [phantom, SLUG] }));
  expect(rec.phantomsRedirected).toBe(1); expect(rec.factsInserted).toBe(0);
  expect(await rows()).toMatchObject([{ id, expired: true }]);
});

// R7-3 — fails on 9e028dabc (chunks 0 / second arrival refused / no convergence)
test('R7-3 lifecycle: world row searchable after ordinary committed-only sync, next arrival inserted, crash retry converges, neighbour indexed', async () => {
  const first = await isolated(() => performSync(engine, { sourceId: SOURCE, noEmbed: true, noPull: true }));
  const id = await seed('Zephyroquartz knowledge', 'world');
  expect((await extract()).legacyRowsRepaired).toBe(1);
  expect(await chunkHits('Zephyroquartz')).toEqual([{ n: 1 }]);
  const next = await isolated(() => performSync(engine, { sourceId: SOURCE, noEmbed: true, noPull: true }));
  expect(next.status).toBe('up_to_date');
  expect(await chunkHits('Zephyroquartz')).toEqual([{ n: 1 }]);
  expect((await engine.searchKeyword('Zephyroquartz', { sourceId: SOURCE })).length).toBeGreaterThan(0);
  expect(git('show', `HEAD:${SLUG}.md`)).toBe(ORIGINAL);                       // no repair commit
  // Second ordinary arrival on the still-uncommitted, DB-accounted page.
  const second = await seed('Second ordinary arrival', 'world');
  const r2 = await extract(); expect(r2).toMatchObject({ guardTriggered: false, legacyRowsRepaired: 1 });
  expect(parseFactsFence(readFileSync(file, 'utf8')).facts.map(f => [f.rowNum, f.claim])).toEqual([[1, 'Zephyroquartz knowledge'], [2, 'Second ordinary arrival']]);
  expect(readFileSync(file, 'utf8').startsWith(ORIGINAL)).toBe(true);
  expect(await chunkHits('Second ordinary')).toEqual([{ n: 1 }]);
  expect(await rows()).toMatchObject([{ id, row_num: 1 }, { id: second, row_num: 2 }]);
  // Crash after the write, before COMMIT: the retry reuses the exact rendering.
  const third = await seed('Third arrival', 'world');
  const crashed = await repair({ beforeCommit: () => { throw new Error('crash after write'); } });
  expect(crashed.rowsStamped).toBe(0); expect(parseFactsFence(readFileSync(file, 'utf8')).facts).toHaveLength(3);
  const bytes = readFileSync(file);
  const retry = await extract();
  expect(retry).toMatchObject({ guardTriggered: false, legacyRowsRepaired: 1 });
  expect(readFileSync(file)).toEqual(bytes);
  expect((await rows()).find(r => r.id === third)!.row_num).toBe(3);
  // A healthy neighbour is indexed in the same run.
  const neighbor = 'people/healthy-neighbor'; const npath = join(repo, `${neighbor}.md`);
  const nbody = upsertFactRow(ORIGINAL, { claim: 'Healthy neighbor fact', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'medium', validFrom: '2026-01-02', source: 'api:fixture' }).body;
  writeFileSync(npath, nbody); await isolated(() => importFromContent(engine, neighbor, nbody, { sourceId: SOURCE, noEmbed: true }));
  git('add', '--', `${neighbor}.md`); git('commit', '-qm', 'neighbor');
  const fourth = await seed('Fourth arrival', 'world');
  const r4 = await extract({ slugs: [SLUG, neighbor] });
  expect(r4.guardTriggered).toBe(false);
  expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND entity_slug=$2', [SOURCE, neighbor])).toHaveLength(1);
  expect((await rows()).find(r => r.id === fourth)!.row_num).toBe(4);
  void first;
});

test('R7-3 boundaries retained: a human draft in the same file, forgotten residue, and a widening row still refuse', async () => {
  await seed(); expect((await repair()).rowsStamped).toBe(1);
  writeFileSync(file, readFileSync(file, 'utf8') + '\nHuman paragraph.\n');
  await seed('Later arrival');
  expect((await repair()).skippedByReason.file_uncommitted).toBe(1);
});

test('R7-3 later arrival never overwrites a same-inode human edit after the final check', async () => {
  await seed('First arrival', 'world'); expect((await repair()).rowsStamped).toBe(1);
  const id = await seed('Second arrival', 'world');
  const before = readFileSync(file, 'utf8');
  const human = `${before}\nHuman edit after planning.\n`;
  const result = await repair({ beforeRename: () => writeFileSync(file, human) });
  expect(result.rowsStamped).toBe(0);
  const after = readFileSync(file, 'utf8');
  expect(after).toBe(human);
  expect(result.skippedByReason.concurrent_edit).toBe(1);
  expect((await rows()).find(r => r.id === id)!.row_num).toBeNull();
  expect((await repair()).skippedByReason.file_uncommitted).toBe(1);
});

// R7-4 — fails on 9e028dabc (migration completes and rounds)
for (const change of ["confidence=0.987", "source_session='fixture-session'", "valid_from='2026-01-02T12:00:00Z'"]) {
  test(`R7-4 v0.32.2 backfill refuses ${change} without mutation`, async () => {
    const id = await seed(); await seed('Second fact');
    await engine.executeRaw(`UPDATE facts SET ${change} WHERE id=$1`, [id]);
    const before = await engine.executeRaw('SELECT to_jsonb(f)::text AS s FROM facts f WHERE source_id=$1 ORDER BY id', [SOURCE]);
    const r = await isolated(() => migration.phaseBFenceFacts(engine, { sourceId: SOURCE, yes: true, dryRun: false, noAutopilotInstall: true }));
    expect(r.status).toBe('failed'); expect(r.detail).toContain('refused');
    expect(await engine.executeRaw('SELECT to_jsonb(f)::text AS s FROM facts f WHERE source_id=$1 ORDER BY id', [SOURCE])).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });
}
test('R7-4 v0.32.2 backfill honors GBRAIN_FACT_REPAIR=off', async () => {
  await seed();
  const r = await withEnv({ GBRAIN_FACT_REPAIR: 'off', GBRAIN_HOME: home }, () => migration.phaseBFenceFacts(engine, { sourceId: SOURCE, yes: true, dryRun: false, noAutopilotInstall: true }));
  expect(r.status).toBe('failed'); expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  expect((await rows())[0]!.row_num).toBeNull();
});
test('R7-4 v0.32.2 backfill carries typed metadata into the fence and through a destructive reconcile', async () => {
  const id = await seed(); await seed('Second fact');
  await engine.executeRaw("UPDATE facts SET claim_metric='mrr',claim_value=123.25,claim_unit='USD' WHERE id=$1", [id]);
  const r = await isolated(() => migration.phaseBFenceFacts(engine, { sourceId: SOURCE, yes: true, dryRun: false, noAutopilotInstall: true }));
  expect(r.status).toBe('complete'); await sync();
  writeFileSync(file, readFileSync(file, 'utf8').replace('Second fact', 'Second edited')); await sync();
  expect((await extract()).factsInserted).toBe(2);
  expect(await engine.executeRaw('SELECT confidence, claim_metric, claim_value::float8 AS v, claim_unit FROM facts WHERE source_id=$1 AND fact=$2', [SOURCE, 'Keep this fact']))
    .toEqual([{ confidence: 0.9, claim_metric: 'mrr', v: 123.25, claim_unit: 'USD' }]);
});

test('R7-3 post-write crash retries by exact reuse, without committing or changing any bytes', async () => {
  const id = await seed('Retryable world knowledge', 'world');
  const head = git('rev-parse', 'HEAD');
  const crashed = await repair({ beforeCommit: () => { throw new Error('crash after append'); } });
  expect(crashed.rowsStamped).toBe(0);
  const bytes = readFileSync(file);
  const retry = await extract();
  expect(retry).toMatchObject({ guardTriggered: false, legacyRowsRepaired: 1 });
  expect(retry.legacyRepair?.rowsAppended).toBe(0);
  expect(readFileSync(file)).toEqual(bytes);
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(await rows()).toMatchObject([{ id, row_num: 1, expired: false }]);
  expect(await chunkHits('Retryable world')).toEqual([{ n: 1 }]);
  expect((await extract()).legacyRowsRepaired).toBe(0);
});

for (const unavailable of ['missing file', 'write-through off', 'no local path'] as const) {
  test(`R7-1 replacement plus ${unavailable} never licenses silent deletion`, async () => {
    const id = await seed(); expect((await repair()).rowsStamped).toBe(1);
    writeFileSync(file, ORIGINAL); await sync();
    if (unavailable === 'missing file') rmSync(file);
    if (unavailable === 'write-through off') await engine.setConfig('sync.write_through', 'false');
    if (unavailable === 'no local path') await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [SOURCE]);
    const rec = await extract();
    expect(rec.factsDeleted).toBe(0);
    expect(rec.warnings.some(w => w.includes('FACTS_FENCE_UNPUBLISHED_CONFLICT'))).toBe(true);
    expect(await rows()).toMatchObject([{ id, expired: false }]);
  });
}

test('R7-1 a revision of an already-stale cache cannot authorize dropping unseen owned facts', async () => {
  const id = await seed('Invisible to stale cache', 'world'); expect((await repair()).rowsStamped).toBe(1);
  writeFileSync(file, ORIGINAL); await sync();
  await isolated(async () => {
    const current = await op('get_page').handler(ctx(false), { slug: SLUG, include_content: true }) as { revision: string; content: string };
    await expect(op('put_page').handler(ctx(false), { slug: SLUG, content: current.content + '\nHuman edit.\n', base_revision: current.revision }))
      .rejects.toMatchObject({ code: 'conflict' });
  });
  expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  expect(await rows()).toMatchObject([{ id, expired: false }]);
});

test('R7-3 private rows remain excluded from chunk search after repair', async () => {
  await seed('Secretzebraclaim', 'private'); expect((await repair()).rowsStamped).toBe(1);
  expect(await chunkHits('Secretzebraclaim')).toEqual([{ n: 0 }]);
  expect(await rows()).toHaveLength(1);
});

test('R7-4 migration cannot bypass a dirty file or invent a missing file', async () => {
  const id = await seed(); const before = await rows();
  writeFileSync(file, ORIGINAL + '\nUncommitted human paragraph.\n');
  const dirty = readFileSync(file);
  const r = await isolated(() => migration.phaseBFenceFacts(engine, { sourceId: SOURCE, yes: true, dryRun: false, noAutopilotInstall: true }));
  expect(r.status).toBe('failed'); expect(readFileSync(file)).toEqual(dirty); expect(await rows()).toEqual(before);
  writeFileSync(file, ORIGINAL); rmSync(file);
  const missing = await isolated(() => migration.phaseBFenceFacts(engine, { sourceId: SOURCE, yes: true, dryRun: false, noAutopilotInstall: true }));
  expect(missing.status).toBe('failed'); expect(await rows()).toMatchObject([{ id, row_num: null }]);
});
