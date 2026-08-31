// Minion JSONB write path — Postgres lane (DATABASE_URL-gated).
//
// THIS is the lane that matters. The PGLite sibling
// (test/minions-jsonb-payload-shape.test.ts) cannot see the double-encode at
// all: it stores a JSON.stringify'd payload and still reports
// jsonb_typeof = 'object', so the sibling passes with the bug present. Verified
// by re-introducing the defect against it. Only real Postgres exposes this,
// which is exactly the hole the bug lived in.
//
// The static guard scripts/check-jsonb-params.mjs is the other half of the pin,
// but it is NOT sufficient on its own — its span heuristic flags the four
// `minion_inbox` binds and MISSES the `MinionQueue.add()` payload bind, which
// is the single highest-traffic JSONB write in the queue. Between a PGLite
// suite that cannot fail and a static guard with a gap, the `add()` site had no
// coverage whatsoever. This file closes that.
//
// What went wrong on this brain (2026-08-28): a local patch wrapped the
// `$N::jsonb` binds in JSON.stringify. postgres.js already applies the jsonb
// serializer to a raw object, so the payload landed as a jsonb STRING SCALAR.
// Every SQL-level read then returned NULL — per-source scoping
// (`data->>'source_id'`), the `__param_hash` coalesce-dedupe, and the
// `payload->>'type' = 'child_done'` inbox index — while `rowToMinionJob`
// JSON.parse'd it back on read, so handlers and dashboards stayed green.
// 42 corrupt rows over three days, and only 5 of 47 recent jobs kept a readable
// source id.
//
// The patch was masking a REAL bug: a truncated emoji in a subagent prompt left
// an unpaired UTF-16 surrogate, which Postgres rejects at the ::jsonb cast with
// SQLSTATE 22P02, killing the job. Double-encoding suppressed the throw by
// turning the escape into a literal — trading a loud crash for silent
// corruption. `sanitizeJsonbDeep` is the real fix. Note `$N::text::jsonb`, the
// form the static guard suggests, does NOT help: a lone surrogate is invalid
// JSON text on either binding form.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';

const SKIP = !hasDatabase();
const d = SKIP ? describe.skip : describe;

// Built via fromCharCode so no lone surrogate is ever a literal in this file.
const LONE_HI = String.fromCharCode(0xd83d);
const PROMPT = `You are Lens ${LONE_HI}`;
const PROMPT_CLEAN = 'You are Lens �';

let engine: PostgresEngine;
let queue: MinionQueue;

d('minion JSONB payloads on real Postgres', () => {
  beforeAll(async () => {
    await setupDB();
    engine = getEngine();
    queue = new MinionQueue(engine);
  });

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
  });

  it('add() binds data as a jsonb object, so source scoping resolves', async () => {
    const job = await queue.add('facts-absorb', { sourceId: 'shared', source_id: 'shared' });

    const [row] = await engine.executeRaw<{ typ: string; a: string | null; b: string | null }>(
      `SELECT jsonb_typeof(data) AS typ,
              data->>'sourceId'  AS a,
              data->>'source_id' AS b
         FROM minion_jobs WHERE id = $1`,
      [job.id],
    );

    // With the double-encode: typ='string', a=null, b=null — on a payload whose
    // stored text visibly contains "sourceId":"shared". That NULL is what broke
    // per-source backpressure, the synthesize daily-cap denominator, and
    // source-health job counts.
    expect(row.typ).toBe('object');
    expect(row.a).toBe('shared');
    expect(row.b).toBe('shared');
  });

  it('the param-hash dedupe key stays readable, so coalescing still works', async () => {
    const job = await queue.add('facts-absorb', { __param_hash: 'abc123', n: 1 });

    const [row] = await engine.executeRaw<{ h: string | null }>(
      `SELECT data->>'__param_hash' AS h FROM minion_jobs WHERE id = $1`,
      [job.id],
    );

    // A NULL here means the coalesce SELECT in add() can never match, so every
    // re-submit inserts a new job — a duplicate-job amplifier on a per-source
    // dream fan-out.
    expect(row.h).toBe('abc123');
  });

  it('a lone surrogate in a subagent prompt does not kill the job (22P02)', async () => {
    // Pre-fix this threw: invalid input syntax for type json —
    // "Unicode low surrogate must follow a high surrogate". Five jobs died of
    // it, and because runPhaseSynthesize rethrows non-quota errors, one bad
    // transcript aborted the whole synthesize phase.
    const job = await queue.add('subagent', { prompt: PROMPT }, undefined, {
      allowProtectedSubmit: true,
    });

    const [row] = await engine.executeRaw<{ typ: string; p: string }>(
      `SELECT jsonb_typeof(data) AS typ, data->>'prompt' AS p
         FROM minion_jobs WHERE id = $1`,
      [job.id],
    );

    expect(row.typ).toBe('object');
    expect(row.p).toBe(PROMPT_CLEAN);
  });

  it('child_done inbox payloads stay objects so the partial index matches', async () => {
    const parent = await queue.add('parent', {}, { max_children: 4 });
    const child = await queue.add('child', {}, { parent_job_id: parent.id });

    await queue.claim('tok-child', 60_000, 'default', ['child']);
    await queue.completeJob(child.id, 'tok-child', { out: `done${LONE_HI}` });

    const [row] = await engine.executeRaw<{ typ: string; kind: string | null }>(
      `SELECT jsonb_typeof(payload) AS typ, payload->>'type' AS kind
         FROM minion_inbox WHERE job_id = $1 ORDER BY id DESC LIMIT 1`,
      [parent.id],
    );

    // idx_minion_inbox_child_done is WHERE (payload->>'type') = 'child_done'.
    // A string scalar makes that NULL, the index stops matching, and aggregator
    // parents sit in waiting-children forever.
    expect(row.typ).toBe('object');
    expect(row.kind).toBe('child_done');
  });

  it('completeJob writes result as jsonb, and an empty result stays SQL NULL', async () => {
    const withResult = await queue.add('r1', {});
    await queue.claim('tok-r1', 60_000, 'default', ['r1']);
    await queue.completeJob(withResult.id, 'tok-r1', { ok: true, note: `n${LONE_HI}` });

    const empty = await queue.add('r2', {});
    await queue.claim('tok-r2', 60_000, 'default', ['r2']);
    await queue.completeJob(empty.id, 'tok-r2');

    const rows = await engine.executeRaw<{ id: number; typ: string | null }>(
      `SELECT id, jsonb_typeof(result) AS typ FROM minion_jobs
        WHERE id = ANY($1) ORDER BY id`,
      [[withResult.id, empty.id]],
    );

    expect(rows[0].typ).toBe('object');
    // JSON.stringify(result ?? null) wrote the jsonb string scalar "null" here,
    // which is not SQL NULL — `result IS NULL` stopped holding for a job that
    // returned nothing.
    expect(rows[1].typ).toBeNull();
  });
});
