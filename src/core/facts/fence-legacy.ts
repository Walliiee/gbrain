/**
 * Thin source-scoped legacy repair caller. The native writer performs all
 * validation and transactional stamping. Repair can append through a pinned
 * file descriptor or reuse a complete committed fence; it cannot rewrite,
 * commit, heal or restore files. Every newly discovered residue-only page is
 * inspected, including previous eligibility candidates and unavailable paths.
 * Unknown/dirty residue blocks the source before redirection/reconciliation.
 *
 * No online rollback. Stop/disable ALL producers and drain them before any
 * rollback SQL or manual file merge; see docs/architecture/fact-repair.md.
 */

import type { BrainEngine } from '../engine.ts';
import { isAborted } from '../abort-check.ts';
import { isFactRepairDisabled } from './repair-policy.ts';
import {
  stampLegacyFactsToFence,
  healResidueOnlyPage,
  fenceDateSql,
  type LegacyStampRow,
  type LegacyStampHooks,
  type LegacyStampSkipReason,
  type ResidueSweepOutcome,
} from './fence-write.ts';

export type { LegacyStampHooks, LegacyStampSkipReason } from './fence-write.ts';

/** A legacy row plus the page it belongs to. */
export interface LegacyFactRow extends LegacyStampRow {
  source_id: string;
  entity_slug: string;
}

export interface RepairLegacyRowsSummary {
  rowsEligible: number;
  rowsStamped: number;
  rowsAppended: number;
  /** Existing fence rows rewritten in place to carry fields only the DB row held. */
  rowsRewritten: number;
  pagesFenced: number;
  pagesSkipped: number;
  /** Pending pages by refusal reason, so the halt can say why. */
  skippedByReason: Partial<Record<LegacyStampSkipReason, number>>;
  /** `slug (reason: detail)` for the first few refusals. */
  skippedDetails: string[];
  /** Legacy rows still eligible after the pass — re-counted, not derived. */
  rowsRemaining: number;
  /** Read-only inspection attempts, including unavailable targets. */
  residuePagesChecked: number;
  /** Compatibility counter; always zero. Automatic healing was removed. */
  residuePagesHealed: number;
  /** Unknown, dirty, unavailable, unsafe-cache or unvisited residue candidates.
   * Any block halts this source before BOTH redirection and reconciliation.
   * A commit alone cannot make a forgotten active claim safe to reinsert. */
  residuePagesBlocked: Array<{ slug: string; reason: Exclude<ResidueSweepOutcome, 'healed' | 'clean' | 'skipped'> | 'unswept'; detail?: string }>;
  /**
   * Set when a repair-WIDE step threw — listing the eligible rows, listing the
   * residue-only pages, or the final recount. The per-page writer calls never
   * throw: `stampLegacyFactsToFence` and `healResidueOnlyPage` contain their
   * whole body, so a page whose target resolution or write-through read hits
   * a DB fault is that page's `error` refusal, counted like any other. The
   * summary is then PARTIAL: every counter and every block collected before
   * the throw is kept, but no page the pass did not reach is proven safe, and
   * `rowsRemaining` is NOT a fresh count. The caller must fail closed on it —
   * a repair that could not complete is not a repair that found nothing to
   * block.
   */
  failure?: string;
  dryRun: boolean;
  aborted: boolean;
}

export interface RepairLegacyRowsOpts {
  sourceId: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Per-page lock wait. Default 5 s, matching the fence writer. */
  lockTimeoutMs?: number;
  /** Cap on pages per pass so a large backlog cannot outgrow the cycle budget. */
  maxPages?: number;
  hooks?: LegacyStampHooks;
}

/**
 * `GBRAIN_FACT_REPAIR=off` disables the in-cycle repair without a deploy; the
 * phase then halts exactly as before this module existed.
 */
export { isFactRepairDisabled } from './repair-policy.ts';

/**
 * The guard's predicate, verbatim: row never fenced, entity page live in THIS
 * source, source has a local_path, row not soft-expired. Keep in step with the
 * COUNT in runExtractFacts.
 */
const ELIGIBLE_WHERE = `
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
        )`;

export async function listLegacyRowsForSource(engine: BrainEngine, sourceId: string): Promise<LegacyFactRow[]> {
  return engine.executeRaw<LegacyFactRow>(
    `SELECT f.id::text AS id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility,
            f.notability, f.context, ${fenceDateSql('f.valid_from')} AS valid_from, ${fenceDateSql('f.valid_until')} AS valid_until,
            f.source, f.confidence, f.claim_metric, f.claim_value::text AS claim_value,
            f.claim_unit, f.claim_period, f.superseded_by, to_jsonb(f)::text AS snapshot
       FROM facts f${ELIGIBLE_WHERE}
      ORDER BY f.entity_slug, f.id`,
    [sourceId],
  );
}

export async function countLegacyRowsForSource(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*) AS n FROM facts f${ELIGIBLE_WHERE}`, [sourceId]);
  return parseInt(rows[0]?.n ?? '0', 10);
}

/**
 * Pages in `sourceId` that carry never-fenced rows which have ALL been
 * forgotten (soft-expired, `row_num IS NULL`) and no eligible row: the guard
 * does not arm on them and the stamp path never visits them, yet a crashed
 * run may have left its appends on their file (review finding 3). Live page,
 * regardless of source.local_path; losing file access cannot erase a tombstone.
 */
export async function listResidueOnlyPagesForSource(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ entity_slug: string }>(
    `SELECT DISTINCT f.entity_slug
       FROM facts f
      WHERE f.source_id = $1
        AND f.row_num IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.expired_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = f.source_id
             AND p.slug = f.entity_slug
             AND p.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM facts e
           WHERE e.source_id = f.source_id
             AND e.entity_slug = f.entity_slug
             AND e.row_num IS NULL
             AND e.expired_at IS NULL
        )
      ORDER BY f.entity_slug`,
    [sourceId],
  );
  return rows.map(r => r.entity_slug);
}

const DEFAULT_MAX_PAGES = 500;

/**
 * Drain every eligible legacy row in `sourceId`, page by page, then sweep the
 * pages whose never-fenced rows have all been forgotten for a crashed run's
 * uncommitted residue. Never throws: the two per-page writer calls contain
 * their whole body (a page they cannot even resolve is counted under `error`
 * with the message), and each of the three repair-wide queries is caught
 * here — a throw ends the pass and returns the partial summary with
 * `failure` set, so the caller fails closed on it and nothing collected so
 * far is lost. `rowsRemaining` is re-counted after the pass.
 */
export async function repairLegacyRowsForSource(
  engine: BrainEngine,
  opts: RepairLegacyRowsOpts,
): Promise<RepairLegacyRowsSummary> {
  const dryRun = opts.dryRun ?? false;
  const summary: RepairLegacyRowsSummary = {
    rowsEligible: 0, rowsStamped: 0, rowsAppended: 0, rowsRewritten: 0,
    pagesFenced: 0, pagesSkipped: 0,
    skippedByReason: {}, skippedDetails: [],
    rowsRemaining: 0, residuePagesChecked: 0, residuePagesHealed: 0, residuePagesBlocked: [],
    dryRun, aborted: false,
  };

  // A repair-wide throw ends the pass with what was collected so far; the
  // caller reads `failure`, never a counter, to decide that this pass proved
  // nothing about the pages it did not reach.
  const fail = (step: string, err: unknown): RepairLegacyRowsSummary => {
    summary.failure = `${step}: ${err instanceof Error ? err.message : String(err)}`;
    return summary;
  };

  if (isFactRepairDisabled()) return fail('disabled', 'GBRAIN_FACT_REPAIR disables repair and reconciliation; drain all writers before rollback');

  let rows: LegacyFactRow[];
  try {
    rows = await listLegacyRowsForSource(engine, opts.sourceId);
  } catch (err) {
    return fail('listing eligible legacy rows', err);
  }
  summary.rowsEligible = rows.length;

  const bySlug = new Map<string, LegacyFactRow[]>();
  for (const r of rows) bySlug.set(r.entity_slug, [...(bySlug.get(r.entity_slug) ?? []), r]);

  let pages = 0;
  for (const [slug, group] of bySlug) {
    if (isAborted(opts.signal)) { summary.aborted = true; break; }
    if (pages++ >= (opts.maxPages ?? DEFAULT_MAX_PAGES)) break;
    const r = await stampLegacyFactsToFence(
      engine,
      { sourceId: opts.sourceId, slug },
      group,
      { dryRun, lockTimeoutMs: opts.lockTimeoutMs, hooks: opts.hooks },
    );
    if (r.status === 'stamped') {
      summary.pagesFenced += 1;
      summary.rowsStamped += r.stamped;
      summary.rowsAppended += r.appended;
      summary.rowsRewritten += r.rewritten;
    } else {
      summary.pagesSkipped += 1;
      const reason = r.reason ?? 'error';
      summary.skippedByReason[reason] = (summary.skippedByReason[reason] ?? 0) + 1;
      if (summary.skippedDetails.length < 10) {
        summary.skippedDetails.push(`${slug} (${reason}${r.detail ? `: ${r.detail.slice(0, 160)}` : ''})`);
      }
    }
  }

  // Re-query after ALL stamp attempts. Earlier eligibility membership does
  // not prove safety: a concurrent forget can make that page residue-only.
  // Inspection is read-only; dirty or unavailable content is never healed.
  if (!dryRun && !summary.aborted) {
    let residuePages: string[];
    try {
      residuePages = await listResidueOnlyPagesForSource(engine, opts.sourceId);
    } catch (err) {
      // The stamp counters above stand; which pages carry residue is unknown.
      return fail('listing residue-only pages', err);
    }
    for (const slug of residuePages) {
      if (isAborted(opts.signal)) { summary.aborted = true; break; }
      if (pages++ >= (opts.maxPages ?? DEFAULT_MAX_PAGES)) {
        summary.residuePagesBlocked.push({ slug, reason: 'unswept', detail: 'per-pass page cap reached' });
        continue;
      }
      const r = await healResidueOnlyPage(engine, { sourceId: opts.sourceId, slug }, { lockTimeoutMs: opts.lockTimeoutMs });
      if (r.outcome === 'clean') continue;
      summary.residuePagesChecked += 1;
      summary.residuePagesBlocked.push({ slug, reason: r.outcome === 'skipped' || r.outcome === 'healed' ? 'unswept' : r.outcome, detail: r.detail });
    }
  }

  if (dryRun) {
    summary.rowsRemaining = rows.length;
    return summary;
  }
  try {
    summary.rowsRemaining = await countLegacyRowsForSource(engine, opts.sourceId);
  } catch (err) {
    // Every block and counter collected above stays on the summary; only the
    // fresh count is missing, and the caller must not treat its absence as
    // zero — a `not_residue` block collected above must survive this throw.
    return fail('re-counting eligible legacy rows', err);
  }
  return summary;
}
