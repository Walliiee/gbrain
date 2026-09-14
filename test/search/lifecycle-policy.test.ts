import { describe, expect, test } from 'bun:test';
import { parseExcludedStatuses, resolveSearchLifecyclePolicy } from '../../src/core/search/lifecycle-policy.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';
import { runConfig } from '../../src/commands/config.ts';
import { knobsHash, resolveSearchMode } from '../../src/core/search/mode.ts';

describe('search.exclude_statuses validation', () => {
  test('absence and an empty array preserve upstream lifecycle behavior', () => {
    expect(parseExcludedStatuses(null)).toEqual([]);
    expect(parseExcludedStatuses('[]')).toEqual([]);
  });

  test('normalizes ASCII case and surrounding whitespace, deduplicates and sorts', () => {
    expect(parseExcludedStatuses('[" SUPERSEDED ", "archived", "Archived", "done"]')).toEqual(['archived', 'done', 'superseded']);
  });

  for (const value of ['', 'not-json', '{}', 'null', 'true', '"superseded"', '[1]', '[null]', '[" "]', '["superseded", false]', '["\\u0000"]']) {
    test(`rejects invalid policy ${JSON.stringify(value)}`, () => {
      expect(() => parseExcludedStatuses(value)).toThrow('search.exclude_statuses');
    });
  }

  test('config lookup errors are not mistaken for an absent policy', async () => {
    const engine = { getConfig: async () => { throw new Error('synthetic config read failure'); } } as unknown as BrainEngine;
    await expect(resolveSearchLifecyclePolicy(engine)).rejects.toThrow('synthetic config read failure');
  });
});

describe('config set lifecycle policy', () => {
  test('registers a discoverable config key and stores a valid policy on the DB plane', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain('search.exclude_statuses');
    const writes: Array<[string, string]> = [];
    const engine = { setConfig: async (key: string, value: string) => { writes.push([key, value]); } } as unknown as BrainEngine;
    await runConfig(engine, ['set', 'search.exclude_statuses', '["SUPERSEDED","archived"]']);
    expect(writes).toEqual([['search.exclude_statuses', '["SUPERSEDED","archived"]']]);
  });

  for (const value of ['not-json', '{}', 'null', '[1]', '[" "]', '["\\u0000"]']) {
    test(`invalid ${JSON.stringify(value)} rejects before writing even with --force`, async () => {
      let writes = 0;
      const engine = { setConfig: async () => { writes += 1; } } as unknown as BrainEngine;
      await expect(runConfig(engine, ['set', 'search.exclude_statuses', value, '--force'])).rejects.toThrow('search.exclude_statuses');
      expect(writes).toBe(0);
    });
  }
});

describe('lifecycle policy cache identity', () => {
  const mode = resolveSearchMode({ mode: 'conservative' });

  test('changed exclusions cannot reuse a prior policy cache identity', () => {
    expect(knobsHash(mode, { excludeStatuses: ['superseded'] }))
      .not.toBe(knobsHash(mode, { excludeStatuses: ['archived'] }));
    expect(knobsHash(mode, { excludeStatuses: ['superseded'] }))
      .not.toBe(knobsHash(mode));
  });

  test('equivalent case, whitespace, duplicates and ordering share identity', () => {
    expect(knobsHash(mode, { excludeStatuses: [' SUPERSEDED ', 'archived', 'Archived'] }))
      .toBe(knobsHash(mode, { excludeStatuses: ['archived', 'superseded'] }));
    expect(knobsHash(mode, { excludeStatuses: [] })).toBe(knobsHash(mode));
  });
});
