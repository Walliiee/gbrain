/**
 * Read-only compatibility check for an uncommitted fence. This proves that
 * every differing byte is representable by the page's current facts; it does
 * NOT prove authorship. Callers may reuse these bytes unchanged, never remove,
 * replace, commit or extend them on this evidence. Tombstones and extra human
 * fields must not be mistaken for a still-eligible repair.
 */
import {
  parseFactsFence, renderFactsTable, upsertFactRow,
  FACTS_FENCE_BEGIN, FACTS_FENCE_END, type ParsedFact,
} from '../facts-fence.ts';
import { FENCE_SOURCE_DEFAULT } from './extract-from-fence.ts';

/** One fence-owned DB row of the page, as the fence renders it. */
export interface OwnedFenceRow {
  rowNum: number;
  /** `expired_at IS NULL` */
  active: boolean;
  /** The DB row rendered through `legacyRowToFenceRow`. */
  view: ParsedFact;
}

export type DirtAccount =
  | { kind: 'clean' }
  | { kind: 'accounted'; ownedRows: number[]; reusableRows: number[] }
  | { kind: 'unaccounted'; detail: string };

/** Sentinel standing in for the whole fence span while comparing the rest. */
const FENCE_TOKEN = '\u0000gbrain:facts\u0000';

const FIELDS = [
  'kind', 'confidence', 'visibility', 'notability',
  'validFrom', 'validUntil', 'context',
  'claimMetric', 'claimValue', 'claimUnit', 'claimPeriod',
] as const;

function fenceSpan(body: string): { begin: number; end: number } | null {
  const begin = body.indexOf(FACTS_FENCE_BEGIN);
  if (begin === -1) return null;
  const end = body.indexOf(FACTS_FENCE_END, begin + FACTS_FENCE_BEGIN.length);
  return end === -1 ? null : { begin, end: end + FACTS_FENCE_END.length };
}

function outsideFence(body: string): string {
  const span = fenceSpan(body);
  return span ? body.slice(0, span.begin) + FENCE_TOKEN + body.slice(span.end) : body;
}

/** Recognize only exact canonical sections appended after the committed bytes. */
function repairAppendChain(headBody: string, workBody: string): ParsedFact[] | null {
  if (!workBody.startsWith(headBody)) return null;
  let suffix = workBody.slice(headBody.length);
  const rows: ParsedFact[] = [];
  while (suffix.length > 0) {
    const sep = rows.length > 0 ? '\n\n' : headBody.endsWith('\n') ? '\n' : '\n\n';
    const prefix = `${sep}## Facts\n\n`;
    if (!suffix.startsWith(prefix)) return null;
    suffix = suffix.slice(prefix.length);
    const end = suffix.indexOf(FACTS_FENCE_END);
    if (end === -1) return null;
    const block = suffix.slice(0, end + FACTS_FENCE_END.length);
    const parsed = parseFactsFence(block);
    if (parsed.warnings.length > 0 || parsed.facts.length === 0 || block !== renderFactsTable(parsed.facts)) return null;
    rows.push(...parsed.facts);
    suffix = suffix.slice(block.length);
    if (suffix === '\n') suffix = '';
  }
  return rows;
}

function key(claim: string, source: string | undefined): string {
  return `${claim}\u0000${source ?? FENCE_SOURCE_DEFAULT}`;
}

/** Two fence rows are the same row: same number, same state, same columns. */
function sameRow(a: ParsedFact, b: ParsedFact): boolean {
  return a.rowNum === b.rowNum && a.active === b.active
    && key(a.claim, a.source) === key(b.claim, b.source)
    && FIELDS.every(f => a[f] === b[f]);
}

/**
 * The on-disk row carries the DB row: same key, same state, and every column
 * the DB row holds. `forget_fact` rewrites `valid_until` and `context` on the
 * struck row while the DB row keeps its own values, so for a struck row those
 * two columns are deliberately not compared.
 */
export function diskRowCarries(onDisk: ParsedFact, view: ParsedFact, active: boolean): boolean {
  if (onDisk.active !== active) return false;
  if (key(onDisk.claim, onDisk.source) !== key(view.claim, view.source)) return false;
  const compare = active ? FIELDS : FIELDS.filter(f => f !== 'validUntil' && f !== 'context');
  return compare.every(f => onDisk[f] === view[f]);
}

/**
 * Can the database account for every byte by which `workBody` differs from
 * `headBody`? `owned` is every fence-owned DB row of this page; `eligible` is
 * the canonical view of the legacy rows still eligible for repair here.
 */
export function accountFenceDirt(
  headBody: string,
  workBody: string,
  owned: OwnedFenceRow[],
  eligible: ParsedFact[],
): DirtAccount {
  if (headBody === workBody) return { kind: 'clean' };
  const head = parseFactsFence(headBody);
  const work = parseFactsFence(workBody);
  if (head.warnings.length > 0 || work.warnings.length > 0) {
    return { kind: 'unaccounted', detail: 'fence does not parse cleanly' };
  }
  const appendedChain = repairAppendChain(headBody, workBody);
  if (appendedChain) {
    const ownedByNum = new Map(owned.map(o => [o.rowNum, o]));
    const ownedRows: number[] = [];
    const reusableRows: number[] = [];
    for (const row of appendedChain) {
      const o = ownedByNum.get(row.rowNum);
      if (o) {
        if (!diskRowCarries(row, o.view, o.active)) return { kind: 'unaccounted', detail: `fence row #${row.rowNum} differs from the DB row that owns it` };
        ownedRows.push(row.rowNum);
      } else if (row.active && eligible.some(v => diskRowCarries(row, v, true))) {
        reusableRows.push(row.rowNum);
      } else {
        return { kind: 'unaccounted', detail: `fence row #${row.rowNum} is owned by no DB row and renders no eligible legacy row` };
      }
    }
    return { kind: 'accounted', ownedRows, reusableRows };
  }
  const span = fenceSpan(workBody);
  if (!span) return { kind: 'unaccounted', detail: 'bytes outside any fence differ from HEAD' };
  if (workBody.slice(span.begin, span.end) !== renderFactsTable(work.facts)) {
    return { kind: 'unaccounted', detail: 'fence is not a canonical rendering' };
  }
  // When HEAD had no fence at all, the only accepted wrapper is the exact
  // `## Facts` section the writers emit — rendered here by the real writer
  // with a throwaway row so no hand-written variant can pass.
  const expectedOutside = fenceSpan(headBody)
    ? outsideFence(headBody)
    : outsideFence(upsertFactRow(headBody, {
        claim: 'x', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
      }).body);
  if (outsideFence(workBody) !== expectedOutside) {
    return { kind: 'unaccounted', detail: 'bytes outside the fence differ from HEAD' };
  }
  // Committed rows must be untouched and in place; the accounted rows can only
  // be a suffix of the table (the repair's own insertion point).
  for (let i = 0; i < head.facts.length; i++) {
    const before = head.facts[i]!;
    const after = work.facts[i];
    if (!after || !sameRow(before, after)) {
      return { kind: 'unaccounted', detail: `committed fence row #${before.rowNum} was changed` };
    }
  }
  const ownedByNum = new Map(owned.map(o => [o.rowNum, o]));
  const ownedRows: number[] = [];
  const reusableRows: number[] = [];
  for (const row of work.facts.slice(head.facts.length)) {
    const o = ownedByNum.get(row.rowNum);
    if (o) {
      if (!diskRowCarries(row, o.view, o.active)) {
        return { kind: 'unaccounted', detail: `fence row #${row.rowNum} differs from the DB row that owns it` };
      }
      ownedRows.push(row.rowNum);
      continue;
    }
    // Compatible bytes, regardless of authorship: reuse only, never rewrite.
    if (row.active && eligible.some(v => diskRowCarries(row, v, true))) {
      reusableRows.push(row.rowNum);
      continue;
    }
    return {
      kind: 'unaccounted',
      detail: `fence row #${row.rowNum} is owned by no DB row and renders no eligible legacy row`,
    };
  }
  return { kind: 'accounted', ownedRows, reusableRows };
}
