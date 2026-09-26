import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { getStoredWalletId } from "./storage";

export { getStoredWalletId, storeSelectedWalletId, clearSelectedWalletId } from "./storage";

export interface SupportedWalletMeta {
  id: "freighter" | "xbull" | "ledger" | "walletconnect";
  name: string;
  type: "extension" | "hardware" | "qr";
  url: string;
  description: string;
}

export const SUPPORTED_WALLETS: readonly SupportedWalletMeta[] = [
  {
    id: "freighter",
    name: "Freighter",
    type: "extension",
    url: "https://www.freighter.app/",
    description: "Official browser extension wallet for Stellar & Soroban smart contracts.",
  },
  {
    id: "xbull",
    name: "xBull Wallet",
    type: "extension",
    url: "https://xbull.app/",
    description: "Multi-platform wallet supporting desktop extensions and hardware keys.",
  },
  {
    id: "ledger",
    name: "Ledger",
    type: "hardware",
    url: "https://www.ledger.com/",
    description: "Industry-standard hardware wallet for cold storage and secure transaction signing.",
  },
  {
    id: "walletconnect",
    name: "WalletConnect",
    type: "qr",
    url: "https://walletconnect.com/",
    description: "Connect instantly using mobile Stellar wallets via QR code scan.",
  },
] as const;

export type SupportedWalletId = (typeof SUPPORTED_WALLETS)[number]["id"];

let initialized = false;

export function ensureWalletKitInitialized(): void {
  if (initialized || typeof window === "undefined") return;

  StellarWalletsKit.init({
    network: Networks.TESTNET,
    selectedWalletId: getStoredWalletId(),
    modules: [new FreighterModule(), new xBullModule()],
  });

  initialized = true;
}

export { StellarWalletsKit };
