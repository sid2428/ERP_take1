// Only used when VITE_USE_SAMPLE_DATA=true, so the UI can be viewed without a backend.
import type { FeeStatement, Payment, Student, Wallet } from '../types';

export const sampleStudent: Student = {
  name: 'Pratik Arun Jadhav', initials: 'PJ', studentNo: 'STU202600142', admissionNo: 'ADM202400142',
  department: 'Information Technology', program: 'B.Tech (IT)', category: 'Regular admission',
};

export const sampleStatement: FeeStatement = {
  academicYear: '2026–27', amountPaid: 0, status: 'PENDING',
  components: [
    { id: 'dev', name: 'Development Fee', amount: 25000 },
    { id: 'tut', name: 'Tuition Fee', amount: 45000 },
    { id: 'exam', name: 'Examination Fee', amount: 5000 },
    { id: 'other', name: 'Other Fees', amount: 10000 },
  ],
};

export const samplePayments: Payment[] = [];

export const sampleWallet: Wallet = {
  balance: 2500,
  transactions: [
    { id: 'w1', date: '2026-10-12T10:00:00+05:30', description: 'Library fine refund', type: 'CREDIT', amount: 150, status: 'COMPLETED' },
    { id: 'w2', date: '2026-10-10T13:10:00+05:30', description: 'Canteen purchase', type: 'DEBIT', amount: 120, status: 'COMPLETED' },
    { id: 'w3', date: '2026-10-03T09:30:00+05:30', description: 'Top-up via UPI', type: 'CREDIT', amount: 1000, status: 'COMPLETED' },
    { id: 'w4', date: '2026-09-28T16:00:00+05:30', description: 'Stationery store', type: 'DEBIT', amount: 80, status: 'COMPLETED' },
    { id: 'w5', date: '2026-09-15T11:00:00+05:30', description: 'Top-up via UPI', type: 'CREDIT', amount: 500, status: 'COMPLETED' },
    { id: 'w6', date: '2026-09-09T12:20:00+05:30', description: 'Photocopy', type: 'DEBIT', amount: 20, status: 'PENDING' },
  ],
};
