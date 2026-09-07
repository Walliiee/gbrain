/**
 * The generated-record contract the dream cycle stamps on everything it writes,
 * and the review queue that carries candidate tasks and corrections.
 *
 * WHY THESE ARE PINNED. Dream output used to carry three frontmatter keys —
 * `dream_generated`, `dream_cycle_date`, `raw_source`. A governed retrieval
 * policy demotes replaceable output through weights keyed on `generated: true`
 * and `canonical: false`; with neither key written the demotion could never
 * fire, so fresh synthesis systematically outranked the canonical record on its
 * own subject (measured: generated page rank 1 / score 1.0000 before, rank 10 /
 * 0.1861 after). Nothing in the phase fails when the stamp regresses — retrieval
 * just quietly starts preferring last night's guess over a ratified decision, so
 * the contract needs a test or it is one refactor away from being dropped again.
 *
 * The review queue exists so the cycle can surface candidate tasks and
 * corrections WITHOUT a model ever writing the task list or editing a ruling:
 * `dream-cycle-proposals/*` is authorized, `tasks/*`, `decisions/*`,
 * `learnings/*`, `context/*` and `agent-runs/*` are not, and a proposal's
 * `status`/`expires_at` are forced rather than defaulted so it cannot promote
 * itself out of the queue.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { matchesSlugAllowList } from '../src/core/ops/context.ts';
import {
  applyGeneratedStamp,
  ensureBodyH1,
  generatedRecordStamp,
  isProposalSlug,
  renderPageToMarkdown,
  DREAM_PROPOSAL_PREFIX,
  __testing,
  withProposalLane,
} from '../src/core/cycle/synthesize.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';
import type { Page } from '../src/core/types.ts';

const CYCLE_DATE = '2026-08-22';

describe('generatedRecordStamp — the demotion levers', () => {
  test('forces the four keys a retrieval policy multiplies', () => {
    const { forced } = generatedRecordStamp({ cycleDate: CYCLE_DATE });
    expect(forced.canonical).toBe(false);
    expect(forced.generated).toBe(true);
    expect(forced.authority_level).toBe('derived');
    expect(forced.provenance).toBe('synthesis');
    // The identity surface transcript-discovery.ts greps for stays intact.
    expect(forced.dream_generated).toBe(true);
    expect(forced.dream_cycle_date).toBe(CYCLE_DATE);
  });

  test('defaults carry the lifecycle a validator requires, expiring in 90 days', () => {
    const { defaults } = generatedRecordStamp({ cycleDate: CYCLE_DATE });
    expect(defaults.status).toBe('active');
    expect(defaults.created).toBe(CYCLE_DATE);
    expect(defaults.expires_at).toBe('2026-11-20');
    expect(defaults.owner).toBe('gbrain-dream');
    expect(defaults.record_version).toBe(1);
  });

  test('a source id that is not a record scope falls back to shared, never adaptig', () => {
    expect(generatedRecordStamp({ sourceId: 'adaptig' }).defaults.scope).toBe('adaptig');
    expect(generatedRecordStamp({ sourceId: 'hermes-native' }).defaults.scope).toBe('shared');
    expect(generatedRecordStamp({}).defaults.scope).toBe('shared');
  });

  test('the raw trace is content-addressed so it survives the corpus file moving', () => {
    const { defaults, forced } = generatedRecordStamp({
      cycleDate: CYCLE_DATE,
      rawSourcePath: '/corpus/2026-08-22-standup.md',
      rawSourceHash: 'a'.repeat(64),
    });
    expect(forced.raw_source).toBe('/corpus/2026-08-22-standup.md');
    expect(forced.raw_source_name).toBe('2026-08-22-standup.md');
    expect(forced.raw_source_sha256).toBe(`sha256:${'a'.repeat(64)}`);
    expect(defaults.derived_from).toBe(
      `file:///corpus/2026-08-22-standup.md#sha256=${'a'.repeat(12)}`,
    );
  });

  test('no raw path at all still yields a derived_from (the cycle itself)', () => {
    const { defaults, forced } = generatedRecordStamp({ cycleDate: CYCLE_DATE });
    expect(defaults.derived_from).toBe(`gbrain:dream-cycle/${CYCLE_DATE}`);
    expect(defaults.source_refs).toEqual([`gbrain:dream-cycle/${CYCLE_DATE}`]);
    expect('raw_source' in forced).toBe(false);
  });
});

describe('applyGeneratedStamp — merge precedence', () => {
  test("a subagent's own status survives; the orchestrator's guarantees do not yield", () => {
    const fm = applyGeneratedStamp(
      { status: 'draft', canonical: true, title_note: 'mine' },
      { cycleDate: CYCLE_DATE },
    );
    expect(fm.status).toBe('draft');       // default, merged under
    expect(fm.title_note).toBe('mine');    // untouched
    expect(fm.canonical).toBe(false);      // forced, merged over
    expect(fm.generated).toBe(true);
  });

  test('a re-render inherits the row\'s cycle date instead of resetting it to today', () => {
    // stampDreamProvenance writes the DB row before any reverse-render, so the
    // row is the authority: a `--date` backfill must not re-render as today.
    const fm = applyGeneratedStamp({ dream_cycle_date: CYCLE_DATE, created: CYCLE_DATE });
    expect(fm.dream_cycle_date).toBe(CYCLE_DATE);
    expect(fm.created).toBe(CYCLE_DATE);
    expect(fm.expires_at).toBe('2026-11-20');
  });
});

describe('ensureBodyH1 — the missing_h1 strict-validation failure', () => {
  test('prepends an H1 when the body has none', () => {
    expect(ensureBodyH1('Some prose.', 'A title')).toBe('# A title\n\nSome prose.');
  });

  test('rewrites a first H1 that disagrees with the title', () => {
    expect(ensureBodyH1('# Wrong\n\nbody', 'Right')).toBe('# Right\n\nbody');
  });

  test('is idempotent — a re-render never adds a second heading', () => {
    const once = ensureBodyH1('body', 'T');
    expect(ensureBodyH1(once, 'T')).toBe(once);
  });

  test('whitespace differences do not count as a mismatch', () => {
    expect(ensureBodyH1('#  Two   words\n\nbody', 'Two words')).toBe('#  Two   words\n\nbody');
  });

  test('an untitled page is left alone rather than given an empty heading', () => {
    expect(ensureBodyH1('body', '   ')).toBe('body');
  });
});

describe('dream-cycle-proposals — the review queue', () => {
  const taskSlug = `${DREAM_PROPOSAL_PREFIX}2026-08-22-task-ship-the-thing-abc123`;
  const correctionSlug = `${DREAM_PROPOSAL_PREFIX}2026-08-22-correction-stale-rate-abc123`;

  test('isProposalSlug recognizes the queue and nothing else', () => {
    expect(isProposalSlug(taskSlug)).toBe(true);
    expect(isProposalSlug('wiki/personal/reflections/2026-08-22-x-abc123')).toBe(false);
    expect(isProposalSlug(undefined)).toBe(false);
  });

  test('status and expiry are FORCED, so a proposal cannot promote itself', () => {
    const fm = applyGeneratedStamp(
      { status: 'active', expires_at: '2099-01-01' },
      { slug: taskSlug, cycleDate: CYCLE_DATE },
    );
    expect(fm.status).toBe('proposed');
    expect(fm.proposal).toBe(true);
    expect(fm.review_state).toBe('pending');
    // 30 days, not the 90 ordinary generated output gets.
    expect(fm.expires_at).toBe('2026-09-21');
  });

  test('promotion_target names where a HUMAN would file it, per proposal kind', () => {
    expect(generatedRecordStamp({ slug: taskSlug, sourceId: 'shared' }).forced.promotion_target)
      .toBe('shared:tasks/current');
    expect(generatedRecordStamp({ slug: correctionSlug, sourceId: 'shared' }).forced.promotion_target)
      .toContain('decisions|learnings');
  });

  test('the rendered file pins type: note — a candidate task is not a task', () => {
    const page = {
      slug: taskSlug,
      type: 'task',
      title: 'Ship the thing',
      compiled_truth: '## Proposed task\nShip it.',
      timeline: '',
      frontmatter: {},
    } as unknown as Page;
    const md = renderPageToMarkdown(page, [], { slug: taskSlug, cycleDate: CYCLE_DATE });
    expect(md).toMatch(/^type:\s*note$/m);
    expect(md).toMatch(/^status:\s*proposed$/m);
    expect(md).toMatch(/^canonical:\s*false$/m);
    // The H1 the record contract requires, added by the producer.
    expect(md).toContain('# Ship the thing');
  });
});

describe('synthesis prompt — Tasks E and F', () => {
  const transcript = {
    filePath: '/tmp/t.txt',
    basename: 't',
    content: 'User: hello world',
    contentHash: 'abcdef0123456789',
    inferredDate: '2026-07-17',
  } as DiscoveredTranscript;

  const prompt = (manifest = ''): string => __testing.buildSynthesisPrompt(
    transcript, 'chunk', 0, 1, '', 'wiki', '', manifest, ['wiki/personal/reflections/*'],
  );

  test('both proposal slug templates live under the review-queue prefix', () => {
    const p = prompt();
    expect(p).toContain(`${DREAM_PROPOSAL_PREFIX}2026-07-17-task-`);
    expect(p).toContain(`${DREAM_PROPOSAL_PREFIX}2026-07-17-correction-`);
  });

  test('a task proposal must first check whether the brain already knows', () => {
    // The single worst duplicating writer in the system was Task E proposing
    // work the brain already tracks — including work it had already CLOSED.
    expect(prompt('LINK CANDIDATES\n- wiki/people/jane')).toContain('SEARCH FIRST');
    expect(prompt()).toContain('You have NO search tool in this run');
  });

  test('with no manifest, corrections are forbidden rather than improvised', () => {
    expect(prompt()).toContain('write NO correction pages at all');
    expect(prompt('LINK CANDIDATES\n- wiki/people/jane')).toContain('taken from LINK CANDIDATES above');
  });

  test('the truth namespaces stay off-limits in the prompt as well as server-side', () => {
    expect(prompt()).toContain('Never write to `tasks/`, `decisions/`, `learnings/`, `context/` or `agent-runs/`');
  });
});


// ---------------------------------------------------------------------------
// The review queue's AUTHORIZATION, not just its slug shape.
//
// isProposalSlug (above) only says what a proposal slug looks like. This block
// pins the thing that actually decides whether a proposal can be written at all:
// the allow-list handed to put_page. A rejected write is SILENT — put_page
// refuses server-side with no error surface — so if this glob ever goes missing
// the cycle keeps reporting success and quietly stops producing proposals. That
// is precisely the failure patch 1696774de exists to prevent, and it is why the
// append lives in an exported function instead of an inline push.
// ---------------------------------------------------------------------------
describe('dream-cycle-proposals — the write is actually authorized', () => {
  // The globs a real load returns; the lane is appended on top of them.
  const BASE = ['wiki/*', 'dream-cycle-summaries/*'];

  test('the proposals lane is authorized after withProposalLane', () => {
    const before = [...BASE];
    expect(matchesSlugAllowList(`${DREAM_PROPOSAL_PREFIX}2026-08-22-task-x-abc123`, before)).toBe(false);

    const after = withProposalLane([...BASE]);
    expect(matchesSlugAllowList(`${DREAM_PROPOSAL_PREFIX}2026-08-22-task-x-abc123`, after)).toBe(true);
    expect(matchesSlugAllowList(`${DREAM_PROPOSAL_PREFIX}2026-08-22-correction-y-abc123`, after)).toBe(true);
  });

  test('it authorizes NOTHING the cycle must never write', () => {
    const after = withProposalLane([...BASE]);
    for (const forbidden of [
      'tasks/current',
      'decisions/2026-08-05-canonical-task-home-ai-brain-tasks',
      'learnings/2026-08-06-a-rule-without-a-check-is-not-a-rule',
      'context/mike-business/anything',
      'agent-runs/some-run',
    ]) {
      expect(matchesSlugAllowList(forbidden, after)).toBe(false);
    }
  });

  test('it is idempotent and preserves the globs it was given', () => {
    const once = withProposalLane([...BASE]);
    const twice = withProposalLane([...once]);
    expect(twice).toEqual(once);
    expect(twice.filter(g => g.startsWith(DREAM_PROPOSAL_PREFIX))).toHaveLength(1);
    for (const g of BASE) expect(twice).toContain(g);
  });
});

/**
 * The seam this port had to build, and the reason it needs its own tests.
 *
 * The stamp was written against v0.47.8.0. Upstream v0.48.3.0 carries #4337 —
 * a page's FIRST dream cycle date is immutable, mirrored into
 * `dream_created_cycle_date`, so a re-synthesis pass cannot rewrite a page's
 * provenance to the maintenance run's date. The two features touch the same
 * three keys from opposite directions: #4337 wants the OLD date preserved,
 * while the contract's `forced` block asserts THIS run's `dream_cycle_date`.
 *
 * Applied naively, the stamp wins and #4337 silently regresses — nothing fails,
 * the dates are simply wrong forever after. These tests pin the resolution:
 * `cycleDate` is resolved from the row BEFORE the stamp is built, so `forced`
 * re-asserts the page's own original date rather than today's.
 */
describe('#4337 coexistence — the stamp must not rewrite a page\'s first cycle date', () => {
  test('the immutable mirror is FORCED, not merely defaulted', () => {
    const { forced, defaults } = generatedRecordStamp({ cycleDate: CYCLE_DATE });
    expect(forced.dream_created_cycle_date).toBe(CYCLE_DATE);
    expect(forced.dream_cycle_date).toBe(CYCLE_DATE);
    // Seeded in defaults too, for frontmatter key ORDER only — the marker block
    // has to render inside the 2000 chars the self-consumption guard scans.
    expect(defaults.dream_created_cycle_date).toBe(CYCLE_DATE);
  });

  test('the created mirror outranks the back-compat key when the two disagree', () => {
    // A row stamped before #4337 and re-stamped after can carry both. The DB
    // path COALESCEs created-mirror first; the render path must agree, or the
    // file and the row report different origin dates for the same page.
    const fm = applyGeneratedStamp({
      dream_created_cycle_date: '2026-03-01',
      dream_cycle_date: '2026-08-22',
    });
    expect(fm.dream_cycle_date).toBe('2026-03-01');
    expect(fm.dream_created_cycle_date).toBe('2026-03-01');
    expect(fm.created).toBe('2026-03-01');
    expect(fm.expires_at).toBe('2026-05-30');
  });

  test('an explicit caller cycleDate still wins over the row (a --date backfill)', () => {
    const fm = applyGeneratedStamp(
      { dream_created_cycle_date: '2026-03-01' },
      { cycleDate: CYCLE_DATE },
    );
    expect(fm.dream_created_cycle_date).toBe(CYCLE_DATE);
  });

  test('a rerender of a stamped page re-emits its OWN date, never today', () => {
    const page = {
      slug: 'wiki/personal/reflections/2026-03-01-x-abc123',
      type: 'note',
      title: 'A reflection',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: { dream_created_cycle_date: '2026-03-01', dream_generated: true },
    } as unknown as Page;
    // No ctx — exactly how reverseWriteRefs renders a page it did not just write.
    const md = renderPageToMarkdown(page, []);
    expect(md).toMatch(/^dream_cycle_date:\s*['"]?2026-03-01/m);
    expect(md).toMatch(/^dream_created_cycle_date:\s*['"]?2026-03-01/m);
    expect(md).toMatch(/^created:\s*['"]?2026-03-01/m);
    expect(md).not.toContain(new Date().toISOString().slice(0, 10));
  });

  test('an UNSTAMPED page still renders — the fallback is today, not a crash', () => {
    const page = {
      slug: 'x', type: 'note', title: 'T', compiled_truth: 'b', timeline: '', frontmatter: {},
    } as unknown as Page;
    const md = renderPageToMarkdown(page, []);
    expect(md).toMatch(
      new RegExp(`^dream_created_cycle_date:\\s*['"]?${new Date().toISOString().slice(0, 10)}`, 'm'),
    );
  });

  test('the DB stamp appends the immutable pair AFTER forced, or forced would win', () => {
    // The SQL is the only place the two features are ordered, and the order is
    // load-bearing: `forced` carries this run's date, so the COALESCE'd pair has
    // to be the LAST concatenation. Pinned as source text because the ordering
    // is not observable from the return value of a mocked engine.
    const src = readFileSync(
      new URL('../src/core/cycle/synthesize.ts', import.meta.url),
      'utf8',
    );
    const stmt = /SET frontmatter = \$4::jsonb[\s\S]*?WHERE slug = \$1/.exec(src);
    expect(stmt).not.toBeNull();
    const sql = stmt![0];
    expect(sql.indexOf('$5::jsonb')).toBeLessThan(sql.indexOf('jsonb_build_object'));
    expect(sql).toContain("COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', '')");
  });
});
