/**
 * Regression tests for the doctor "NOT CHECKED" post-pass.
 *
 * Origin: `Check.status` is a three-value union with no state for "this check
 * did not run". Every early-return site — dependency absent, feature opt-in
 * and off, column not provisioned — therefore returned `ok`, and the summary
 * printed "All checks passed" while N checks had inspected nothing. On the
 * production brain that was 7 of 81, including two nightly probes and the
 * embedding-provider health check.
 *
 * The two failure modes this pins are symmetric, and the second is the one
 * that makes a naive fix worse than no fix:
 *
 *   1. A check that skipped must not be counted as passing.
 *   2. A check that RAN must not be labelled "not checked" — `sync_consolidation`
 *      embeds `--skip-failed` in a recommended cron command, and
 *      `brainstorm_health` says "not yet generated" about a sub-feature while
 *      having verified the migration. Both are real checks. A loose /skip/i
 *      or /not yet/i mislabels them.
 *
 * Every message below is a live string in the v0.47.8.0 doctor surface (the
 * two REAL_RAN traps included) — this file is the pin that keeps the
 * classifier honest as those messages get reworded.
 */

import { describe, test, expect } from 'bun:test';
import { computeDoctorReport, isNotChecked, type Check } from '../src/commands/doctor.ts';

const ok = (name: string, message: string): Check => ({ name, status: 'ok', message });

/** Verbatim messages from the production brain's `doctor --json`, 2026-08-07. */
const REAL_SKIPS: Array<[string, string]> = [
  ['nightly_quality_probe_health', 'disabled (opt-in). Enable with: gbrain config set autopilot.nightly_quality_probe.enabled true'],
  ['conversation_facts_backlog', 'disabled (opt-in). Enable with: gbrain config set cycle.conversation_facts_backfill.enabled true'],
  ['conversation_parser_probe_health', 'Skipped (nightly probe is opt-in; enable with `gbrain config set autopilot.conversation_parser_probe.enabled true`)'],
  ['unified_multimodal_coverage', 'search.unified_multimodal is off; coverage check N/A'],
  ['salience_health', "Skipped (no pages have emotional_weight > 0; either fresh install or recompute hasn't run yet)"],
  ['autopilot_fanout_concurrency', 'No supervisor observed — skipping fan-out/concurrency check'],
  ['ze_embedding_health', 'Configured embedding model "ollama:snowflake-arctic-embed2" is not ZeroEntropy — skip.'],
];

/** Verbatim messages from checks that DID run. None may be reclassified. */
const REAL_RAN: Array<[string, string]> = [
  ['sync_consolidation', '19 active sources detected. Recommended cron: `gbrain sync --all --parallel 4 --workers 4 --skip-failed`. If your crontab has separate per-source entries, replace them with one --all line — future sources auto-pick-up without a crontab edit.'],
  ['brainstorm_health', 'Migration v79 applied; tracking enabled. Calibration profile not yet generated — brainstorm/lsd will run unbiased until enough takes are resolved.'],
  ['autopilot_lock_scope', 'Lock path: /Users/mmk/.gbrain/autopilot.lock'],
  ['reranker_health', 'Reranker disabled — no failures expected'],
  ['embed_coverage', '6618/6618 chunks embedded (100%)'],
];

describe('isNotChecked', () => {
  test.each(REAL_SKIPS)('classifies %s as not checked', (name, message) => {
    expect(isNotChecked(ok(name, message))).toBe(true);
  });

  test.each(REAL_RAN)('does NOT reclassify %s, which ran', (name, message) => {
    expect(isNotChecked(ok(name, message))).toBe(false);
  });

  test('an explicit not_checked flag wins over message shape', () => {
    expect(isNotChecked({ name: 'x', status: 'ok', message: 'anything at all', not_checked: true })).toBe(true);
  });

  test('only ok qualifies — a warn or fail already tells the operator to look', () => {
    // A check that skipped AND warned is surfacing something; leave it in the
    // warn list rather than burying it under NOT CHECKED.
    expect(isNotChecked({ name: 'x', status: 'warn', message: 'Skipped (timeout)' })).toBe(false);
    expect(isNotChecked({ name: 'x', status: 'fail', message: 'Skipped (timeout)', not_checked: true })).toBe(false);
  });
});

describe('computeDoctorReport', () => {
  test('THE REGRESSION: a report of nothing but skips is not a healthy brain', () => {
    const report = computeDoctorReport(REAL_SKIPS.map(([n, m]) => ok(n, m)));
    expect(report.not_checked).toHaveLength(7);
    // The score is unchanged by design (see below) — the honesty lives in
    // not_checked, which is what an operator or CI gate must read.
    expect(report.status).toBe('healthy');
    expect(report.not_checked).toContain('ze_embedding_health');
  });

  test('the production shape: 7 of 81 never ran', () => {
    const filler = Array.from({ length: 74 }, (_, i) => ok(`check_${i}`, `${i} of ${i} fine`));
    const report = computeDoctorReport([...filler, ...REAL_SKIPS.map(([n, m]) => ok(n, m))]);
    expect(report.checks).toHaveLength(81);
    expect(report.not_checked).toHaveLength(7);
  });

  test('BACK-COMPAT: health_score math is untouched by the post-pass', () => {
    // The invariant documented on DoctorReport.health_score. A skipped check
    // scored 0 penalty before this change and must still score 0 penalty —
    // otherwise every existing CI gate and monitor shifts under the fix.
    const checks: Check[] = [
      ...REAL_SKIPS.map(([n, m]) => ok(n, m)),
      { name: 'a', status: 'warn', message: 'w' },
      { name: 'b', status: 'fail', message: 'f' },
    ];
    const report = computeDoctorReport(checks);
    expect(report.health_score).toBe(100 - 20 - 5); // 1 fail, 1 warn, skips free
    expect(report.status).toBe('unhealthy');
  });

  test('a fully-covered brain reports an empty not_checked, not undefined', () => {
    const report = computeDoctorReport([ok('a', 'all good'), ok('b', '10/10 fine')]);
    expect(report.not_checked).toEqual([]);
  });

  test('not_checked entries stay in `checks` so no consumer loses a row', () => {
    // JSON consumers that iterate .checks must see the same 81 rows they
    // always did; not_checked is additive, not a move.
    const report = computeDoctorReport(REAL_SKIPS.map(([n, m]) => ok(n, m)));
    expect(report.checks.map((c) => c.name).sort()).toEqual(REAL_SKIPS.map(([n]) => n).sort());
  });

  test('schema_version stays 2 and the extras passthrough still works', () => {
    // v0.47.x widened computeDoctorReport with an `extras` argument
    // (engine / db_url_source). not_checked is a sibling additive field, not
    // a replacement — a caller passing extras gets both.
    const report = computeDoctorReport([ok('a', 'Skipped (PGLite — no multi-process worker surface)')], {
      engine: 'pglite',
      db_url_source: null,
    });
    expect(report.schema_version).toBe(2);
    expect(report.engine).toBe('pglite');
    expect(report.not_checked).toEqual(['a']);
  });
});
