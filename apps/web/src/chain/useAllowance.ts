import { useEffect, useState } from "react";
import type { DecryptionAllowance } from "@dno/chain-adapter";
import { useChain, useLedger } from "./ChainProvider";
import { useLive } from "./useLive";

/**
 * The connected wallet's decryptions left, kept live: read again after every action, every block
 * or so, on coming back to the tab (the free ones come back at midnight UTC), and as soon as a
 * decryption or an encrypted input has gone through the relayer. Null where nobody counts them.
 */
export function useAllowance(): DecryptionAllowance | null {
  const { adapter, account } = useChain();
  const ledger = useLedger();
  const [allowance, setAllowance] = useState<DecryptionAllowance | null>(null);
  const [spent, setSpent] = useState(0);

  useEffect(() => adapter.onAllowanceSpent(() => setSpent((n) => n + 1)), [adapter]);

  useLive(
    (live) =>
      void adapter.decryptionAllowance().then(
        (a) => live() && setAllowance(a),
        () => undefined,
      ),
    [adapter, account, ledger, spent],
    !!account,
  );

  // A new account starts blank rather than showing the last one's count.
  useEffect(() => setAllowance(null), [account]);
  return account ? allowance : null;
}
