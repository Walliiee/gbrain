import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

mock.module('../src/core/ai/gateway.ts', () => ({
  probeChatModel: () => ({ ok: true }),
}));

mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async () => undefined,
  // Same whole-module rule as the wait-for-completion mock below: patterns.ts
  // imports five names from synthesize.ts, so all five must be here or the file
  // dies at load with a SyntaxError. The v0.47.8.0 port added these two
  // (patterns.ts:642,651) and this mock was not updated, which took the serial
  // patterns coverage out silently while the narrow gates stayed green.
  applyGeneratedStamp: (
    existing: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> => existing ?? {},
  ensureBodyH1: (body: string) => body,
}));

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError: class TimeoutError extends Error {},
  waitForCompletion: async (_queue: unknown, jobId: number) => ({
    id: jobId,
    status: 'completed',
  }),
  // patterns/synthesize import the lease-renewing variant; a module mock
  // replaces the WHOLE module, so it must export every named import its
  // consumers reach for (a missing one is a load-time SyntaxError).
  waitForCompletionRenewing: async (
    _queue: unknown,
    jobId: number,
    opts?: { renew?: () => Promise<void> },
  ) => {
    if (opts?.renew) await opts.renew();
    return { id: jobId, status: 'completed' };
  },
}));

const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
});

async function seedReflections(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       VALUES ($1, 'note', $2, $3)`,
      [
        `wiki/personal/reflections/2026-08-0${i + 1}-reflection`,
        `Reflection ${i + 1}`,
        `Recurring theme fixture number ${i + 1}.`,
      ],
    );
  }
}

describe('runPhasePatterns completed child outcome (#4026)', () => {
  test('completed child with zero writes is an ok no-op, not PATTERNS_CHILD_COMPLETED', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-completed-'));
    try {
      await seedReflections();

      const result = await runPhasePatterns(engine, { brainDir, dryRun: false });

      expect(result.status).toBe('ok');
      expect(result.details.child_outcome).toBe('completed');
      expect(result.details.patterns_written).toBe(0);
      expect(result.error?.code).not.toBe('PATTERNS_CHILD_COMPLETED');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
