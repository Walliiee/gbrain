/**
 * v0.32.2 — markdown-first fact write path.
 *
 * The "system of record" invariant means new facts land in the entity
 * page's `## Facts` fence FIRST, then the DB index gets stamped via
 * engine.insertFacts. After this commit, every write path that wants
 * persistent fact storage routes through `writeFactsToFence`. The DB
 * single-row `engine.insertFact` stays in the surface for the
 * legacy / thin-client fallback only (when the brain has no
 * sources.local_path configured).
 *
 * Concurrency: reuses the v0.28 page-lock primitive
 * (`src/core/page-lock.ts`), an FS-level lockfile under
 * `~/.gbrain/page-locks/<sha256-of-slug>.lock` with heartbeat-recency
 * staleness (5-minute TTL; namespace-agnostic — no PID-liveness, #2840).
 * Multi-process safe — two `gbrain` invocations writing
 * to the same entity page serialize through the same kernel-visible
 * lockfile. 5-second timeout per the plan's "5s retry" failure mode.
 *
 * Atomicity: write the fence to `<file>.tmp`, re-parse the .tmp body,
 * THEN `renameSync` to the canonical file. If parse fails the .tmp
 * stays in place as quarantine evidence and the JSONL surface
 * (`facts.write_failures.jsonl`) records the failure for `gbrain
 * doctor` to surface. The on-disk markdown file is never corrupted
 * mid-write (renameSync is atomic on POSIX) and the DB is never
 * inserted when the fence isn't valid (Codex Q7 atomic-write
 * recovery).
 *
 * No re-entrancy needed: writeFactsToFence uses fs.writeFileSync +
 * renameSync directly — NOT engine.putPage — so no code path can
 * re-trigger runFactsBackstop on the markdown write. The architecture
 * self-prevents the recursion concern Codex Q7 raised; documenting
 * here so a future refactor that swaps writeFileSync for putPage
 * sees the constraint.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative } from 'node:path';

import type { BrainEngine, NewFact, FactVisibility, FactKind } from '../engine.ts';
import type { ResolutionSource } from '../entities/resolve.ts';
import { inferTypeFromPack, parseMarkdown } from '../markdown.ts';
import { sanitizeText } from '../batch-rows.ts';
import { loadActivePackBestEffort } from '../schema-pack/best-effort.ts';
import { withPageLock } from '../page-lock.ts';
import { gbrainPath } from '../config.ts';
import { isWriteThroughDisabled, resolvePageWriteTarget } from '../write-through.ts';
import { isDurabilityHardened, commitWriteThroughFile } from '../brain-repo-durability.ts';
import { upsertFactRow, parseFactsFence, renderFactsTable, FACTS_FENCE_BEGIN, FACTS_FENCE_END, type ParsedFact } from '../facts-fence.ts';
import { contentHash } from '../utils.ts';
import { extractFactsFromFenceText, FENCE_SOURCE_DEFAULT } from './extract-from-fence.ts';
import { logStubGuardEvent } from './stub-guard-audit.ts';

/** Resolved source binding for the entity page. */
export interface FenceTarget {
  /** Source primary key, e.g. 'default'. */
  sourceId: string;
  /** Filesystem root for this source. Null when the brain is read-only / thin-client. */
  localPath: string | null;
  /** Entity slug — also becomes source_markdown_slug + the file basename. */
  slug: string;
  /**
   * #4108: how `slug` was resolved. REQUIRED (not optional) so no caller can
   * silently skip provenance: 'fallback_slugify' and null (resolver returned
   * nothing / caller has no resolution step) are blocked from stub-creating a
   * page — a fallback-minted slug names an entity nothing verified exists.
   * 'exact_page' / 'alias_exact' / 'fuzzy_match' all verified a live page, so
   * stub-create (DB↔file drift repair) stays allowed for them.
   */
  resolutionSource: ResolutionSource | null;
}

/** Input fact prepared by runPipelineWithBody (post-dedup). */
export interface FenceInputFact {
  fact: string;
  kind: NewFact['kind'];
  notability: NewFact['notability'];
  source: string;
  context?: string | null;
  visibility: FactVisibility;
  /** Defaults to 1.0 when undefined (matches engine.insertFact behavior). */
  confidence?: number;
  validFrom?: Date;
  /**
   * MEMORY_VERBS v1 (c5): remember's ttl → valid_until. Date-only in the
   * fence cell; the DB column derives from it on the stamp step.
   * Undefined/null = never expires (pre-v1 behavior unchanged).
   */
  validUntil?: Date | null;
  embedding: Float32Array | null;
  sessionId: string | null;
}

export interface FenceWriteResult {
  /** Number of new rows written + indexed. */
  inserted: number;
  /** DB ids assigned to the inserted rows, in input order. */
  ids: number[];
  /** True when the path fell through to DB-only because local_path was unset. */
  legacyFallback?: true;
  /** True when fence parse-validate failed; rows were NOT inserted, .tmp quarantined. */
  fenceWriteFailed?: true;
  /**
   * True when the stub-creation guard refused to spawn a phantom entity
   * page — either for an unprefixed bare slug (e.g. `jared` with no
   * `people/` directory), or (#4108) for a slug whose resolutionSource is
   * 'fallback_slugify'/null, i.e. a slug the resolver invented rather than
   * verified. Rows were NOT inserted; the caller is expected to route the
   * facts to the legacy DB-only path so they aren't silently dropped.
   *
   * The unprefixed arm is the v0.34.5 fix for the entity-resolution bug
   * where `"Jared"` fell through resolution and produced a top-level
   * `jared.md` stub.
   */
  stubGuardBlocked?: true;
  /**
   * True when the shared page-target resolver could not produce a usable
   * fence file path (source tree missing / not a directory, or a hostile
   * recorded `source_path` escaping the tree). Rows were NOT inserted; the
   * caller is expected to route the facts to the legacy DB-only path so
   * they aren't silently dropped. Unlike the old blind `mkdir -p`, we do
   * NOT resurrect a deleted source tree just to hold a fence — the same
   * refusal writePageThrough applies (#2018 `repo_not_found`).
   */
  targetUnresolvable?: true;
}

const FAILURE_LOG_PATH = (): string => gbrainPath('facts.write_failures.jsonl');

function recordWriteFailure(slug: string, sourceId: string, warnings: string[], filePath: string): void {
  // Best-effort JSONL append — never throws back into the caller. The
  // log is the operator-visibility surface; `gbrain doctor` reads it
  // to surface facts.write_failures.
  try {
    const dir = dirname(FAILURE_LOG_PATH());
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      slug,
      source_id: sourceId,
      file_path: filePath,
      warnings,
    });
    appendFileSync(FAILURE_LOG_PATH(), `${line}\n`, 'utf-8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[facts.write_failures] couldn't append: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type FactFenceGitPathState = 'clean' | 'self_dirty' | 'foreign_dirty' | 'unknown';

const GIT_OPTS: { encoding: 'utf-8'; stdio: ['ignore', 'pipe', 'ignore']; timeout: number; env: NodeJS.ProcessEnv } = {
  encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: process.env,
};

/**
 * `git status --porcelain` prints paths relative to the repository ROOT, not
 * to `-C <dir>` — so for a source registered in a git SUBDIRECTORY (a
 * `repo/brain` layout) the entry for `people/alice.md` reads
 * `brain/people/alice.md`. Resolve the prefix once so self-dirt on such a
 * source is attributed to the file instead of misread as foreign dirt.
 */
function gitRootRelative(repoPath: string, rel: string): string {
  const posix = rel.replaceAll('\\', '/');
  try {
    const prefix = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-prefix'], GIT_OPTS).trim();
    return `${prefix}${posix}`;
  } catch {
    return posix;
  }
}

/**
 * The Unicode forms a path may take in git's index and worktree, deduped. macOS
 * is normalization-insensitive: a file the DB names in NFC (`é` as one code
 * point) may sit in the index as NFD (`e` + combining acute) or the reverse,
 * and a pathspec in the other form matches NOTHING — an empty status that
 * would read as clean. Ask git for every form; compare on one.
 */
function pathspecForms(rel: string): string[] {
  return [...new Set([rel, rel.normalize('NFC'), rel.normalize('NFD')])];
}

function samePath(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC');
}

function gitPathState(repoPath: string, filePath: string): FactFenceGitPathState {
  try {
    const rel = relative(repoPath, filePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'unknown';
    // `-z`: every path verbatim and NUL-terminated. Without it, `core.quotePath`
    // (default true) prints any non-ASCII byte C-quoted — `"people/\303\251lise.md"`
    // for `people/élise.md` — which no literal comparison recognises, so an
    // ordinary æ/ø/å or é filename read as foreign dirt.
    const status = execFileSync(
      'git',
      ['-C', repoPath, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecForms(rel)],
      GIT_OPTS,
    );
    const entries = status.split('\0').filter((l) => l.length > 0);
    if (entries.length === 0) return 'clean';
    const rootRel = gitRootRelative(repoPath, rel);
    // Distinguish dirt that IS the target fence file (safe for the
    // path-limited commit to sweep — a prior gbrain fence-commit that failed
    // leaves exactly this shape) from genuinely foreign dirt: unmerged
    // conflict states, rename/copy entries (under `-z` the ORIGINAL path
    // follows as a second NUL-terminated field, so returning here also keeps
    // it from being read as an entry of its own), or any entry the parse
    // can't positively attribute to the file.
    for (const entry of entries) {
      const xy = entry.slice(0, 2);
      if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'foreign_dirty';
      if (xy.includes('R') || xy.includes('C')) return 'foreign_dirty';
      if (!samePath(entry.slice(3), rootRel)) return 'foreign_dirty';
    }
    return 'self_dirty';
  } catch {
    return 'unknown';
  }
}

/**
 * Stamp-mode only: does git hold a committed preimage for this file? An empty
 * `git status` is NOT that — an ignored or untracked path also yields empty
 * status (the fixture under a `/*`-ignoring parent repo reproduced exactly
 * this). Require the path to be in the index AND to have a blob at HEAD.
 * `writeFactsToFence` deliberately does not use this: a stub page it just
 * created is untracked by design and its path-limited commit is what makes it
 * durable.
 *
 * `HEAD:<path>` resolves from the repository root, while `ls-files` and
 * `check-ignore` take pathspecs relative to `-C <dir>`; `HEAD:./<path>` is
 * git's own spelling for "relative to the working directory", so a source
 * registered in a git subdirectory resolves the same blob the other two
 * probes describe (review finding 5).
 */
type FactFenceTrackedState = 'tracked' | 'untracked' | 'ignored' | 'not_at_head' | 'unknown';

function gitTrackedAtHead(repoPath: string, filePath: string): FactFenceTrackedState {
  const rel = relative(repoPath, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'unknown';
  const run = (args: string[]): number => {
    try {
      execFileSync('git', ['-C', repoPath, ...args], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000, env: process.env });
      return 0;
    } catch (err) {
      const status = (err as { status?: number | null }).status;
      return typeof status === 'number' ? status : 128;
    }
  };
  // The index may hold the path in another Unicode form than the DB names it
  // (see `pathspecForms`); `--error-unmatch` fails on ANY unmatched pathspec,
  // so each form is asked on its own and the first hit is the file's.
  let listed = 1;
  let indexed = rel;
  for (const form of pathspecForms(rel)) {
    listed = run(['ls-files', '--error-unmatch', '--', form]);
    if (listed === 0) { indexed = form; break; }
    if (listed !== 1) return 'unknown';               // 128: not a git repo / unreadable
  }
  if (listed !== 0) {
    return run(['check-ignore', '-q', '--', rel]) === 0 ? 'ignored' : 'untracked';
  }
  return run(['cat-file', '-e', `HEAD:./${indexed.replaceAll('\\', '/')}`]) === 0 ? 'tracked' : 'not_at_head';
}

/** The committed preimage of `filePath` (`HEAD:./<rel>`, in whichever Unicode form HEAD holds it), or null when git holds none. */
function gitHeadBlob(repoPath: string, filePath: string): string | null {
  const rel = relative(repoPath, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  for (const form of pathspecForms(rel)) {
    try {
      return execFileSync('git', ['-C', repoPath, 'show', `HEAD:./${form.replaceAll('\\', '/')}`], GIT_OPTS);
    } catch {
      // not under this form; try the next
    }
  }
  return null;
}

async function commitFactFenceFile(
  repoPath: string,
  filePath: string,
  slug: string,
  sourceId: string,
  prewriteState: FactFenceGitPathState,
): Promise<void> {
  // Self-dirt does NOT block the commit: a prior fence-commit failure
  // (index.lock contention, kill mid-commit) leaves the fence file itself
  // dirty, and refusing on that shape latched the page's durability off
  // permanently. The locked read-modify-write already incorporated the
  // file's pre-write content, and the commit below is path-limited to this
  // one file, so sweeping self-dirt is the recovery — only genuinely foreign
  // dirt (or an unreadable state) keeps the audit-and-skip behavior.
  if (prewriteState === 'foreign_dirty' || prewriteState === 'unknown') {
    recordWriteFailure(
      slug,
      sourceId,
      [prewriteState === 'foreign_dirty'
        ? 'git_durability_preexisting_dirty'
        : 'git_durability_prewrite_state_unknown'],
      filePath,
    );
    return;
  }

  for (const delayMs of [0, 50, 200] as const) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (commitWriteThroughFile(repoPath, filePath, slug) && gitPathState(repoPath, filePath) === 'clean') {
      return;
    }
  }

  recordWriteFailure(slug, sourceId, ['git_durability_commit_failed'], filePath);
}

/**
 * Stub-create body for a new entity page. Minimum frontmatter so the
 * page validates as gbrain-canonical markdown and survives an
 * `importFromFile` round-trip. Type inferred from slug prefix
 * (e.g. `people/alice` → 'person'); unknown prefixes fall back to
 * 'concept' which is the most permissive PageType.
 */
function stubEntityPage(
  slug: string,
  pack: Parameters<typeof inferTypeFromPack>[1] | null,
): string {
  // #4322: resolve the type through the ACTIVE PACK, not a hardcoded table.
  // The previous people/companies/deals/topics ternary shadowed every other
  // pack-declared prefix, so a stub under a declared prefix such as
  // `products/` was written as `concept` even though the pack maps that
  // prefix to `company` — manufacturing prefix/type mismatches in brains
  // that were otherwise fully pack-conformant, and (because `concept` skips
  // the facts backstop) silently opting those pages out of the very
  // subsystem that created them.
  //
  // A null pack means the load failed. Per best-effort.ts's contract we do
  // NOT substitute an ad-hoc table here; passing an empty pack routes
  // inferTypeFromPack to its own documented GBRAIN_BASE_PATH_PREFIXES
  // fallback, the same base behaviour every other ingest path degrades to.
  const type = inferTypeFromPack(slug, pack ?? { page_types: [] });
  const tail = slug.split('/').slice(1).join('/');
  const title = tail
    .replace(/[-_/]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase()) || slug;
  return `---\ntype: ${type}\ntitle: ${title}\nslug: ${slug}\n---\n\n# ${title}\n`;
}

/**
 * Run a markdown-first fence write for one entity. Acquires the page
 * lock, reads or stub-creates the file, appends each input fact to
 * the `## Facts` fence, atomically renames the .tmp into place, and
 * stamps the DB index via engine.insertFacts.
 *
 * Returns `legacyFallback: true` when `target.localPath` is null —
 * the caller is responsible for falling through to the legacy
 * DB-only `engine.insertFact` path. We don't do the legacy fallback
 * here because the caller has the FactsBackstopCtx (visibility,
 * session, supersede policy) that the fence path doesn't need but
 * the legacy path does.
 *
 * Returns `fenceWriteFailed: true` when parse-validation of the
 * just-written .tmp fails. In that case the .tmp stays on disk as
 * quarantine evidence, the JSONL failure log records the warnings,
 * and the DB is NOT touched. The caller treats this as a hard
 * failure on the page (no rows inserted, no duplicate count, no
 * fact_ids).
 */
export async function writeFactsToFence(
  engine: BrainEngine,
  target: FenceTarget,
  facts: FenceInputFact[],
): Promise<FenceWriteResult> {
  if (target.localPath === null) {
    return { inserted: 0, ids: [], legacyFallback: true };
  }
  if (facts.length === 0) {
    return { inserted: 0, ids: [] };
  }
  // `sync.write_through` off values make the brain DB-only by operator
  // choice: no fence file, no stub entity page, no git commit. Same
  // legacyFallback contract as a missing local_path — the caller's DB-only
  // path still records the facts.
  if (await isWriteThroughDisabled(engine)) {
    return { inserted: 0, ids: [], legacyFallback: true };
  }

  // #4204: compute the SAME path writePageThrough computes for this
  // (source, slug) — the fence appends to the page's file, so the two writers
  // must agree. The previous resolvePageFilePath routing nested any
  // non-default source under `<local_path>/.sources/<id>/` — but every
  // non-default source that reaches this line has its OWN `local_path`
  // (callers fall back to the legacy DB-only path when `sources.local_path`
  // is NULL), and write-through/scanOneSource put that topology's pages at
  // the tree ROOT. Sync's walker skips dot-directories, so a `.sources/`
  // fence was invisible to sync and the next extract_facts reconcile deleted
  // the fence-owned DB rows. The shared resolver also prefers the page's
  // recorded `source_path`, so the fence lands in the file of record instead
  // of minting a slug-derived twin beside a human-named vault file.
  const resolved = await resolvePageWriteTarget(engine, target.slug, target.sourceId);
  if (!resolved.ok) {
    // Target tree unusable (deleted dir, hostile source_path row, …) — the
    // caller routes the facts to the legacy DB-only path so they are
    // recorded, not dropped.
    return { inserted: 0, ids: [], targetUnresolvable: true };
  }
  const { filePath, writeRoot } = resolved;
  const tmpPath = `${filePath}.tmp`;
  const durabilityEnabled = isDurabilityHardened(writeRoot);

  return withPageLock(
    target.slug,
    async () => {
      // 1. Read existing body or stub-create.
      let body: string;
      if (existsSync(filePath)) {
        body = readFileSync(filePath, 'utf-8');
      } else {
        // Stub-creation guard, two arms:
        //
        // 1. Unprefixed slug (v0.34.5). Phantom entity pages at the brain
        //    root were being spawned when resolveEntitySlug fell through to
        //    a bare slugify because pg_trgm scored too low on short bare
        //    names. The resolver now has a prefix-expansion step that
        //    catches most of those, but this arm is the second wall: refuse
        //    to stub-create a page whose slug has no directory prefix
        //    (people/, companies/, deals/, topics/, etc.).
        //
        // 2. Fallback/absent resolution provenance (#4108). A PREFIXED
        //    fallback_slugify result (e.g. "companies/zeta-widgets" for an
        //    entity no page backs) sailed past arm 1 and materialized as a
        //    canonical stub page; after sync it resolved as exact_page,
        //    closing a fallback→stub→exact-match feedback loop. Blocklist
        //    shape on purpose: only 'fallback_slugify' and null are blocked,
        //    so future ResolutionSource members that verify a live page
        //    (like v0.46.15's 'alias_exact') fence without touching this.
        //
        // Either way the caller routes these facts to the legacy DB-only
        // path so they aren't silently dropped — the fact still gets
        // recorded (entity_slug retained), it just doesn't spawn a phantom
        // entity page on disk.
        //
        // Sunset target: v0.36, for arm 1 ONLY (the 'unprefixed' reason in
        // the audit log). Once `stub_guard_24h` (the gbrain doctor surface
        // backed by the audit log written here) reads <5 unprefixed
        // hits/week for 3 consecutive weeks on production brains, the
        // prefix-expansion in resolveEntitySlug is sufficient and arm 1 can
        // be removed. Arm 2 does NOT sunset: it is the only wall between
        // resolver-invented slugs and canonical page creation, and no
        // resolver improvement can retire it (the fallback floor is by
        // design). The audit log under
        // `~/.gbrain/audit/stub-guard-YYYY-Www.jsonl` is the operator
        // visibility surface, with per-arm `reason` fields.
        const fallbackResolved =
          target.resolutionSource === 'fallback_slugify' || target.resolutionSource == null;
        if (!target.slug.includes('/') || fallbackResolved) {
          logStubGuardEvent({
            slug: target.slug,
            source_id: target.sourceId,
            fact_count: facts.length,
            reason: !target.slug.includes('/') ? 'unprefixed' : 'fallback_resolution',
          });
          // eslint-disable-next-line no-console
          console.warn(
            !target.slug.includes('/')
              ? `[facts] refusing to stub-create unprefixed entity page slug=${target.slug} — routing to legacy DB-only path. Provide a directory prefix (people/, companies/, etc.) to opt into fence writes.`
              : `[facts] refusing to stub-create entity page slug=${target.slug} from a fallback-resolved reference (no live page verified) — routing to legacy DB-only path.`,
          );
          return { inserted: 0, ids: [], stubGuardBlocked: true };
        }
        // Stub-create the parent directory if it doesn't exist.
        mkdirSync(dirname(filePath), { recursive: true });
        const activePack = await loadActivePackBestEffort({ engine } as never);
        body = stubEntityPage(target.slug, activePack?.manifest ?? null);
      }

      // 2. Upsert each fact onto the fence in input order. row_num
      //    monotonically increases (max-existing + 1 per call, append-only).
      //
      //    Seed the counter from the DB as well as the fence file. Uniqueness
      //    is enforced by idx_facts_fence_key on
      //    (source_id, source_markdown_slug, row_num) in Postgres, but
      //    upsertFactRow derives the next value from the fence in the markdown
      //    alone — and falls back to 1 when the file has no fence at all. Any
      //    write path that rewrites a page without preserving its facts fence
      //    (put_page write-through, sync, dream-cycle reverse-render) therefore
      //    resets the counter below what the DB already holds, and the next
      //    absorb re-issues a row_num that is already taken. That surfaces as
      //    "duplicate key value violates unique constraint idx_facts_fence_key"
      //    and the whole batch of facts is dropped.
      //
      //    Symptom in the wild: a page whose fence had been rewritten away had
      //    24 facts in the DB and none in the file, so every subsequent absorb
      //    on it failed permanently. Taking the max of both sources keeps the
      //    file as the readable mirror while the DB stays authoritative about
      //    which row_nums have been issued.
      //
      //    Degrades to the previous file-only behaviour if the lookup fails
      //    (pre-v51 brain without the fence columns, or a transient DB error):
      //    a fence write must not become impossible just because the counter
      //    hint is unavailable.
      let dbMaxRowNum = 0;
      try {
        const rows = await engine.executeRaw<{ max_row_num: number | null }>(
          `SELECT MAX(row_num) AS max_row_num FROM facts
            WHERE source_id = $1 AND source_markdown_slug = $2`,
          [target.sourceId, target.slug],
        );
        dbMaxRowNum = Number(rows[0]?.max_row_num ?? 0);
      } catch {
        dbMaxRowNum = 0;
      }
      const { facts: existingFenceFacts } = parseFactsFence(body);
      const fileMaxRowNum = existingFenceFacts.length > 0
        ? Math.max(...existingFenceFacts.map(f => f.rowNum))
        : 0;
      let nextRowNum = Math.max(fileMaxRowNum, dbMaxRowNum) + 1;

      const assignedRowNums: number[] = [];
      for (const f of facts) {
        const validFromStr = (f.validFrom ?? new Date()).toISOString().slice(0, 10);
        const { body: updated, rowNum } = upsertFactRow(body, {
          rowNum:      nextRowNum++,
          claim:       f.fact,
          kind:        (f.kind ?? 'fact') as FactKind,
          confidence:  f.confidence ?? 1.0,
          visibility:  f.visibility,
          notability:  f.notability ?? 'medium',
          validFrom:   validFromStr,
          // MEMORY_VERBS v1 (c5): remember's ttl threads through to the fence
          // cell — was hard-coded undefined, which silently dropped expiry on
          // this path. extractFactsFromFenceText derives the DB column from it.
          validUntil:  f.validUntil ? f.validUntil.toISOString().slice(0, 10) : undefined,
          source:      f.source,
          context:     f.context ?? undefined,
        });
        body = updated;
        assignedRowNums.push(rowNum);
      }

      // Snapshot the prewrite git state INSIDE the lock, immediately before
      // the write: an out-of-lock snapshot raced concurrent fence writers — a
      // waiter observed the holder's not-yet-committed rename as pre-existing
      // dirt and mis-attributed it in the audit.
      const durabilityPrewriteState: FactFenceGitPathState = durabilityEnabled
        ? gitPathState(writeRoot, filePath)
        : 'clean';

      // 3. Atomic write: .tmp first, then parse-validate, then rename.
      writeFileSync(tmpPath, body, 'utf-8');

      // 4. Parse-before-rename: re-read the .tmp content and verify the
      //    fence is well-formed. Anything malformed → leave .tmp in
      //    place as quarantine, write JSONL, do NOT insert to DB.
      const tmpBody = readFileSync(tmpPath, 'utf-8');
      const parsed = parseFactsFence(tmpBody);
      if (parsed.warnings.length > 0) {
        recordWriteFailure(target.slug, target.sourceId, parsed.warnings, filePath);
        return { inserted: 0, ids: [], fenceWriteFailed: true };
      }

      // 5. Rename .tmp → file. POSIX atomic; the canonical file is
      //    either the old content or the new content, never partial.
      renameSync(tmpPath, filePath);

      // #4872: mirror the rewritten file into pages.compiled_truth. get_page
      // and the extract_facts reconcile read the DB body, not the file — left
      // stale, a plain get→put round-trip flattens the new row off disk and
      // the next reconcile deletes it from the facts table. Same recipe as
      // forget.ts (#4696): parse + sanitize the FILE bytes as import-file.ts
      // does. Body-only: content_chunks are untouched, so the row KEEPS its
      // old content_hash and the next sync re-imports + re-chunks. Stamping
      // the importer's hash here made sync skip the page and left search
      // blind to the new row forever. Never persist an EMPTY hash: a row
      // that had none gets a row-shaped hash of its pre-mirror content,
      // which the rewritten file can't match. Best-effort: the file is
      // already committed; a stub page with no DB row is created by sync.
      try {
        const reparsed = parseMarkdown(tmpBody, `${target.slug}.md`);
        const existing = await engine.getPage(target.slug, { sourceId: target.sourceId });
        if (existing) {
          await engine.refreshPageBody(target.slug, target.sourceId,
            sanitizeText(reparsed.compiled_truth), sanitizeText(reparsed.timeline),
            existing.content_hash || contentHash(existing));
        }
      } catch { /* degrades to the pre-#4872 window (stale until the next sync) */ }

      // 6. Stamp the DB. extractFactsFromFenceText handles the
      //    validFrom/validUntil date derivation + the strikethrough
      //    semantic distinction. We only want to insert the NEW rows
      //    (those with row_nums in assignedRowNums), so filter the
      //    re-parsed facts to that subset.
      const allExtracted = extractFactsFromFenceText(parsed.facts, target.slug, target.sourceId);
      const newRowSet = new Set(assignedRowNums);
      const toInsert = allExtracted.filter(r => newRowSet.has(r.row_num));

      // Carry per-input embedding + sessionId across — the fence
      // parser doesn't reconstruct embeddings (they're not in the
      // fence text) and source_session is runtime provenance that
      // isn't a fence column either. Stitch them back by row_num
      // index.
      const enriched = toInsert.map((row, i) => ({
        ...row,
        embedding:      facts[i].embedding,
        source_session: facts[i].sessionId,
      }));

      const result = await engine.insertFacts(enriched, { source_id: target.sourceId }); // gbrain-allow-direct-insert: writeFactsToFence is the markdown-first reconcile path; runs only after the atomic fence write commits
      // v0.46 (#3014) — an unresolvable `superseded by #N` reference (self
      // / dangling / struck target) leaves superseded_by NULL; log it rather
      // than swallow it. The row still lands (expired_at set for struck
      // rows), never a bad FK.
      for (const w of result.warnings) {
        // eslint-disable-next-line no-console
        console.warn(`[facts.supersession] ${w}`);
      }
      if (durabilityEnabled) {
        await commitFactFenceFile(
          writeRoot,
          filePath,
          target.slug,
          target.sourceId,
          durabilityPrewriteState,
        );
      }
      return { inserted: result.inserted, ids: result.ids };
    },
    { timeoutMs: 5_000 },
  );
}

/**
 * Look up `sources.local_path` for a given source_id. Returns null
 * when the source has no local_path configured (thin-client / remote-
 * brain installs). Cached via the calling site is not necessary —
 * brains have at most a few sources and the lookup is a single
 * indexed query.
 *
 * Lives here (not in sources-ops.ts) so fence-write callers don't
 * need to thread the sources-ops module through the FactsBackstopCtx.
 */
export async function lookupSourceLocalPath(
  engine: BrainEngine,
  sourceId: string,
): Promise<string | null> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  );
  if (rows.length === 0) return null;
  return rows[0].local_path;
}

// ── Stamp EXISTING legacy rows onto the fence (2026-09-13) ─────────────────
//
// `writeFactsToFence` above inserts NEW rows. The v0.32.2 guard in
// extract-facts.ts halts a source while `row_num IS NULL` rows whose entity
// page is live remain, and the only native drain was the manual, whole-tree-
// refusing Phase B of the migration. This sibling reuses the writer's own
// steps — target resolution, page lock, per-FILE git state, `.tmp` + parse +
// rename, the #4872 body mirror, path-limited commit — and replaces the one
// step that differs: an `UPDATE … WHERE row_num IS NULL` per existing id in
// place of `insertFacts`. What it deliberately does NOT do: stub-create a
// page (a live DB page with no file is drift for the operator), append into a
// file that has no committed preimage (untracked, ignored, or uncommitted —
// git HEAD is the rollback), or assign one row_num to two ids.
//
// Order of operations (2026-09-14 review, finding 1): EVERY validation and
// every DB write happens inside ONE transaction, and the file is renamed into
// place as the LAST step before COMMIT — never before a check can still refuse
// the page. Inside the transaction: lock the page row, require the DB body to
// still be the committed file's body (the reconcile's own stale-cache rule),
// lock every fact row and re-check it against the eligibility snapshot on
// every fence-expressible column, refuse owned row_nums, mirror the fenced
// body, verify the mirror carries every row losslessly, stamp, THEN write the
// file. A refusal at any point throws, so the transaction rolls back with
// nothing written anywhere; a refusal or crash after the rename restores the
// file from the in-memory preimage only once the DB VERIFIABLY rolled back
// (and only if the file is still byte-identical to what this run wrote —
// someone else's edit is never overwritten). An outcome that cannot be read
// is indeterminate: the fenced file stays, since it may be the only backing
// of a committed stamp. So a refused repair — including one refused because a
// concurrent forget expired a row — leaves NO active fence row behind for the
// reconcile to resurrect.
//
// Process-death residue: the only window is between `renameSync` and the
// COMMIT being applied. It leaves the committed preimage plus appended active
// rows on disk, uncommitted, with the DB untouched. The next run recognises
// exactly that shape — working file == HEAD blob + THIS page's never-fenced DB
// rows (expired or not) rendered exactly as this repair renders them, every
// appended row equal to a DB row on every fence column — restores HEAD and
// re-plans from the clean preimage, so a row forgotten in between simply is
// not re-appended. A page whose never-fenced rows have ALL been forgotten is
// visited by the residue-only sweep (`healResidueOnlyPage`, driven from
// fence-legacy.ts) so the residue cannot be imported and re-inserted. Any
// other uncommitted change refuses (`file_uncommitted`). Nothing is ever
// fence-owned before the DB body verifiably carries its fence.
//
// Values are canonicalised the way the fence reads them back: the row is
// rendered through the real renderer and re-parsed (trim, `\|` escaping, blank
// provenance → `fence:reconcile`), and the stamp writes those canonical
// `fact`/`source` values onto the DB row. The reconcile keys rows on exactly
// that view (`factContentKey`), so a raw value that differed only by
// whitespace or a blank source would otherwise read as stale on the very next
// cycle and be wiped + re-inserted under a new id. An on-disk row that already
// carries the same key is re-used only when it loses nothing the DB row holds:
// fields the disk row lacks are filled in place, a conflicting or struck disk
// row refuses the page (`fence_row_mismatch`) — a later wipe + reinsert
// rebuilds every row from the fence, so a lossy fence is silent data loss.

/** One `row_num IS NULL` fact row, as read from the facts table. */
export interface LegacyStampRow {
  id: string;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  notability: NewFact['notability'];
  context: string | null;
  valid_from: Date | string;
  valid_until: Date | string | null;
  source: string | null;
  confidence: number;
  /** v0.35.4 typed-claim columns; carried into the wide fence when set. */
  claim_metric?: string | null;
  claim_value?: number | string | null;
  claim_unit?: string | null;
  claim_period?: string | null;
  /**
   * An ACTIVE legacy row carrying a supersession pointer has no faithful fence
   * form (`superseded by #N` is page-local and the reconcile re-resolves it),
   * so the page is refused (`unexpressible_columns`) rather than silently
   * dropped on the next wipe + reinsert.
   */
  superseded_by?: number | string | null;
}

export type LegacyStampSkipReason =
  | 'write_through_disabled'   // sync.write_through=off: the file is not canonical here
  | 'target_unresolvable'      // resolvePageWriteTarget refused
  | 'file_missing'             // live DB page, no file — never stub-created here
  | 'symlink'                  // target or temp path is a symlink / pre-exists
  | 'file_uncommitted'         // THIS file is not what HEAD holds (modified, untracked, or staged-only): no committed preimage
  | 'foreign_dirty'            // unmerged/rename/unattributable git state, not a git repo, or git-ignored path
  | 'fence_parse_failed'       // existing or rendered fence does not parse / row does not survive a round-trip
  | 'duplicate_legacy_rows'    // two ids share the canonical (fact, source): one row_num cannot own both
  | 'unexpressible_columns'    // a row carries a column the fence cannot express (superseded_by on an active row)
  | 'fence_row_mismatch'       // the on-disk row with the same (claim, source) conflicts with the DB row, or is struck
  | 'concurrent_edit'          // file changed between read and rename
  | 'verify_failed'            // DB body is not the file's body, or did not carry every assigned row after the mirror
  | 'fence_row_owned'          // an assigned row_num already belongs to another fact id
  | 'row_changed'              // a fact row was expired, stamped, superseded, moved, or edited between snapshot and stamp
  | 'lock_busy'
  | 'error';

export interface LegacyStampResult {
  slug: string;
  status: 'stamped' | 'skipped';
  reason?: LegacyStampSkipReason;
  detail?: string;
  /** Rows stamped (row_num + source_markdown_slug) by this call. */
  stamped: number;
  /** Rows appended to the fence file (0 when the fence already carried them). */
  appended: number;
  /** Existing fence rows rewritten in place to carry fields only the DB row held. */
  rewritten: number;
  committed: boolean;
}

/**
 * Test-only seams; each runs immediately before the named transition.
 * `beforeStamp` runs OUTSIDE the transaction (after the read-only plan) — a
 * concurrent writer injected there is what the locked re-check must catch.
 * Every other seam runs INSIDE the stamp transaction: a throw rolls the whole
 * stamp back (and, after `beforeCommit`, restores the file); on PGLite they
 * must not touch the engine (single connection).
 */
export interface LegacyStampHooks {
  beforeStamp?: (slug: string) => void | Promise<void>;
  /** After the page row and every fact row are locked FOR UPDATE and re-checked, before any write. */
  afterRowLock?: (slug: string) => void | Promise<void>;
  beforeMirror?: (slug: string) => void | Promise<void>;
  /** After the first row UPDATE. */
  afterFirstStampUpdate?: (slug: string) => void | Promise<void>;
  /** After every row UPDATE, before the file rename. */
  beforeRename?: (slug: string) => void | Promise<void>;
  /** After the file rename, before COMMIT. */
  beforeCommit?: (slug: string) => void | Promise<void>;
  /** OUTSIDE the transaction, immediately after it committed: a throw models a lost COMMIT acknowledgement. */
  afterCommit?: (slug: string) => void | Promise<void>;
  /** Inside each attempt to verify whether a COMMIT landed: a throw models the verification query being unavailable. */
  beforeVerifyLanded?: (slug: string) => void | Promise<void>;
}

/** A refusal raised inside the stamp transaction: rolls it back, reported as `skipped`. */
class StampRefusal extends Error {
  constructor(public readonly reason: LegacyStampSkipReason, public readonly refusalDetail?: string) {
    super(`stamp refused: ${reason}${refusalDetail ? ` (${refusalDetail})` : ''}`);
    this.name = 'StampRefusal';
  }
}

/**
 * A `timestamptz` column rendered as the fence's `YYYY-MM-DD`: its UTC calendar
 * day, whatever the session time zone. That is the day every fence writer
 * renders (`toISOString().slice(0, 10)`, incl. the v0.32.2 backfill) and the
 * day the fence mapper parses back (`new Date('YYYY-MM-DD')` is UTC midnight),
 * so a row inserted through the API round-trips. Rendering in the SESSION zone
 * instead shifts a UTC-midnight instant back a day under any negative offset.
 */
export function fenceDateSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
}

function legacyIsoDate(v: Date | string | null | undefined): string | undefined {
  if (v == null) return undefined;
  // Every repair SELECT renders the day with fenceDateSql; a Date (tests,
  // typed callers) takes the same UTC day.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(v)) return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function legacyNumber(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The fence row a legacy DB row renders to — BEFORE the round-trip. */
function legacyRowToFenceRow(row: LegacyStampRow, rowNum: number): ParsedFact {
  return {
    rowNum,
    claim:       row.fact,
    kind:        row.kind,
    confidence:  row.confidence,
    visibility:  row.visibility,
    notability:  row.notability ?? 'medium',
    validFrom:   legacyIsoDate(row.valid_from) ?? '',
    validUntil:  legacyIsoDate(row.valid_until),
    source:      row.source ?? undefined,
    context:     row.context ?? undefined,
    active:      true,
    claimMetric: row.claim_metric ?? undefined,
    claimValue:  legacyNumber(row.claim_value),
    claimUnit:   row.claim_unit ?? undefined,
    claimPeriod: row.claim_period ?? undefined,
  };
}

/**
 * How the fence will read this row back: render through the real renderer,
 * re-parse with the real parser. Null when the row does not survive (parse
 * warning, or the claim reads as strikethrough / a different row).
 */
function fenceRoundTrip(row: LegacyStampRow): ParsedFact | null {
  const parsed = parseFactsFence(renderFactsTable([legacyRowToFenceRow(row, 1)]));
  if (parsed.warnings.length > 0 || parsed.facts.length !== 1) return null;
  const view = parsed.facts[0]!;
  if (!view.active || view.rowNum !== 1) return null;
  return view;
}

/** The reconcile's content key (`factContentKey` in extract-facts.ts), on fence-parsed values. */
function fenceKey(claim: string, source: string | null | undefined): string {
  return `${claim}\u0000${source ?? FENCE_SOURCE_DEFAULT}`;
}

/**
 * Every fence column with a meaning of its own — the fields a later wipe +
 * reinsert rebuilds the DB row from. `claim`/`source` are the key; `rowNum`,
 * `active`, `supersededBy`, `forgotten` are position/state, compared separately.
 */
const VIEW_FIELDS = [
  'kind', 'confidence', 'visibility', 'notability',
  'validFrom', 'validUntil', 'context',
  'claimMetric', 'claimValue', 'claimUnit', 'claimPeriod',
] as const;
type ViewField = typeof VIEW_FIELDS[number];

/** Two canonical views describe the same row on every expressible column. */
function viewEquals(a: ParsedFact, b: ParsedFact): boolean {
  return fenceKey(a.claim, a.source) === fenceKey(b.claim, b.source)
    && VIEW_FIELDS.every(f => a[f] === b[f]);
}

/**
 * `onDisk` carries `view` losslessly: same key, active, and every column the
 * DB row holds is present with the same value (the disk row may hold more).
 */
function rowCarriesView(onDisk: ParsedFact, view: ParsedFact): boolean {
  return onDisk.active
    && fenceKey(onDisk.claim, onDisk.source) === fenceKey(view.claim, view.source)
    && VIEW_FIELDS.every(f => view[f] === undefined || onDisk[f] === view[f]);
}

/**
 * Existing-fence re-use (review finding 2). `same`: the disk row already
 * carries everything the DB row holds. `merge`: the disk row lacks fields the
 * DB row has and conflicts on none — the merged row fills them in place.
 * `conflict`: a column is set on both sides with different values (names it).
 */
function reconcileDiskRow(onDisk: ParsedFact, view: ParsedFact):
  | { kind: 'same' }
  | { kind: 'merge'; merged: ParsedFact; filled: ViewField[] }
  | { kind: 'conflict'; field: ViewField } {
  const filled: ViewField[] = [];
  const merged: ParsedFact = { ...onDisk, active: true };
  for (const f of VIEW_FIELDS) {
    const disk = onDisk[f];
    const db = view[f];
    if (db === undefined || disk === db) continue;
    if (disk !== undefined) return { kind: 'conflict', field: f };
    Object.assign(merged, { [f]: db });
    filled.push(f);
  }
  return filled.length === 0 ? { kind: 'same' } : { kind: 'merge', merged, filled };
}

/** Replace the fence row numbered `row.rowNum` in `body`; null when the fence is not cleanly editable. */
function replaceFenceRow(body: string, row: ParsedFact): string | null {
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length > 0 || !parsed.facts.some(f => f.rowNum === row.rowNum)) return null;
  const begin = body.indexOf(FACTS_FENCE_BEGIN);
  const end = body.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
  if (begin === -1 || end === -1) return null;
  const fence = renderFactsTable(parsed.facts.map(f => (f.rowNum === row.rowNum ? row : f)));
  return body.slice(0, begin) + fence + body.slice(end + FACTS_FENCE_END.length);
}

/** Every assignment present in `body`'s fence, active, with the canonical key and no field of the DB row lost. */
function fenceCarries(body: string, views: Map<string, ParsedFact>, assignments: Array<{ id: string; row_num: number }>): boolean {
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length > 0) return false;
  const byRowNum = new Map(parsed.facts.map(f => [f.rowNum, f]));
  return assignments.every(a => {
    const onPage = byRowNum.get(a.row_num);
    const view = views.get(a.id);
    return onPage !== undefined && view !== undefined && rowCarriesView(onPage, view);
  });
}

/**
 * The pages-cache body must be the committed file's body before this run
 * mirrors over it — the same rule the reconcile applies before a destructive
 * pass (`canonicalCacheState` in extract-facts.ts). A DB body that is NOT the
 * file's (a save whose write-through never landed) would be silently replaced
 * by file-derived content.
 */
function pageBodyIsFile(page: { compiled_truth: string | null; timeline: string | null }, fileBody: string, slug: string): boolean {
  const parsed = parseMarkdown(fileBody, `${slug}.md`);
  return sanitizeText(parsed.compiled_truth).trim() === (page.compiled_truth ?? '').trim()
    && sanitizeText(parsed.timeline).trim() === (page.timeline ?? '').trim();
}

/** Exclusive-create temp sibling + rename (the writePageThrough convention); never follows a pre-planted link. */
function atomicReplace(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let tmpPreexists = true;
  try { lstatSync(tmpPath); } catch { tmpPreexists = false; }
  if (tmpPreexists) throw new StampRefusal('symlink', `temp path pre-exists: ${tmpPath}`);
  writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

function skip(slug: string, reason: LegacyStampSkipReason, detail?: string): LegacyStampResult {
  return { slug, status: 'skipped', reason, detail, stamped: 0, appended: 0, rewritten: 0, committed: false };
}

interface StampPlan {
  preBody: string;
  body: string;
  assignments: Array<{ id: string; row_num: number }>;
  appended: number;
  rewritten: number;
  /** A crashed run's uncommitted appends were recognised and the committed preimage restored first. */
  healedResidue: boolean;
}

/**
 * Process-death residue (see the header): the working file is EXACTLY what a
 * crashed run of this repair rendered — the committed preimage plus active
 * rows appended through the real renderer FROM THIS PAGE'S OWN never-fenced DB
 * rows (expired or not — a row forgotten after the crash still proves the
 * append was this repair's). Every appended row must equal a DB row's canonical
 * view on every fence column, and re-rendering those DB rows onto HEAD must
 * reproduce the working file byte for byte; a row that merely shares the
 * (claim, source) key but carries a note, a date or typed columns the DB row
 * does not is someone's addition and refuses (`not_residue`). The DB read is
 * an await: the file is re-read immediately before the rename and only the
 * exact bytes recognised as residue are ever replaced — a save that landed
 * meanwhile is someone's and stays (`not_residue`). Restores HEAD in place.
 *
 * `healed` is reported only once the pages cache is PROVEN to carry the
 * restored body too (`residueCacheIsFile`): a sync may already have imported
 * the residue, and the reconcile inserts from the cache. Otherwise
 * `cache_unsafe` — the file is healed, the page is not yet safe to reconcile.
 */
export type ResidueHealOutcome = 'healed' | 'cache_unsafe' | 'not_residue';

async function healCrashResidue(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  writeRoot: string,
  filePath: string,
): Promise<ResidueHealOutcome> {
  const headBody = gitHeadBlob(writeRoot, filePath);
  if (headBody === null) return 'not_residue';
  const working = readFileSync(filePath, 'utf-8');
  const head = parseFactsFence(headBody);
  const work = parseFactsFence(working);
  if (head.warnings.length > 0 || work.warnings.length > 0) return 'not_residue';
  const headNums = new Set(head.facts.map(f => f.rowNum));
  const extras = work.facts.filter(f => !headNums.has(f.rowNum)).sort((a, b) => a.rowNum - b.rowNum);
  if (extras.length === 0 || extras.some(f => !f.active)) return 'not_residue';
  const dbRows = await engine.executeRaw<LegacyStampRow>(
    `SELECT id::text AS id, fact, kind, visibility, notability, context,
            ${fenceDateSql('valid_from')} AS valid_from, ${fenceDateSql('valid_until')} AS valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, superseded_by
       FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL`,
    [sourceId, slug],
  );
  const views: Array<{ row: LegacyStampRow; view: ParsedFact }> = [];
  for (const r of dbRows) {
    const v = fenceRoundTrip(r);
    if (v) views.push({ row: r, view: v });
  }
  // Byte-exact reconstruction: HEAD plus THE DB ROWS rendered exactly as the
  // crashed run rendered them, in the order it appended. A parsed extra that
  // matches no DB row on every column, or a diff that is not exactly those
  // appends, is not ours.
  let rebuilt = headBody;
  const used = new Set<string>();
  for (const f of extras) {
    const match = views.find(({ row, view }) => !used.has(row.id) && viewEquals(f, view));
    if (!match) return 'not_residue';
    used.add(match.row.id);
    rebuilt = upsertFactRow(rebuilt, legacyRowToFenceRow(match.row, f.rowNum)).body;
  }
  if (rebuilt !== working) return 'not_residue';
  if (readFileSync(filePath, 'utf-8') !== working) return 'not_residue';
  atomicReplace(filePath, headBody);
  return residueCacheIsFile(engine, sourceId, slug, headBody, working, filePath);
}

/**
 * The pages cache after a residue restore: already the preimage's body (or no
 * row) → `healed`; the residue's body → put back to the preimage (hash kept,
 * so the next sync re-imports) and READ BACK before `healed`; any other body,
 * a refresh that fails, or a cache that cannot be read → `cache_unsafe`,
 * audited to the write-failure log.
 */
async function residueCacheIsFile(
  engine: BrainEngine, sourceId: string, slug: string, headBody: string, residueBody: string, filePath: string,
): Promise<'healed' | 'cache_unsafe'> {
  const unsafe = (why: string): 'cache_unsafe' => {
    recordWriteFailure(slug, sourceId, [`residue_cache_unsafe: ${why}`], filePath);
    return 'cache_unsafe';
  };
  try {
    const page = await engine.getPage(slug, { sourceId });
    if (!page || pageBodyIsFile(page, headBody, slug)) return 'healed';
    if (!pageBodyIsFile(page, residueBody, slug)) return unsafe('cache body is neither the preimage nor the residue; run gbrain sync');
    const restored = parseMarkdown(headBody, `${slug}.md`);
    await engine.refreshPageBody(slug, sourceId,
      sanitizeText(restored.compiled_truth), sanitizeText(restored.timeline),
      page.content_hash || contentHash(page));
    const after = await engine.getPage(slug, { sourceId });
    return after && pageBodyIsFile(after, headBody, slug) ? 'healed' : unsafe('cache did not read back as the preimage after refresh');
  } catch (err) {
    return unsafe(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `clean` is PROVEN: the file is tracked with a blob at HEAD and its status is
 * empty. `error` (lock not acquired, a throw mid-sweep, or a git state that
 * could not be read at all) leaves the page's state unknown; `skipped` means
 * the sweep never looked (write-through off, target unresolvable, file
 * missing or a symlink). The caller blocks the reconcile on `not_residue`,
 * `cache_unsafe` and `error`.
 */
export type ResidueSweepOutcome = ResidueHealOutcome | 'clean' | 'skipped' | 'error';

/**
 * Residue-only entry point for a page that has NO eligible legacy row left —
 * every never-fenced row on it has been forgotten since a crashed run appended
 * them (review finding 3). The stamp path never visits such a page, so a sync
 * would import the uncommitted residue and the reconcile would re-insert the
 * forgotten claims. Same lock, same target resolution, same recognizer as the
 * stamp path; a clean file or an unresolvable target is a no-op. Only a
 * PROVEN clean file reads as clean — empty status on a file git holds at
 * HEAD. Uncommitted change the parse cannot attribute to the file
 * (`foreign_dirty`), or an empty status on a file with no committed preimage
 * (an ignored path — the shape a source nested in an unrelated repo yields),
 * is handed back `not_residue`; a git that could not be asked (`unknown`, a
 * directory that is not a repository) is `error`. None of those proves the
 * file free of a crashed run's appends. Never throws.
 */
export async function healResidueOnlyPage(
  engine: BrainEngine,
  target: { sourceId: string; slug: string },
  opts: { lockTimeoutMs?: number } = {},
): Promise<{ slug: string; outcome: ResidueSweepOutcome; detail?: string }> {
  const { sourceId, slug } = target;
  type Verdict = { slug: string; outcome: ResidueSweepOutcome; detail?: string };
  const unproven = (state: string, why: string): Verdict =>
    state === 'unknown'
      ? { slug, outcome: 'error', detail: 'git state unknown: not a git repository, or git could not be run' }
      : { slug, outcome: 'not_residue', detail: `${state}: ${why}` };
  // `self_dirty` → recognise; a verdict otherwise.
  const proven = (writeRoot: string, filePath: string): 'self_dirty' | Verdict => {
    const state = gitPathState(writeRoot, filePath);
    if (state === 'self_dirty') return state;
    if (state !== 'clean') return unproven(state, 'uncommitted changes the sweep cannot attribute to this repair');
    const tracked = gitTrackedAtHead(writeRoot, filePath);
    return tracked === 'tracked' ? { slug, outcome: 'clean' } : unproven(tracked, 'no committed preimage to prove the file against');
  };
  try {
    if (await isWriteThroughDisabled(engine)) return { slug, outcome: 'skipped', detail: 'write_through_disabled' };
    const resolved = await resolvePageWriteTarget(engine, slug, sourceId);
    if (!resolved.ok) return { slug, outcome: 'skipped', detail: resolved.skipped };
    const { filePath, writeRoot } = resolved;
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(filePath); } catch { return { slug, outcome: 'skipped', detail: 'file_missing' }; }
    if (st.isSymbolicLink() || !st.isFile()) return { slug, outcome: 'skipped', detail: 'symlink' };
    const state = proven(writeRoot, filePath);
    if (state !== 'self_dirty') return state;
    return await withPageLock(slug, async () => {
      const locked = proven(writeRoot, filePath);
      if (locked !== 'self_dirty') return locked;
      const outcome = await healCrashResidue(engine, sourceId, slug, writeRoot, filePath);
      return { slug, outcome };
    }, { timeoutMs: opts.lockTimeoutMs ?? 5_000 });
  } catch (err) {
    return { slug, outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stamp one page's legacy rows. Never throws — every outcome is a
 * `LegacyStampResult`, so a repair pass keeps every counter and block it has
 * collected whatever one page does. The locked body below already refuses per
 * page; this boundary contains the reads BEFORE the lock (the write-through
 * switch, target resolution, a dry-run's plan), which reach the DB and the
 * file too and used to escape as a throw that discarded the pass's summary.
 */
export async function stampLegacyFactsToFence(
  engine: BrainEngine,
  target: { sourceId: string; slug: string },
  rows: LegacyStampRow[],
  opts: { dryRun?: boolean; lockTimeoutMs?: number; hooks?: LegacyStampHooks } = {},
): Promise<LegacyStampResult> {
  try {
    return await stampLegacyFactsToFenceUnguarded(engine, target, rows, opts);
  } catch (err) {
    return skip(target.slug, 'error', err instanceof Error ? err.message : String(err));
  }
}

async function stampLegacyFactsToFenceUnguarded(
  engine: BrainEngine,
  target: { sourceId: string; slug: string },
  rows: LegacyStampRow[],
  opts: { dryRun?: boolean; lockTimeoutMs?: number; hooks?: LegacyStampHooks },
): Promise<LegacyStampResult> {
  const { sourceId, slug } = target;
  if (rows.length === 0) return { slug, status: 'stamped', stamped: 0, appended: 0, rewritten: 0, committed: false };
  if (await isWriteThroughDisabled(engine)) return skip(slug, 'write_through_disabled');

  // Canonical view of every row, exactly as the fence will read it back.
  const views = new Map<string, ParsedFact>();
  for (const r of rows) {
    if (r.superseded_by != null) {
      return skip(slug, 'unexpressible_columns', `id ${r.id}: superseded_by=${r.superseded_by} on an active row has no fence form`);
    }
    // #1928: `cli:`-origin conversation facts are never fence-owned — the
    // reconcile's listExistingFactsForPage excludes them, so a stamped one
    // would be re-inserted against its own row_num (idx_facts_fence_key).
    if ((r.source ?? '').startsWith('cli:')) {
      return skip(slug, 'unexpressible_columns', `id ${r.id}: source=${r.source} is conversation provenance, not fence-owned`);
    }
    const view = fenceRoundTrip(r);
    if (!view) return skip(slug, 'fence_parse_failed', `id ${r.id}: row does not survive a fence round-trip: ${r.fact.slice(0, 60)}`);
    views.set(r.id, view);
  }

  // Codex #3: one row_num cannot own two ids. Refuse the page rather than
  // fabricate convergence; the operator drains one via forget_fact. Keyed on
  // the canonical view, so `''` and `fence:reconcile` provenance collide here
  // exactly as they collide in the reconcile.
  const seen = new Set<string>();
  for (const r of rows) {
    const v = views.get(r.id)!;
    const k = fenceKey(v.claim, v.source);
    if (seen.has(k)) return skip(slug, 'duplicate_legacy_rows', `(fact, source) repeated: ${v.claim.slice(0, 60)}`);
    seen.add(k);
  }

  const resolved = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!resolved.ok) return skip(slug, 'target_unresolvable', resolved.skipped);
  const { filePath, writeRoot } = resolved;

  // Read-only planning: file state, git state, on-disk de-dupe, row_num
  // assignment. Runs with no lock for a dry-run (nothing is written, no lock
  // dir or lockfile is created, no stale lock is reaped) and again INSIDE the
  // lock for a real run, so the plan always describes the file as locked. The
  // one write a locked plan may perform is restoring the committed preimage
  // over a crashed run's own uncommitted appends (`healCrashResidue`).
  const plan = async (locked: boolean): Promise<StampPlan | LegacyStampResult> => {
    // Never follow a link, never stub-create.
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(filePath); } catch { return skip(slug, 'file_missing', filePath); }
    if (st.isSymbolicLink() || !st.isFile()) return skip(slug, 'symlink', filePath);

    // Per-FILE git state (the writer's own rule), then a committed preimage:
    // empty status alone also describes ignored and untracked files.
    let gitState = gitPathState(writeRoot, filePath);
    let healedResidue = false;
    if (gitState === 'self_dirty' && locked) {
      // `cache_unsafe` restored the file too; the stamp transaction's own
      // DB-body-is-the-file check (`verify_failed`) then decides.
      if (await healCrashResidue(engine, sourceId, slug, writeRoot, filePath) !== 'not_residue') {
        healedResidue = true;
        gitState = gitPathState(writeRoot, filePath);
      }
    }
    if (gitState === 'self_dirty') return skip(slug, 'file_uncommitted', filePath);
    if (gitState !== 'clean') return skip(slug, 'foreign_dirty', `${gitState}: ${filePath}`);
    const tracked = gitTrackedAtHead(writeRoot, filePath);
    if (tracked === 'untracked' || tracked === 'not_at_head') return skip(slug, 'file_uncommitted', `${tracked}: ${filePath}`);
    if (tracked !== 'tracked') return skip(slug, 'foreign_dirty', `${tracked}: ${filePath}`);

    const preBody = readFileSync(filePath, 'utf-8');
    const pre = parseFactsFence(preBody);
    if (pre.warnings.length > 0) return skip(slug, 'fence_parse_failed', pre.warnings.join('; '));

    // De-dupe against the fence on disk and seed the counter from BOTH
    // stores, exactly as writeFactsToFence does, so no issued row_num is
    // reused. Only an ACTIVE disk row can stand in for an active DB row; a
    // struck one with the same key would make the reconcile expire the DB
    // row on the next cycle.
    const activeByKey = new Map<string, ParsedFact>();
    const struckKeys = new Set<string>();
    for (const f of pre.facts) {
      const k = fenceKey(f.claim, f.source);
      if (!f.active) { struckKeys.add(k); continue; }
      if (!activeByKey.has(k)) activeByKey.set(k, f);
    }
    let dbMax = 0;
    try {
      const r = await engine.executeRaw<{ max_row_num: number | null }>(
        `SELECT MAX(row_num) AS max_row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2`,
        [sourceId, slug],
      );
      dbMax = Number(r[0]?.max_row_num ?? 0);
    } catch { dbMax = 0; }
    const fileMax = pre.facts.length > 0 ? Math.max(...pre.facts.map(f => f.rowNum)) : 0;
    let next = Math.max(fileMax, dbMax) + 1;

    let body = preBody;
    const assignments: Array<{ id: string; row_num: number }> = [];
    let appended = 0;
    let rewritten = 0;
    for (const row of rows) {
      const v = views.get(row.id)!;
      const k = fenceKey(v.claim, v.source);
      const onDisk = activeByKey.get(k);
      if (onDisk !== undefined) {
        const cmp = reconcileDiskRow(onDisk, v);
        if (cmp.kind === 'conflict') {
          return skip(slug, 'fence_row_mismatch', `id ${row.id}: fence row #${onDisk.rowNum} differs on ${cmp.field} (${String(onDisk[cmp.field])} vs ${String(v[cmp.field])})`);
        }
        if (cmp.kind === 'merge') {
          const updated = replaceFenceRow(body, cmp.merged);
          if (updated === null) return skip(slug, 'fence_parse_failed', `id ${row.id}: fence row #${onDisk.rowNum} could not be rewritten in place`);
          body = updated;
          rewritten += 1;
        }
        assignments.push({ id: row.id, row_num: onDisk.rowNum });
        continue;
      }
      if (struckKeys.has(k)) {
        return skip(slug, 'fence_row_mismatch', `id ${row.id}: the fence carries this claim struck through while the DB row is active`);
      }
      const { body: updated, rowNum } = upsertFactRow(body, legacyRowToFenceRow(row, next++));
      body = updated;
      assignments.push({ id: row.id, row_num: rowNum });
      appended += 1;
    }
    return { preBody, body, assignments, appended, rewritten, healedResidue };
  };

  if (opts.dryRun) {
    const p = await plan(false);
    if ('status' in p) return p;
    return { slug, status: 'stamped', stamped: 0, appended: p.appended, rewritten: p.rewritten, committed: false, detail: `dry-run: would stamp ${p.assignments.length}, append ${p.appended}, rewrite ${p.rewritten}` };
  }

  let locked = false;
  try {
    return await withPageLock(slug, async () => {
      locked = true;
      const p = await plan(true);
      if ('status' in p) return p;
      const { preBody, body, assignments, appended, rewritten, healedResidue } = p;
      const fileChanges = appended > 0 || rewritten > 0;

      // Verify the rendered body BEFORE the transaction opens (pure string
      // work — nothing is written yet): a body that does not carry every row
      // losslessly refuses without a transaction.
      if (!fenceCarries(body, views, assignments)) {
        recordWriteFailure(slug, sourceId, parseFactsFence(body).warnings, filePath);
        return skip(slug, 'fence_parse_failed', 'rendered fence failed re-parse');
      }

      // Everything below is ONE transaction: page row locked first (the
      // postgres-engine.ts:2276 idiom), the DB body required to be the file's,
      // every fact row locked and re-checked against its eligibility snapshot
      // on every fence column (a forget, a supersession, a competing stamp, a
      // move or an edit refuses the page), owned row_nums refused, then the
      // mirror + verify + stamp, and the file rename as the LAST step before
      // COMMIT. A refusal throws `StampRefusal` so the transaction rolls back
      // with nothing written; a refusal or crash after the rename also puts
      // the preimage back (review finding 1: a refused repair leaves no active
      // fence row behind).
      await opts.hooks?.beforeStamp?.(slug);
      const ids = assignments.map(a => a.id);
      const nums = assignments.map(a => a.row_num);
      let renamed = false;
      let stampedCount = 0;
      try {
        stampedCount = await engine.transaction(async (tx) => {
          const pageLock = await tx.executeRaw<{ id: string }>(
            `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL FOR UPDATE`,
            [slug, sourceId],
          );
          if (pageLock.length === 0) throw new StampRefusal('verify_failed', 'page row missing');
          const page = await tx.getPage(slug, { sourceId });
          if (!page) throw new StampRefusal('verify_failed', 'page row missing');
          if (!pageBodyIsFile(page, preBody, slug)) {
            throw new StampRefusal('verify_failed', 'DB body is not the committed file\'s body (stale page cache; run gbrain sync)');
          }

          const current = await tx.executeRaw<LegacyStampRow & { expired_at: unknown; row_num: number | null; entity_slug: string | null }>(
            `SELECT id::text AS id, fact, source, kind, visibility, notability, context,
                    ${fenceDateSql('valid_from')} AS valid_from, ${fenceDateSql('valid_until')} AS valid_until, confidence,
                    claim_metric, claim_value, claim_unit, claim_period, superseded_by, expired_at, row_num, entity_slug
               FROM facts WHERE id = ANY($1::bigint[]) AND source_id = $2 FOR UPDATE`,
            [ids.map(Number), sourceId],
          );
          const byId = new Map(current.map(c => [c.id, c]));
          for (const id of ids) {
            const c = byId.get(id);
            if (!c) throw new StampRefusal('row_changed', `id ${id}: row no longer exists in source ${sourceId}`);
            if (c.expired_at != null) throw new StampRefusal('row_changed', `id ${id}: expired since eligibility was read`);
            if (c.row_num != null) throw new StampRefusal('row_changed', `id ${id}: already fence-owned (#${c.row_num})`);
            if (c.entity_slug !== slug) throw new StampRefusal('row_changed', `id ${id}: moved to page ${c.entity_slug ?? 'NULL'} since eligibility was read`);
            if (c.superseded_by != null) throw new StampRefusal('row_changed', `id ${id}: superseded (by ${c.superseded_by}) since eligibility was read`);
            const nowView = fenceRoundTrip(c);
            const then = views.get(id)!;
            if (!nowView || !viewEquals(nowView, then)) {
              throw new StampRefusal('row_changed', `id ${id}: edited since eligibility was read (${describeViewDiff(nowView, then)})`);
            }
          }
          const owned = await tx.executeRaw<{ id: string; row_num: number }>(
            `SELECT id::text AS id, row_num FROM facts
              WHERE source_id = $1 AND source_markdown_slug = $2
                AND row_num = ANY($3::int[]) AND NOT (id::text = ANY($4::text[]))`,
            [sourceId, slug, nums, ids],
          );
          if (owned.length > 0) {
            throw new StampRefusal('fence_row_owned', owned.map(o => `#${o.row_num} is id ${o.id}`).join(' '));
          }
          await opts.hooks?.afterRowLock?.(slug);

          // #4872 mirror, REQUIRED here: a row must not become fence-owned
          // while the DB body still lacks its fence. Same transaction, so the
          // verify below reads exactly what the stamp will commit with.
          await opts.hooks?.beforeMirror?.(slug);
          const reparsed = parseMarkdown(body, `${slug}.md`);
          await tx.refreshPageBody(slug, sourceId,
            sanitizeText(reparsed.compiled_truth), sanitizeText(reparsed.timeline),
            page.content_hash || contentHash(page));
          const mirrored = await tx.getPage(slug, { sourceId });
          if (!mirrored || !fenceCarries(mirrored.compiled_truth ?? '', views, assignments)) {
            throw new StampRefusal('verify_failed', 'DB body does not carry every assigned row after the mirror');
          }

          let stamped = 0;
          for (const a of assignments) {
            const v = views.get(a.id)!;
            const r = await tx.executeRaw<{ id: string }>(
              `UPDATE facts SET row_num = $1, source_markdown_slug = $2, fact = $3, source = $4
                WHERE id = $5 AND source_id = $6 AND row_num IS NULL AND expired_at IS NULL
                RETURNING id::text AS id`,
              [a.row_num, slug, v.claim, v.source ?? FENCE_SOURCE_DEFAULT, a.id, sourceId],
            );
            if (r.length !== 1) {
              throw new Error(`stamp: id ${a.id} did not update inside the locked transaction`);
            }
            stamped += r.length;
            if (stamped === 1) await opts.hooks?.afterFirstStampUpdate?.(slug);
          }

          // The file, last. Unique temp name (the writePageThrough
          // convention), exclusive create, re-read, never through a link
          // (Codex #4). The file must still be what we read — on the reuse
          // path too (review finding 5): the rows being stamped are backed
          // ONLY by the fence that was planned against, so an edit that
          // landed since is refused, never overwritten and never stamped over.
          await opts.hooks?.beforeRename?.(slug);
          if (readFileSync(filePath, 'utf-8') !== preBody) throw new StampRefusal('concurrent_edit', filePath);
          if (fileChanges) {
            atomicReplace(filePath, body);
            renamed = true;
            if (readFileSync(filePath, 'utf-8') !== body) throw new StampRefusal('fence_parse_failed', 'file did not read back as written');
          }
          await opts.hooks?.beforeCommit?.(slug);
          return stamped;
        });
        // Test seam for a lost COMMIT acknowledgement: the transaction is
        // committed, the caller never learns it.
        await opts.hooks?.afterCommit?.(slug);
      } catch (err) {
        if (renamed) {
          // The rename landed but the transaction did not report success. If
          // the COMMIT was in fact applied (the ack was lost), the DB is
          // stamped and the file must stay; if it verifiably rolled back, the
          // preimage goes back — but only over OUR bytes. An outcome that
          // cannot be read is INDETERMINATE (review finding 1): the file is
          // left fenced, because it may be the only backing of a committed
          // stamp, and a next run either finds the rows stamped (done) or
          // recognises the appends as this repair's residue and re-plans.
          const landed = await stampLanded(engine, sourceId, assignments, opts.hooks, slug);
          if (landed === 'landed') {
            return { slug, status: 'stamped', stamped: assignments.length, appended, rewritten, committed: false, detail: 'commit acknowledgement lost; stamp verified in the DB' };
          }
          if (landed === 'rolled_back') {
            restorePreimage(filePath, body, preBody, slug, sourceId);
          } else {
            recordWriteFailure(slug, sourceId, ['stamp_commit_outcome_unknown_file_left_fenced'], filePath);
            return skip(slug, 'error', `commit outcome unknown (${err instanceof Error ? err.message : String(err)}); file left fenced, nothing restored`);
          }
        }
        if (err instanceof StampRefusal) return skip(slug, err.reason, err.refusalDetail);
        throw err;
      }

      let committed = false;
      if (fileChanges && isDurabilityHardened(writeRoot)) {
        await commitFactFenceFile(writeRoot, filePath, slug, sourceId, 'clean');
        committed = gitPathState(writeRoot, filePath) === 'clean';
      }
      return {
        slug, status: 'stamped', stamped: stampedCount, appended, rewritten, committed,
        ...(healedResidue ? { detail: 'restored the committed preimage over a crashed run\'s uncommitted appends first' } : {}),
      };
    }, { timeoutMs: opts.lockTimeoutMs ?? 5_000 });
  } catch (err) {
    if (err instanceof StampRefusal) return skip(slug, err.reason, err.refusalDetail);
    const msg = err instanceof Error ? err.message : String(err);
    return skip(slug, locked ? 'error' : 'lock_busy', msg);
  }
}

/** Which expressible column a re-read row differs on, for the refusal detail. */
function describeViewDiff(now: ParsedFact | null, then: ParsedFact): string {
  if (!now) return 'row no longer survives a fence round-trip';
  if (fenceKey(now.claim, now.source) !== fenceKey(then.claim, then.source)) return 'fact/source';
  const f = VIEW_FIELDS.find(field => now[field] !== then[field]);
  return f ? `${f}: ${String(then[f])} -> ${String(now[f])}` : 'unknown column';
}

/**
 * After a post-rename transaction failure: did the COMMIT actually apply?
 * `landed` when every assignment is stamped exactly as planned; `rolled_back`
 * when every assignment still reads as never-fenced; `unknown` when the
 * verification itself cannot be read (three attempts) or the rows are in
 * neither state. Only a verified rollback licenses touching the file.
 */
async function stampLanded(
  engine: BrainEngine,
  sourceId: string,
  assignments: Array<{ id: string; row_num: number }>,
  hooks?: LegacyStampHooks,
  slug?: string,
): Promise<'landed' | 'rolled_back' | 'unknown'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await hooks?.beforeVerifyLanded?.(slug ?? '');
      const rows = await engine.executeRaw<{ id: string; row_num: number | null }>(
        `SELECT id::text AS id, row_num FROM facts WHERE id = ANY($1::bigint[]) AND source_id = $2`,
        [assignments.map(a => Number(a.id)), sourceId],
      );
      const byId = new Map(rows.map(r => [r.id, r.row_num]));
      if (assignments.every(a => Number(byId.get(a.id)) === a.row_num)) return 'landed';
      if (assignments.every(a => byId.has(a.id) && byId.get(a.id) == null)) return 'rolled_back';
      return 'unknown';
    } catch {
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  return 'unknown';
}

/**
 * Put the committed preimage back after the DB rolled back — only if the file
 * still holds exactly what this run wrote. Anything else is someone's edit
 * that landed outside the page lock and is left alone (audited, so the next
 * run's `file_uncommitted` refusal has a cause on record).
 */
function restorePreimage(filePath: string, written: string, preimage: string, slug: string, sourceId: string): void {
  try {
    if (readFileSync(filePath, 'utf-8') !== written) {
      recordWriteFailure(slug, sourceId, ['stamp_rollback_file_changed_outside_lock'], filePath);
      return;
    }
    atomicReplace(filePath, preimage);
  } catch (err) {
    recordWriteFailure(slug, sourceId, [`stamp_rollback_restore_failed: ${err instanceof Error ? err.message : String(err)}`], filePath);
  }
}
