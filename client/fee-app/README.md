# PICT Student Portal: Fees & D-Wallet (frontend)

React + TypeScript + Tailwind (Vite). Matches the PICT Student Portal mockup and pays through
**Razorpay Checkout (Test Mode)**. The frontend never marks anything paid by itself: it only
reflects what your backend has verified.

## Run
```bash
npm install
cp .env.example .env        # set VITE_USE_SAMPLE_DATA=true to view the UI without a backend
npm run dev                 # http://localhost:5173  (proxies /api to http://localhost:5000)
npm run build
```

## Structure
- `src/components/layout/`: ERPLayout, Sidebar, TopHeader (shared shell for every page)
- `src/pages/`: Dashboard, FeesPage (the payment flow lives here)
- `src/components/fees/`: FeeSummaryCards, FeeStatement, DWallet, PaymentHistory, AddMoneyModal, PaymentSuccess, FeeReceipt
- `src/lib/api.ts`: every backend call; `src/lib/razorpay.ts`: opens Razorpay and interprets the outcome

## Payment flow
1. Student clicks **Pay Fee** (or **Add Money**).
2. Frontend calls `POST /payments/fee/order` (or `/wallet/topup/order`). Backend creates a Razorpay order.
3. Razorpay's own Checkout popup opens (test keys = test mode).
4. On success the frontend sends the 3 Razorpay values to `POST /payments/verify`.
5. Backend verifies the signature, THEN marks the fee paid / credits the wallet, and returns the receipt data.
6. Frontend re-fetches statement, wallet and history, then shows the success screen.

Outcomes: success -> success screen. Failed -> error notice, balances unchanged, retry allowed.
Closed popup -> "cancelled", unchanged. Verify call unreachable -> "processing" (do not pay again; webhook settles it).

## Backend API this frontend expects (cookie session, JSON, amounts in rupees unless noted)
| Method & path | Returns |
|---|---|
| `GET /student/me` | `Student` (name, initials, studentNo, admissionNo, department, program, category, email?, phone?) |
| `GET /fees/statement` | `{ academicYear, components:[{id,name,amount}], amountPaid, status:'PENDING'\|'PROCESSING'\|'PAID' }` (`amountPaid` = verified payments only) |
| `GET /fees/payments` | `Payment[]` fee attempts incl. FAILED / CANCELLED, newest first |
| `GET /wallet` | `{ balance, transactions:[{id,date,description,type:'CREDIT'\|'DEBIT',amount,status}] }` (the wallet column in your DB) |
| `POST /payments/fee/order` | `{ orderId, amount (PAISE), currency:'INR', keyId }` amount comes from YOUR fee table, not the client |
| `POST /wallet/topup/order` body `{amount}` | same shape; validate min/max server-side |
| `POST /payments/verify` body `{razorpay_order_id, razorpay_payment_id, razorpay_signature}` | `{ purpose:'FEE'\|'WALLET_TOPUP', paymentId, referenceId, receiptNo, amount, method, paidAt, isTest }` or HTTP 4xx if the signature is invalid |
| `POST /payments/outcome` body `{orderId,status:'FAILED'\|'CANCELLED',reason?}` | records the attempt (never counts as paid) |
| `GET /fees/receipt/:paymentId/pdf` | the receipt PDF (generate it server-side) |

Backend must: keep the Razorpay **key secret** server-side only; verify
`HMAC_SHA256(order_id + "|" + payment_id, key_secret)` equals the signature; make verify idempotent
(a retry must not credit twice); update payment + fee/wallet in one DB transaction; and add a Razorpay
webhook (`payment.captured`) to settle payments when the browser closes early.

Test Mode: use Razorpay's test cards / test UPI IDs from their "Test Card and UPI details" docs page.
