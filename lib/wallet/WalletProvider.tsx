"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ensureWalletKitInitialized,
  StellarWalletsKit,
  storeSelectedWalletId,
  clearSelectedWalletId,
  getStoredWalletId,
} from "./kit";
import { broadcastWalletEvent, subscribeWalletSync, type WalletSyncMessage } from "./sync";

interface WalletContextValue {
  address: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue>({
  address: null,
  connecting: false,
  error: null,
  connect: async () => {},
  disconnect: async () => {},
});

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExternalSyncRef = useRef(false);

  // Restore existing connection on mount
  useEffect(() => {
    ensureWalletKitInitialized();
    if (!getStoredWalletId()) return;

    let cancelled = false;
    StellarWalletsKit.getAddress()
      .then(({ address: restoredAddress }) => {
        if (!cancelled) setAddress(restoredAddress);
      })
      .catch(() => {
        clearSelectedWalletId();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for cross-tab synchronization events
  useEffect(() => {
    const unsubscribe = subscribeWalletSync((msg: WalletSyncMessage) => {
      isExternalSyncRef.current = true;
      try {
        if (msg.type === "CONNECTED") {
          setAddress(msg.address);
          if (msg.walletId) storeSelectedWalletId(msg.walletId);
        } else if (msg.type === "DISCONNECTED") {
          setAddress(null);
          clearSelectedWalletId();
        } else if (msg.type === "ACCOUNT_CHANGED") {
          setAddress(msg.address);
        }
      } finally {
        // Reset flag after microtask
        setTimeout(() => {
          isExternalSyncRef.current = false;
        }, 0);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const connect = useCallback(async () => {
    ensureWalletKitInitialized();
    setConnecting(true);
    setError(null);
    try {
      await StellarWalletsKit.authModal({});
      const { address: connectedAddress } = await StellarWalletsKit.getAddress();
      setAddress(connectedAddress);
      const selectedId = StellarWalletsKit.selectedModule?.productId;
      if (selectedId) {
        storeSelectedWalletId(selectedId);
      }
      // Broadcast to other tabs
      broadcastWalletEvent({
        type: "CONNECTED",
        address: connectedAddress,
        walletId: selectedId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch {
      // Some modules don't implement disconnect(); local state is cleared regardless.
    }
    clearSelectedWalletId();
    setAddress(null);

    // Broadcast disconnection to other tabs
    broadcastWalletEvent({
      type: "DISCONNECTED",
    });
  }, []);

  return (
    <WalletContext.Provider value={{ address, connecting, error, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}
