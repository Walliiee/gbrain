/** Revision checks for native whole-page saves. Read-only, called under page lock. */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { FENCE_SOURCE_DEFAULT } from './extract-from-fence.ts';

export const pageRevision = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

type Verdict = { ok: true; droppedIds: string[] } | { ok: false; message: string; suggestion: string };
const conflict = (message: string): Verdict => ({ ok: false, message,
  suggestion: 'Read get_page include_content:true again, retain its facts and reapply your edit with base_revision. Use forget_fact for explicit forgetting.' });
function rowsIn(body: string, timeline: string): ParsedFact[] | null {
  const parts = [parseFactsFence(body), parseFactsFence(timeline)];
  return parts.some(p => p.warnings.length) ? null : parts.flatMap(p => p.facts);
}
const key = (claim: string, source: string | null | undefined) => JSON.stringify([claim, source ?? FENCE_SOURCE_DEFAULT]);

export async function checkFenceRowsOnPut(engine: BrainEngine, opts: {
  slug: string; sourceId: string; content: string; remote: boolean; baseRevision?: string;
}): Promise<Verdict> {
  const page = await engine.getPage(opts.slug, { sourceId: opts.sourceId });
  const tags = page ? await engine.getTags(page.slug, { sourceId: opts.sourceId }) : [];
  const visible = page && opts.remote ? { ...page,
    compiled_truth: sanitizeRemoteBody(page.compiled_truth), timeline: sanitizeRemoteBody(page.timeline ?? ''),
  } : page;
  if (opts.baseRevision !== undefined && (!visible || pageRevision(serializePageToMarkdown(visible as Page, tags)) !== opts.baseRevision)) {
    return conflict(`put_page: '${opts.slug}' changed since base_revision; nothing written.`);
  }
  const owned = await engine.executeRaw<{ id: string; row_num: number; fact: string; source: string | null }>(
    `SELECT id::text AS id, row_num, fact, source FROM facts
     WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL
       AND expired_at IS NULL${opts.remote ? " AND visibility = 'world'" : ''} ORDER BY row_num`,
    [opts.sourceId, opts.slug]);
  if (!owned.length) return { ok: true, droppedIds: [] };
  const parsed = parseMarkdown(opts.content, `${opts.slug}.md`);
  const incoming = rowsIn(parsed.compiled_truth, parsed.timeline ?? '');
  if (!incoming) return conflict(`put_page: '${opts.slug}' has an ambiguous Facts fence; nothing written.`);
  const present = new Set(incoming.map(f => f.rowNum));
  const dropped = owned.filter(f => !present.has(Number(f.row_num)));
  if (!dropped.length) return { ok: true, droppedIds: [] };
  // Even a matching token cannot license dropping facts absent from that view:
  // the page cache itself could have been replaced by a stale file import.
  const previous = visible ? rowsIn(visible.compiled_truth, visible.timeline ?? '') : null;
  if (opts.baseRevision === undefined || !previous || dropped.some(r => !previous.some(f =>
    f.active && f.rowNum === Number(r.row_num) && key(f.claim, f.source) === key(r.fact, r.source)))) {
    return conflict(`put_page: content omits ${dropped.length} active Facts row(s) without a current view carrying them; nothing written.`);
  }
  return { ok: true, droppedIds: dropped.map(r => r.id) };
}
