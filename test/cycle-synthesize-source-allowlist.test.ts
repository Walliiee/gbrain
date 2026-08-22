/**
 * `dream.synthesize.source_allowlist` — pin WHICH source may run a corpus-scan
 * synthesize.
 *
 * `dream.synthesize.session_corpus_dir` is one GLOBAL directory but synthesis
 * output is source-scoped, so on a multi-source nightly cron every source
 * synthesizes the SAME transcripts into its own checkout. The only thing
 * deciding the destination is `dream.synthesize.last_completion_ts`, a single
 * global cooldown key claimed by whichever source runs first AND is not capped
 * that night — and a capped source returns WITHOUT stamping it (CX8), handing
 * the baton to the next source in the loop. Destination by accident, not intent.
 *
 * These tests pin: the gate fires for a disallowed source, does NOT fire for an
 * allowed one, is inert when the key is unset (legacy default), and never runs
 * for explicit --input/--date/--from/--to targets.
 *
 * The gate sits BEFORE the cooldown check on purpose: a disallowed source must
 * neither consume nor stamp the cooldown. The stub engine below has no
 * executeRaw, so any test that reaches the cooldown query or corpus discovery
 * would throw rather than silently pass.
 */

import { describe, test, expect } from 'bun:test';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const CORPUS = '/nonexistent-corpus-dir';

function stubEngine(config: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => config[key] ?? null,
  } as unknown as BrainEngine;
}

function baseConfig(extra: Record<string, string> = {}): Record<string, string> {
  return { 'dream.synthesize.session_corpus_dir': CORPUS, ...extra };
}

describe('loadSynthConfig — source_allowlist parsing', () => {
  test('unset resolves to an empty list (legacy: every source allowed)', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine(baseConfig()));
    expect(cfg.sourceAllowlist).toEqual([]);
  });

  test('comma-separated values are split and trimmed', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine(baseConfig({
      'dream.synthesize.source_allowlist': ' shared , hermes-native ',
    })));
    expect(cfg.sourceAllowlist).toEqual(['shared', 'hermes-native']);
  });

  test('empty segments are dropped rather than becoming a "" source', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine(baseConfig({
      'dream.synthesize.source_allowlist': 'shared,,',
    })));
    expect(cfg.sourceAllowlist).toEqual(['shared']);
  });

  test('a whitespace-only value is inert, not an allowlist of nothing', async () => {
    const cfg = await __testing.loadSynthConfig(stubEngine(baseConfig({
      'dream.synthesize.source_allowlist': '   ',
    })));
    expect(cfg.sourceAllowlist).toEqual([]);
  });
});

describe('runPhaseSynthesize — source_allowlist gate', () => {
  test('a source outside the allowlist is skipped as source_not_allowed', async () => {
    const res = await runPhaseSynthesize(
      stubEngine(baseConfig({ 'dream.synthesize.source_allowlist': 'shared' })),
      { brainDir: '/tmp', sourceId: 'adaptig' },
    );
    expect(res.status).toBe('skipped');
    expect((res.details as { reason: string }).reason).toBe('source_not_allowed');
    expect(res.summary).toContain('adaptig');
  });

  test('an unset sourceId is treated as "default" and gated the same way', async () => {
    const res = await runPhaseSynthesize(
      stubEngine(baseConfig({ 'dream.synthesize.source_allowlist': 'shared' })),
      { brainDir: '/tmp' },
    );
    expect(res.status).toBe('skipped');
    expect((res.details as { reason: string }).reason).toBe('source_not_allowed');
    expect(res.summary).toContain('default');
  });

  test('an allowed source is NOT gated (it proceeds past the allowlist check)', async () => {
    const res = await runPhaseSynthesize(
      stubEngine(baseConfig({ 'dream.synthesize.source_allowlist': 'shared' })),
      { brainDir: '/tmp', sourceId: 'shared' },
    );
    expect((res.details as { reason?: string }).reason).not.toBe('source_not_allowed');
  });

  test('unset allowlist leaves every source ungated (legacy default)', async () => {
    const res = await runPhaseSynthesize(
      stubEngine(baseConfig()),
      { brainDir: '/tmp', sourceId: 'adaptig' },
    );
    expect((res.details as { reason?: string }).reason).not.toBe('source_not_allowed');
  });

  test('an explicit --input target bypasses the allowlist', async () => {
    const res = await runPhaseSynthesize(
      stubEngine(baseConfig({ 'dream.synthesize.source_allowlist': 'shared' })),
      { brainDir: '/tmp', sourceId: 'adaptig', inputFile: '/nonexistent/transcript.txt' },
    );
    expect((res.details as { reason?: string }).reason).not.toBe('source_not_allowed');
  });

  test('an explicit --date target bypasses the allowlist', async () => {
    const res = await runPhaseSynthesize(
      stubEngine(baseConfig({ 'dream.synthesize.source_allowlist': 'shared' })),
      { brainDir: '/tmp', sourceId: 'adaptig', date: '2026-08-22' },
    );
    expect((res.details as { reason?: string }).reason).not.toBe('source_not_allowed');
  });
});
