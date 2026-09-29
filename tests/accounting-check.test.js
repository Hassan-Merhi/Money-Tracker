import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts/accounting-check.mjs');
const baselineFixturePath = join(repoRoot, 'tests/fixtures/wave0-ledger-baseline.json');

function runCheck(fixturePath) {
  const args = [scriptPath];
  if (fixturePath) args.push(fixturePath);
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

test('accounting-check exits 0 on baseline fixture and prints tie-out table', () => {
  // Test with default path (no args)
  const defaultRun = runCheck();
  assert.equal(defaultRun.status, 0, `Expected exit code 0, got ${defaultRun.status}: ${defaultRun.stderr}`);
  assert.match(defaultRun.stdout, /ACCOUNT BALANCES TIE-OUT/);
  assert.match(defaultRun.stdout, /PERSON BALANCES/);
  assert.match(defaultRun.stdout, /DASHBOARD TOTALS/);
  assert.match(defaultRun.stdout, /RESULT: PASS/);

  // Test with explicit path argument
  const explicitRun = runCheck(baselineFixturePath);
  assert.equal(explicitRun.status, 0);
  assert.match(explicitRun.stdout, /RESULT: PASS/);
});

test('accounting-check exits 1 when a split transaction sum does not match total amount', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'acct-check-split-'));
  const tempFile = join(tempDir, 'broken-split.json');
  try {
    const data = JSON.parse(readFileSync(baselineFixturePath, 'utf8'));
    const splitEntry = data.entries.find(e => e.id === 'entry_split');
    assert.ok(splitEntry, 'entry_split must exist in baseline');
    // Change first split from 40 to 30, so sum(splits) = 30 + 50 = 80 != 90
    splitEntry.splits[0].amount = 30;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');

    const result = runCheck(tempFile);
    assert.equal(result.status, 1, 'Expected exit code 1 on broken split');
    const combined = result.stdout + '\n' + result.stderr;
    assert.match(combined, /entry id:\s*entry_split/i);
    assert.match(combined, /expected:/i);
    assert.match(combined, /actual:/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('accounting-check exits 1 when person_adjustment has |signedAmount| != amount', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'acct-check-adj-'));
  const tempFile = join(tempDir, 'broken-adj.json');
  try {
    const data = JSON.parse(readFileSync(baselineFixturePath, 'utf8'));
    const adjEntry = data.entries.find(e => e.id === 'entry_adjust_charlie');
    assert.ok(adjEntry, 'entry_adjust_charlie must exist in baseline');
    // Change signedAmount to 25 while amount remains 30
    adjEntry.signedAmount = 25;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');

    const result = runCheck(tempFile);
    assert.equal(result.status, 1, 'Expected exit code 1 on broken adjustment');
    const combined = result.stdout + '\n' + result.stderr;
    assert.match(combined, /entry id:\s*entry_adjust_charlie/i);
    assert.match(combined, /expected:/i);
    assert.match(combined, /actual:/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('accounting-check exits 1 when expected account balance does not match recomputation', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'acct-check-bal-'));
  const tempFile = join(tempDir, 'broken-bal.json');
  try {
    const data = JSON.parse(readFileSync(baselineFixturePath, 'utf8'));
    // Corrupt expected account balance
    data.expected.accountBalances.account_bank_usd = 999;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');

    const result = runCheck(tempFile);
    assert.equal(result.status, 1, 'Expected exit code 1 on account balance mismatch');
    const combined = result.stdout + '\n' + result.stderr;
    assert.match(combined, /expected:/i);
    assert.match(combined, /actual:/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('accounting-check exits 1 when expected dashboard totals do not match recomputation', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'acct-check-tot-'));
  const tempFile = join(tempDir, 'broken-tot.json');
  try {
    const data = JSON.parse(readFileSync(baselineFixturePath, 'utf8'));
    // Corrupt expected totals net
    data.expected.totals.USD.net = 999;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');

    const result = runCheck(tempFile);
    assert.equal(result.status, 1, 'Expected exit code 1 on totals mismatch');
    const combined = result.stdout + '\n' + result.stderr;
    assert.match(combined, /expected:/i);
    assert.match(combined, /actual:/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
