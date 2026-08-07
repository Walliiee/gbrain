/**
 * Regression tests for the `reranker_health` doctor check.
 *
 * Origin: a production brain accumulated 5,469 consecutive rerank failures
 * over seven weeks (5,221 `unknown` from a missing provider key, 248 `network`
 * from a local reranker timing out) and `gbrain doctor` reported `ok` the
 * entire time. Two independent defects made that possible:
 *
 *   1. Every branch in the check tested a SPECIFIC failure reason. `unknown`
 *      matched none of them and fell through to the trailing `ok` return —
 *      which printed the four-digit failure count in an `ok` message.
 *   2. The check read `search.reranker.enabled` directly instead of resolving
 *      through the mode bundle, so a mode that enables the reranker with no
 *      config key set was reported as "Reranker disabled".
 *
 * These tests pin both. A check that cannot see a failure class must not
 * vouch for it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { computeIsoWeekFilename } from '../src/core/audit/audit-writer.ts';

/** Minimal engine stub — the check only ever reads config keys. */
function fakeEngine(config: Record<string, string> = {}) {
  return {
    getConfig: async (key: string): Promise<string | null> => config[key] ?? null,
  } as any;
}

let auditDir: string;
let prevAuditDir: string | undefined;

/** Write failure events into the ISO-week file `readRecent` will walk. */
function writeFailures(events: Array<{ reason: string; model?: string; error_summary?: string }>) {
  const now = new Date();
  const file = join(auditDir, computeIsoWeekFilename('rerank-failures', now));
  const lines = events.map((e) =>
    JSON.stringify({
      ts: now.toISOString(),
      model: e.model ?? 'zeroentropyai:zerank-2',
      reason: e.reason,
      query_hash: 'deadbeef',
      doc_count: 25,
      error_summary: e.error_summary ?? 'boom',
    }),
  );
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

describe('checkRerankerHealth', () => {
  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-audit-'));
    prevAuditDir = process.env.GBRAIN_AUDIT_DIR;
    process.env.GBRAIN_AUDIT_DIR = auditDir;
  });

  afterEach(() => {
    if (prevAuditDir === undefined) delete process.env.GBRAIN_AUDIT_DIR;
    else process.env.GBRAIN_AUDIT_DIR = prevAuditDir;
    rmSync(auditDir, { recursive: true, force: true });
  });

  test('THE REGRESSION: thousands of `unknown` failures must not report ok', async () => {
    // The exact shape of the seven-week outage: a missing API key fails open
    // and classifies as `unknown`, matching no reason-specific branch.
    writeFailures(
      Array.from({ length: 5221 }, () => ({
        reason: 'unknown',
        error_summary: 'ZEROENTROPY_API_KEY not set',
      })),
    );

    const check = await checkRerankerHealth(fakeEngine({ 'search.reranker.enabled': 'true' }));

    expect(check.name).toBe('reranker_health');
    expect(check.status).not.toBe('ok');
    expect(check.message).toContain('5221');
    // The operator must learn that search still works but reranking does not.
    expect(check.message.toLowerCase()).toContain('failing open');
  });

  test('a single unclassified failure warns rather than falling through', async () => {
    writeFailures([{ reason: 'unknown' }]);
    const check = await checkRerankerHealth(fakeEngine());
    expect(check.status).toBe('warn');
    expect(check.message.toLowerCase()).toContain('unclassified');
  });

  test('volume backstop catches high failure counts of any known reason', async () => {
    // 60 network failures: below no individual branch's radar once the
    // transient threshold message is considered "just transient", but the
    // reranker is plainly not running.
    writeFailures(Array.from({ length: 60 }, () => ({ reason: 'network' })));
    const check = await checkRerankerHealth(fakeEngine());
    expect(check.status).toBe('warn');
    expect(check.message).toContain('60');
  });

  test('known-reason branches still take precedence over the catch-all', async () => {
    writeFailures([{ reason: 'auth' }, { reason: 'unknown' }]);
    const check = await checkRerankerHealth(fakeEngine());
    expect(check.status).toBe('warn');
    // auth is the more actionable diagnosis and is checked first.
    expect(check.message.toLowerCase()).toContain('auth');
  });

  test('a handful of transient failures stays ok (fail-open is normal)', async () => {
    writeFailures(Array.from({ length: 3 }, () => ({ reason: 'timeout' })));
    const check = await checkRerankerHealth(fakeEngine());
    expect(check.status).toBe('ok');
  });

  test('no failures + reranker off reports disabled, not healthy', async () => {
    const check = await checkRerankerHealth(fakeEngine({ 'search.reranker.enabled': 'false' }));
    expect(check.status).toBe('ok');
    expect(check.message.toLowerCase()).toContain('disabled');
  });

  test('effective state comes from the mode bundle, not just the config key', async () => {
    // tokenmax enables the reranker with NO `search.reranker.enabled` key set.
    // Reading the raw key alone reported "disabled — no failures expected"
    // for a brain that was actively reranking.
    const check = await checkRerankerHealth(fakeEngine({ 'search.mode': 'tokenmax' }));
    expect(check.status).toBe('ok');
    expect(check.message.toLowerCase()).not.toContain('disabled');
    expect(check.message).toContain('No rerank failures');
  });
});
