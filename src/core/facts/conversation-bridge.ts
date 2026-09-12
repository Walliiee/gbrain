/**
 * conversation-bridge.ts — the one-way extraction bridge for
 * `extract-conversation-facts`.
 *
 * The bulk conversation extractor reads pages from ONE input source and, by
 * default, writes the extracted fact rows back into that same source with the
 * engine's default visibility (`private`). On a multi-source brain where the
 * raw conversation pages live in a NON-federated source (raw chat logs that
 * must stay isolated), that default strands every extracted fact: normal
 * federated recall never sees the input source, and remote/MCP callers never
 * see private rows. The knowledge is extracted and unusable at the same time.
 *
 * The bridge splits the two concerns:
 *
 *   input source  (`sourceId`)        — page reads, the per-page advisory
 *                                       lock, checkpoints, receipts/rollups,
 *                                       and the durable audit rows (terminal
 *                                       + non-extractable)
 *   output source (`outputSourceId`)  — ONLY the extracted knowledge rows,
 *                                       stamped with the requested visibility,
 *                                       and the save-time entity resolution
 *                                       that canonicalizes their `entity_slug`
 *
 * Entity resolution follows the rows, not the page: the resolver probes ONE
 * source (exact slug / alias / prefix / fuzzy, then slugify), and the pages
 * a fact's `entity_slug` should point at live beside the rows in the output
 * source — an input source of raw conversation pages holds none, so probing
 * it would slugify every name into a one-off label.
 *
 * Nothing from the raw page crosses over except the fact rows themselves.
 * `source_markdown_slug` keeps naming the input page; the input SOURCE rides
 * in the row's `source` column (`bridgedFactSource`) so a bridged row is
 * always attributable to the page it came from, and so replay cleanup can
 * target exactly the rows one (input source, page) pair produced.
 *
 * Why bridged rows get a DISTINCT `source` value instead of reusing
 * `cli:extract-conversation-facts`: the extractor's delete-orphans-first
 * replay wipes `source LIKE 'cli:extract-conversation-facts%'` for
 * (source_id, slug). If the output source also holds a same-slug page that
 * was extracted same-source, a shared prefix would let each side's replay
 * delete the other side's rows. The bridge prefix does not match that LIKE,
 * and it carries the input source id, so the two row sets never collide in
 * cleanup. It still starts with `cli:` so the fence-reconcile paths
 * (`excludeSourcePrefixes: ['cli:']`, #1928) keep protecting bridged rows
 * exactly like same-source conversation rows.
 *
 * Row numbering: the facts unique index is `(source_id, source_markdown_slug,
 * row_num)` and `insertFacts` uses ON CONFLICT DO NOTHING. Bridged rows
 * therefore start at MAX(row_num)+1 for (output source, slug) so they append
 * after any fence rows or same-source rows a same-slug output page may own,
 * instead of silently colliding with them.
 *
 * Default behaviour is unchanged: no output source → same source; no
 * visibility → the shared facts ladder (explicit value > the
 * `facts.default_visibility` config key > `private`, `./visibility.ts`).
 *
 * Leaf module (engine type + two small helpers) so the command file, the
 * Minion handler, and the cycle phase share one definition of the route.
 */

import type { BrainEngine, FactVisibility } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import { fetchSource } from '../sources-load.ts';
import { resolveVisibilityParam } from './visibility.ts';

/** `source` prefix stamped on bridged rows; the input source id follows. */
export const BRIDGE_SOURCE_PREFIX = 'cli:conversation-facts-bridge';

/** `facts.source` value for rows bridged out of `inputSourceId`. */
export function bridgedFactSource(inputSourceId: string): string {
  return `${BRIDGE_SOURCE_PREFIX}:${inputSourceId}`;
}

/** Where one extraction run reads from, writes to, and how visible the rows are. */
export interface ConversationFactsRoute {
  /** Input source: pages, locks, checkpoints, audit rows, receipts. */
  sourceId: string;
  /** Output source for the extracted knowledge rows and their entity resolution (== sourceId when not bridged). */
  outputSourceId: string;
  /** Visibility stamped on the extracted knowledge rows (audit rows stay private). */
  visibility: FactVisibility;
  /** true when outputSourceId !== sourceId. */
  bridged: boolean;
}

export interface ResolveRouteOpts {
  sourceId: string;
  outputSourceId?: string;
  visibility?: FactVisibility | string;
}

/**
 * Validate and resolve the route for one run. Throws on an invalid or
 * unknown/archived output source so a typo can never park knowledge in a
 * source nobody reads. Visibility resolves through the shared facts ladder.
 */
export async function resolveConversationFactsRoute(
  engine: BrainEngine,
  opts: ResolveRouteOpts,
): Promise<ConversationFactsRoute> {
  const sourceId = opts.sourceId;
  let outputSourceId = sourceId;
  if (opts.outputSourceId !== undefined && opts.outputSourceId !== '') {
    assertValidSourceId(opts.outputSourceId);
    outputSourceId = opts.outputSourceId;
  }
  const bridged = outputSourceId !== sourceId;
  if (bridged) {
    const row = await fetchSource(engine, outputSourceId);
    if (!row) {
      throw new Error(
        `extract-conversation-facts: output source "${outputSourceId}" is not registered ` +
          `(gbrain sources list). Refusing to write facts into an unknown source.`,
      );
    }
    if (row.archived === true) {
      throw new Error(
        `extract-conversation-facts: output source "${outputSourceId}" is archived; ` +
          `restore it before bridging facts into it.`,
      );
    }
  }
  if (
    opts.visibility !== undefined &&
    opts.visibility !== 'world' &&
    opts.visibility !== 'private'
  ) {
    throw new Error(
      `extract-conversation-facts: visibility must be "world" or "private" (got ${JSON.stringify(opts.visibility)})`,
    );
  }
  const visibility = await resolveVisibilityParam(engine, opts.visibility);
  return { sourceId, outputSourceId, visibility, bridged };
}

/** Parse a CLI/config visibility token; returns undefined for unset, throws on garbage. */
export function parseVisibilityToken(raw: string | null | undefined): FactVisibility | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'world' || v === 'private') return v;
  throw new Error(`visibility must be "world" or "private" (got ${JSON.stringify(raw)})`);
}

/**
 * Delete-orphans companion for the OUTPUT side of a bridged route: removes the
 * rows a prior run of this exact (input source, page) pair bridged into the
 * output source, and nothing else — not same-source rows of a same-slug output
 * page, not rows bridged from a different input source, not fence rows.
 * No-op (returns 0) when the route is not bridged; the input-side cleanup in
 * the command file already covers that case.
 */
export async function deleteBridgedOrphanFacts(
  engine: BrainEngine,
  route: ConversationFactsRoute,
  slug: string,
): Promise<number> {
  if (!route.bridged) return 0;
  const rows = await engine.executeRaw<{ count: string }>(
    `WITH del AS (
       DELETE FROM facts
       WHERE source_markdown_slug = $1
         AND source = $2
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM del`,
    [slug, bridgedFactSource(route.sourceId)],
  );
  const n = parseInt(rows[0]?.count ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Next free `row_num` for (source_id, slug): MAX(row_num)+1 over EVERY row
 * the pair owns, whichever path wrote it. The bridged path always starts
 * here; the same-source path uses it for dry runs and as a defensive
 * fallback. Pre-migration brains without the fence columns fall back to 0.
 */
export async function peekRowNumStart(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ max_row: number | null }>(
      `SELECT COALESCE(MAX(row_num), -1) AS max_row
         FROM facts
        WHERE source_id = $1 AND source_markdown_slug = $2`,
      [sourceId, slug],
    );
    const maxRow = rows[0]?.max_row ?? -1;
    return Number(maxRow) + 1;
  } catch {
    // Pre-migration brains may not have source_markdown_slug populated.
    // Fall back to 0; insertFacts will fail with a clearer error if
    // there's a real collision.
    return 0;
  }
}
