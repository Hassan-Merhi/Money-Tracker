# Accounting Audit & Invariants

## 1. Normative Accounting Contract (Invariants I1–I10)

This section constitutes the authoritative normative contract for the Money Tracker ledger engine. Any state, transaction mutation, import, snapshot, or migration that violates any of these invariants is mathematically invalid and must be rejected.

### Invariant I1: Dashboard Net Identity
For every currency $c$:
$$\text{net}_c = \text{owedToMe}_c - \text{iOwe}_c$$

The aggregate net position displayed on the dashboard for currency $c$ must strictly equal the difference between what counterparties owe the user (`owedToMe`) and what the user owes counterparties (`iOwe`). No unallocated remainder, truncation error, or rounding drift is permitted.

### Invariant I2: Person Balance Sign Partitioning
For every person $p$ and currency $c$, their net ledger balance $B(p, c)$ partitions strictly into aggregate dashboard categories:
$$\text{owedToMe}_c = \sum_{p} \max(0, B(p, c))$$
$$\text{iOwe}_c = \sum_{p} \max(0, -B(p, c))$$
$$\text{net}_c = \sum_{p} B(p, c)$$

- A positive balance ($B(p, c) > 0$) means person $p$ owes the user money.
- A negative balance ($B(p, c) < 0$) means the user owes person $p$ money.
- A zero balance ($B(p, c) = 0$) represents a fully settled position and contributes to neither side.

### Invariant I3: Split Allocation Conservation
For every transaction of type `split_paid_for_people` with total amount $A$ and split allocations $s_1, s_2, \dots, s_k$ in currency $c$:
$$\sum_{i=1}^{k} \text{toMinor}(s_i.\text{amount}, c) = \text{toMinor}(A, c)$$

Every split transaction must conserve total funds exactly in integer minor units. The sum of all individual split shares must equal the parent transaction amount with zero difference.

### Invariant I4: Person Adjustment Magnitude Consistency
For every entry of type `person_adjustment` with magnitude `amount` and directional `signedAmount` in currency $c$:
$$|\text{toMinor}(e.\text{signedAmount}, c)| = \text{toMinor}(e.\text{amount}, c)$$

The unsigned `amount` field must equal the absolute value of `signedAmount`. The sign of `signedAmount` determines the direction of the balance adjustment (+ increases what they owe me; - decreases what they owe me or increases what I owe them).

### Invariant I5: Account Balance Dual-Recomputation & Conservation
For every account $a$ with opening balance $O_a$ and currency $c$:
The final account balance computed sequentially via chronological transaction replay:
$$\text{Balance}_1(a) = \text{toMinor}(O_a, c) + \sum_{e \in E} \Delta_{\text{account}}(e, a)$$

must identically equal the balance computed via independent debit/credit bucket aggregation:
$$\text{Balance}_2(a) = \text{toMinor}(O_a, c) + \sum \text{Credits}(a) - \sum \text{Debits}(a)$$

Both methods must yield the exact same integer minor-unit balance:
$$\text{Balance}_1(a) \equiv \text{Balance}_2(a)$$

### Invariant I6: Dual-Leg Transfer Conservation
For every transaction of type `account_transfer` $e$:
- Outflow from source account: $\Delta(e, e.\text{fromAccountId}) = -\text{toMinor}(e.\text{fromAmount} \lor e.\text{amount}, c_{\text{from}})$
- Inflow to destination account: $\Delta(e, e.\text{toAccountId}) = +\text{toMinor}(e.\text{toAmount} \lor e.\text{amount}, c_{\text{to}})$
- For intra-currency transfers ($c_{\text{from}} = c_{\text{to}}$), source and destination amounts must match: $e.\text{fromAmount} = e.\text{toAmount}$.
- Cross-account transfers do not alter any person debt balance ($\forall p, \Delta_{\text{person}}(e, p) = 0$).

### Invariant I7: Personal Cash-Flow Isolation
Transactions of type `account_expense` and `account_income` represent direct personal expenditure and earnings:
- They debit or credit account balances and assign category metadata.
- They have zero effect on counterparty debt balances ($\forall p, \Delta_{\text{person}}(e, p) = 0$).

Personal lifestyle spending never distorts counterparty debt claims.

### Invariant I8: Bank-Free / Debt-Only Feasibility
Transactions of person types (`paid_for_person`, `received_from_person`, `borrowed_from_person`, `paid_to_person`, `person_adjustment`) where `accountId == null`:
- Accurately modify counterparty balances according to their contractual direction.
- Produce zero movements on financial account balances ($\forall a, \Delta_{\text{account}}(e, a) = 0$).

Debt tracking remains fully functional without requiring a bank or cash account.

### Invariant I9: Integer Minor-Unit Exactness
All monetary storage, summation, and comparison are conducted in integer minor units according to the currency exponent defined in `lib/money.js`:
- Zero decimals: JPY, KRW, VND, etc. (exponent 0)
- Three decimals: BHD, IQD, JOD, KWD, LYD, OMR, TND (exponent 3)
- Four decimals: CLF, UYW (exponent 4)
- Default: 2 decimals (USD, EUR, GBP, LBP, etc.)

No IEEE 754 binary floating-point representation is permitted for authoritative balance accumulation or equality comparisons.

### Invariant I10: Strict Currency Isolation
All ledger states, counterparty balances, account balances, running statements, and dashboard totals are maintained strictly per-currency:
- Balances in different currencies are never implicitly converted, summed, or netted together.
- Currency conversion occurs exclusively through explicit dual-leg transfers with distinct source and destination currencies and amounts.

## 2. Reconciliation Engine & Verification

The accounting guardrails are verified by `scripts/accounting-check.mjs`.

- **Input**: Raw ledger fixtures (`tests/fixtures/wave0-ledger-baseline.json` or custom path).
- **Execution**: `npm run accounting:check` or `node scripts/accounting-check.mjs <fixture-path>`.
- **Exit contract**:
  - Exits `0` on pass after outputting a formatted tie-out table covering Account Balances (dual recomputations), Person Balances, and Dashboard Totals.
  - Exits `1` on failure, printing the offending entry ID (or entity ID) along with expected and actual values.
- **CI Gate**: Enforced on every pull request and push to main branches in `.github/workflows/ci.yml`.
