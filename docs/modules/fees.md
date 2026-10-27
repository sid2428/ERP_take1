# Fees and D-Wallet (T6)

## Data and rules

Migration 091 adds `fee_record`, `fee_payment`, `wallet`, `wallet_txn`, `fee_receipt_seq` and
`v_fee_receipt`. Amounts are stored in paise. `fee_record` generated columns calculate totals,
paid amount, outstanding balance and status; constraints prevent negative/overpaid balances.
`fee_payment` records each gateway attempt and ties fee payments to the same student's fee record.
The wallet is a balance plus an append-only ledger; a partial unique index prevents duplicate
ledger credits per payment.

`apply_fee_payment(order_id, gateway_payment_id)` locks the payment, is idempotent on retry,
assigns a receipt, applies the fee amount and credits excess to the wallet. It must only be called
after the payment signature or webhook is verified by application code. `wallet_credit` updates
the balance and ledger together. `v_fee_receipt` contains successful payments only. The student fee
API derives student identity from the authenticated session. Migration 095 emits one event-keyed
notification for a persisted successful payment.

```sql
SELECT receipt_no, student_number, amount_paise, paid_at
FROM erp.v_fee_receipt ORDER BY paid_at DESC LIMIT 10;
SELECT student_id, balance_paise FROM erp.wallet LIMIT 10;
```

## Demonstration

1. As a student, open `/student/fee` and inspect the current fee statement and wallet balance.
2. In a configured local gateway environment, create a payment, complete the verified callback and
   confirm a receipt and ledger row appear once.
3. Replay the same verified payment event and confirm it does not double-apply.
4. Use the test fixtures for signature, amount, ownership and retry failures; never use a live
   gateway payment as a demo fixture.

Tests: `tests/db/finance-payments.test.ts`, `tests/unit/finance-routes.test.ts` and the finance
application tests where present. Payment credentials are configured outside this document.
