import type { PageReadPolicy } from '../types.ts';
import { privatePagesFilterFragment } from './private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { lifecycleFilterFragment } from './lifecycle-policy.ts';

/** Preserve unrestricted local reads while retaining source-only restrictions. */
export function hasReadPolicy(scope?: PageReadPolicy): boolean {
  return !!(scope?.excludeStatuses?.length || scope?.sourceIds?.length || scope?.sourceId || scope?.excludePrivate || scope?.requireSafeChunks || scope?.takesHoldersAllowList !== undefined);
}

/** Callers supply fixed SQL aliases; policy values use binds or escaped literals. */
export function pageReadFilter(
  alias: string,
  scope: PageReadPolicy | undefined,
  params: unknown[],
  live = false,
): string {
  const clauses: string[] = [];
  if (scope?.sourceIds?.length) {
    params.push(scope.sourceIds);
    clauses.push(`${alias}.source_id = ANY($${params.length}::text[])`);
  } else if (scope?.sourceId) {
    params.push(scope.sourceId);
    clauses.push(`${alias}.source_id = $${params.length}`);
  }
  if (scope?.excludeStatuses?.length) clauses.push(lifecycleFilterFragment(alias, scope.excludeStatuses));
  if (scope?.excludePrivate) clauses.push(privatePagesFilterFragment(alias));
  if (live) clauses.push(
    `${alias}.deleted_at IS NULL`,
    quarantineFilterFragment(alias),
    `EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = ${alias}.source_id AND NOT read_source.archived)`,
  );
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}
