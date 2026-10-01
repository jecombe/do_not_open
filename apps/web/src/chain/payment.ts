import { useSyncExternalStore } from "react";
import type { Payment } from "@dno/chain-adapter";

/** How the user last chose to pay, kept across visits. cUSDC until they pick otherwise: it is
 *  the only way the collection takes, and plain USDC is shielded into it first, publicly. */
const KEY = "dno.payment";
const listeners = new Set<() => void>();

function read(): Payment {
  try {
    return localStorage.getItem(KEY) === "usdc" ? "usdc" : "cusdc";
  } catch {
    return "cusdc";
  }
}

let current: Payment = read();

export function setPayment(next: Payment): void {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode: the choice lasts for this visit.
  }
  for (const l of listeners) l();
}

export function usePayment(): Payment {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
