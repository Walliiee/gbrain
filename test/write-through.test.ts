/**
 * Shared write-through helper tests (src/core/write-through.ts).
 *
 * Covers the skip/error branches and the atomic-write guarantee. The helper is
 * the canonical disk sink shared by `put_page` and `gbrain brainstorm/lsd
 * --save`, extracted from the v0.38 put_page write-through and upgraded to write
 * atomically (.tmp + rename).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import {
  writePageThrough, deletePageThrough, resolvePageWriteTarget,
  isWriteThroughDisabled, _resetWriteThroughCacheForTest,
} from '../src/core/write-through.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializePageToMarkdown, resolvePageFilePath } from '../src/core/markdown.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';
import { withEnv } from './helpers/with-env.ts';
import { createHash } from 'node:crypto';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  _resetWriteThroughCacheForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-wt-helper-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function seedPage(slug: string): Promise<void> {
  await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body ${slug}\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: `${slug}.md`,
  });
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('writePageThrough', () => {
  test('writes the file rendered from the saved row; no .tmp leftover', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/2026-01-01-lsd-foo-abc123';
    await seedPage(slug);

    const res = await writePageThrough(engine, slug, {
      sourceId: 'default',
      frontmatterOverrides: { source_kind: 'lsd' },
    });

    expect(res.written).toBe(true);
    const expectedPath = resolvePageFilePath(brainDir, slug, 'default');
    expect(res.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    // Content is the canonical serialization of the saved row (the file is
    // rendered FROM the row, so the sinks can't diverge).
    const page = await engine.getPage(slug, { sourceId: 'default' });
    const tags = await engine.getTags(slug, { sourceId: 'default' });
    const expected = serializePageToMarkdown(page!, tags, {
      frontmatterOverrides: { source_kind: 'lsd' },
    });
    expect(fs.readFileSync(expectedPath, 'utf8')).toBe(expected);

    // Atomic write left no temp sibling.
    const dir = path.dirname(expectedPath);
    expect(fs.readdirSync(dir).some((f) => f.includes('.tmp.'))).toBe(false);
  });

  test('no sync.repo_path → skipped no_repo_configured', async () => {
    await engine.setConfig('sync.repo_path', '');
    const slug = 'wiki/ideas/x-1';
    await seedPage(slug);
    const res = await writePageThrough(engine, slug);
    expect(res).toEqual({ written: false, skipped: 'no_repo_configured' });
  });

  test('sync.repo_path is a file, not a directory → skipped repo_not_found', async () => {
    const fileAsRepo = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(fileAsRepo, 'x');
    await engine.setConfig('sync.repo_path', fileAsRepo);
    const slug = 'wiki/ideas/x-2';
    await seedPage(slug);
    const res = await writePageThrough(engine, slug);
    expect(res).toEqual({ written: false, skipped: 'repo_not_found' });
  });

  test('row missing → skipped page_not_found_after_write', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const res = await writePageThrough(engine, 'wiki/ideas/does-not-exist');
    expect(res).toEqual({ written: false, skipped: 'page_not_found_after_write' });
  });

  test('[REGRESSION twin] honors the recorded source_path instead of minting a slug-named twin', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    // A human-authored vault file whose on-disk name is NOT its slug — the
    // normal case for Obsidian (Title Case, spaces) once slugified.
    const slug = 'library/people/steve-jobs';
    const authored = 'Library/People/Steve Jobs.md';
    await importFromContent(engine, slug, `---\ntitle: Steve Jobs\ntype: person\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: authored,
    });
    fs.mkdirSync(path.join(brainDir, 'Library', 'People'), { recursive: true });
    fs.writeFileSync(path.join(brainDir, authored), 'stale\n');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(path.join(brainDir, authored));
    // The authored file was UPDATED in place...
    expect(fs.readFileSync(path.join(brainDir, authored), 'utf8')).not.toBe('stale\n');
    // ...and no slug-derived twin appeared anywhere in the tree.
    const twin = resolvePageFilePath(brainDir, slug, 'default');
    expect(fs.existsSync(twin)).toBe(false);
    expect(walkFiles(brainDir).sort()).toEqual([path.join(brainDir, authored)]);
  });

  test('[REGRESSION twin] null source_path falls back to the slug path and binds it immediately (#4247)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'inbox/2026-01-01-abc123';
    // Born via put/capture: no file of record, so source_path stays NULL.
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(resolvePageFilePath(brainDir, slug, 'default'));
    // #4247: the just-materialized file IS the file of record — mtime-watermark
    // incremental sync never rescans an untouched file, so without an immediate
    // bind the row stays source_path=NULL forever.
    const rows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(rows[0]?.source_path).toBe(`${slug}.md`);
  });

  test('[REGRESSION twin] falls back to a contained file:// source_uri when source_path is null (capture --file of a vault file)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'library/companies/postiz';
    const authored = 'Library/Companies/Postiz.md';
    // `capture --file` records the absolute path as source_uri and leaves
    // source_path NULL — the exact shape that used to mint a twin.
    await importFromContent(engine, slug, `---\ntitle: Postiz\ntype: company\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });
    await engine.executeRaw(`UPDATE pages SET source_uri = $1 WHERE slug = $2`, [
      `file://${path.join(brainDir, authored)}`,
      slug,
    ]);
    fs.mkdirSync(path.join(brainDir, 'Library', 'Companies'), { recursive: true });
    fs.writeFileSync(path.join(brainDir, authored), 'stale\n');

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(path.join(brainDir, authored));
    // #4247: the contained file:// target is the file of record — bind it.
    const rows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(rows[0]?.source_path).toBe(authored);
    // NB: no `existsSync(slug path)` assertion here — this slug differs from the
    // authored name only by CASE, so a case-insensitive FS (macOS/Windows) folds
    // the two and existsSync would report a twin that isn't there. walkFiles
    // enumerates real directory entries, so it is case-truthful on every FS.
    expect(walkFiles(brainDir).sort()).toEqual([path.join(brainDir, authored)]);
  });

  test('[REGRESSION twin] a file:// source_uri OUTSIDE the repo is ignored', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'inbox/from-elsewhere';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
    });
    // A file captured from outside the brain repo has no file of record inside it.
    await engine.executeRaw(`UPDATE pages SET source_uri = $1 WHERE slug = $2`, [
      `file://${path.join(tmpRoot, 'outside', 'Notes.md')}`,
      slug,
    ]);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(resolvePageFilePath(brainDir, slug, 'default'));
    expect(fs.existsSync(path.join(tmpRoot, 'outside', 'Notes.md'))).toBe(false);
  });

  test('[REGRESSION twin] a traversing source_path is ignored, not joined', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/hostile-1';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: `${slug}.md`,
    });
    // Simulate a hostile / corrupted row after the fact.
    await engine.executeRaw(`UPDATE pages SET source_path = $1 WHERE slug = $2`, [
      '../../escaped.md',
      slug,
    ]);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    // Falls back to the slug path rather than escaping the write root.
    expect(res.written).toBe(true);
    expect(res.path).toBe(resolvePageFilePath(brainDir, slug, 'default'));
    expect(fs.existsSync(path.join(tmpRoot, '..', 'escaped.md'))).toBe(false);
  });

  test('sync.write_through=false → skipped disabled_by_config, nothing touches disk', async () => {
    // Everything else is configured for a successful write — the flag alone
    // must stop it, proving the gate runs before any FS work.
    await engine.setConfig('sync.repo_path', brainDir);
    await engine.setConfig('sync.write_through', 'false');
    const slug = 'wiki/ideas/db-only-note';
    await seedPage(slug);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res).toEqual({ written: false, skipped: 'disabled_by_config' });
    expect(walkFiles(brainDir).some((f) => f.endsWith('.md'))).toBe(false);
    // The DB row stays the durable sink.
    expect(await engine.getPage(slug, { sourceId: 'default' })).not.toBeNull();
  });

  test('sync.write_through=false also gates the per-source local_path branch', async () => {
    const alphaDir = path.join(tmpRoot, 'alpha-flag-repo');
    fs.mkdirSync(alphaDir, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('alpha', 'Alpha', $1, '{}'::jsonb)`,
      [alphaDir],
    );
    await engine.setConfig('sync.write_through', 'false');

    const slug = 'notes/alpha-db-only';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'alpha',
      sourcePath: `${slug}.md`,
    });

    const res = await writePageThrough(engine, slug, { sourceId: 'alpha' });

    expect(res).toEqual({ written: false, skipped: 'disabled_by_config' });
    expect(walkFiles(alphaDir).some((f) => f.endsWith('.md'))).toBe(false);
  });

  test('sync.write_through unset or any non-"false" value keeps the default write-through behavior', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    // Explicit 'true' — same as unset (the flag is an opt-out).
    await engine.setConfig('sync.write_through', 'true');
    const slug = 'wiki/ideas/still-written';
    await seedPage(slug);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    expect(fs.existsSync(res.path!)).toBe(true);
  });

  test('off values parse case-insensitively: FALSE / 0 / Off / no / " false " all disable', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/off-value-parsing';
    await seedPage(slug);

    for (const value of ['FALSE', '0', 'Off', 'no', ' false ']) {
      await engine.setConfig('sync.write_through', value);
      _resetWriteThroughCacheForTest();
      const res = await writePageThrough(engine, slug, { sourceId: 'default' });
      expect(res).toEqual({ written: false, skipped: 'disabled_by_config' });
    }

    // Non-off values (including garbage) keep the default-on behavior.
    for (const value of ['1', 'yes', 'banana', '']) {
      await engine.setConfig('sync.write_through', value);
      _resetWriteThroughCacheForTest();
      expect(await isWriteThroughDisabled(engine)).toBe(false);
      _resetWriteThroughCacheForTest();
    }
  });

  test('the flag read is memoized per engine — bulk loops pay one config SELECT, not one per page', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    let flagReads = 0;
    const counting = Object.create(engine) as typeof engine;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (counting as any).getConfig = async (key: string) => {
      if (key === 'sync.write_through') flagReads += 1;
      return engine.getConfig(key);
    };

    const slugA = 'wiki/ideas/memo-a';
    const slugB = 'wiki/ideas/memo-b';
    await seedPage(slugA);
    await seedPage(slugB);

    expect((await writePageThrough(counting, slugA, { sourceId: 'default' })).written).toBe(true);
    expect((await writePageThrough(counting, slugB, { sourceId: 'default' })).written).toBe(true);
    expect(flagReads).toBe(1);

    // A config flip inside the TTL window keeps serving the cached value...
    await engine.setConfig('sync.write_through', 'false');
    expect((await writePageThrough(counting, slugA, { sourceId: 'default' })).written).toBe(true);
    // ...and becomes visible once the cache is dropped.
    _resetWriteThroughCacheForTest();
    const res = await writePageThrough(counting, slugA, { sourceId: 'default' });
    expect(res).toEqual({ written: false, skipped: 'disabled_by_config' });
  });

  test('a failing flag read fails open to enabled (the write still lands)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const failing = Object.create(engine) as typeof engine;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (failing as any).getConfig = async (key: string) => {
      if (key === 'sync.write_through') throw new Error('simulated config outage');
      return engine.getConfig(key);
    };

    const slug = 'wiki/ideas/fail-open';
    await seedPage(slug);
    const res = await writePageThrough(failing, slug, { sourceId: 'default' });
    expect(res.written).toBe(true);
    expect(fs.existsSync(res.path!)).toBe(true);
  });

  test('[REGRESSION #2018] default page (null local_path) in a multi-source brain → skipped, no leak into a sibling source repo', async () => {
    // A sibling federated source with its OWN working tree.
    const siblingDir = path.join(tmpRoot, 'housefax');
    fs.mkdirSync(siblingDir, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('housefax', 'Housefax', $1, '{}'::jsonb)`,
      [siblingDir],
    );
    // The leak trigger: global sync.repo_path points at the sibling's tree
    // while the default source (re-seeded by resetPgliteState) has no
    // local_path of its own.
    await engine.setConfig('sync.repo_path', siblingDir);

    const slug = 'internal/cross-cutting-note';
    await seedPage(slug); // sourceId 'default'

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res).toEqual({ written: false, skipped: 'source_repo_belongs_to_other_source' });
    // The sibling source's repo stays clean — the whole point of #2018.
    expect(walkFiles(siblingDir).some((f) => f.endsWith('.md'))).toBe(false);
  });

  test('[#2018] page assigned to a source with its own local_path writes to that tree root, not the global path', async () => {
    const alphaDir = path.join(tmpRoot, 'alpha-repo');
    fs.mkdirSync(alphaDir, { recursive: true });
    const globalDir = path.join(tmpRoot, 'global-repo');
    fs.mkdirSync(globalDir, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('alpha', 'Alpha', $1, '{}'::jsonb)`,
      [alphaDir],
    );
    // Must NOT be used — the assigned source has its own tree.
    await engine.setConfig('sync.repo_path', globalDir);

    const slug = 'notes/alpha-thing';
    await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'alpha',
      sourcePath: `${slug}.md`,
    });

    const res = await writePageThrough(engine, slug, { sourceId: 'alpha' });

    expect(res.written).toBe(true);
    // File at the source's tree ROOT, never nested under `.sources/<id>/`.
    expect(res.path).toBe(path.join(alphaDir, `${slug}.md`));
    expect(fs.existsSync(path.join(alphaDir, `${slug}.md`))).toBe(true);
    // The global repo path is untouched.
    expect(walkFiles(globalDir).some((f) => f.endsWith('.md'))).toBe(false);
  });

  test('Git-root source_path updates the file inside a subdirectory local_path', async () => {
    const gitRoot = path.join(tmpRoot, 'monorepo');
    fs.mkdirSync(path.join(gitRoot, '.git'), { recursive: true });
    const sourceRoot = path.join(gitRoot, 'public', 'changelog');
    fs.mkdirSync(path.join(sourceRoot, 'posts'), { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('changelog', 'Changelog', $1, '{}'::jsonb)`,
      [sourceRoot],
    );
    const slug = 'public/changelog/posts/2026-08-18';
    const sourcePath = `${slug}.md`;
    const filePath = path.join(sourceRoot, 'posts', '2026-08-18.md');
    await importFromContent(engine, slug, `---\ntitle: Release\ntype: note\n---\n\n# Current body\n`, {
      noEmbed: true,
      sourceId: 'changelog',
      sourcePath,
    });
    fs.writeFileSync(filePath, 'stale\n');

    const res = await writePageThrough(engine, slug, { sourceId: 'changelog' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(filePath);
    expect(fs.readFileSync(filePath, 'utf8')).not.toBe('stale\n');
    expect(fs.existsSync(path.join(sourceRoot, sourcePath))).toBe(false);
  });

  test('[#4247] put-born page in a subdirectory-scoped local_path binds a Git-root-relative source_path', async () => {
    const gitRoot = path.join(tmpRoot, 'monorepo');
    fs.mkdirSync(path.join(gitRoot, '.git'), { recursive: true });
    const sourceRoot = path.join(gitRoot, 'public', 'changelog');
    fs.mkdirSync(sourceRoot, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('changelog', 'Changelog', $1, '{}'::jsonb)`,
      [sourceRoot],
    );
    const slug = 'posts/2026-08-24';
    // Born via put: no file of record, so the slug-derived path is minted
    // under the source's own tree.
    await importFromContent(engine, slug, `---\ntitle: Release\ntype: note\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'changelog',
    });

    const res = await writePageThrough(engine, slug, { sourceId: 'changelog' });

    expect(res.written).toBe(true);
    expect(res.path).toBe(path.join(sourceRoot, 'posts', '2026-08-24.md'));
    // Scoped syncs record source_path GIT-ROOT-relative (#774), and
    // delete-reconcile keys on that exact form — a local_path-relative bind
    // here would desync reconcile and sweep the page while its file exists.
    const rows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'changelog' AND slug = $1`,
      [slug],
    );
    expect(rows[0]?.source_path).toBe(`public/changelog/${slug}.md`);
  });

  test('[#4247] an existing scanner-recorded source_path is never rewritten by write-through', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'library/people/steve-jobs';
    const authored = 'Library/People/Steve Jobs.md';
    await importFromContent(engine, slug, `---\ntitle: Steve Jobs\ntype: person\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: authored,
    });
    fs.mkdirSync(path.join(brainDir, 'Library', 'People'), { recursive: true });

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(true);
    const rows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(rows[0]?.source_path).toBe(authored);
  });

  test('[REGRESSION #2831] differently-cased entry occupying the target → skipped case_insensitive_collision, existing file untouched', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/note';
    await seedPage(slug);

    // A differently-cased file already occupies the target path's fold slot
    // (e.g. an uncontrolled repo file, or another slug's normalization
    // variant). On macOS/Windows the FS resolves `note.md` to it.
    const dir = path.join(brainDir, 'wiki', 'ideas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'precious existing content');

    // Detect whether THIS filesystem folds case (macOS/Windows: yes; Linux
    // CI: no — there the two names are distinct files and no guard fires).
    const caseInsensitiveFs = fs.existsSync(path.join(dir, 'note.md'));

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    if (caseInsensitiveFs) {
      expect(res).toEqual({ written: false, skipped: 'case_insensitive_collision' });
      // The pre-existing file was NOT clobbered — the whole point of #2831.
      expect(fs.readFileSync(path.join(dir, 'NOTE.md'), 'utf8')).toBe('precious existing content');
    } else {
      expect(res.written).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'NOTE.md'), 'utf8')).toBe('precious existing content');
      expect(fs.existsSync(path.join(dir, 'note.md'))).toBe(true);
    }
  });

  test('[#2831] exact-case rewrite of the same slug still updates (guard falls through)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'wiki/ideas/rewrite-me';
    await seedPage(slug);

    const first = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(first.written).toBe(true);
    const second = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(second.written).toBe(true);
    expect(second.path).toBe(first.path);
  });

  test('[REGRESSION] mkdir ENOTDIR (parent is a file) → error, no partial .md, no .tmp', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    // Block the `wiki/` directory by putting a FILE named "wiki" under the repo,
    // so `mkdir -p <repo>/wiki/ideas` throws ENOTDIR deterministically.
    fs.writeFileSync(path.join(brainDir, 'wiki'), 'blocker');
    const slug = 'wiki/ideas/blocked-1';
    await seedPage(slug);

    const res = await writePageThrough(engine, slug, { sourceId: 'default' });

    expect(res.written).toBe(false);
    expect(typeof res.error).toBe('string');
    const files = walkFiles(brainDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
  });
});

describe('deletePageThrough (#4022)', () => {
  // The leak this closes: delete_page was DB-only, so the artifact outlived the
  // page. On any brain committed on a timer (snapshot cron, hardened
  // post-commit push) the orphan got committed AFTER deletion and the next
  // `gbrain sync` resurrected the page.
  test('removes the artifact written by writePageThrough (path parity)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'concepts/delete-me';
    await seedPage(slug);

    const written = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(written.written).toBe(true);
    expect(fs.existsSync(written.path!)).toBe(true);

    const removed = await deletePageThrough(engine, slug, { sourceId: 'default' });
    expect(removed.removed).toBe(true);
    // Path parity is the whole point of the shared resolver: a delete that
    // computed the path differently would miss the file (leaving the orphan)
    // or unlink the wrong one.
    expect(removed.path).toBe(written.path);
    expect(fs.existsSync(written.path!)).toBe(false);
  });

  test('missing artifact is a clean no-op, not an error', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'concepts/db-only-page';
    await seedPage(slug);

    const res = await deletePageThrough(engine, slug, { sourceId: 'default' });
    expect(res.removed).toBe(false);
    expect(res.skipped).toBe('file_not_present');
    expect(res.error).toBeUndefined();
  });

  test('no repo configured → skipped, never throws', async () => {
    // sync.repo_path deliberately unset (DB-only brain by design).
    const slug = 'concepts/no-repo';
    await seedPage(slug);

    const res = await deletePageThrough(engine, slug, { sourceId: 'default' });
    expect(res.removed).toBe(false);
    expect(res.skipped).toBe('no_repo_configured');
  });

  test('sync.write_through=false → skipped disabled_by_config, file untouched', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'concepts/opted-out';
    await seedPage(slug);
    const written = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(written.written).toBe(true);

    // The operator opted the brain out of the disk sink — the delete plane
    // must not start unlinking files gbrain no longer owns.
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest();

    const res = await deletePageThrough(engine, slug, { sourceId: 'default' });
    expect(res).toEqual({ removed: false, skipped: 'disabled_by_config' });
    expect(fs.existsSync(written.path!)).toBe(true);
  });

  test('a pre-stamp target keeps the recorded source_path reachable after soft-delete', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'library/people/ada-lovelace';
    const authored = 'Library/People/Ada Lovelace.md';
    await importFromContent(engine, slug, `---\ntitle: Ada Lovelace\ntype: person\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: authored,
    });
    const written = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(written.path).toBe(path.join(brainDir, authored));

    // resolvePageWriteTarget reads source_path from ACTIVE rows only, so the
    // delete plane resolves the target BEFORE softDeletePage stamps
    // deleted_at; a post-stamp resolution would fall back to the slug-derived
    // twin, report a clean file_not_present no-op, and leave the REAL
    // artifact on disk for the next timer-based commit to resurrect.
    const target = await resolvePageWriteTarget(engine, slug, 'default');
    await engine.softDeletePage(slug, { sourceId: 'default' });

    const removed = await deletePageThrough(engine, slug, { sourceId: 'default', target });
    expect(removed.removed).toBe(true);
    expect(removed.path).toBe(path.join(brainDir, authored));
    expect(fs.existsSync(path.join(brainDir, authored))).toBe(false);
  });
});

describe('delete_page / restore_page write-through symmetry (#4022)', () => {
  const delete_page = operations.find((o) => o.name === 'delete_page')!;
  const restore_page = operations.find((o) => o.name === 'restore_page')!;

  function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
    return {
      engine: engine as any,
      config: { engine: 'pglite' } as any,
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      ...overrides,
    } as OperationContext;
  }

  test('[REGRESSION resurrect] delete_page removes the recorded source_path artifact', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'library/people/grace-hopper';
    const authored = 'Library/People/Grace Hopper.md';
    await importFromContent(engine, slug, `---\ntitle: Grace Hopper\ntype: person\n---\n\n# Body\n`, {
      noEmbed: true,
      sourceId: 'default',
      sourcePath: authored,
    });
    const written = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(written.path).toBe(path.join(brainDir, authored));

    const res = await delete_page.handler(ctxOf(), { slug }) as Record<string, any>;

    expect(res.status).toBe('soft_deleted');
    // Pre-fix the delete was DB-only: the authored `.md` survived, the next
    // timer-based commit pushed it back into git, and `gbrain sync`
    // re-imported it — resurrecting the page the user deleted.
    expect(fs.existsSync(path.join(brainDir, authored))).toBe(false);
    expect(res.write_through?.removed).toBe(true);
    expect(res.write_through?.path).toBe(path.join(brainDir, authored));
  });

  test('restore_page re-renders the artifact (sync --full must not re-delete the restored page)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'concepts/round-trip';
    await seedPage(slug);
    const written = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(fs.existsSync(written.path!)).toBe(true);

    const del = await delete_page.handler(ctxOf(), { slug }) as Record<string, any>;
    expect(del.write_through?.removed).toBe(true);
    expect(fs.existsSync(written.path!)).toBe(false);

    const res = await restore_page.handler(ctxOf(), { slug }) as Record<string, any>;

    expect(res.status).toBe('restored');
    // Without the re-render a restored page has a DB row and no artifact, and
    // `sync --full` delete-reconcile treats the missing file as a user
    // deletion — silently re-deleting the page the user just restored.
    expect(res.write_through?.written).toBe(true);
    expect(fs.existsSync(written.path!)).toBe(true);
  });

  test('sandbox subagents stay DB-only on both planes (matches put_page trust gate)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'concepts/sandboxed';
    await seedPage(slug);
    const written = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(fs.existsSync(written.path!)).toBe(true);

    const sandboxCtx = ctxOf({ viaSubagent: true });
    const del = await delete_page.handler(sandboxCtx, { slug }) as Record<string, any>;
    expect(del.status).toBe('soft_deleted');
    expect(del.write_through?.skipped).toBe('subagent_sandbox');
    // The DB row is soft-deleted but the sandboxed caller never touches disk.
    expect(fs.existsSync(written.path!)).toBe(true);

    const rest = await restore_page.handler(sandboxCtx, { slug }) as Record<string, any>;
    expect(rest.status).toBe('restored');
    expect(rest.write_through?.skipped).toBe('subagent_sandbox');
  });
});

describe('writePageThrough — page lock (2026-09-14 review finding 1)', () => {
  const lockHome = () => path.join(tmpRoot, 'home');
  const lockFileFor = (slug: string) =>
    path.join(lockHome(), '.gbrain', 'page-locks', `${createHash('sha256').update(slug).digest('hex')}.lock`);

  test('a held page lock degrades to skipped: page_lock_timeout — no throw, file untouched, DB row intact', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/locked';
    await seedPage(slug);
    const first = await withEnv({ GBRAIN_HOME: lockHome() }, () => writePageThrough(engine, slug, { sourceId: 'default' }));
    expect(first.written).toBe(true);
    const before = fs.readFileSync(first.path!, 'utf8');
    await engine.putPage(slug, { type: 'note', title: 'T', compiled_truth: '# changed', timeline: '' } as any, { sourceId: 'default' });

    const holder = await withEnv({ GBRAIN_HOME: lockHome() }, () => acquirePageLock(slug));
    expect(holder).not.toBeNull();
    try {
      const t0 = Date.now();
      const res = await withEnv({ GBRAIN_HOME: lockHome() }, () => writePageThrough(engine, slug, { sourceId: 'default' }));
      expect(res).toEqual({ written: false, skipped: 'page_lock_timeout' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
      expect(fs.readFileSync(first.path!, 'utf8')).toBe(before);
      expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toBe('# changed');
    } finally {
      await holder!.release();
    }
    // Once released, the same write lands and the lock is released again after it.
    const after = await withEnv({ GBRAIN_HOME: lockHome() }, () => writePageThrough(engine, slug, { sourceId: 'default' }));
    expect(after.written).toBe(true);
    expect(fs.readFileSync(after.path!, 'utf8')).toContain('# changed');
    expect(fs.existsSync(lockFileFor(slug))).toBe(false);
  }, 20_000);

  test('holdsPageLock: true skips acquisition (re-entrant callers do not deadlock against themselves)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/reentrant';
    await seedPage(slug);
    const holder = await withEnv({ GBRAIN_HOME: lockHome() }, () => acquirePageLock(slug));
    try {
      const res = await withEnv({ GBRAIN_HOME: lockHome() }, () =>
        writePageThrough(engine, slug, { sourceId: 'default', holdsPageLock: true }));
      expect(res.written).toBe(true);
      // The caller's lock is still theirs: not released by the write.
      expect(fs.existsSync(lockFileFor(slug))).toBe(true);
    } finally {
      await holder!.release();
    }
  });
});

describe('put_page / restore_page hold the page lock across the DB write AND the write-through (2026-09-14 review 2, finding 4)', () => {
  const lockHome = () => path.join(tmpRoot, 'home');
  const lockFileFor = (slug: string) =>
    path.join(lockHome(), '.gbrain', 'page-locks', `${createHash('sha256').update(slug).digest('hex')}.lock`);
  const put_page = operations.find((o) => o.name === 'put_page')!;
  const delete_page = operations.find((o) => o.name === 'delete_page')!;
  const restore_page = operations.find((o) => o.name === 'restore_page')!;
  const ctx = () => ({
    engine: engine as any,
    config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: 'default',
  }) as OperationContext;
  const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: lockHome() }, fn);
  const OLD = '---\ntitle: T\ntype: note\n---\n\n# Old content\n';
  const NEW = '---\ntitle: T\ntype: note\n---\n\n# New content, acknowledged\n';

  test('a page lock held for the whole wait: put_page refuses BEFORE the DB write (storage_error) — nothing created, no file', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/locked-put';
    const holder = await inHome(() => acquirePageLock(slug));
    expect(holder).not.toBeNull();
    try {
      const t0 = Date.now();
      await expect(inHome(() => put_page.handler(ctx(), { slug, content: NEW }))).rejects.toMatchObject({ code: 'storage_error' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
      expect(fs.existsSync(path.join(brainDir, `${slug}.md`))).toBe(false);
    } finally {
      await holder!.release();
    }
    // The caller's retry lands in both sinks.
    const res = await inHome(() => put_page.handler(ctx(), { slug, content: NEW })) as Record<string, any>;
    expect(res.status).toBe('created_or_updated');
    expect(res.write_through.written).toBe(true);
    expect(fs.readFileSync(path.join(brainDir, `${slug}.md`), 'utf8')).toContain('# New content, acknowledged');
    expect(fs.existsSync(lockFileFor(slug))).toBe(false);
  }, 20_000);

  test('no lost save: an existing page stays OLD in both sinks while refused, so a sync in between changes nothing; the retry lands NEW in both, and a later sync keeps NEW', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/durable';
    const filePath = path.join(brainDir, `${slug}.md`);
    const first = await inHome(() => put_page.handler(ctx(), { slug, content: OLD })) as Record<string, any>;
    expect(first.write_through.written).toBe(true);
    const oldFile = fs.readFileSync(filePath, 'utf8');
    const oldRow = (await engine.getPage(slug, { sourceId: 'default' }))!;

    const holder = await inHome(() => acquirePageLock(slug));
    try {
      await expect(inHome(() => put_page.handler(ctx(), { slug, content: NEW }))).rejects.toMatchObject({ code: 'storage_error' });
      // Refused before the DB write: row and file are still the OLD save.
      const row = (await engine.getPage(slug, { sourceId: 'default' }))!;
      expect(row.compiled_truth).toBe(oldRow.compiled_truth);
      expect(row.content_hash).toBe(oldRow.content_hash);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(oldFile);
      // What `gbrain sync` would do next with the file: re-import it — and the
      // file IS the old save, so the row is unchanged (pre-fix, the row held the
      // acknowledged NEW content and this step reverted it to OLD).
      await importFromContent(engine, slug, fs.readFileSync(filePath, 'utf8'), { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` });
      expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toBe(oldRow.compiled_truth);
    } finally {
      await holder!.release();
    }

    const retry = await inHome(() => put_page.handler(ctx(), { slug, content: NEW })) as Record<string, any>;
    expect(retry.status).toBe('created_or_updated');
    expect(retry.write_through.written).toBe(true);
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('New content, acknowledged');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('# New content, acknowledged');
    // A sync after the acknowledged save keeps it: the file carries the same content.
    await importFromContent(engine, slug, fs.readFileSync(filePath, 'utf8'), { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` });
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('New content, acknowledged');
  }, 20_000);

  test('a REAL blocked writer: put_page waits while another holder has the page, then lands both sinks once the holder releases; the lock is released after', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/blocked-then-landed';
    const filePath = path.join(brainDir, `${slug}.md`);
    // Scanner-recorded source_path (a synced page), so the file of record is
    // deterministic: a put-born page under a sync.repo_path that itself sits
    // inside a git repo (the operator's TMPDIR here) binds a git-root-relative
    // source_path that the repo_path branch then joins under the page root — a
    // twin, and the shape the `[REGRESSION twin]` cases above already pin.
    await seedPage(slug);
    const first = await inHome(() => put_page.handler(ctx(), { slug, content: OLD })) as Record<string, any>;
    expect(first.write_through.path).toBe(filePath);
    const holder = (await inHome(() => acquirePageLock(slug)))!;
    let releasedAt = 0;
    let fileWhileHeld = '';
    let bodyWhileHeld = '';
    // The holder releases from a timer callback: put_page is genuinely
    // blocked on the lockfile until then (its poll is 200 ms, its wait 5 s).
    // Observations are captured here and asserted below.
    const release = new Promise<void>((resolve) => setTimeout(async () => {
      fileWhileHeld = fs.readFileSync(filePath, 'utf8');
      bodyWhileHeld = (await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth;
      releasedAt = Date.now();
      await holder.release();
      resolve();
    }, 1_000));
    const t0 = Date.now();
    const res = await inHome(() => put_page.handler(ctx(), { slug, content: NEW })) as Record<string, any>;
    await release;
    expect(fileWhileHeld).toContain('# Old content');                 // while held: nothing written…
    expect(bodyWhileHeld).toContain('Old content');                   // …in either sink
    expect(res.status).toBe('created_or_updated');
    expect(res.write_through.written).toBe(true);
    expect(res.write_through.path).toBe(filePath);                    // the same file of record, not a twin
    expect(Date.now()).toBeGreaterThanOrEqual(releasedAt);           // landed after the release, not before
    expect(releasedAt - t0).toBeGreaterThanOrEqual(900);
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('New content, acknowledged');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('# New content, acknowledged');
    expect(fs.existsSync(lockFileFor(slug))).toBe(false);
  }, 20_000);

  test('the lock is released on every exit: after a successful save, and after a refused one (empty overwrite)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/lock-released';
    await inHome(() => put_page.handler(ctx(), { slug, content: OLD }));
    expect(fs.existsSync(lockFileFor(slug))).toBe(false);
    await expect(inHome(() => put_page.handler(ctx(), { slug, content: '   ' }))).rejects.toMatchObject({ code: 'invalid_params' });
    expect(fs.existsSync(lockFileFor(slug))).toBe(false);
    // A fence writer can take it right away.
    const h = await inHome(() => acquirePageLock(slug));
    expect(h).not.toBeNull();
    await h!.release();
  });

  test('restore_page: a held lock refuses BEFORE the row is restored; once free, the row is restored AND the file re-rendered', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = 'people/restore-locked';
    const filePath = path.join(brainDir, `${slug}.md`);
    await seedPage(slug);   // scanner-recorded source_path: see the blocked-writer case above
    const first = await inHome(() => put_page.handler(ctx(), { slug, content: OLD })) as Record<string, any>;
    expect(first.write_through.path).toBe(filePath);
    const del = await inHome(() => delete_page.handler(ctx(), { slug })) as Record<string, any>;
    expect(del.write_through).toMatchObject({ removed: true, path: filePath });
    expect(fs.existsSync(filePath)).toBe(false);
    const holder = (await inHome(() => acquirePageLock(slug)))!;
    try {
      await expect(inHome(() => restore_page.handler(ctx(), { slug }))).rejects.toMatchObject({ code: 'storage_error' });
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();            // still soft-deleted
      expect(fs.existsSync(filePath)).toBe(false);
    } finally {
      await holder.release();
    }
    const res = await inHome(() => restore_page.handler(ctx(), { slug })) as Record<string, any>;
    expect(res.status).toBe('restored');
    expect(res.write_through.written).toBe(true);
    expect(res.write_through.path).toBe(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('# Old content');
    expect(fs.existsSync(lockFileFor(slug))).toBe(false);
  }, 20_000);
});
