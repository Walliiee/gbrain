import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runConfig } from '../../src/commands/config.ts';
import { resolveSearchLifecyclePolicy } from '../../src/core/search/lifecycle-policy.ts';
import { withEnv } from '../helpers/with-env.ts';

const KEY = 'search.exclude_statuses';
const QUERY = 'lifecyclecfgneedle';
const ALL_SLUGS = ['notes/cfg-active', 'notes/cfg-archived', 'notes/cfg-superseded'];
let engine: PGLiteEngine;
let home: string;
let configPath: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-lifecycle-config-'));
  mkdirSync(join(home, '.gbrain'));
  configPath = join(home, '.gbrain', 'config.json');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const status of ['active', 'archived', 'superseded']) {
    const slug = `notes/cfg-${status}`;
    const text = `${QUERY} ${status}`;
    await engine.putPage(slug, {
      type: 'note', title: text, compiled_truth: text, frontmatter: { status },
    });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }]);
  }
}, 60_000);

afterAll(async () => {
  try { if (engine) await engine.disconnect(); }
  finally { if (home) rmSync(home, { recursive: true, force: true }); }
});

async function readback(filePolicy: Record<string, unknown>, dbValue: string | null, raw = false) {
  writeFileSync(configPath, JSON.stringify({ engine: 'pglite', ...filePolicy }));
  const fileBefore = readFileSync(configPath, 'utf8');
  if (dbValue === null) await engine.unsetConfig(KEY);
  else await engine.setConfig(KEY, dbValue);

  const stdout: string[] = [];
  const stderr: string[] = [];
  // Capture output only: config loading, DB reads, lifecycle resolution, and
  // SQL search all execute their actual implementations against this fixture.
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout.push(args.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await runConfig(engine, ['get', ...(raw ? ['--raw'] : []), KEY]);
      const policy = await resolveSearchLifecyclePolicy(engine);
      const results = await engine.searchKeyword(QUERY, { sourceId: 'default', limit: 10 });
      expect(readFileSync(configPath, 'utf8')).toBe(fileBefore);
      return { stdout, stderr: stderr.join('\n'), policy, slugs: results.map(row => row.slug).sort() };
    });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

for (const [shape, filePolicy] of [
  ['flat', { [KEY]: ['archived'] }],
  ['nested', { search: { exclude_statuses: ['archived'] } }],
] as const) {
  test(`${shape} file policy cannot shadow DB readback or effective search`, async () => {
    const result = await readback(filePolicy, '["superseded"]');
    expect(result.stdout).toEqual(['["superseded"]']);
    expect(result.stderr).toContain('db plane (authoritative for this key)');
    expect(result.stderr).toContain('config-file values are ignored for search.exclude_statuses');
    expect(result.stderr).not.toContain('shadowed at runtime');
    expect(result.policy.excludeStatuses).toEqual(['superseded']);
    expect(result.slugs).toEqual(['notes/cfg-active', 'notes/cfg-archived']);
  });
}

test('an absent DB row reports effective [] despite a configured file value', async () => {
  const result = await readback({ search: { exclude_statuses: ['superseded'] } }, null);
  expect(result.stdout).toEqual(['[]']);
  expect(result.stderr).toContain('no DB row; effective exclusions: []');
  expect(result.stderr).toContain('config-file values are ignored');
  expect(result.policy.excludeStatuses).toEqual([]);
  expect(result.slugs).toEqual(ALL_SLUGS);
});

test('an explicit empty DB policy remains authoritative with --raw', async () => {
  const result = await readback({ [KEY]: ['superseded'] }, '[]', true);
  expect(result.stdout).toEqual(['[]']);
  expect(result.stderr).toContain('db plane (authoritative for this key)');
  expect(result.stderr).not.toContain('no DB row');
  expect(result.policy.excludeStatuses).toEqual([]);
  expect(result.slugs).toEqual(ALL_SLUGS);
});

test('matching file and DB values still identify the DB as authoritative', async () => {
  const result = await readback({ search: { exclude_statuses: ['superseded'] } }, '["superseded"]');
  expect(result.stdout).toEqual(['["superseded"]']);
  expect(result.stderr).toContain('db plane (authoritative for this key)');
  expect(result.stderr).toContain('config-file values are ignored');
  expect(result.slugs).toEqual(['notes/cfg-active', 'notes/cfg-archived']);
});
