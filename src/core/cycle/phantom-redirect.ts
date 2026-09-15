/**
 * Redirect unprefixed phantom pages to a unique canonical page. The pass
 * holds the source sync lock; each transfer also locks both native pages in
 * sorted order and re-reads state. One DB transaction locks endpoint pages
 * and facts, verifies file/DB expiry agreement, projects chunks and transfers
 * original identities (including tombstones). No residual facts are deleted.
 *
 * Conflicting deduplication, unresolved legacy history and page-local
 * supersession references refuse. A queued forget rechecks its route under
 * the page lock and follows the original ID after the transfer releases it.
 * Files use the native phantom replacement policy; this lock contract covers
 * cooperating native page writers, not arbitrary external filesystem edits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { contentHash } from '../utils.ts';
import { withPageLock } from '../page-lock.ts';
import { FENCE_SOURCE_DEFAULT } from '../facts/extract-from-fence.ts';
import { indexRepairedPage } from '../facts/repair-index.ts';
import type { Page } from '../types.ts';
import {
  resolvePhantomCanonical,
  findPrefixCandidates,
} from '../entities/resolve.ts';
import {
  parseFactsFence,
  renderFactsTable,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
} from '../facts-fence.ts';
import { parseMarkdown, splitBody, serializeMarkdown } from '../markdown.ts';
import { tryAcquireDbLock, syncLockId, type DbLockHandle } from '../db-lock.ts';
import { isAborted } from '../abort-check.ts';
import { isFactRepairDisabled } from '../facts/repair-policy.ts';
import { logPhantomEvent, type PhantomOutcome } from '../facts/phantom-audit.ts';

/** Tagged-union outcome of a single phantom-redirect attempt. */
export type RedirectOutcome =
  | 'not_phantom'
  | 'redirected'
  | 'ambiguous'
  | 'drift'
  | 'no_canonical';

/** Result envelope for the single-phantom handler. */
export interface RedirectResult {
  outcome: RedirectOutcome;
  /** Canonical slug, populated only on outcome === 'redirected' (incl. dry-run preview). */
  canonical?: string;
}

export interface PhantomPassResult {
  scanned: number;
  redirected: number;
  ambiguous: number;
  skipped_drift: number;
  no_canonical: number;
  not_phantom: number;
  /** True iff the pass was skipped wholesale because the writer lock was busy. */
  lock_busy: boolean;
  /** True iff more phantoms exist than the per-cycle cap — caller surfaces to operator. */
  more_pending: boolean;
  /**
   * Canonical slugs whose disk fence was merged with phantom rows this pass.
   * `extract_facts`'s main reconcile loop UNIONs these into its slug set so
   * the canonical's DB facts derive from the just-merged fence — without
   * this, scenario B (phantom has only-on-disk fence, no DB facts yet) would
   * leave canonical's DB facts stale until the next full-walk cycle.
   *
   * Scenario A (phantom HAD DB facts that migrateFactsToCanonical moved) is
   * also covered: the main loop's reconcile wipes+reinserts the migrated
   * rows from the merged fence, dropping the embedding column. That's the
   * same fence→DB roundtrip extract_facts already performs every cycle, so
   * it's not a phantom-redirect-specific regression.
   */
  touched_canonicals: string[];
}

const DEFAULT_PHANTOM_LIMIT = 50;
const LOCK_TTL_MINUTES = 5;
const LOCK_RETRY_INTERVAL_MS = 1000;
const LOCK_TOTAL_TIMEOUT_MS = 30_000;

/** Empty counters helper (used by the legacy-guard fast-path in extract-facts). */
export function emptyPhantomPassResult(): PhantomPassResult {
  return {
    scanned: 0,
    redirected: 0,
    ambiguous: 0,
    skipped_drift: 0,
    no_canonical: 0,
    not_phantom: 0,
    lock_busy: false,
    more_pending: false,
    touched_canonicals: [],
  };
}

/**
 * Strip frontmatter (already absent from `compiled_truth`), the leading H1
 * heading, and the entire `## Facts` fenced block. Returns the residue
 * with whitespace trimmed. Used by the body-shape gate (codex #2).
 *
 * Real top-level pages have prose / lists / paragraphs that aren't fenced
 * facts and aren't a one-line H1. Phantoms have only the stub shape
 * (`# alice` + maybe a facts fence). Zero-length residue is the gate.
 *
 * The fence strip walks both fence-marker pairs (with the leading
 * `## Facts` heading if present) so a phantom with just a facts table
 * still gates as empty residue.
 */
export function stripFenceAndFrontmatterAndLeadingH1(body: string): string {
  if (!body) return '';
  let working = body;

  // 1. Strip the entire `## Facts\n\n<fence>...<fence>` block. We grab
  //    the `## Facts` heading too (with surrounding blank lines) so the
  //    section header doesn't count as residue.
  const beginIdx = working.indexOf(FACTS_FENCE_BEGIN);
  const endIdx = beginIdx >= 0
    ? working.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length)
    : -1;
  if (beginIdx !== -1 && endIdx !== -1) {
    // Walk backward from beginIdx to swallow a leading `## Facts\n\n`
    // (or `## facts\n\n` — case-insensitive markdown headings).
    let headingStart = beginIdx;
    // Skip whitespace-only lines before the marker.
    while (headingStart > 0 && working[headingStart - 1] !== '\n') headingStart--;
    // Walk back over the blank line(s).
    while (headingStart > 0) {
      const prevLineEnd = headingStart - 1;
      const prevLineStart = working.lastIndexOf('\n', prevLineEnd - 1) + 1;
      const prevLine = working.slice(prevLineStart, prevLineEnd);
      if (prevLine.trim() === '') {
        headingStart = prevLineStart;
        continue;
      }
      if (/^#{1,6}\s+facts\b/i.test(prevLine)) {
        headingStart = prevLineStart;
      }
      break;
    }
    working = working.slice(0, headingStart)
      + working.slice(endIdx + FACTS_FENCE_END.length);
  }

  // 2. Strip the leading H1 (` # text\n` at the very top — phantom stubs
  //    open with `# <slug>`).
  working = working.replace(/^\s*#\s+[^\n]*\n?/, '');

  // 3. Whitespace-trim. Empty (or only whitespace) is the gate.
  return working.trim();
}

/**
 * Block-on-busy lock acquisition with bounded retry. Returns null when
 * total timeout elapses without a successful acquire.
 */
async function acquireLockWithRetry(
  engine: BrainEngine,
  lockId: string,
  signal?: AbortSignal,
): Promise<DbLockHandle | null> {
  const deadline = Date.now() + LOCK_TOTAL_TIMEOUT_MS;
  let handle = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  while (!handle) {
    // #1972: bail immediately on abort instead of retrying for the full 30s —
    // otherwise this loop alone can blow past the worker's 30s force-evict.
    if (isAborted(signal)) return null;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    handle = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  }
  return handle;
}

/** Plan a transfer without losing row identity or merging conflicting states. */
function planPhantomFenceMerge(body: string, phantomFacts: ParsedFact[], dbMax: number) {
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length) throw new Error('canonical fence does not parse');
  const existing = parsed.facts;
  const key = (f: ParsedFact) => JSON.stringify([f.claim, f.validFrom ?? '']);
  const byKey = new Map(existing.map(f => [key(f), f]));
  const rowNumByPhantom = new Map<number, number>();
  const merged = [...existing];
  let next = Math.max(dbMax, ...existing.map(f => f.rowNum), 0) + 1;
  for (const f of phantomFacts) {
    // A supersession reference is page-local. Moving it needs a separate
    // reference remap; refuse instead of silently pointing at another row.
    if (f.supersededBy !== undefined) throw new Error('phantom supersession requires reviewed reference remap');
    const hit = byKey.get(key(f));
    if (hit) {
      if (renderFactsTable([{ ...hit, rowNum: 1 }]) !== renderFactsTable([{ ...f, rowNum: 1 }])) {
        throw new Error('phantom row conflicts with canonical content or expiry');
      }
      rowNumByPhantom.set(f.rowNum, hit.rowNum);
    } else {
      const row = { ...f, rowNum: next++ };
      merged.push(row); byKey.set(key(f), row); rowNumByPhantom.set(f.rowNum, row.rowNum);
    }
  }
  const newFence = renderFactsTable(merged);
  const begin = body.indexOf(FACTS_FENCE_BEGIN);
  const end = body.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
  const updated = merged.length === existing.length ? body : begin >= 0 && end >= 0
    ? body.slice(0, begin) + newFence + body.slice(end + FACTS_FENCE_END.length)
    : `${body}${body.endsWith('\n') ? '\n' : '\n\n'}## Facts\n\n${newFence}\n`;
  return { body: updated, rowNumByPhantom };
}

/**
 * Check bi-directional drift between phantom's DB body and its disk file.
 * When both exist and disagree on the parsed fence row set (by claim +
 * valid_from), classify as `drift` — operator triages manually.
 *
 * When the disk file is absent, the DB body is the truth; not drift.
 */
function fenceDbDrift(page: Page, brainDir: string): boolean {
  const phantomPath = path.join(brainDir, `${page.slug}.md`);
  if (!fs.existsSync(phantomPath)) return false;

  const dbBody = page.compiled_truth ?? '';
  const dbParse = parseFactsFence(dbBody);
  const dbKeys = new Set(dbParse.facts.map((f) => `${f.claim}|${f.validFrom ?? ''}`));

  let diskBody: string;
  try {
    diskBody = fs.readFileSync(phantomPath, 'utf-8');
  } catch {
    // File vanished between exists check and read — treat as DB-only,
    // no drift.
    return false;
  }
  // Strip frontmatter from the disk read so we compare the body portion
  // only. parseMarkdown handles frontmatter + body+timeline split.
  let diskCompiled = diskBody;
  try {
    const parsed = parseMarkdown(diskBody, `${page.slug}.md`);
    diskCompiled = parsed.compiled_truth;
  } catch {
    // Bad markdown on disk — treat as drift (operator should triage).
    return true;
  }
  const diskParse = parseFactsFence(diskCompiled);
  const diskKeys = new Set(diskParse.facts.map((f) => `${f.claim}|${f.validFrom ?? ''}`));

  if (dbKeys.size !== diskKeys.size) return true;
  for (const k of dbKeys) {
    if (!diskKeys.has(k)) return true;
  }
  return false;
}

/**
 * Materialize a DB-only canonical page to disk by serializing its full
 * page state (frontmatter + body + timeline). Reuses `serializeMarkdown`
 * so the output round-trips through `parseMarkdown` cleanly.
 */
async function materializeCanonicalToDisk(
  engine: BrainEngine,
  canonicalSlug: string,
  sourceId: string,
  canonicalPath: string,
): Promise<void> {
  if (fs.existsSync(canonicalPath)) return;
  const canonicalPage = await engine.getPage(canonicalSlug, { sourceId });
  if (!canonicalPage) {
    // Canonical doesn't exist in DB either. Materialize a minimal stub
    // so the subsequent fence append has somewhere to land.
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    const titleFromSlug = canonicalSlug.split('/').pop() ?? canonicalSlug;
    const stubBody = serializeMarkdown(
      {},
      `# ${titleFromSlug}\n`,
      '',
      { type: 'concept', title: titleFromSlug, tags: [] },
    );
    fs.writeFileSync(canonicalPath, stubBody, 'utf-8');
    return;
  }
  const tags = await engine.getTags(canonicalSlug, { sourceId });
  const body = serializeMarkdown(
    canonicalPage.frontmatter ?? {},
    canonicalPage.compiled_truth ?? '',
    canonicalPage.timeline ?? '',
    {
      type: canonicalPage.type,
      title: canonicalPage.title,
      tags,
    },
  );
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  fs.writeFileSync(canonicalPath, body, 'utf-8');
}

/**
 * Single-phantom redirect. Caller (the pass) is responsible for the
 * outer lock + the audit-log cap.
 */
export async function tryRedirectPhantom(
  engine: BrainEngine,
  page: Page,
  sourceId: string,
  brainDir: string,
  dryRun: boolean,
): Promise<RedirectResult> {
  // Predicate (D2): unprefixed AND alive (deleted_at filter done by caller).
  if (page.slug.includes('/')) return { outcome: 'not_phantom' };

  // A3 + codex #2: strict zero-residue body-shape gate. Real top-level
  // pages have prose; phantoms have only the stub-shape `# slug` + maybe
  // a facts fence.
  const residue = stripFenceAndFrontmatterAndLeadingH1(page.compiled_truth ?? '');
  if (residue.length > 0) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'not_phantom_has_residue',
      source_id: sourceId,
    });
    return { outcome: 'not_phantom' };
  }

  // Codex #1: phantom-specific resolver bypasses exact-self-match.
  const canonical = await resolvePhantomCanonical(engine, sourceId, page.slug);
  if (!canonical) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'no_canonical',
      source_id: sourceId,
    });
    return { outcome: 'no_canonical' };
  }

  // D5 + codex #11: standalone ambiguity query.
  const candidates = await findPrefixCandidates(engine, sourceId, page.slug);
  if (candidates.length > 1) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'ambiguous',
      candidates,
      source_id: sourceId,
    });
    return { outcome: 'ambiguous', canonical };
  }

  // Round 27/29/30: bi-directional drift check.
  if (fenceDbDrift(page, brainDir)) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'drift',
      source_id: sourceId,
    });
    return { outcome: 'drift', canonical };
  }

  // D10: dry-run preview — no FS / DB / audit writes.
  if (dryRun) return { outcome: 'redirected', canonical };

  const [first, second] = [page.slug, canonical].sort();
  return withPageLock(first, () => withPageLock(second,
    () => redirectUnderLocks(engine, page.slug, canonical, sourceId, brainDir),
    { timeoutMs: 5_000 }), { timeoutMs: 5_000 });
}

interface TransferRow {
  id: string; entity_slug: string; source_markdown_slug: string | null;
  row_num: number | null; active: boolean; fact: string; source: string | null;
}

/** Both native page locks stay held through the fresh read, transfer and unlink. */
async function redirectUnderLocks(engine: BrainEngine, slug: string, canonical: string, sourceId: string, brainDir: string): Promise<RedirectResult> {
  const drift = (reason: string): RedirectResult => {
    logPhantomEvent({ phantom_slug: slug, outcome: 'drift', source_id: sourceId, reason });
    return { outcome: 'drift', canonical };
  };
  if (isFactRepairDisabled()) return drift('repair disabled');
  const phantomPath = path.join(brainDir, `${slug}.md`);
  const canonicalPath = path.join(brainDir, `${canonical}.md`);
  let migrated = 0;
  try {
    await engine.transaction(async tx => {
      const pages = await tx.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])
          AND deleted_at IS NULL ORDER BY slug FOR UPDATE`, [sourceId, [slug, canonical]]);
      if (pages.length !== 2) throw new Error('redirect endpoint missing');
      const fresh = await tx.getPage(slug, { sourceId });
      if (!fresh) throw new Error('phantom disappeared');
      const diskBefore = fs.existsSync(phantomPath) ? fs.readFileSync(phantomPath, 'utf8') : null;
      const body = diskBefore === null ? fresh.compiled_truth : parseMarkdown(diskBefore, `${slug}.md`).compiled_truth;
      if (stripFenceAndFrontmatterAndLeadingH1(body).length) throw new Error('phantom gained prose');
      const phantomFence = parseFactsFence(body);
      if (phantomFence.warnings.length) throw new Error('phantom fence does not parse');
      const unresolved = await tx.executeRaw<{ id: string }>(
        `SELECT id::text AS id FROM facts WHERE source_id = $1 AND row_num IS NULL
          AND (entity_slug = $2 OR entity_slug = $3) LIMIT 1`, [sourceId, slug, canonical]);
      if (unresolved.length) throw new Error('unreviewed legacy history at endpoint');
      const all = await tx.executeRaw<TransferRow>(
        `SELECT id::text AS id, entity_slug, source_markdown_slug, row_num,
                expired_at IS NULL AS active, fact, source
         FROM facts WHERE source_id = $1 AND (entity_slug = ANY($2::text[])
           OR source_markdown_slug = ANY($2::text[])) ORDER BY id FOR UPDATE`, [sourceId, [slug, canonical]]);
      if (all.some(r => r.row_num === null || r.entity_slug !== r.source_markdown_slug)) throw new Error('unresolved or externally owned fact at endpoint');
      const owned = all.filter(r => r.source_markdown_slug === slug);
      const carries = (rows: TransferRow[], fence: ParsedFact[]) => rows.every(r => fence.some(f =>
        f.rowNum === Number(r.row_num) && f.active === r.active && f.claim === r.fact
        && (f.source ?? FENCE_SOURCE_DEFAULT) === (r.source ?? FENCE_SOURCE_DEFAULT)));
      if (!carries(owned, phantomFence.facts)) throw new Error('phantom fence disagrees with current facts/forget state');
      await materializeCanonicalToDisk(tx, canonical, sourceId, canonicalPath);
      const before = fs.readFileSync(canonicalPath, 'utf8');
      const canonicalRows = all.filter(r => r.source_markdown_slug === canonical);
      if (!carries(canonicalRows, parseFactsFence(before).facts)) throw new Error('canonical fence disagrees with current facts/forget state');
      const plan = planPhantomFenceMerge(before, phantomFence.facts, Math.max(...canonicalRows.map(r => Number(r.row_num)), 0));
      const occupied = new Set(canonicalRows.map(r => Number(r.row_num)));
      if (owned.some(r => occupied.has(plan.rowNumByPhantom.get(Number(r.row_num))!))) throw new Error('canonical row already has a different DB identity');
      if (isFactRepairDisabled()) throw new Error('repair disabled');
      if (plan.body !== before) {
        // Existing native phantom write policy, but never follow a pre-existing
        // .tmp (including symlinks). The two endpoint locks exclude native saves.
        const tmp = `${canonicalPath}.tmp`;
        fs.writeFileSync(tmp, plan.body, { encoding: 'utf8', flag: 'wx' });
        if (parseFactsFence(fs.readFileSync(tmp, 'utf8')).warnings.length) throw new Error('transferred fence does not parse');
        if (fs.readFileSync(canonicalPath, 'utf8') !== before) throw new Error('canonical file changed during transfer');
        fs.renameSync(tmp, canonicalPath);
      }
      const reparsed = parseMarkdown(plan.body, `${canonical}.md`);
      const tags = await tx.getTags(canonical, { sourceId });
      await tx.refreshPageBody(canonical, sourceId, reparsed.compiled_truth, reparsed.timeline, contentHash({ ...reparsed, tags }));
      await indexRepairedPage(tx, canonical, sourceId, reparsed.compiled_truth, reparsed.timeline);
      for (const row of owned) {
        const changed = await tx.executeRaw<{ id: string }>(
          `UPDATE facts SET entity_slug = $1, source_markdown_slug = $1, row_num = $2
           WHERE id = $3 AND source_id = $4 AND source_markdown_slug = $5 AND row_num = $6
           RETURNING id::text AS id`,
          [canonical, plan.rowNumByPhantom.get(Number(row.row_num)), row.id, sourceId, slug, row.row_num]);
        if (changed.length !== 1) throw new Error('phantom DB identity changed during transfer');
        migrated++;
      }
      const left = await tx.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM facts WHERE source_id = $1 AND (entity_slug = $2 OR source_markdown_slug = $2)`, [sourceId, slug]);
      if (left[0]?.n !== 0) throw new Error('facts remain at phantom; deletion refused');
      if (fs.readFileSync(canonicalPath, 'utf8') !== plan.body || (diskBefore !== null && fs.readFileSync(phantomPath, 'utf8') !== diskBefore)) {
        throw new Error('endpoint bytes changed before transfer commit');
      }
      if (isFactRepairDisabled()) throw new Error('repair disabled');
      await tx.rewriteLinks(slug, canonical);
      await tx.softDeletePage(slug, { sourceId });
      // Do not deleteFactsForPage: expired original identities move too.
    });
  } catch (err) { return drift(err instanceof Error ? err.message : String(err)); }
  // Native writes remain excluded. A missing file is already removed.
  if (fs.existsSync(phantomPath)) fs.unlinkSync(phantomPath);
  logPhantomEvent({ phantom_slug: slug, canonical_slug: canonical, outcome: 'redirected', fact_count: migrated, source_id: sourceId });
  return { outcome: 'redirected', canonical };
}

/**
 * The per-cycle phantom-redirect pass. Runs INSIDE `runExtractFacts` after
 * the legacy-row guard fires its empty fast-path. Single per-cycle lock
 * acquisition with bounded retry; if lock is busy the entire pass is
 * skipped this cycle (next cycle retries cleanly).
 */
export async function runPhantomRedirectPass(
  engine: BrainEngine,
  brainDir: string,
  sourceId: string,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<PhantomPassResult> {
  const result = emptyPhantomPassResult();
  const limitRaw = process.env.GBRAIN_PHANTOM_REDIRECT_LIMIT;
  const limit = (() => {
    if (limitRaw === undefined || limitRaw === '') return DEFAULT_PHANTOM_LIMIT;
    const n = parseInt(limitRaw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PHANTOM_LIMIT;
  })();

  // Bounded-retry lock acquisition. tryAcquireDbLock returns null on
  // contention; we loop with 1s backoff up to 30s total.
  // v0.40 D16: per-source lock matching performSync's posture. Phantom + same-
  // source sync still serialize; cross-source parallel sync proceeds unblocked.
  const lock = await acquireLockWithRetry(engine, syncLockId(sourceId), signal);
  if (!lock) {
    logPhantomEvent({ outcome: 'pass_skipped_lock_busy', source_id: sourceId });
    result.lock_busy = true;
    return result;
  }

  try {
    // Find unprefixed phantoms in this source. We over-fetch by 1 so
    // `more_pending` reflects whether the cap actually clipped work.
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND slug NOT LIKE '%/%'
       ORDER BY slug ASC
       LIMIT $2`,
      [sourceId, limit + 1],
    );
    result.more_pending = rows.length > limit;

    const touchedSet = new Set<string>();
    for (let i = 0; i < Math.min(rows.length, limit); i++) {
      // #1972: bail between phantoms on abort (each is independently committed).
      if (isAborted(signal)) break;
      const slug = rows[i].slug;
      const page = await engine.getPage(slug, { sourceId });
      if (!page) continue;
      result.scanned += 1;

      let redirectResult: RedirectResult;
      try {
        redirectResult = await tryRedirectPhantom(engine, page, sourceId, brainDir, dryRun);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[gbrain] phantom-redirect: ${slug} failed (${msg}); skipping\n`);
        logPhantomEvent({
          phantom_slug: slug,
          outcome: 'drift',
          source_id: sourceId,
          reason: `exception: ${msg.slice(0, 200)}`,
        });
        redirectResult = { outcome: 'drift' };
      }

      switch (redirectResult.outcome) {
        case 'redirected':
          result.redirected += 1;
          // Track the canonical so the main reconcile loop can pick it up
          // (scenario B fix: phantom had only-on-disk fence; canonical's
          // DB facts now need to derive from the merged disk fence).
          if (!dryRun && redirectResult.canonical) {
            touchedSet.add(redirectResult.canonical);
          }
          break;
        case 'ambiguous':    result.ambiguous += 1; break;
        case 'drift':        result.skipped_drift += 1; break;
        case 'no_canonical': result.no_canonical += 1; break;
        case 'not_phantom':  result.not_phantom += 1; break;
      }
    }
    result.touched_canonicals = Array.from(touchedSet).sort();
  } finally {
    try {
      await lock.release();
    } catch {
      // TTL expiry will reclaim eventually.
    }
  }

  return result;
}

// Re-export type for cycle.ts consumers.
export type { PhantomOutcome };
