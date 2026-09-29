/**
 * Accounting gate — verifies the money invariants the product promises, end to end.
 *
 * Run with: npm run accounting:check
 *
 * It boots a throwaway SQLite ledger through the real HTTP API and asserts:
 *   1. every stored money value is an exact integer minor unit;
 *   2. posted Bank Feed rows agree with the ledger entries they were posted from
 *      (A4), and an edited entry reopens the rows that stop matching;
 *   3. reconciliation totals per account (feed posted vs ledger movements) match,
 *      excluding opening balances and counting transfers on both accounts;
 *   4. the inbox paginates while the Pending/Posted/Ignored stats keep counting
 *      every row (A5).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mot-accounting-'));
process.env.DB_PATH = join(dir, 'check.sqlite');
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { server, db } = await import(`../server.mjs?accounting=${Date.now()}`);
const { reconcileFeed } = await import('../lib/bank-feed.js');
const { accountBalances } = await import('../lib/ledger.js');
const { fromMinor, toMinor } = await import('../lib/money.js');

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '', csrf = '', state = null;
const checks = [];

async function request(path, { method = 'GET', body, useCookie = cookie, useCsrf = csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (useCookie) headers.cookie = useCookie;
  if (useCsrf && method !== 'GET') headers['x-csrf-token'] = useCsrf;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { res, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function check(name, fn) {
  try { await fn(); checks.push(`${name}: ok`); }
  catch (error) { checks.push(`${name}: FAILED`); throw error; }
}

try {
  const registered = await request('/api/auth/register', {
    method: 'POST', useCookie: '', useCsrf: '',
    body: { email: `accounting-${Date.now()}@example.com`, password: 'correct horse battery staple', displayName: 'Accounting Check' }
  });
  assert.equal(registered.res.status, 201);
  cookie = registered.cookie; csrf = registered.data.csrfToken;

  await check('money columns are integer minor units', () => {
    const expected = {
      accounts: ['opening_balance_minor'],
      entries: ['amount_minor', 'from_amount_minor', 'to_amount_minor', 'signed_amount_minor'],
      bank_feed_items: ['signed_amount_minor']
    };
    for (const [table, columns] of Object.entries(expected)) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all();
      for (const column of columns) {
        const row = info.find(entry => entry.name === column);
        assert.ok(row, `${table}.${column} exists`);
        assert.equal(row.type, 'INTEGER', `${table}.${column} is INTEGER`);
      }
    }
    const stored = db.prepare('SELECT amount_minor AS amountMinor FROM entries').all();
    for (const row of stored) assert.ok(Number.isInteger(Number(row.amountMinor)), 'entry amounts are integers');
  });

  const stamp = new Date().toISOString();
  const seeded = await request('/api/state', {
    method: 'PUT',
    body: {
      version: 1,
      settings: { displayName: 'Accounting Check', defaultCurrency: 'USD' },
      people: [],
      accounts: [
        { id: 'account_bank', name: 'Main Bank', type: 'bank', currency: 'USD', openingBalance: 1000, createdAt: stamp },
        { id: 'account_cash', name: 'Cash', type: 'cash', currency: 'USD', openingBalance: 50, createdAt: stamp }
      ],
      entries: []
    }
  });
  assert.equal(seeded.res.status, 200);
  state = seeded.data;

  const imports = [
    ['account_bank', 'check.csv', [
      { date: '2026-09-27', description: 'CORNER STORE', merchant: 'Corner Store', signedAmount: -45, currency: 'USD', externalId: 'check-expense' },
      { date: '2026-09-27', description: 'PAYROLL', merchant: 'Employer', signedAmount: 500, currency: 'USD', externalId: 'check-income' },
      { date: '2026-09-28', description: 'Transfer to cash', signedAmount: -100, currency: 'USD', externalId: 'check-transfer-out' }
    ]],
    ['account_cash', 'check-cash.csv', [
      { date: '2026-09-28', description: 'Transfer from bank', signedAmount: 100, currency: 'USD', externalId: 'check-transfer-in' }
    ]]
  ];
  for (const [accountId, sourceName, rows] of imports) {
    const imported = await request('/api/bank-feed/import', { method: 'POST', body: { accountId, sourceName, rows } });
    assert.equal(imported.res.status, 200, 'statement import succeeds');
    assert.equal(imported.data.imported, rows.length);
  }

  const feedBefore = (await request('/api/bank-feed')).data;
  const post = async (externalId, body) => {
    const item = (await request('/api/bank-feed')).data.items.find(row => row.externalId === externalId);
    assert.ok(item, `${externalId} imported`);
    const posted = await request(`/api/bank-feed/${item.id}/post`, { method: 'POST', body: { expectedRevision: state.version, ...body } });
    assert.equal(posted.res.status, 200, `${externalId} posts`);
    state = posted.data.state;
    return posted.data;
  };

  await post('check-expense', { classification: 'expense' });
  await post('check-income', { classification: 'income' });
  const transferOut = await post('check-transfer-out', { classification: 'transfer', targetAccountId: 'account_cash' });
  const transferIn = await post('check-transfer-in', { classification: 'transfer', targetAccountId: 'account_bank' });
  await check('both statement sides of one transfer share one ledger movement', () => {
    assert.equal(transferIn.linkedExistingTransfer, true);
    assert.equal(transferIn.entryId, transferOut.entryId);
    assert.equal(state.entries.length, 3);
  });

  const feedSnapshot = async () => (await request('/api/bank-feed')).data;
  const reconcile = async () => {
    const feed = await feedSnapshot();
    const aggregateByAccount = new Map((feed.accountStats || []).map(row => [row.accountId, row]));
    return reconcileFeed(feed.items, state.entries, state.accounts).map(row => {
      const aggregate = aggregateByAccount.get(row.accountId) || {};
      const feedMinor = Number(aggregate.postedMinor || 0);
      const ledgerMinor = toMinor(row.ledgerAmount || 0, row.currency);
      const differenceMinor = feedMinor - ledgerMinor;
      const imported = Number(aggregate.imported || 0);
      const posted = Number(aggregate.posted || 0);
      const ignored = Number(aggregate.ignored || 0);
      const pending = Number(aggregate.pending || 0);
      const rowsBalanced = imported === posted + ignored + pending;
      return {
        ...row,
        imported,
        posted,
        ignored,
        pending,
        feedMinor,
        ledgerMinor,
        differenceMinor,
        difference: fromMinor(differenceMinor, row.currency),
        rowsBalanced,
        balanced: differenceMinor === 0 && rowsBalanced
      };
    });
  };
  await check('feed posted totals equal ledger movements per account', async () => {
    const out = await reconcile();
    for (const row of out) {
      assert.equal(row.ledgerMinor, row.feedMinor, `${row.name} feed ${row.feedMinor} vs ledger ${row.ledgerMinor}`);
      assert.equal(row.differenceMinor, 0, `${row.name} has no difference`);
      assert.equal(row.rowsBalanced, true, `${row.name} imported rows equal pending+posted+ignored`);
    }
    assert.equal(out.every(row => row.balanced), true);
    const bank = out.find(row => row.accountId === 'account_bank');
    assert.equal(bank.feedMinor, 35500, 'bank feed posted total excludes the opening balance');
    assert.equal(bank.ledgerAmount, 355, 'bank ledger movements exclude the opening balance');
    const cash = out.find(row => row.accountId === 'account_cash');
    assert.equal(cash.feedMinor, 10000, 'the transfer leg counts on the receiving account');
  });

  const balances = accountBalances(state.entries, state.accounts);
  await check('account balances follow the ledger, the opening balance, and cancel transfer legs', async () => {
    assert.equal(balances.account_bank, 1355);
    assert.equal(balances.account_cash, 150);
    const out = await reconcile();
    const legs = out.reduce((sum, row) => sum + row.ledgerMinor, 0);
    const nonTransfer = state.entries.reduce((sum, entry) => {
      if (entry.type === 'account_transfer') return sum;
      if (entry.type === 'account_income') return sum + Math.round(entry.amount * 100);
      return sum - Math.round(entry.amount * 100);
    }, 0);
    assert.equal(legs, nonTransfer, 'transfer legs cancel out across accounts');
  });

  const expenseEntry = state.entries.find(entry => entry.amount === 45 && entry.type === 'account_expense');
  const edited = await request('/api/entries/' + expenseEntry.id, {
    method: 'PUT', body: { ...expenseEntry, amount: 60, expectedRevision: state.version }
  });
  assert.equal(edited.res.status, 200);
  await check('editing a posted entry reopens the feed row that no longer matches', async () => {
    assert.equal(edited.data.reopenedFeedItems, 1);
    state = edited.data;
    const feed = (await request('/api/bank-feed')).data;
    const item = feed.items.find(row => row.externalId === 'check-expense');
    assert.equal(item.status, 'pending');
    assert.equal(item.postedEntryId, null);
    assert.equal(feed.stats.posted, 3);
    assert.equal(feed.stats.pending, 1);
    const out = await reconcile();
    const bank = out.find(row => row.accountId === 'account_bank');
    assert.equal(bank.feedMinor, 40000, 'the feed still says $45 left the account');
    assert.equal(bank.ledgerMinor, 34000, 'the ledger now says $60 left the account');
    assert.equal(bank.difference, 60);
    assert.equal(bank.balanced, false);
    assert.equal(out.every(row => row.balanced), false);
  });

  const removed = await request('/api/entries/' + expenseEntry.id, {
    method: 'DELETE', body: { expectedRevision: state.version }
  });
  assert.equal(removed.res.status, 200);
  state = removed.data;
  assert.equal(state.entries.some(entry => entry.id === expenseEntry.id), false);
  await check('re-posting the reopened row brings the books back into balance', async () => {
    const reposted = await post('check-expense', { classification: 'expense' });
    assert.equal(reposted.linkedExistingTransfer, false);
    const out = await reconcile();
    assert.equal(out.every(row => row.balanced), true);
    const bank = out.find(row => row.accountId === 'account_bank');
    assert.equal(bank.feedMinor, 35500);
    assert.equal(bank.ledgerMinor, 35500);
    assert.equal(bank.posted, 3);
    const cash = out.find(row => row.accountId === 'account_cash');
    assert.equal(cash.feedMinor, 10000);
    assert.equal(cash.ledgerMinor, 10000);
  });

  const bulk = Array.from({ length: 250 }, (_, index) => ({
    date: '2026-09-29', description: 'SCALE ROW ' + index, signedAmount: -(index + 1), currency: 'USD', externalId: 'check-scale-' + index
  }));
  const scaled = await request('/api/bank-feed/import', { method: 'POST', body: { accountId: 'account_bank', sourceName: 'scale.csv', rows: bulk } });
  assert.equal(scaled.res.status, 200);
  assert.equal(scaled.data.imported, 250);
  await check('the inbox paginates while the stats count every row', async () => {
    const page = (await request('/api/bank-feed?status=pending&limit=100&offset=100')).data;
    assert.equal(page.items.length, 100);
    assert.deepEqual(page.page, { limit: 100, offset: 100, returned: 100, total: 250 });
    assert.equal(page.stats.pending, 250);
    assert.equal(page.stats.posted, 4);
    assert.equal(page.stats.ignored, 0);
    const clamped = (await request('/api/bank-feed?status=pending&limit=9999')).data;
    assert.equal(clamped.page.limit, 500);
    assert.equal(clamped.items.length, 250);
    const seen = new Set();
    for (let offset = 0; offset < 250; offset += 100) {
      const slice = (await request(`/api/bank-feed?status=pending&limit=100&offset=${offset}`)).data;
      for (const item of slice.items) seen.add(item.id);
    }
    assert.equal(seen.size, 250, 'every pending row is reachable through the pager');
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('ACCOUNTING_CHECK_OK ' + JSON.stringify({ checks: checks.length, moneyStorage: 'integer-minor-units' }));
for (const line of checks) console.log('  · ' + line);
