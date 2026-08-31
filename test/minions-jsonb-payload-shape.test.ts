/**
 * Regression pins for the minion JSONB write path — the two failure modes that
 * bit a production brain on 2026-08-28, in opposite directions.
 *
 * 1. DOUBLE-ENCODE (the corruption). A downstream patch wrapped the `$N::jsonb`
 *    binds in `JSON.stringify`. postgres.js already applies the jsonb
 *    serializer to a raw object, so stringifying first stored a jsonb STRING
 *    SCALAR — `"{\"sourceId\":\"a-source\"}"` — instead of an object. Every
 *    SQL-level read of the payload then returned NULL: per-source scoping
 *    (`data->>'source_id'`), the `__param_hash` coalesce-dedupe, and the
 *    `payload->>'type' = 'child_done'` inbox index all silently stopped
 *    matching, while `rowToMinionJob` kept JSON.parse-ing on read so handlers
 *    and every dashboard still looked green. 42 rows before it was caught.
 *
 * 2. LONE SURROGATE (the crash the patch was masking). A truncated emoji in a
 *    subagent prompt left an unpaired UTF-16 half; Postgres rejects it inside a
 *    `::jsonb` cast with SQLSTATE 22P02 `invalid input syntax for type json`.
 *    Five jobs died of it. Double-encoding accidentally suppressed the throw by
 *    turning the escape into a literal — trading a loud crash for silent
 *    corruption. `sanitizeJsonbDeep` is the actual fix; note that the
 *    `$N::text::jsonb` form the guard suggests does NOT help, because a lone
 *    surrogate is invalid JSON text on either binding form.
 *
 * PGLITE CAVEAT — READ BEFORE TRUSTING THIS FILE. Same shape as
 * test/links-timeline-jsonb-poison.test.ts: PGLite CANNOT see the
 * double-encode. It stores a `JSON.stringify`'d payload and still reports
 * `jsonb_typeof = 'object'`, so lane 2 below passes with the defect
 * re-introduced (verified). What this file actually pins is the JS-side shape
 * plus the sanitizer's own contract. The REAL pin for the double-encode is the
 * DATABASE_URL-gated sibling test/e2e/minions-jsonb-payload-postgres.test.ts,
 * with the static guard scripts/check-jsonb-params.mjs as the third leg.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { sanitizeJsonbDeep } from '../src/core/batch-rows.ts';

// Built via fromCharCode so no lone surrogate is ever a literal in this file.
const LONE_HI = String.fromCharCode(0xd83d); // high half of an emoji pair
const LONE_LO = String.fromCharCode(0xdc00); // bare low half
const NUL = String.fromCharCode(0);

const SUB = { allowProtectedSubmit: true } as const;

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  // minion_inbox is ON DELETE CASCADE off minion_jobs, so one DELETE clears both.
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('sanitizeJsonbDeep', () => {
  test('well-forms lone surrogates in values, at any depth', () => {
    const out = sanitizeJsonbDeep({
      prompt: `You are a subagent ${LONE_HI}`,
      nested: { deep: [{ text: `x${LONE_LO}y` }] },
    });
    expect(out.prompt).toBe('You are a subagent �');
    expect((out.nested.deep[0] as { text: string }).text).toBe('x�y');
    expect(JSON.stringify(out).isWellFormed()).toBe(true);
  });

  test('strips NUL, and sanitizes object KEYS too', () => {
    const out = sanitizeJsonbDeep({ [`k${LONE_HI}`]: `a${NUL}b` });
    expect(Object.keys(out)).toEqual(['k�']);
    expect(out['k�']).toBe('ab');
  });

  test('leaves clean payloads referentially faithful and non-strings intact', () => {
    const out = sanitizeJsonbDeep({ a: 1, b: true, c: null, d: [1, 'two'], e: { f: 'g' } });
    expect(out).toEqual({ a: 1, b: true, c: null, d: [1, 'two'], e: { f: 'g' } });
  });

  test('passes non-plain objects through untouched (Date keeps its toJSON)', () => {
    const d = new Date('2026-08-28T07:03:36.000Z');
    expect(sanitizeJsonbDeep({ at: d }).at).toBe(d);
  });

  test('is depth-bounded, so a cyclic payload cannot hang the walk', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => sanitizeJsonbDeep(cyclic)).not.toThrow();
  });
});

describe('minion payloads land as jsonb objects, not string scalars', () => {
  test('add() stores data as a jsonb OBJECT so SQL-level extraction works', async () => {
    const job = await queue.add('facts-absorb', { sourceId: 'a-source', n: 1 });

    const [row] = await engine.executeRaw<{ typ: string; src: string | null }>(
      `SELECT jsonb_typeof(data) AS typ, data->>'sourceId' AS src
         FROM minion_jobs WHERE id = $1`,
      [job.id]
    );

    // The corruption signature: typ === 'string' and src === null, on a payload
    // whose stored text visibly contains "sourceId":"a-source".
    expect(row.typ).toBe('object');
    expect(row.src).toBe('a-source');
  });

  test('a lone surrogate in the payload does not abort the insert', async () => {
    const job = await queue.add(
      'subagent',
      { prompt: `You are a subagent ${LONE_HI}` },
      undefined,
      SUB,
    );

    const [row] = await engine.executeRaw<{ typ: string; prompt: string }>(
      `SELECT jsonb_typeof(data) AS typ, data->>'prompt' AS prompt
         FROM minion_jobs WHERE id = $1`,
      [job.id]
    );

    expect(row.typ).toBe('object');
    expect(row.prompt).toBe('You are a subagent �');
  });

  test('child_done inbox payloads stay objects, so the type index still matches', async () => {
    const parent = await queue.add('parent', {}, { max_children: 4 });
    const child = await queue.add('child', {}, { parent_job_id: parent.id });

    const claimed = await queue.claim('tok-child', 60_000, 'default', ['child']);
    expect(claimed?.id).toBe(child.id);
    // A result carrying a lone surrogate is the realistic subagent case.
    await queue.completeJob(child.id, 'tok-child', { out: `done${LONE_HI}` });

    const [row] = await engine.executeRaw<{ typ: string; kind: string | null }>(
      `SELECT jsonb_typeof(payload) AS typ, payload->>'type' AS kind
         FROM minion_inbox WHERE job_id = $1 ORDER BY id DESC LIMIT 1`,
      [parent.id]
    );

    // payload->>'type' is what idx_minion_inbox_child_done keys on; a string
    // scalar makes it NULL and aggregator parents hang in waiting-children.
    expect(row.typ).toBe('object');
    expect(row.kind).toBe('child_done');
  });

  test('completeJob writes result as a jsonb object, and no result stays SQL NULL', async () => {
    const withResult = await queue.add('r1', {});
    await queue.claim('tok-r1', 60_000, 'default', ['r1']);
    await queue.completeJob(withResult.id, 'tok-r1', { ok: true });

    const empty = await queue.add('r2', {});
    await queue.claim('tok-r2', 60_000, 'default', ['r2']);
    await queue.completeJob(empty.id, 'tok-r2');

    const rows = await engine.executeRaw<{ id: number; typ: string | null }>(
      `SELECT id, jsonb_typeof(result) AS typ FROM minion_jobs
        WHERE id = ANY($1) ORDER BY id`,
      [[withResult.id, empty.id]]
    );

    expect(rows[0].typ).toBe('object');
    // JSON.stringify(null) wrote the jsonb string scalar "null" here, which is
    // not SQL NULL — `result IS NULL` stopped holding for a job that returned
    // nothing.
    expect(rows[1].typ).toBeNull();
  });
});
