export interface Student {
  name: string;
  initials: string;
  studentNo: string;
  admissionNo: string;
  department: string;
  program: string;
  category: string;
  email?: string;
  phone?: string;
}

export interface FeeComponent { id: string; name: string; amount: number }

/** PENDING = unpaid, PROCESSING = paid at gateway but not yet confirmed by server, PAID = verified. */
export type FeeStatus = 'PENDING' | 'PROCESSING' | 'PAID';

export interface FeeStatement {
  academicYear: string;
  components: FeeComponent[];
  amountPaid: number; // sum of VERIFIED payments, computed by the server
  status: FeeStatus;
  hasRecord: boolean;
}

export type PaymentStatus = 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'PENDING';

export interface Payment {
  id: string;
  date: string; // ISO
  academicYear: string;
  description: string;
  referenceId: string; // Razorpay payment id (or order id for failed attempts)
  method: string;
  amount: number;
  status: PaymentStatus;
  receiptNo?: string;
  isTest?: boolean;
}

export interface WalletTx {
  id: string;
  date: string; // ISO
  description: string;
  type: 'CREDIT' | 'DEBIT';
  amount: number;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
}

export interface Wallet { balance: number; transactions: WalletTx[] }

/** Returned by your backend when it creates a Razorpay order. */
export interface OrderResponse {
  orderId: string;
  amount: number; // in paise
  currency: string;
  keyId: string; // public Razorpay key id (rzp_test_...), never the secret
}

export interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/** Returned by the backend AFTER it has verified the signature. */
export interface VerifyResult {
  purpose: 'FEE' | 'WALLET_TOPUP';
  paymentId: string;
  referenceId: string;
  receiptNo: string;
  amount: number;
  method: string;
  paidAt: string; // ISO
  isTest: boolean;
}
