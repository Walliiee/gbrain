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
 * unique `.tmp` + parse + rename, body mirror, verify-inside-the-stamp-
 * transaction with the page row and fact rows locked, duplicate-key refusal.
 * The SELECT below carries every column the fence can express (typed-claim
 * columns included) plus `superseded_by`, which the writer refuses on an
 * active row. Columns the fence cannot express — `embedding`, `source_session`,
 * `created_at`, `consolidated_at`/`consolidated_into`, `event_type`,
 * `dimension`, `value`, `value_hash`, `dim_status` — stay on the row through
 * the stamp (it is an UPDATE) and are subject to the same wipe + reinsert
 * every fence-owned row is. This file owns only: the eligibility query (the guard's own
 * predicate, so counted-there and repaired-here cannot diverge), grouping,
 * the per-source summary the halt reports, and a kill switch.
 *
 * Rollback is git-native and has no code here: un-stamp FIRST
 * (`UPDATE facts SET row_num = NULL, source_markdown_slug = NULL WHERE
 * source_id = $1 AND source_markdown_slug = $2 AND id = ANY($3)`), then
 * restore the file from its committed preimage (`git checkout -- <file>` or
 * `git revert` of the path-limited commit), then `gbrain sync --source <id>`.
 * The writer refuses files with uncommitted changes, so a committed preimage
 * always exists for anything it touched. Proven in
 * test/facts-fence-legacy-repair.test.ts (un-stamp before fence removal;
 * the reverse order is the deletion window).
 */

import type { BrainEngine } from '../engine.ts';
import { isAborted } from '../abort-check.ts';
import {
  stampLegacyFactsToFence,
  type LegacyStampRow,
  type LegacyStampHooks,
  type LegacyStampSkipReason,
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
  pagesFenced: number;
  pagesSkipped: number;
  /** Pending pages by refusal reason, so the halt can say why. */
  skippedByReason: Partial<Record<LegacyStampSkipReason, number>>;
  /** `slug (reason: detail)` for the first few refusals. */
  skippedDetails: string[];
  /** Legacy rows still eligible after the pass — re-counted, not derived. */
  rowsRemaining: number;
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
            f.notability, f.context, f.valid_from, f.valid_until, f.source, f.confidence,
            f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.superseded_by
       FROM facts f${ELIGIBLE_WHERE}
      ORDER BY f.entity_slug, f.id`,
    [sourceId],
  );
}

export async function countLegacyRowsForSource(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*) AS n FROM facts f${ELIGIBLE_WHERE}`, [sourceId]);
  return parseInt(rows[0]?.n ?? '0', 10);
}

const DEFAULT_MAX_PAGES = 500;

/**
 * Drain every eligible legacy row in `sourceId`, page by page. Never throws:
 * a page the writer refuses is counted under its reason and left for the
 * guard to report. `rowsRemaining` is re-counted after the pass.
 */
export async function repairLegacyRowsForSource(
  engine: BrainEngine,
  opts: RepairLegacyRowsOpts,
): Promise<RepairLegacyRowsSummary> {
  const dryRun = opts.dryRun ?? false;
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
