/**
 * Legacy-fact repair — fence `row_num IS NULL` rows in place during maintenance.
 *
 * Why this exists. `runExtractFacts` refuses to reconcile a source while it
 * still holds genuinely-backfillable legacy rows (row never fenced, entity
 * page live, source has a local_path, not soft-expired). Since 2026-09-13
 * that halt is loud (`✗ extract_facts`, `FENCE_BACKFILL_PENDING`) — but it
 * is still a halt: fact extraction stays down for the source until an
 * operator runs the v0.32.2 backfill by hand, and Phase B of that backfill
 * refuses unless the WHOLE working tree is clean, which on a repo with
 * several concurrent writers is a race.
 *
 * This module is the self-draining alternative the 2026-09-13 build proposed
 * instead of fencing at page-creation time: the guard still arms, and the
 * maintenance phase heals the rows it armed on, page by page, under the
 * page lock, refusing per FILE rather than per tree. It runs only where
 * gbrain already writes into the repo (the cycle), never on put_page or
 * sync import, so the file/DB ordering race those hooks would open does not
 * exist here.
 *
 * Why the deletion window is closed. Stamping `row_num` +
 * `source_markdown_slug` makes a row fence-owned, and the reconcile deletes
 * fence-owned rows for any page whose DB body has no fence. The v0.32.2
 * backfill stamps rows after writing the FILE only — the DB body catches up
 * on the next sync, and a `put_page` in between re-renders the file from the
 * fence-less DB body, erasing the fence. Here the order is: file → DB body
 * (`refreshPageBody`, the phantom-redirect precedent) → verify BOTH carry
 * every assigned row → stamp. A row is never fence-owned before both stores
 * can prove they hold its fence.
 *
 * Crash safety without cross-store atomicity. The file and the DB cannot
 * commit together, so every transition is designed to be retried by the
 * next run, keyed on `row_num IS NULL`:
 *   - crash before rename: `.tmp` is left, file and DB untouched;
 *   - crash after rename, before the body refresh: file has the fence,
 *     DB rows are still NULL → next run de-dupes against the fence on disk,
 *     assigns the EXISTING row_nums, refreshes, stamps — no duplicate rows;
 *   - crash after the body refresh, before the stamp: same, refresh is
 *     idempotent (identical body, identical hash);
 *   - crash mid-stamp: stamped rows leave the guard set, unstamped rows are
 *     picked up next run and de-dupe to their existing fence row.
 * Each page write also records a preimage of the file and a journal line
 * under `<GBRAIN_HOME>/.gbrain/fact-repair/`, so a repair can be reverted
 * with `rollbackFactRepairEntry` (facts are retained, un-stamped, and the
 * guard simply arms again).
 *
 * What it will NOT do: create a page or a stub file (a live DB page with no
 * file is drift for the operator, not a repair target), follow a symlink,
 * write outside the source tree, touch a file whose git state it cannot
 * positively attribute, or sweep another writer's uncommitted edit of the
 * same file into a gbrain commit. Every refusal is counted and named so the
 * halt that follows says which pages are still pending and why.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import type { FactKind, FactVisibility } from '../engine.ts';

type FactNotability = 'high' | 'medium' | 'low';
import { gbrainPath } from '../config.ts';
import { withPageLock } from '../page-lock.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { isDurabilityHardened, commitWriteThroughFile } from '../brain-repo-durability.ts';
import { parseFactsFence, upsertFactRow } from '../facts-fence.ts';
import { parseMarkdown } from '../markdown.ts';
import { contentHash } from '../utils.ts';
import { isAborted } from '../abort-check.ts';

// ── Types ──────────────────────────────────────────────────────────────────

/** One `row_num IS NULL` fact row, as read from the facts table. */
export interface LegacyFactRow {
  id: string;
  source_id: string;
  entity_slug: string;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  notability: FactNotability;
  context: string | null;
  valid_from: Date | string;
  valid_until: Date | string | null;
  source: string | null;
  confidence: number;
}

export type LegacyPageSkipReason =
  | 'target_unresolvable'   // resolvePageWriteTarget refused (tree missing, path escapes root, …)
  | 'file_missing'          // live DB page, no file on disk — drift, not a repair target
  | 'symlink'               // the target (or its .tmp) is a symlink
  | 'foreign_dirty'         // git cannot attribute this path's dirt to a plain edit of it
  | 'lock_busy'             // page lock not acquired within the timeout
  | 'fence_parse_failed'    // rendered fence failed re-parse; .tmp quarantined
  | 'verify_failed'         // file or DB body did not read back every assigned row
  | 'error';                // anything thrown; detail carries the message

export interface FenceLegacyPageResult {
  slug: string;
  /** 'fenced' wrote or confirmed rows and stamped them; 'skipped' left every row NULL. */
  status: 'fenced' | 'skipped';
  reason?: LegacyPageSkipReason;
  detail?: string;
  /** Rows stamped (row_num + source_markdown_slug) by this call. */
  stamped: number;
  /** Rows appended to the fence file (0 on a pure re-stamp after a crash). */
  appended: number;
  /** Whether the path-limited git commit ran and left the file clean. */
  committed: boolean;
  journalPath?: string;
}

export interface RepairLegacyRowsSummary {
  rowsEligible: number;
  rowsStamped: number;
  rowsAppended: number;
  pagesFenced: number;
  pagesSkipped: number;
  /** Pending pages by refusal reason, so the halt can say why. */
  skippedByReason: Partial<Record<LegacyPageSkipReason, number>>;
  /** `slug (reason: detail)` for the first few refusals. */
  skippedDetails: string[];
  /** Legacy rows still eligible after the pass (re-counted, not derived). */
  rowsRemaining: number;
  dryRun: boolean;
  aborted: boolean;
}

/**
 * Failure-injection seams. Test-only: each hook runs immediately BEFORE the
 * named transition and may throw to simulate a crash there. Production
 * callers never set them.
 */
export interface FenceLegacyHooks {
  beforeRename?: (slug: string) => void | Promise<void>;
  beforeBodyRefresh?: (slug: string) => void | Promise<void>;
  beforeStamp?: (slug: string) => void | Promise<void>;
  /** Runs before stamping the row at `index` (0-based) — a mid-stamp crash. */
  beforeStampRow?: (slug: string, index: number) => void | Promise<void>;
}

export interface RepairLegacyRowsOpts {
  sourceId: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Journal + preimage root. Default `<GBRAIN_HOME>/.gbrain/fact-repair`. */
  journalDir?: string;
  /** Per-page lock wait. Default 5 s, matching the fence writer. */
  lockTimeoutMs?: number;
  /** Cap on pages per pass so a huge backlog cannot outgrow the cycle budget. */
  maxPages?: number;
  hooks?: FenceLegacyHooks;
}

/** One journal line. `phase: 'done'` entries are the input to rollback. */
export interface FactRepairJournalEntry {
  ts: string;
  phase: 'begin' | 'done' | 'failed';
  source_id: string;
  slug: string;
  file: string;
  preimage: string | null;
  /** DB fact ids this entry stamped (or intended to). */
  ids: string[];
  assignments: Array<{ id: string; row_num: number }>;
  appended: number;
  detail?: string;
}

// ── Kill switch ────────────────────────────────────────────────────────────

/**
 * `GBRAIN_FACT_REPAIR=off` disables the in-cycle repair without a deploy;
 * the phase then halts exactly as before this module existed. Rollback
 * lever for the first unattended nights.
 */
export function isFactRepairDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GBRAIN_FACT_REPAIR ?? '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'disabled';
}

// ── Eligibility (mirrors the extract_facts guard exactly) ──────────────────

/**
 * The rows the empty-fence guard counts for `sourceId`, in page order. Same
 * predicate as the guard's COUNT so "eligible here" and "counted there" can
 * never diverge: row never fenced, entity page live in THIS source, source
 * has a local_path, row not soft-expired.
 */
export async function listLegacyRowsForSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<LegacyFactRow[]> {
  return engine.executeRaw<LegacyFactRow>(
    `SELECT f.id::text AS id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility,
            f.notability, f.context, f.valid_from, f.valid_until, f.source, f.confidence
       FROM facts f
      WHERE f.source_id = $1
        AND f.row_num IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.expired_at IS NULL
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = f.source_id
             AND p.slug = f.entity_slug
             AND p.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM sources s
           WHERE s.id = f.source_id
             AND s.local_path IS NOT NULL
        )
      ORDER BY f.entity_slug, f.id`,
    [sourceId],
  );
}

export async function countLegacyRowsForSource(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM facts f
      WHERE f.source_id = $1
        AND f.row_num IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.expired_at IS NULL
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = f.source_id
             AND p.slug = f.entity_slug
             AND p.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM sources s
           WHERE s.id = f.source_id
             AND s.local_path IS NOT NULL
        )`,
    [sourceId],
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}

// ── Pure fence rendering ───────────────────────────────────────────────────

function isoDate(v: Date | string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function fenceKey(claim: string, source: string | null | undefined): string {
  return `${claim} ${source ?? ''}`;
}

/**
 * Append `rows` to the `## Facts` fence in `body`, de-duplicating on
 * (claim, source) against rows already present so a retry after a crash
 * re-uses the existing row_num instead of appending a twin. Pure: no IO.
 */
export function appendLegacyRowsToBody(
  body: string,
  rows: LegacyFactRow[],
): { body: string; assignments: Array<{ id: string; row_num: number }>; appended: number } {
  const existing = parseFactsFence(body);
  const byKey = new Map<string, number>();
  for (const f of existing.facts) {
    const k = fenceKey(f.claim, f.source);
    if (!byKey.has(k)) byKey.set(k, f.rowNum);
  }
  const assignments: Array<{ id: string; row_num: number }> = [];
  let appended = 0;
  let out = body;
  for (const row of rows) {
    const k = fenceKey(row.fact, row.source);
    const known = byKey.get(k);
    if (known !== undefined) {
      assignments.push({ id: row.id, row_num: known });
      continue;
    }
    const { body: updated, rowNum } = upsertFactRow(out, {
      claim:      row.fact,
      kind:       row.kind,
      confidence: row.confidence,
      visibility: row.visibility,
      notability: row.notability,
      validFrom:  isoDate(row.valid_from) ?? '',
      validUntil: isoDate(row.valid_until),
      source:     row.source ?? undefined,
      context:    row.context ?? undefined,
    });
    out = updated;
    byKey.set(k, rowNum);
    assignments.push({ id: row.id, row_num: rowNum });
    appended += 1;
  }
  return { body: out, assignments, appended };
}

/** True when every assignment's row_num is present in `body`'s fence with the expected claim. */
function bodyCarriesAssignments(
  body: string,
  rows: LegacyFactRow[],
  assignments: Array<{ id: string; row_num: number }>,
): boolean {
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length > 0) return false;
  const claimByRowNum = new Map(parsed.facts.map(f => [f.rowNum, f.claim]));
  const rowById = new Map(rows.map(r => [r.id, r]));
  for (const a of assignments) {
    const row = rowById.get(a.id);
    if (!row) return false;
    if (claimByRowNum.get(a.row_num) !== row.fact) return false;
  }
  return true;
}

// ── Git state, per FILE ────────────────────────────────────────────────────

export type RepairGitPathState = 'clean' | 'self_dirty' | 'foreign_dirty' | 'not_a_repo';

/**
 * Per-path `git status`, so dirt elsewhere in the tree is invisible (the
 * whole-tree refusal in the v0.32.2 backfill is exactly what forced three
 * repos clean at once). 'foreign_dirty' = unmerged/rename states or an entry
 * that cannot be positively attributed to this path. 'not_a_repo' = git is
 * absent or the path is not inside a repository; writes proceed, no commit.
 */
export function repairGitPathState(repoPath: string, filePath: string): RepairGitPathState {
  const rel = relative(repoPath, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'foreign_dirty';
  let status: string;
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return 'not_a_repo';
  }
  try {
    status = execFileSync(
      'git',
      ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=all', '--', rel],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
  } catch {
    return 'foreign_dirty';
  }
  const lines = status.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return 'clean';
  for (const line of lines) {
    const xy = line.slice(0, 2);
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'foreign_dirty';
    const pathField = line.slice(3);
    if (pathField !== rel && pathField !== `"${rel}"`) return 'foreign_dirty';
  }
  return 'self_dirty';
}

// ── Journal + preimages ────────────────────────────────────────────────────

export function defaultJournalDir(): string {
  return gbrainPath('fact-repair');
}

function journalFile(journalDir: string, sourceId: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(journalDir, sourceId, `${day}.jsonl`);
}

function writePreimage(journalDir: string, sourceId: string, slug: string, body: string): string {
  const dir = join(journalDir, sourceId, 'preimages');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${createHash('sha256').update(slug).digest('hex').slice(0, 16)}-${stamp}.md`;
  const p = join(dir, name);
  writeFileSync(p, body, 'utf-8');
  return p;
}

function appendJournal(journalDir: string, entry: FactRepairJournalEntry): string {
  const p = journalFile(journalDir, entry.source_id);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify(entry)}\n`, 'utf-8');
  return p;
}

/** Parse a journal file into entries; malformed lines are skipped. */
export function readFactRepairJournal(path: string): FactRepairJournalEntry[] {
  if (!existsSync(path)) return [];
  const out: FactRepairJournalEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as FactRepairJournalEntry); } catch { /* skip */ }
  }
  return out;
}

// ── DB body refresh (phantom-redirect precedent) ───────────────────────────

async function refreshDbBodyFromDisk(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  filePath: string,
): Promise<{ compiled_truth: string }> {
  const disk = readFileSync(filePath, 'utf-8');
  const reparsed = parseMarkdown(disk, `${slug}.md`);
  const tags = await engine.getTags(slug, { sourceId });
  const hash = contentHash({
    title: reparsed.title,
    type: reparsed.type,
    compiled_truth: reparsed.compiled_truth,
    timeline: reparsed.timeline,
    frontmatter: reparsed.frontmatter,
    tags,
  });
  await engine.refreshPageBody(slug, sourceId, reparsed.compiled_truth, reparsed.timeline, hash);
  return { compiled_truth: reparsed.compiled_truth };
}

// ── Per-page repair ────────────────────────────────────────────────────────

interface PageRepairInput {
  sourceId: string;
  slug: string;
  rows: LegacyFactRow[];
  dryRun: boolean;
  journalDir: string;
  lockTimeoutMs: number;
  hooks?: FenceLegacyHooks;
}

function skipped(
  slug: string,
  reason: LegacyPageSkipReason,
  detail?: string,
): FenceLegacyPageResult {
  return { slug, status: 'skipped', reason, detail, stamped: 0, appended: 0, committed: false };
}

/**
 * Fence one page's legacy rows and stamp them. Runs under the page lock.
 * Order: resolve target → refuse unsafe → render → preimage + journal →
 * .tmp → re-parse → rename → DB body refresh → verify file AND DB →
 * stamp rows → journal done → path-limited commit (clean prewrite only).
 */
export async function fenceLegacyRowsForPage(
  engine: BrainEngine,
  input: PageRepairInput,
): Promise<FenceLegacyPageResult> {
  const { sourceId, slug, rows, dryRun, journalDir, hooks } = input;
  if (rows.length === 0) {
    return { slug, status: 'fenced', stamped: 0, appended: 0, committed: false };
  }

  const resolved = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!resolved.ok) return skipped(slug, 'target_unresolvable', resolved.skipped);
  const { filePath, writeRoot } = resolved;
  const tmpPath = `${filePath}.tmp`;

  let lockAcquired = false;
  try {
    return await withPageLock(
      slug,
      async () => {
        lockAcquired = true;
        // Symlink and existence checks INSIDE the lock, right before the read.
        if (!existsSync(filePath)) return skipped(slug, 'file_missing', filePath);
        if (lstatSync(filePath).isSymbolicLink()) return skipped(slug, 'symlink', filePath);
        if (existsSync(tmpPath) && lstatSync(tmpPath).isSymbolicLink()) return skipped(slug, 'symlink', tmpPath);

        const gitState = repairGitPathState(writeRoot, filePath);
        if (gitState === 'foreign_dirty') return skipped(slug, 'foreign_dirty', filePath);

        const preBody = readFileSync(filePath, 'utf-8');
        const preParsed = parseFactsFence(preBody);
        if (preParsed.warnings.length > 0) {
          // A malformed existing fence is not ours to rewrite.
          return skipped(slug, 'fence_parse_failed', `existing fence: ${preParsed.warnings.join('; ')}`);
        }
        const rendered = appendLegacyRowsToBody(preBody, rows);

        if (dryRun) {
          return {
            slug, status: 'fenced', stamped: 0, appended: rendered.appended, committed: false,
            detail: `dry-run: would stamp ${rendered.assignments.length} row(s), append ${rendered.appended}`,
          };
        }

        // Preimage + journal BEFORE the first byte moves.
        const preimage = writePreimage(journalDir, sourceId, slug, preBody);
        const ids = rows.map(r => r.id);
        const base: Omit<FactRepairJournalEntry, 'phase' | 'ts'> = {
          source_id: sourceId, slug, file: filePath, preimage, ids,
          assignments: rendered.assignments, appended: rendered.appended,
        };
        const journalPath = appendJournal(journalDir, { ...base, ts: new Date().toISOString(), phase: 'begin' });

        try {
          if (rendered.appended > 0) {
            writeFileSync(tmpPath, rendered.body, 'utf-8');
            const tmpBody = readFileSync(tmpPath, 'utf-8');
            const parsed = parseFactsFence(tmpBody);
            if (parsed.warnings.length > 0 || !bodyCarriesAssignments(tmpBody, rows, rendered.assignments)) {
              // .tmp stays as quarantine evidence.
              appendJournal(journalDir, {
                ...base, ts: new Date().toISOString(), phase: 'failed',
                detail: `rendered fence failed re-parse: ${parsed.warnings.join('; ') || 'assignment mismatch'}`,
              });
              return skipped(slug, 'fence_parse_failed', parsed.warnings.join('; ') || 'assignment mismatch');
            }
            await hooks?.beforeRename?.(slug);
            renameSync(tmpPath, filePath);
          }

          // DB body carries the fence in the same call — closes the window
          // where a put_page re-render could erase an on-disk fence.
          await hooks?.beforeBodyRefresh?.(slug);
          const { compiled_truth } = await refreshDbBodyFromDisk(engine, slug, sourceId, filePath);

          // Verify BOTH stores before any row becomes fence-owned.
          const diskNow = readFileSync(filePath, 'utf-8');
          const dbPage = await engine.getPage(slug, { sourceId });
          const dbOk = !!dbPage && bodyCarriesAssignments(dbPage.compiled_truth ?? '', rows, rendered.assignments);
          const diskOk = bodyCarriesAssignments(diskNow, rows, rendered.assignments);
          if (!dbOk || !diskOk) {
            appendJournal(journalDir, {
              ...base, ts: new Date().toISOString(), phase: 'failed',
              detail: `verify: disk=${diskOk} db=${dbOk} (compiled_truth ${compiled_truth.length} bytes)`,
            });
            return skipped(slug, 'verify_failed', `disk=${diskOk} db=${dbOk}`);
          }

          await hooks?.beforeStamp?.(slug);
          let stamped = 0;
          for (let i = 0; i < rendered.assignments.length; i++) {
            const a = rendered.assignments[i]!;
            await hooks?.beforeStampRow?.(slug, i);
            // `row_num IS NULL` keeps the stamp idempotent under retry.
            const r = await engine.executeRaw<{ id: string }>(
              `UPDATE facts SET row_num = $1, source_markdown_slug = $2
                WHERE id = $3 AND row_num IS NULL RETURNING id::text AS id`,
              [a.row_num, slug, a.id],
            );
            stamped += r.length;
          }

          appendJournal(journalDir, { ...base, ts: new Date().toISOString(), phase: 'done', detail: `stamped=${stamped}` });

          // Commit only what this call wrote, and only when the file was clean
          // beforehand: a self-dirty prewrite state means another writer's
          // uncommitted edit is in this file, and it is theirs to commit.
          let committed = false;
          if (rendered.appended > 0 && gitState === 'clean' && isDurabilityHardened(writeRoot)) {
            committed = commitWriteThroughFile(writeRoot, filePath, slug)
              && repairGitPathState(writeRoot, filePath) === 'clean';
          }
          return { slug, status: 'fenced', stamped, appended: rendered.appended, committed, journalPath };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendJournal(journalDir, { ...base, ts: new Date().toISOString(), phase: 'failed', detail: msg });
          throw err;
        }
      },
      { timeoutMs: input.lockTimeoutMs },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!lockAcquired) return skipped(slug, 'lock_busy', msg);
    return skipped(slug, 'error', msg);
  }
}

// ── Per-source pass ────────────────────────────────────────────────────────

const DEFAULT_MAX_PAGES = 500;

/**
 * Drain every eligible legacy row in `sourceId`, page by page. Never throws:
 * a page that cannot be repaired safely is counted under its reason and
 * left for the guard to report. `rowsRemaining` is re-counted after the
 * pass, so the caller's halt/continue decision rests on the DB, not on
 * this function's bookkeeping.
 */
export async function repairLegacyRowsForSource(
  engine: BrainEngine,
  opts: RepairLegacyRowsOpts,
): Promise<RepairLegacyRowsSummary> {
  const dryRun = opts.dryRun ?? false;
  const journalDir = opts.journalDir ?? defaultJournalDir();
  const lockTimeoutMs = opts.lockTimeoutMs ?? 5_000;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const summary: RepairLegacyRowsSummary = {
    rowsEligible: 0, rowsStamped: 0, rowsAppended: 0,
    pagesFenced: 0, pagesSkipped: 0,
    skippedByReason: {}, skippedDetails: [],
    rowsRemaining: 0, dryRun, aborted: false,
  };

  const rows = await listLegacyRowsForSource(engine, opts.sourceId);
  summary.rowsEligible = rows.length;
  if (rows.length === 0) return summary;

  const bySlug = new Map<string, LegacyFactRow[]>();
  for (const r of rows) {
    const list = bySlug.get(r.entity_slug) ?? [];
    list.push(r);
    bySlug.set(r.entity_slug, list);
  }

  let pages = 0;
  for (const [slug, group] of bySlug) {
    if (isAborted(opts.signal)) { summary.aborted = true; break; }
    if (pages >= maxPages) break;
    pages += 1;
    const r = await fenceLegacyRowsForPage(engine, {
      sourceId: opts.sourceId, slug, rows: group, dryRun, journalDir, lockTimeoutMs, hooks: opts.hooks,
    });
    if (r.status === 'fenced') {
      summary.pagesFenced += 1;
      summary.rowsStamped += r.stamped;
      summary.rowsAppended += r.appended;
    } else {
      summary.pagesSkipped += 1;
      const reason = r.reason ?? 'error';
      summary.skippedByReason[reason] = (summary.skippedByReason[reason] ?? 0) + 1;
      if (summary.skippedDetails.length < 10) {
        summary.skippedDetails.push(`${slug} (${reason}${r.detail ? `: ${r.detail.slice(0, 160)}` : ''})`);
      }
    }
  }

  summary.rowsRemaining = dryRun ? rows.length : await countLegacyRowsForSource(engine, opts.sourceId);
  return summary;
}

// ── Rollback ───────────────────────────────────────────────────────────────

export interface RollbackResult {
  slug: string;
  status: 'rolled_back' | 'refused' | 'failed';
  detail?: string;
  /** Rows returned to `row_num IS NULL` (the guard will arm on them again). */
  unstamped: number;
  fileRestored: boolean;
}

/**
 * Revert one `phase: 'done'` journal entry: restore the file preimage, refresh
 * the DB body from it, and un-stamp the rows the entry fenced. Facts are
 * retained — they simply become legacy rows again and the guard arms on the
 * next cycle (set `GBRAIN_FACT_REPAIR=off` first if that is not wanted).
 *
 * Refuses when the file on disk no longer carries the entry's rows (someone
 * edited the fence since; restoring the preimage would discard their work).
 */
export async function rollbackFactRepairEntry(
  engine: BrainEngine,
  entry: FactRepairJournalEntry,
  opts: { lockTimeoutMs?: number } = {},
): Promise<RollbackResult> {
  const { slug, source_id: sourceId, file: filePath } = entry;
  if (entry.phase !== 'done') {
    return { slug, status: 'refused', detail: `journal phase is '${entry.phase}', only 'done' entries roll back`, unstamped: 0, fileRestored: false };
  }
  try {
    return await withPageLock(slug, async () => {
      let fileRestored = false;
      if (entry.appended > 0) {
        if (!entry.preimage || !existsSync(entry.preimage)) {
          return { slug, status: 'refused', detail: 'preimage missing', unstamped: 0, fileRestored };
        }
        if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) {
          return { slug, status: 'refused', detail: 'target file missing or symlink', unstamped: 0, fileRestored };
        }
        const now = readFileSync(filePath, 'utf-8');
        const parsed = parseFactsFence(now);
        const present = new Set(parsed.facts.map(f => f.rowNum));
        const ours = entry.assignments.filter(a => present.has(a.row_num));
        if (ours.length !== entry.assignments.length) {
          return { slug, status: 'refused', detail: 'fence on disk no longer carries every repaired row; edited since — refusing to overwrite', unstamped: 0, fileRestored };
        }
        // Only restore when the current fence equals preimage + our rows;
        // any other row added since would be lost by a blind restore.
        const pre = parseFactsFence(readFileSync(entry.preimage, 'utf-8'));
        const expected = new Set([...pre.facts.map(f => f.rowNum), ...entry.assignments.map(a => a.row_num)]);
        if (parsed.facts.some(f => !expected.has(f.rowNum))) {
          return { slug, status: 'refused', detail: 'fence gained rows after the repair; refusing to overwrite', unstamped: 0, fileRestored };
        }
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, readFileSync(entry.preimage, 'utf-8'), 'utf-8');
        renameSync(tmp, filePath);
        fileRestored = true;
        await refreshDbBodyFromDisk(engine, slug, sourceId, filePath);
      }
      let unstamped = 0;
      for (const a of entry.assignments) {
        const r = await engine.executeRaw<{ id: string }>(
          `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
            WHERE id = $1 AND source_id = $2 AND source_markdown_slug = $3 AND row_num = $4
            RETURNING id::text AS id`,
          [a.id, sourceId, slug, a.row_num],
        );
        unstamped += r.length;
      }
      return { slug, status: 'rolled_back', unstamped, fileRestored };
    }, { timeoutMs: opts.lockTimeoutMs ?? 5_000 });
  } catch (err) {
    return { slug, status: 'failed', detail: err instanceof Error ? err.message : String(err), unstamped: 0, fileRestored: false };
  }
}
