import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openRepairFile } from '../src/core/facts/repair-file.ts';
const ORIGINAL = 'Original bytes.\n';
let root: string, repo: string, file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repair-boundary-'));
  repo = join(root, 'repo'); file = join(repo, 'people', 'example-person.md');
  mkdirSync(join(repo, 'people'), { recursive: true }); writeFileSync(file, ORIGINAL);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('positive kernel boundary: parent swap AFTER the last check cannot redirect the append', () => {
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'example-person.md'), ORIGINAL);
  const handle = openRepairFile(repo, file, true);
  try {
    expect(() => handle.append(ORIGINAL + '\nRepair append.\n', () => {
      renameSync(join(repo, 'people'), join(repo, 'old-people')); symlinkSync(outside, join(repo, 'people'));
    })).toThrow(); // Namespace changed: no hidden success.
    expect(readFileSync(join(outside, 'example-person.md'), 'utf8')).toBe(ORIGINAL);
    expect(readFileSync(join(repo, 'old-people', 'example-person.md'), 'utf8')).toBe(ORIGINAL + '\nRepair append.\n');
  } finally { handle.close(); }
});

test('positive file boundary: a replacement human inode AFTER the last check is never overwritten', () => {
  const handle = openRepairFile(repo, file, true);
  try {
    expect(() => handle.append(ORIGINAL + '\nRepair append.\n', () => {
      renameSync(file, file + '.original'); writeFileSync(file, 'Human replacement.\n');
    })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('Human replacement.\n');
    expect(readFileSync(file + '.original', 'utf8')).toBe(ORIGINAL + '\nRepair append.\n');
  } finally { handle.close(); }
});
