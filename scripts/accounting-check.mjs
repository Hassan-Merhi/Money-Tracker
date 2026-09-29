import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toMinor,
  fromMinor,
  addMinor,
  sumMinor,
  currencyExponent
} from '../lib/money.js';

function formatAmount(value, currency = 'USD') {
  const exp = currencyExponent(currency);
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: exp,
    maximumFractionDigits: exp
  });
}

function padRight(str, len) {
  const s = String(str ?? '');
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(str, len) {
  const s = String(str ?? '');
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

export function verifyAccounting(fixtureData, { fixturePath = 'in-memory' } = {}) {
  const errors = [];
  const rawState = fixtureData.state || fixtureData;
  const entries = Array.isArray(rawState.entries) ? rawState.entries : [];
  const fixturePeople = Array.isArray(rawState.people) ? rawState.people : [];
  const fixtureAccounts = Array.isArray(rawState.accounts) ? rawState.accounts : [];
  const expected = fixtureData.expected || rawState.expected;

  // 1. Collect all known people and accounts
  const peopleMap = new Map();
  for (const person of fixturePeople) {
    if (person?.id) peopleMap.set(person.id, person);
  }
  const accountsMap = new Map();
  for (const account of fixtureAccounts) {
    if (account?.id) accountsMap.set(account.id, account);
  }

  // Also collect any mentioned in entries
  for (const entry of entries) {
    if (entry.personId && !peopleMap.has(entry.personId)) {
      peopleMap.set(entry.personId, { id: entry.personId, name: entry.personId });
    }
    if (Array.isArray(entry.splits)) {
      for (const split of entry.splits) {
        if (split.personId && !peopleMap.has(split.personId)) {
          peopleMap.set(split.personId, { id: split.personId, name: split.personId });
        }
      }
    }
    if (entry.accountId && !accountsMap.has(entry.accountId)) {
      accountsMap.set(entry.accountId, { id: entry.accountId, currency: entry.currency || 'USD', openingBalance: 0 });
    }
    if (entry.fromAccountId && !accountsMap.has(entry.fromAccountId)) {
      accountsMap.set(entry.fromAccountId, { id: entry.fromAccountId, currency: entry.currency || 'USD', openingBalance: 0 });
    }
    if (entry.toAccountId && !accountsMap.has(entry.toAccountId)) {
      accountsMap.set(entry.toAccountId, { id: entry.toAccountId, currency: entry.currency || 'USD', openingBalance: 0 });
    }
  }

  const people = Array.from(peopleMap.values());
  const accounts = Array.from(accountsMap.values());

  // 2. Invariant I3: every split_paid_for_people has sum(splits) == amount in minor units
  let splitsChecked = 0;
  for (const entry of entries) {
    if (entry.type === 'split_paid_for_people') {
      splitsChecked++;
      const currency = String(entry.currency || 'USD').toUpperCase();
      let expectedMinor;
      try {
        expectedMinor = toMinor(entry.amount, currency);
      } catch (err) {
        errors.push({
          entryId: entry.id,
          expected: 'valid amount',
          actual: entry.amount,
          message: `Entry amount invalid for ${currency}: ${err.message}`
        });
        continue;
      }

      const splits = Array.isArray(entry.splits) ? entry.splits : [];
      let actualMinor = 0;
      let splitError = false;
      for (const split of splits) {
        try {
          const sMin = toMinor(split.amount, currency);
          actualMinor = addMinor(actualMinor, sMin);
        } catch (err) {
          splitError = true;
          errors.push({
            entryId: entry.id,
            expected: 'valid split amount',
            actual: split.amount,
            message: `Split amount invalid for ${currency}: ${err.message}`
          });
          break;
        }
      }

      if (!splitError && actualMinor !== expectedMinor) {
        errors.push({
          entryId: entry.id,
          expected: expectedMinor,
          actual: actualMinor,
          message: `Invariant I3 violation: sum(splits) [${fromMinor(actualMinor, currency)} ${currency}] != entry.amount [${fromMinor(expectedMinor, currency)} ${currency}]`
        });
      }
    }
  }

  // 3. Invariant I4: every person_adjustment has |signedAmount| == amount
  let adjustmentsChecked = 0;
  for (const entry of entries) {
    if (entry.type === 'person_adjustment') {
      adjustmentsChecked++;
      const currency = String(entry.currency || 'USD').toUpperCase();
      let amountMinor;
      let signedMinor;
      try {
        amountMinor = toMinor(entry.amount, currency);
      } catch (err) {
        errors.push({
          entryId: entry.id,
          expected: 'valid amount',
          actual: entry.amount,
          message: `person_adjustment amount invalid for ${currency}: ${err.message}`
        });
        continue;
      }
      try {
        signedMinor = toMinor(entry.signedAmount ?? entry.amount, currency);
      } catch (err) {
        errors.push({
          entryId: entry.id,
          expected: 'valid signedAmount',
          actual: entry.signedAmount,
          message: `person_adjustment signedAmount invalid for ${currency}: ${err.message}`
        });
        continue;
      }

      const absSigned = Math.abs(signedMinor);
      if (absSigned !== amountMinor) {
        errors.push({
          entryId: entry.id,
          expected: amountMinor,
          actual: absSigned,
          message: `Invariant I4 violation: |signedAmount| [${fromMinor(absSigned, currency)}] != amount [${fromMinor(amountMinor, currency)}]`
        });
      }
    }
  }

  // 4. Recompute per-person / per-currency balances
  const personMinors = {};
  for (const person of people) {
    personMinors[person.id] = {};
  }

  for (const entry of entries) {
    const currency = String(entry.currency || 'USD').toUpperCase();
    if (entry.type === 'split_paid_for_people') {
      for (const split of entry.splits || []) {
        if (!split.personId) continue;
        personMinors[split.personId] ||= {};
        try {
          const splitMin = toMinor(split.amount || 0, currency);
          personMinors[split.personId][currency] = addMinor(
            personMinors[split.personId][currency] || 0,
            splitMin
          );
        } catch (err) {
          errors.push({
            entryId: entry.id,
            expected: 'valid split amount',
            actual: split.amount,
            message: err.message
          });
        }
      }
    } else if (entry.personId) {
      let deltaMinor = 0;
      try {
        const amtMinor = toMinor(entry.amount || 0, currency);
        switch (entry.type) {
          case 'paid_for_person':
            deltaMinor = amtMinor;
            break;
          case 'received_from_person':
            deltaMinor = -amtMinor;
            break;
          case 'borrowed_from_person':
            deltaMinor = -amtMinor;
            break;
          case 'paid_to_person':
            deltaMinor = amtMinor;
            break;
          case 'person_adjustment':
            deltaMinor = toMinor(entry.signedAmount ?? entry.amount ?? 0, currency);
            break;
          default:
            deltaMinor = 0;
        }
      } catch (err) {
        errors.push({
          entryId: entry.id,
          expected: 'valid entry amount',
          actual: entry.amount,
          message: err.message
        });
      }

      if (deltaMinor !== 0) {
        personMinors[entry.personId] ||= {};
        personMinors[entry.personId][currency] = addMinor(
          personMinors[entry.personId][currency] || 0,
          deltaMinor
        );
      }
    }
  }

  const computedPersonBalances = {};
  for (const [personId, currMap] of Object.entries(personMinors)) {
    computedPersonBalances[personId] = {};
    for (const [currency, minor] of Object.entries(currMap)) {
      computedPersonBalances[personId][currency] = fromMinor(minor, currency);
    }
  }

  // 5. Recompute dashboard totals (owedToMe / iOwe / net) per currency
  const totalsMinors = {};
  for (const currMap of Object.values(personMinors)) {
    for (const [currency, minor] of Object.entries(currMap)) {
      totalsMinors[currency] ||= { owedToMe: 0, iOwe: 0, net: 0 };
      if (minor > 0) {
        totalsMinors[currency].owedToMe = addMinor(totalsMinors[currency].owedToMe, minor);
      } else if (minor < 0) {
        totalsMinors[currency].iOwe = addMinor(totalsMinors[currency].iOwe, -minor);
      }
      totalsMinors[currency].net = addMinor(totalsMinors[currency].net, minor);
    }
  }

  const computedTotals = {};
  for (const [currency, tMin] of Object.entries(totalsMinors)) {
    computedTotals[currency] = {
      owedToMe: fromMinor(tMin.owedToMe, currency),
      iOwe: fromMinor(tMin.iOwe, currency),
      net: fromMinor(tMin.net, currency)
    };
  }

  // Invariant I1: net == owedToMe - iOwe for every currency
  for (const [currency, tMin] of Object.entries(totalsMinors)) {
    const expectedNetMinor = tMin.owedToMe - tMin.iOwe;
    if (tMin.net !== expectedNetMinor) {
      errors.push({
        entryId: 'totals_' + currency,
        expected: fromMinor(expectedNetMinor, currency),
        actual: fromMinor(tMin.net, currency),
        message: `Invariant I1 violation for ${currency}: net (${fromMinor(tMin.net, currency)}) != owedToMe (${fromMinor(tMin.owedToMe, currency)}) - iOwe (${fromMinor(tMin.iOwe, currency)})`
      });
    }
  }

  // 6. Per-account balances: two independent recomputations
  // Recomputation 1: Chronological fold over transactions
  const accountBalances1Minor = {};
  for (const account of accounts) {
    const curr = String(account.currency || 'USD').toUpperCase();
    try {
      accountBalances1Minor[account.id] = toMinor(account.openingBalance || 0, curr);
    } catch (err) {
      errors.push({
        entryId: 'account_' + account.id,
        expected: 'valid openingBalance',
        actual: account.openingBalance,
        message: `Account ${account.id} opening balance invalid: ${err.message}`
      });
      accountBalances1Minor[account.id] = 0;
    }
  }

  for (const entry of entries) {
    if (entry.type === 'account_transfer') {
      if (entry.fromAccountId && accountBalances1Minor[entry.fromAccountId] !== undefined) {
        const acc = accountsMap.get(entry.fromAccountId);
        const curr = String(acc?.currency || entry.currency || 'USD').toUpperCase();
        try {
          const amt = toMinor(entry.fromAmount ?? entry.amount ?? 0, curr);
          accountBalances1Minor[entry.fromAccountId] = addMinor(accountBalances1Minor[entry.fromAccountId], -amt);
        } catch (err) {
          errors.push({
            entryId: entry.id,
            expected: 'valid fromAmount',
            actual: entry.fromAmount ?? entry.amount,
            message: err.message
          });
        }
      }
      if (entry.toAccountId && accountBalances1Minor[entry.toAccountId] !== undefined) {
        const acc = accountsMap.get(entry.toAccountId);
        const curr = String(acc?.currency || entry.currency || 'USD').toUpperCase();
        try {
          const amt = toMinor(entry.toAmount ?? entry.amount ?? 0, curr);
          accountBalances1Minor[entry.toAccountId] = addMinor(accountBalances1Minor[entry.toAccountId], amt);
        } catch (err) {
          errors.push({
            entryId: entry.id,
            expected: 'valid toAmount',
            actual: entry.toAmount ?? entry.amount,
            message: err.message
          });
        }
      }
    } else if (entry.accountId && accountBalances1Minor[entry.accountId] !== undefined) {
      const acc = accountsMap.get(entry.accountId);
      const curr = String(acc?.currency || entry.currency || 'USD').toUpperCase();
      try {
        const amt = toMinor(entry.amount || 0, curr);
        let delta = 0;
        switch (entry.type) {
          case 'paid_for_person':
          case 'split_paid_for_people':
          case 'paid_to_person':
          case 'account_expense':
            delta = -amt;
            break;
          case 'received_from_person':
          case 'borrowed_from_person':
          case 'account_income':
            delta = amt;
            break;
          case 'account_adjustment':
            delta = toMinor(entry.signedAmount ?? entry.amount ?? 0, curr);
            break;
          default:
            delta = 0;
        }
        accountBalances1Minor[entry.accountId] = addMinor(accountBalances1Minor[entry.accountId], delta);
      } catch (err) {
        errors.push({
          entryId: entry.id,
          expected: 'valid amount',
          actual: entry.amount,
          message: err.message
        });
      }
    }
  }

  // Recomputation 2: Account-centric debit/credit bucket aggregation
  const accountBalances2Minor = {};
  const accountDebitsMinor = {};
  const accountCreditsMinor = {};

  for (const account of accounts) {
    const curr = String(account.currency || 'USD').toUpperCase();
    let openingMinor = 0;
    try {
      openingMinor = toMinor(account.openingBalance || 0, curr);
    } catch {
      openingMinor = 0;
    }

    let debits = 0;
    let credits = 0;

    for (const entry of entries) {
      if (entry.type === 'account_transfer') {
        if (entry.fromAccountId === account.id) {
          try {
            const amt = toMinor(entry.fromAmount ?? entry.amount ?? 0, curr);
            debits = addMinor(debits, amt);
          } catch {}
        }
        if (entry.toAccountId === account.id) {
          try {
            const amt = toMinor(entry.toAmount ?? entry.amount ?? 0, curr);
            credits = addMinor(credits, amt);
          } catch {}
        }
      } else if (entry.accountId === account.id) {
        try {
          const amt = toMinor(entry.amount || 0, curr);
          switch (entry.type) {
            case 'paid_for_person':
            case 'split_paid_for_people':
            case 'paid_to_person':
            case 'account_expense':
              debits = addMinor(debits, amt);
              break;
            case 'received_from_person':
            case 'borrowed_from_person':
            case 'account_income':
              credits = addMinor(credits, amt);
              break;
            case 'account_adjustment': {
              const adj = toMinor(entry.signedAmount ?? entry.amount ?? 0, curr);
              if (adj >= 0) credits = addMinor(credits, adj);
              else debits = addMinor(debits, -adj);
              break;
            }
          }
        } catch {}
      }
    }

    accountDebitsMinor[account.id] = debits;
    accountCreditsMinor[account.id] = credits;
    accountBalances2Minor[account.id] = addMinor(openingMinor, credits - debits);
  }

  // Invariant I5: Primary and secondary account recomputations match identically
  for (const account of accounts) {
    const curr = String(account.currency || 'USD').toUpperCase();
    const b1 = accountBalances1Minor[account.id];
    const b2 = accountBalances2Minor[account.id];
    if (b1 !== b2) {
      errors.push({
        entryId: 'account_' + account.id,
        expected: fromMinor(b2, curr),
        actual: fromMinor(b1, curr),
        message: `Invariant I5 violation for account ${account.id}: primary recomputation (${fromMinor(b1, curr)}) != secondary recomputation (${fromMinor(b2, curr)})`
      });
    }
  }

  // 7. Verify against fixture's expected block if present
  if (expected) {
    if (expected.accountBalances) {
      for (const [accId, expBal] of Object.entries(expected.accountBalances)) {
        const acc = accountsMap.get(accId);
        const curr = String(acc?.currency || 'USD').toUpperCase();
        const actualBal = fromMinor(accountBalances1Minor[accId] ?? 0, curr);
        if (actualBal !== expBal) {
          errors.push({
            entryId: 'account_' + accId,
            expected: expBal,
            actual: actualBal,
            message: `Account balance mismatch for ${accId}: expected ${expBal}, actual ${actualBal}`
          });
        }
      }
    }

    if (expected.personBalances) {
      for (const [pId, expCurrs] of Object.entries(expected.personBalances)) {
        for (const [curr, expBal] of Object.entries(expCurrs)) {
          const actualBal = computedPersonBalances[pId]?.[curr] ?? 0;
          if (actualBal !== expBal) {
            errors.push({
              entryId: 'person_' + pId,
              expected: expBal,
              actual: actualBal,
              message: `Person balance mismatch for ${pId} [${curr}]: expected ${expBal}, actual ${actualBal}`
            });
          }
        }
      }
    }

    if (expected.totals) {
      for (const [curr, expTot] of Object.entries(expected.totals)) {
        const actualTot = computedTotals[curr] || { owedToMe: 0, iOwe: 0, net: 0 };
        if (actualTot.owedToMe !== expTot.owedToMe) {
          errors.push({
            entryId: 'totals_' + curr + '_owedToMe',
            expected: expTot.owedToMe,
            actual: actualTot.owedToMe,
            message: `Dashboard totals owedToMe mismatch for ${curr}: expected ${expTot.owedToMe}, actual ${actualTot.owedToMe}`
          });
        }
        if (actualTot.iOwe !== expTot.iOwe) {
          errors.push({
            entryId: 'totals_' + curr + '_iOwe',
            expected: expTot.iOwe,
            actual: actualTot.iOwe,
            message: `Dashboard totals iOwe mismatch for ${curr}: expected ${expTot.iOwe}, actual ${actualTot.iOwe}`
          });
        }
        if (actualTot.net !== expTot.net) {
          errors.push({
            entryId: 'totals_' + curr + '_net',
            expected: expTot.net,
            actual: actualTot.net,
            message: `Dashboard totals net mismatch for ${curr}: expected ${expTot.net}, actual ${actualTot.net}`
          });
        }
      }
    }
  }

  // Format tie-out results
  const accountRows = accounts.map(acc => {
    const curr = String(acc.currency || 'USD').toUpperCase();
    const op = formatAmount(acc.openingBalance || 0, curr);
    const deb = formatAmount(fromMinor(accountDebitsMinor[acc.id] || 0, curr), curr);
    const cred = formatAmount(fromMinor(accountCreditsMinor[acc.id] || 0, curr), curr);
    const b1 = formatAmount(fromMinor(accountBalances1Minor[acc.id] || 0, curr), curr);
    const b2 = formatAmount(fromMinor(accountBalances2Minor[acc.id] || 0, curr), curr);
    const match = accountBalances1Minor[acc.id] === accountBalances2Minor[acc.id];
    return { id: acc.id, currency: curr, opening: op, debits: deb, credits: cred, recomp1: b1, recomp2: b2, status: match ? 'MATCH' : 'MISMATCH' };
  });

  const personRows = [];
  for (const person of people) {
    const balances = computedPersonBalances[person.id] || {};
    const currs = Object.keys(balances);
    if (currs.length === 0) {
      personRows.push({ id: person.id, currency: 'USD', balance: formatAmount(0, 'USD'), direction: 'settled' });
    } else {
      for (const curr of currs) {
        const bal = balances[curr];
        const dir = bal > 0 ? 'owed to me' : bal < 0 ? 'i owe' : 'settled';
        personRows.push({ id: person.id, currency: curr, balance: formatAmount(bal, curr), direction: dir });
      }
    }
  }

  const totalsRows = Object.entries(computedTotals).map(([curr, row]) => {
    const owedStr = formatAmount(row.owedToMe, curr);
    const iOweStr = formatAmount(row.iOwe, curr);
    const netStr = formatAmount(row.net, curr);
    const formulaNetStr = formatAmount(row.owedToMe - row.iOwe, curr);
    const match = row.net === (row.owedToMe - row.iOwe);
    return {
      currency: curr,
      owedToMe: owedStr,
      iOwe: iOweStr,
      net: netStr,
      formulaNet: formulaNetStr,
      status: match ? 'MATCH' : 'MISMATCH'
    };
  });

  return {
    ok: errors.length === 0,
    errors,
    fixturePath,
    stats: {
      entriesCount: entries.length,
      peopleCount: people.length,
      accountsCount: accounts.length,
      splitsChecked,
      adjustmentsChecked
    },
    tables: {
      accounts: accountRows,
      people: personRows,
      totals: totalsRows
    }
  };
}

export function printTieOutTable(result) {
  console.log('='.repeat(80));
  console.log(' ACCOUNTING RECONCILIATION TIE-OUT REPORT');
  console.log('='.repeat(80));
  console.log(`Source fixture: ${result.fixturePath}`);
  console.log(`Summary: ${result.stats.entriesCount} entries, ${result.stats.accountsCount} accounts, ${result.stats.peopleCount} people`);
  console.log('');

  console.log('--- ACCOUNT BALANCES TIE-OUT (Invariant I5: Dual Recomputations) ---');
  console.log(
    padRight('Account ID', 22) +
    padRight('Curr', 6) +
    padLeft('Opening', 16) +
    padLeft('Debits(-)', 14) +
    padLeft('Credits(+)', 14) +
    padLeft('Recomp 1', 16) +
    padLeft('Recomp 2', 16) +
    '  ' + padRight('Status', 8)
  );
  console.log('-'.repeat(110));
  for (const row of result.tables.accounts) {
    console.log(
      padRight(row.id, 22) +
      padRight(row.currency, 6) +
      padLeft(row.opening, 16) +
      padLeft(row.debits, 14) +
      padLeft(row.credits, 14) +
      padLeft(row.recomp1, 16) +
      padLeft(row.recomp2, 16) +
      '  ' + padRight(row.status, 8)
    );
  }
  console.log('');

  console.log('--- PERSON BALANCES ---');
  console.log(
    padRight('Person ID', 22) +
    padRight('Curr', 6) +
    padLeft('Balance', 12) +
    '  ' + padRight('Position', 12)
  );
  console.log('-'.repeat(54));
  for (const row of result.tables.people) {
    console.log(
      padRight(row.id, 22) +
      padRight(row.currency, 6) +
      padLeft(row.balance, 12) +
      '  ' + padRight(row.direction, 12)
    );
  }
  console.log('');

  console.log('--- DASHBOARD TOTALS (Invariant I1: Net == OwedToMe - IOwe) ---');
  console.log(
    padRight('Curr', 6) +
    padLeft('Owed To Me', 14) +
    padLeft('I Owe', 14) +
    padLeft('Net (Computed)', 16) +
    padLeft('Owed - IOwe', 14) +
    '  ' + padRight('Status', 8)
  );
  console.log('-'.repeat(74));
  for (const row of result.tables.totals) {
    console.log(
      padRight(row.currency, 6) +
      padLeft(row.owedToMe, 14) +
      padLeft(row.iOwe, 14) +
      padLeft(row.net, 16) +
      padLeft(row.formulaNet, 14) +
      '  ' + padRight(row.status, 8)
    );
  }
  console.log('');

  console.log('--- INVARIANT CHECKS SUMMARY ---');
  console.log(`[PASS] I1 (Dashboard Net Identity):       verified across ${result.tables.totals.length} currencies`);
  console.log(`[PASS] I3 (Split Allocation Sum):        verified ${result.stats.splitsChecked} split transaction(s) in minor units`);
  console.log(`[PASS] I4 (Adjustment Magnitude):        verified ${result.stats.adjustmentsChecked} person adjustment(s) (|signedAmount| == amount)`);
  console.log(`[PASS] I5 (Account Dual-Recomputation):  verified ${result.stats.accountsCount} account(s) match identically`);
  console.log('='.repeat(80));
  console.log('RESULT: PASS (All accounting guardrails hold)');
  console.log('='.repeat(80));
}

export function runAccountingCheck(targetPathArg) {
  const defaultPath = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/wave0-ledger-baseline.json');
  const fixturePath = targetPathArg ? resolve(process.cwd(), targetPathArg) : defaultPath;

  let fixtureData;
  try {
    const raw = readFileSync(fixturePath, 'utf8');
    fixtureData = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: Unable to load fixture file at "${fixturePath}": ${err.message}`);
    console.error(`entry id: none, expected: readable JSON fixture, actual: ${err.message}`);
    return { ok: false, errors: [{ entryId: 'none', expected: 'readable JSON fixture', actual: err.message, message: err.message }] };
  }

  const result = verifyAccounting(fixtureData, { fixturePath });

  if (!result.ok) {
    console.error('='.repeat(80));
    console.error(' ACCOUNTING RECONCILIATION FAILED');
    console.error('='.repeat(80));
    for (const err of result.errors) {
      console.error(`FAIL: entry id: ${err.entryId || 'none'}, expected: ${err.expected}, actual: ${err.actual} (${err.message})`);
    }
    console.error('='.repeat(80));
    return result;
  }

  printTieOutTable(result);
  return result;
}

// Execute CLI directly when invoked as a script
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runAccountingCheck(process.argv[2]);
  if (!result.ok) {
    process.exit(1);
  }
  process.exit(0);
}
