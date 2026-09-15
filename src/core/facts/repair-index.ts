/**
 * Complete the DB index for a repaired page INSIDE the repair transaction
 * (2026-09-15, R7-3). The repair already mirrors the fenced body into
 * `pages`; without this the page's `content_chunks` still describe the
 * pre-repair body, so a `world` fact the repair just transferred is absent
 * from ordinary keyword/hybrid search until some later commit triggers a full
 * re-import — and this install's refresh runs committed-only sync, which sees
 * no commit because the repair deliberately never commits.
 *
 * This is the same chunk build `importFromContent` performs (markdown chunks
 * for body and timeline, plus fenced-code chunks), a full replacement, and the
 * same `chunker_version` seal. The page's `content_hash` is deliberately left
 * pre-repair, so the next ordinary committed sync still re-imports the file
 * normally once a human publishes it.
 *
 * Chunks land with NULL embeddings, exactly like the existing `deferEmbeds`
 * path; the standing `embed --stale` backfill covers them. `private` facts are
 * stripped from chunk text by design upstream, so chunk-level searchability is
 * a `world`-row property — private rows stay retrievable through the facts
 * table (`recall`/`entity`), which the repair has already stamped.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';
import { isQuarantined } from '../quarantine.ts';
import { isEmbedSkipped } from '../embed-skip.ts';
import { chunkText, MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { resolveMaxChunkTokens } from '../embedding-input-limit.ts';
import { extractFencedChunks } from '../import-file.ts';

export async function indexRepairedPage(
  tx: BrainEngine,
  slug: string,
  sourceId: string,
  compiledTruth: string,
  timeline: string,
): Promise<number> {
  const page = await tx.getPage(slug, { sourceId });
  if (!page) throw new Error('repair index: page disappeared');
  const skip = isQuarantined(page.frontmatter) || isEmbedSkipped(page.frontmatter);
  const chunkOpts = { maxTokens: resolveMaxChunkTokens() };
  const chunks: ChunkInput[] = [];
  if (!skip && compiledTruth.trim()) {
    for (const c of chunkText(compiledTruth, chunkOpts)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
    }
  }
  if (!skip && timeline.trim()) {
    for (const c of chunkText(timeline, chunkOpts)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'timeline' });
    }
  }
  if (!skip && compiledTruth.trim()) {
    chunks.push(...await extractFencedChunks(compiledTruth, chunks.length));
  }
  await tx.deleteChunks(slug, { sourceId });
  if (chunks.length > 0) await tx.upsertChunks(slug, chunks, { sourceId });
  await tx.executeRaw(
    'UPDATE pages SET chunker_version = $1 WHERE source_id = $2 AND slug = $3 AND deleted_at IS NULL',
    [MARKDOWN_CHUNKER_VERSION, sourceId, slug],
  );
  return chunks.length;
}
