/**
 * v0.32.2 migration orchestrator — facts join the system-of-record invariant.
 *
 * Schema migration v51 (src/core/migrate.ts) added the two fence columns
 * (row_num, source_markdown_slug) and the partial UNIQUE index. The
 * orchestrator's job is the data half: walk every existing pre-v51 row
 * in the facts table (row_num IS NULL = "no fence yet") and append it
 * to its entity page's `## Facts` fence, atomically + idempotently.
 *
 * Phases:
 *   A. Schema       — assert migration v51 has run.
 *   B. Fence facts  — backfill DB facts → entity-page fences (dry-run
 *                     by default; explicit --write required).
 *   C. Verify       — re-parse each fence-owned page, count rows, compare
 *                     against the DB rows for that page; partial on
 *                     mismatch. Conversation-miner (`cli:`) facts are not
 *                     fence-owned (extract-conversation-facts writes the
 *                     chat log as source of truth) and are excluded.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B only touches rows with row_num IS NULL. Re-runs
 * after a partial completion pick up where the previous run stopped.
 * Per-page atomic (.tmp + parse + rename, same primitive as
 * fence-write.ts). Dirty-tree refusal mirrors src/core/dry-fix.ts so
 * the user can review the diff before committing.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 *
 * Source scoping (`--source <id>`, 2026-09-13): phases B and C confine
 * themselves to ONE source — its legacy rows, its working tree, its
 * pages. Before this the legacy-row walk was brain-wide and the
 * dirty-tree refusal covered every source that held a row, so draining
 * one source's backlog meant committing every repo clean at the same
 * moment. A scoped run that leaves fenceable rows in OTHER sources
 * finishes `partial` (the migration is not brain-wide complete); the
 * ledger's "complete wins" rule means this never regresses an already-
 * complete brain. No `--source` = brain-wide, unchanged.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { upsertFactRow, parseFactsFence } from '../../core/facts-fence.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function getEngine(): Promise<BrainEngine | null> {
  if (testEngineOverride) return testEngineOverride;
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return engine;
  } catch {
    return null;
  }
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) {
    return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  }
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 51) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 51 (facts_fence_columns); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: row_num + source_markdown_slug exist on facts.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name IN ('row_num', 'source_markdown_slug')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected columns row_num + source_markdown_slug on facts; found ${rows.map(r => r.column_name).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Fence facts ──────────────────────────────────

interface LegacyFactRow {
  id: string;        // BIGSERIAL — string-typed on the wire for safety
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  visibility: 'private' | 'world';
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
  confidence: number;
}

interface SourceLookup {
  id: string;
  local_path: string | null;
}

/** Fenceable legacy rows a scoped run left in some OTHER source. */
interface PendingElsewhere {
  source_id: string;
  n: number;
}

/**
 * Phase B's result. `pending_elsewhere` is populated only on a scoped run
 * (`opts.sourceId`); the orchestrator reads it and strips it before the
 * result reaches the ledger, so the persisted phase shape is unchanged.
 */
type FencePhaseResult = OrchestratorPhaseResult & { pending_elsewhere?: PendingElsewhere[] };

interface PhaseBOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  pages_touched: number;
  failed_pages: string[];
}

/**
 * Dirty-tree refusal: mirror src/core/dry-fix.ts behavior. Refuses to
 * write if any source's local_path has uncommitted changes. Dry-run
 * skips this check (no writes happen anyway).
 */
function isLocalPathDirty(localPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo OR git not on PATH → treat as "not dirty" (the
    // user opted out of git tracking, which is allowed). The fence
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

async function phaseBFenceFacts(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<FencePhaseResult> {
  // `--source <id>`: every legacy-row query below carries this predicate so
  // a scoped run never reads, writes, or git-checks another source.
  const scope = opts.sourceId;
  const scopeSql = scope ? ' AND source_id = $1' : '';
  const scopeParams = scope ? [scope] : [];

  if (opts.dryRun) {
    // Dry-run: report what WOULD happen without touching FS or DB.
    if (!engine) return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
    try {
      const counts = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*) AS n FROM facts WHERE row_num IS NULL${scopeSql}`,
        scopeParams,
      );
      const total = parseInt(counts[0]?.n ?? '0', 10);
      const noEntity = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*) AS n FROM facts WHERE row_num IS NULL AND entity_slug IS NULL${scopeSql}`,
        scopeParams,
      );
      const noEntityCount = parseInt(noEntity[0]?.n ?? '0', 10);
      return {
        name: 'fence_facts',
        status: 'skipped',
        detail: `dry-run: would fence ${total - noEntityCount} rows; ${noEntityCount} unfenceable (NULL entity_slug)` +
          (scope ? ` [scope=${scope}]` : ''),
      };
    } catch (e) {
      return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!engine) {
    return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
  }

  try {
    // Look up all sources + their local_paths.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);
    // A scoped run against a source this brain doesn't know is an operator
    // typo, not an empty backlog — fail loudly rather than report scanned=0.
    if (scope && !localPathById.has(scope)) {
      return {
        name: 'fence_facts',
        status: 'failed',
        detail: `unknown source "${scope}". Run \`gbrain sources list\` for registered ids.`,
      };
    }

    // Walk legacy rows in (source_id, entity_slug) groups for per-page
    // atomic writes.
    const legacy = await engine.executeRaw<LegacyFactRow>(
      `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
              context, valid_from, valid_until, source, confidence
         FROM facts
        WHERE row_num IS NULL${scopeSql}
        ORDER BY source_id, entity_slug, id`,
      scopeParams,
    );

    const outcome: PhaseBOutcome = {
      scanned: legacy.length,
      fenced: 0,
      skipped_no_entity: 0,
      skipped_no_local_path: 0,
      pages_touched: 0,
      failed_pages: [],
    };

    // Group by (source_id, entity_slug) so each page's fence is updated
    // atomically with all its legacy rows.
    const groups = new Map<string, LegacyFactRow[]>();
    for (const row of legacy) {
      if (row.entity_slug === null) {
        outcome.skipped_no_entity += 1;
        continue;
      }
      const localPath = localPathById.get(row.source_id);
      if (!localPath) {
        outcome.skipped_no_local_path += 1;
        continue;
      }
      const key = `${row.source_id}\0${row.entity_slug}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    // Dirty-tree refusal: check ONLY the sources we are about to write
    // into. A dirty tree in an unrelated source (or zero fenceable rows
    // at all) must not block a no-op or a targeted backfill (#927).
    const targetSourceIds = new Set([...groups.keys()].map(k => k.split('\0')[0]));
    for (const id of targetSourceIds) {
      const localPath = localPathById.get(id);
      if (localPath && isLocalPathDirty(localPath)) {
        return {
          name: 'fence_facts',
          status: 'failed',
          detail: `source "${id}" has uncommitted changes in ${localPath}. Commit or stash, then re-run.`,
        };
      }
    }

    for (const [key, group] of groups) {
      const [sourceId, entitySlug] = key.split('\0');
      const localPath = localPathById.get(sourceId)!;
      const filePath = join(localPath, `${entitySlug}.md`);
      const tmpPath = `${filePath}.tmp`;

      try {
        // Read existing body or stub-create with minimum frontmatter.
        let body: string;
        if (existsSync(filePath)) {
          body = readFileSync(filePath, 'utf-8');
        } else {
          mkdirSync(dirname(filePath), { recursive: true });
          const prefix = entitySlug.split('/')[0];
          const type =
            prefix === 'people'    ? 'person' :
            prefix === 'companies' ? 'company' :
            prefix === 'deals'     ? 'deal' :
            /* fallback */           'concept';
          const tail = entitySlug.split('/').slice(1).join('/');
          const title = tail.replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || entitySlug;
          body = `---\ntype: ${type}\ntitle: ${title}\nslug: ${entitySlug}\n---\n\n# ${title}\n`;
        }

        // Append each legacy row, collecting the assigned row_nums.
        // Already-fenced rows (row_num already set) are skipped at the
        // DB-row level by the WHERE clause, but if the SAME (entity,
        // source, claim, source-text) tuple was previously appended in
        // a partial-completion re-run, parseFactsFence will see the
        // existing row and append a duplicate. We dedup on (claim,
        // source) before append to handle this.
        const existingFence = parseFactsFence(body);
        const existingKeySet = new Set(existingFence.facts.map(f => `${f.claim}\0${f.source ?? ''}`));

        const assignments: Array<{ id: string; row_num: number }> = [];
        for (const row of group) {
          const key = `${row.fact}\0${row.source ?? ''}`;
          if (existingKeySet.has(key)) {
            // Already fenced (idempotent re-run). Find the existing
            // row_num and assign it to this DB row.
            const existing = existingFence.facts.find(f =>
              f.claim === row.fact && (f.source ?? '') === (row.source ?? ''),
            );
            if (existing) {
              assignments.push({ id: row.id, row_num: existing.rowNum });
              continue;
            }
          }
          // Append a new row.
          const validFromStr = (row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from))
            .toISOString().slice(0, 10);
          const validUntilStr = row.valid_until
            ? (row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until))
                .toISOString().slice(0, 10)
            : undefined;
          const { body: updated, rowNum } = upsertFactRow(body, {
            claim:      row.fact,
            kind:       row.kind,
            confidence: row.confidence,
            visibility: row.visibility,
            notability: row.notability,
            validFrom:  validFromStr,
            validUntil: validUntilStr,
            source:     row.source,
            context:    row.context ?? undefined,
          });
          body = updated;
          existingKeySet.add(key);
          assignments.push({ id: row.id, row_num: rowNum });
        }

        // Atomic write: .tmp + parse + rename.
        writeFileSync(tmpPath, body, 'utf-8');
        const tmpBody = readFileSync(tmpPath, 'utf-8');
        const parsed = parseFactsFence(tmpBody);
        if (parsed.warnings.length > 0) {
          outcome.failed_pages.push(`${entitySlug} (${parsed.warnings.join('; ')})`);
          // .tmp stays for inspection; do NOT rename.
          continue;
        }
        renameSync(tmpPath, filePath);

        // UPDATE the DB rows with their new row_nums + source_markdown_slug.
        for (const a of assignments) {
          await engine.executeRaw(
            `UPDATE facts SET row_num = $1, source_markdown_slug = $2 WHERE id = $3`,
            [a.row_num, entitySlug, a.id],
          );
        }
        outcome.fenced += assignments.length;
        outcome.pages_touched += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome.failed_pages.push(`${entitySlug} (${msg})`);
      }
    }

    // Scoped run: name what a brain-wide run would still touch elsewhere
    // (same fenceability rule as the walk above: legacy row, entity_slug
    // set, source has a local_path). The orchestrator turns a non-empty
    // list into `partial`, so the ledger cannot claim brain-wide completion
    // off a one-source drain.
    const pendingElsewhere: PendingElsewhere[] = [];
    if (scope) {
      const rows = await engine.executeRaw<{ source_id: string; n: string }>(
        `SELECT f.source_id, COUNT(*) AS n
           FROM facts f
           JOIN sources s ON s.id = f.source_id
          WHERE f.row_num IS NULL
            AND f.entity_slug IS NOT NULL
            AND s.local_path IS NOT NULL
            AND f.source_id <> $1
          GROUP BY f.source_id
          ORDER BY f.source_id`,
        [scope],
      );
      for (const r of rows) pendingElsewhere.push({ source_id: r.source_id, n: parseInt(r.n, 10) });
    }

    const detail = `scanned=${outcome.scanned} fenced=${outcome.fenced} ` +
      `pages=${outcome.pages_touched} skipped_no_entity=${outcome.skipped_no_entity} ` +
      `skipped_no_local_path=${outcome.skipped_no_local_path}` +
      (outcome.failed_pages.length > 0 ? ` failed=${outcome.failed_pages.length}` : '') +
      (scope ? ` [scope=${scope}` +
        (pendingElsewhere.length > 0
          ? `; still pending elsewhere: ${pendingElsewhere.map(p => `${p.source_id}=${p.n}`).join(' ')}`
          : '') +
        ']' : '');

    if (outcome.failed_pages.length > 0) {
      return {
        name: 'fence_facts',
        status: 'failed',
        detail: `${detail} :: ${outcome.failed_pages.slice(0, 3).join(' | ')}${outcome.failed_pages.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'fence_facts', status: 'complete', detail, pending_elsewhere: pendingElsewhere };
  } catch (e) {
    return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'verify', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Per touched page (= any page with a fenced row in the DB), re-parse
    // the fence from disk and compare row counts to the DB.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    // Conversation-miner rows stamp row_num without a ## Facts fence
    // (chat-log shape is the source of truth). Same cli: exclusion as
    // extract_facts reconciliation. Counting them here fails every brain
    // that ran extract-conversation-facts.
    // `--source`: verify only the scoped source's pages. Drift in another
    // repo is not this run's business (it is the exact cross-repo coupling
    // the flag exists to remove).
    const groups = await engine.executeRaw<{ source_id: string; source_markdown_slug: string; n: string }>(
      `SELECT source_id, source_markdown_slug, COUNT(*) AS n
         FROM facts
        WHERE row_num IS NOT NULL
          AND COALESCE(source, '') NOT LIKE 'cli:%'${opts.sourceId ? ' AND source_id = $1' : ''}
        GROUP BY source_id, source_markdown_slug`,
      opts.sourceId ? [opts.sourceId] : [],
    );

    const mismatches: string[] = [];
    let pagesChecked = 0;

    for (const g of groups) {
      const localPath = localPathById.get(g.source_id);
      if (!localPath) continue;
      const filePath = join(localPath, `${g.source_markdown_slug}.md`);
      if (!existsSync(filePath)) {
        mismatches.push(`${g.source_markdown_slug} (file missing)`);
        continue;
      }
      const body = readFileSync(filePath, 'utf-8');
      const parsed = parseFactsFence(body);
      const fenceCount = parsed.facts.length;
      const dbCount = parseInt(g.n, 10);
      if (fenceCount !== dbCount) {
        mismatches.push(`${g.source_markdown_slug} (fence=${fenceCount}, db=${dbCount})`);
      }
      pagesChecked += 1;
    }

    if (mismatches.length > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${mismatches.length} pages drifted: ${mismatches.slice(0, 3).join(' | ')}${mismatches.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'verify', status: 'complete', detail: `pages_checked=${pagesChecked}` };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.32.2 — facts join the system-of-record invariant ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  if (opts.sourceId) console.log(`  (scoped to source "${opts.sourceId}"; other sources untouched)`);
  console.log('');

  const engine = await getEngine();
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(engine, opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const { pending_elsewhere: pendingElsewhere = [], ...b } = await phaseBFenceFacts(engine, opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const c = await phaseCVerify(engine, opts);
  phases.push(c);

  // A scoped run that fenced its source cleanly is still not the whole
  // migration while other sources hold fenceable rows: report `partial` so
  // the ledger never records brain-wide completion off a one-source drain.
  // (On a brain whose ledger already says complete, "complete wins" — the
  // next run still needs the --force-retry marker, exactly as before.)
  if (pendingElsewhere.length > 0) {
    console.log(
      `  fence backfill scoped to "${opts.sourceId}" is done; fenceable legacy rows remain in: ` +
      pendingElsewhere.map(p => `${p.source_id} (${p.n})`).join(', ') +
      `. Drain them with \`gbrain apply-migrations --force-retry 0.32.2\` then ` +
      `\`gbrain apply-migrations --yes --source <id>\` per source (only that tree must be clean), ` +
      `or \`--yes\` alone for every source at once.`,
    );
  }
  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' || pendingElsewhere.length > 0 ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus, engine);
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
  engine: BrainEngine | null,
): OrchestratorResult {
  // Best-effort disconnect of the engine we created. testEngineOverride
  // is owned by the test, never disconnected here.
  if (engine && !testEngineOverride) {
    engine.disconnect().catch(() => { /* best-effort */ });
  }
  return {
    version: '0.32.2',
    status,
    phases,
  };
}

export const v0_32_2: Migration = {
  version: '0.32.2',
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Migration is dry-run by default; pass ' +
      '`--write` to apply.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBFenceFacts,
  phaseCVerify,
  isLocalPathDirty,
};
