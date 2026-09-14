import type { BrainEngine } from '../engine.ts';

/** DB-plane, per-brain policy. No defaults and no caller-controlled opt-out. */
export const SEARCH_EXCLUDE_STATUSES_KEY = 'search.exclude_statuses';

export interface SearchLifecyclePolicy {
  /** Resolved internally from the serving brain, never from tool parameters. */
  excludeStatuses?: string[];
}

/**
 * Status identifiers use ASCII case folding and surrounding ASCII whitespace
 * removal. Keep this identical to the SQL expression below on both engines,
 * independently of the database collation. Missing/non-string page statuses
 * are retained. Only an absent setting or [] disables the policy.
 */
export function normalizeLifecycleStatus(value: string): string {
  return value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '')
    .replace(/[A-Z]/g, (char) => char.toLowerCase());
}

export function parseExcludedStatuses(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  let values: unknown;
  try { values = JSON.parse(raw); } catch {
    throw new Error(`${SEARCH_EXCLUDE_STATUSES_KEY} must be a JSON array of non-empty status strings`);
  }
  if (!Array.isArray(values) || values.some((value) =>
    typeof value !== 'string' || !normalizeLifecycleStatus(value) || value.includes('\0'))) {
    throw new Error(`${SEARCH_EXCLUDE_STATUSES_KEY} must be a JSON array of non-empty status strings without NUL`);
  }
  return [...new Set(values.map(normalizeLifecycleStatus))].sort();
}

/** No process cache: an operator edit takes effect on the next retrieval. */
export async function resolveSearchLifecyclePolicy(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<{ excludeStatuses: string[] }> {
  return { excludeStatuses: parseExcludedStatuses(await engine.getConfig(SEARCH_EXCLUDE_STATUSES_KEY)) };
}

/** Engine-provided alias only. Values are escaped PostgreSQL string literals. */
export function lifecycleFilterFragment(alias: string, statuses?: readonly string[]): string {
  if (!statuses?.length) return 'TRUE';
  const literals = statuses.map((status) =>
    `E'${normalizeLifecycleStatus(status).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(', ');
  // E-string makes the trim character set explicit (btrim's default is spaces
  // only). translate avoids locale-dependent lower() differences across DBs.
  const normalized = `translate(btrim(${alias}.frontmatter->>'status', E' \\t\\n\\r\\f\\013'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  return `(CASE WHEN jsonb_typeof(${alias}.frontmatter->'status') = 'string' THEN ${normalized} NOT IN (${literals}) ELSE TRUE END)`;
}
