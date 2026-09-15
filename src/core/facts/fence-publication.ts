/**
 * A missing active fence row is ambiguous: the file may predate its transfer.
 * HEAD is not a reader revision, and an unavailable file is not permission to
 * delete. Reconcile preserves the page's facts unless all active row numbers
 * remain represented. Explicit removal uses revision-checked put_page or
 * forget_fact. Called under the page lock with a fresh fact-table read.
 */
import type { BrainEngine } from '../engine.ts';

export async function missingOwnedFenceRows(
  engine: BrainEngine, slug: string, sourceId: string, present: ReadonlySet<number>,
): Promise<number[]> {
  const rows = await engine.executeRaw<{ row_num: number }>(
    `SELECT row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2
       AND row_num IS NOT NULL AND expired_at IS NULL
       AND (source IS NULL OR source NOT LIKE 'cli:%') ORDER BY row_num`, [sourceId, slug]);
  return rows.map(r => Number(r.row_num)).filter(n => !present.has(n));
}

export function unpublishedConflictWarning(slug: string, rowNums: number[]): string {
  return `${slug}: FACTS_FENCE_UNPUBLISHED_CONFLICT: active owned rows #${rowNums.join(', #')} `
    + `are missing from the current body. Its author may not have read those facts. Nothing deleted. `
    + `Restore the rows, or explicitly forget_fact their ids; for a deliberate edit use get_page `
    + `include_content:true and put_page base_revision. Git publication alone is not a reader revision.`;
}
