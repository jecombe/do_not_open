import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createAdapter, type ActionOptions, type Address, type ChainAdapter, type ChainMode, type CollectionInfo, type Step, type WalletOption } from "@dno/chain-adapter";
import { errorCopy } from "./copy";

interface ChainState {
  adapter: ChainAdapter;
  mode: ChainMode;
  account: Address | null;
  collection: CollectionInfo | null;
  /** Token ids held by the connected account, once found (see `boxesKnown`). */
  myBoxes: number[];
  /** Who holds a box is encrypted: the account's boxes are found by decrypting its own
   *  receipts, which takes one signature. Until then, no box is known to be the account's. */
  boxesKnown: boolean;
  /** Asks for that signature and finds the account's boxes. */
  findMyBoxes(): Promise<void>;
  findError: string | null;
  /** Set when the chain could not be read at all. */
  offline: string | null;
  /** The mode the build asked for when it is not available yet (e.g. "solana-mainnet"). The app then runs in mock mode. */
  unavailable: string | null;
  /** Re-reads the collection and the account's boxes. */
  refresh(): Promise<void>;
  /** Without `walletId`, opens the wallet picker when the browser offers more than one. */
  connect(walletId?: string): Promise<void>;
  disconnect(): Promise<void>;
  connectError: string | null;
  /** Set while the wallet picker is open: the wallets to choose from. */
  picking: WalletOption[] | null;
  closePicker(): void;
}

const ChainContext = createContext<ChainState | null>(null);

/** Modes announced in `.env.example` that no adapter implements yet. */
const PLANNED_MODES = ["mainnet", "solana-devnet", "solana-mainnet"];

/** Hosts that run the mock whatever the build says: one deployment can serve a demo domain next to the live one. */
const MOCK_HOSTS = (import.meta.env.VITE_MOCK_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

/** `?chain=mock` or `?chain=sepolia` in the URL wins over the host, which wins over the build-time setting. */
function chainMode(): { mode: ChainMode; unavailable: string | null } {
  const byHost = MOCK_HOSTS.includes(window.location.hostname) ? "mock" : undefined;
  const wanted = new URLSearchParams(window.location.search).get("chain") ?? byHost ?? import.meta.env.VITE_CHAIN_MODE ?? "mock";
  if (wanted === "sepolia") return { mode: "sepolia", unavailable: null };
  if (PLANNED_MODES.includes(wanted)) return { mode: "mock", unavailable: wanted };
  if (wanted !== "mock") console.warn(`[chain] unknown VITE_CHAIN_MODE "${wanted}", running the mock`);
  return { mode: "mock", unavailable: null };
}

export function ChainProvider({ children }: { children: ReactNode }) {
  const { mode, unavailable } = useMemo(chainMode, []);
  const [adapter, setAdapter] = useState<ChainAdapter | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const [myBoxes, setMyBoxes] = useState<number[]>([]);
  const [offline, setOffline] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [boxesKnown, setBoxesKnown] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let unsubscribe = () => {};
    void createAdapter({
      mode,
      rpcUrl: import.meta.env.VITE_SEPOLIA_RPC_URL,
      address: import.meta.env.VITE_DNO_ADDRESS,
    }).then((a) => {
      if (!live) return;
      unsubscribe = a.onAccountChange(setAccount);
      setAccount(a.account());
      setAdapter(a);
      // The mock has no wallet to ask: sign in straight away.
      if (a.kind === "mock") void a.connect();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [mode]);

  // A new account starts unknown again; the mock has nothing to sign.
  useEffect(() => {
    setBoxesKnown(adapter?.kind === "mock" && !!account);
    setMyBoxes([]);
    setFindError(null);
  }, [adapter, account]);

  const refresh = useCallback(async () => {
    if (!adapter) return;
    try {
      const [info, boxes] = await Promise.all([adapter.collection(), account && boxesKnown ? adapter.boxesOf(account) : []]);
      setCollection(info);
      setMyBoxes(boxes);
      setOffline(null);
    } catch (error) {
      setOffline(errorCopy(error));
    }
  }, [adapter, account, boxesKnown]);

  useEffect(() => void refresh(), [refresh]);

  const findMyBoxes = useCallback(async () => {
    if (!adapter || !account) return;
    setFindError(null);
    try {
      setMyBoxes(await adapter.boxesOf(account));
      setBoxesKnown(true);
    } catch (error) {
      setFindError(errorCopy(error));
    }
  }, [adapter, account]);

  const [picking, setPicking] = useState<WalletOption[] | null>(null);
  const closePicker = useCallback(() => setPicking(null), []);

  const connect = useCallback(
    async (walletId?: string) => {
      if (!adapter) return;
      setConnectError(null);
      const wallets = adapter.wallets();
      if (walletId === undefined && wallets.length > 1) {
        setPicking(wallets);
        return;
      }
      setPicking(null);
      try {
        await adapter.connect(walletId);
      } catch (error) {
        setConnectError(errorCopy(error));
      }
    },
    [adapter],
  );
  const disconnect = useCallback(async () => adapter?.disconnect(), [adapter]);

  if (!adapter) return <p className="boot">Unlocking the depot…</p>;
  return (
    <ChainContext.Provider
      value={{ adapter, mode, account, collection, myBoxes, boxesKnown, findMyBoxes, findError, offline, unavailable, refresh, connect, disconnect, connectError, picking, closePicker }}
    >
      {children}
    </ChainContext.Provider>
  );
}

export function useChain(): ChainState {
  const state = useContext(ChainContext);
  if (!state) throw new Error("useChain outside ChainProvider");
  return state;
}

interface ActionState {
  /** Name of the action in flight, e.g. "shake". */
  busy: string | null;
  step: Step | null;
  error: string | null;
}

const IDLE: ActionState = { busy: null, step: null, error: null };

/**
 * Runs one chain action at a time and tracks where it is. `run` resolves to the action's
 * result, or to undefined if it failed; the reason is then in `error`, already worded.
 */
export function useAction() {
  const [state, setState] = useState<ActionState>(IDLE);

  const run = useCallback(async <T,>(name: string, action: (opts: ActionOptions) => Promise<T>): Promise<T | undefined> => {
    setState({ busy: name, step: null, error: null });
    try {
      const result = await action({ onStep: (step) => setState((s) => ({ ...s, step })) });
      setState(IDLE);
      return result;
    } catch (error) {
      console.error(`[chain] ${name} failed`, error);
      setState({ busy: null, step: null, error: errorCopy(error) });
      return undefined;
    }
  }, []);

  const reset = useCallback(() => setState(IDLE), []);
  return { ...state, run, reset };
}
