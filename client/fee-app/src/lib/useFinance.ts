import { useCallback, useEffect, useState } from 'react';
import { getPayments, getStatement, getWallet } from './api';
import type { FeeStatement, Payment, Wallet } from '../types';

/** Loads fee statement, wallet and payment history. Call refresh() after any payment outcome. */
export function useFinance() {
  const [statement, setStatement] = useState<FeeStatement | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, w, p] = await Promise.all([getStatement(), getWallet(), getPayments()]);
      setStatement(s); setWallet(w); setPayments(p); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load fee data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { statement, wallet, payments, loading, error, refresh };
}
