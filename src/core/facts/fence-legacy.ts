/**
 * Legacy-fact repair during maintenance — the thin caller.
 *
 * `runExtractFacts` halts a source while `row_num IS NULL` rows whose entity
 * page is live remain (the v0.32.2 empty-fence guard). This module drains
 * exactly those rows, page by page, through the native fence writer's stamp
 * mode (`stampLegacyFactsToFence` in fence-write.ts), then the guard
 * re-counts from the DB before deciding to halt or proceed.
 *
 * Everything that is a safety property lives in the writer: page lock,
 * containment-checked target, per-FILE git refusal (tracked at HEAD, clean),
 * ONE transaction that locks the page row and every fact row, re-checks each
 * row on every fence column, mirrors, verifies, stamps and only THEN renames
 * the file into place (a refusal at any point rolls back with nothing
 * written; a crashed run's own uncommitted appends are recognised and the
 * committed preimage restored on the next run), duplicate-key refusal, and a
 * lossless-reuse rule for rows the fence already carries. The SELECT below
 * carries every column the fence can express (typed-claim columns included)
 * plus `superseded_by`, which the writer refuses on an active row. Columns
 * the fence cannot express — `embedding`, `source_session`, `created_at`,
 * `consolidated_at`/`consolidated_into`, `event_type`, `dimension`, `value`,
 * `value_hash`, `dim_status` — stay on the row through the stamp (it is an
 * UPDATE) and are subject to the same wipe + reinsert every fence-owned row
 * is. This file owns only: the eligibility query (the guard's own predicate,
 * so counted-there and repaired-here cannot diverge), grouping, the
 * residue-only sweep over pages whose never-fenced rows have ALL been
 * forgotten (the stamp path never visits them; the writer's own recognizer
 * decides what is residue, and a page it cannot prove safe is handed back
 * as `residuePagesBlocked` for the reconcile to leave alone), the per-source
 * summary the halt reports, and a kill switch.
 *
 * Rollback after a COMMITTED stamp is git-native and has no code here:
 * un-stamp FIRST (`UPDATE facts SET row_num = NULL, source_markdown_slug =
 * NULL WHERE source_id = $1 AND source_markdown_slug = $2 AND id = ANY($3)`),
 * then restore the file from its committed preimage (`git checkout -- <file>`
 * or `git revert` of the path-limited commit), then `gbrain sync --source
 * <id>`. The writer refuses files with uncommitted changes, so a committed
 * preimage always exists for anything it touched. Proven in
 * test/facts-fence-legacy-repair.test.ts (un-stamp before fence removal;
 * the reverse order is the deletion window).
 */

import type { BrainEngine } from '../engine.ts';
import { isAborted } from '../abort-check.ts';
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
  /**
   * Residue-only sweep (review finding 3): pages whose never-fenced rows have
   * ALL been forgotten, checked for a crashed run's uncommitted appends.
   * `residuePagesChecked` counts pages with a self-dirty file that were
   * examined; `residuePagesHealed` those whose dirt was exactly this repair's
   * residue and were put back to their committed preimage.
   */
  residuePagesChecked: number;
  residuePagesHealed: number;
  /**
   * Residue-only pages the sweep could NOT prove safe: a self-dirty file that
   * is not this repair's exact residue (`not_residue`), a restored file whose
   * cache still carries another body (`cache_unsafe`), a lock or a throw
   * (`error`), or a page the per-pass cap left unvisited (`unswept`). The
   * reconcile skips these slugs; a later sync, commit or restore clears them.
   */
  residuePagesBlocked: Array<{ slug: string; reason: Exclude<ResidueSweepOutcome, 'healed' | 'clean' | 'skipped'> | 'unswept'; detail?: string }>;
  /**
   * Set when a repair-WIDE step threw — listing the eligible rows, listing the
   * residue-only pages, or the final recount (the per-page writer calls never
   * throw; they refuse per page). The summary is then PARTIAL: every counter
   * and every block collected before the throw is kept, but no page the pass
   * did not reach is proven safe, and `rowsRemaining` is NOT a fresh count.
   * The caller must fail closed on it — a repair that could not complete is
   * not a repair that found nothing to block (Codex acceptance round 3, P1).
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
export function isFactRepairDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GBRAIN_FACT_REPAIR ?? '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'disabled';
}

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
            f.source, f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.superseded_by
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
 * source with a local_path — the same fenceability terms as the guard.
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
        AND EXISTS (
          SELECT 1 FROM sources s
           WHERE s.id = f.source_id
             AND s.local_path IS NOT NULL
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
 * uncommitted residue. Never throws: a page the writer refuses is counted
 * under its reason and left for the guard to report, and a repair-wide query
 * that throws returns the partial summary with `failure` set — the caller
 * fails closed on it, nothing collected so far is lost. `rowsRemaining` is
 * re-counted after the pass.
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

  // Residue-only sweep: pages the stamp path can no longer reach. Read-only
  // on a dry-run (nothing is written there); the writer's own recognizer
  // decides, so only this repair's exact bytes are ever put back. A page the
  // stamp loop just visited is skipped — its self-dirt is the stamp's own
  // append, not residue. Every page the sweep cannot prove safe — including
  // one the cap left unvisited — is handed back blocked, never silently
  // left for the reconcile.
  if (!dryRun && !summary.aborted) {
    let residuePages: string[];
    try {
      residuePages = await listResidueOnlyPagesForSource(engine, opts.sourceId);
    } catch (err) {
      // The stamp counters above stand; which pages carry residue is unknown.
      return fail('listing residue-only pages', err);
    }
    for (const slug of residuePages) {
      if (bySlug.has(slug)) continue;
      if (isAborted(opts.signal)) { summary.aborted = true; break; }
      if (pages++ >= (opts.maxPages ?? DEFAULT_MAX_PAGES)) {
        summary.residuePagesBlocked.push({ slug, reason: 'unswept', detail: 'per-pass page cap reached' });
        continue;
      }
      const r = await healResidueOnlyPage(engine, { sourceId: opts.sourceId, slug }, { lockTimeoutMs: opts.lockTimeoutMs });
      if (r.outcome === 'clean' || r.outcome === 'skipped') continue;
      if (r.outcome !== 'error') summary.residuePagesChecked += 1;
      if (r.outcome === 'healed') summary.residuePagesHealed += 1;
      else summary.residuePagesBlocked.push({ slug, reason: r.outcome, detail: r.detail });
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
    // zero. Pre-fix this throw discarded a `not_residue` block that had
    // already been collected.
    return fail('re-counting eligible legacy rows', err);
  }
  return summary;
}
