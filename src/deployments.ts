/**
 * Network deployments for Bushi Collection auction site.
 * Default remains Sepolia until mainnet GO + addresses filled.
 */
import type { Address } from "viem";
import { base, baseSepolia } from "viem/chains";

export type AuctionDeployment = {
  id: "sepolia" | "mainnet";
  chain: typeof baseSepolia | typeof base;
  collection: Address;
  auction: Address;
  /** Bid-history log floor (inclusive). Update after mainnet deploy. */
  auctionDeployBlock: bigint;
  defaultArtist: Address;
  rpcFallback: string;
  explorer: string;
  label: string;
};

/** Base Sepolia — dogfood (schedule OK 2026-08) */
export const sepoliaDeployment: AuctionDeployment = {
  id: "sepolia",
  chain: baseSepolia,
  collection: "0x4BE9e05b953849f13C0e27A257A8D89b4D221318",
  auction: "0x2e21fbc98129886AA6F3AEF39ECbd513BDFEc12A",
  auctionDeployBlock: 44_980_628n,
  defaultArtist: "0x8f6aCF9bC977435ECea3456CA73f8EAf93556667",
  rpcFallback: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org",
  label: "Base Sepolia",
};

/**
 * Base mainnet — LIVE 2026-08-10
 * Deployer B1 · pendingOwner Safe · block 49976410
 */
export const mainnetDeployment: AuctionDeployment = {
  id: "mainnet",
  chain: base,
  collection: "0xbb956e810AA45799760E07775AeaAcd327334BC7",
  auction: "0x5Da0Af241fCE4D6E2bB5E021F2ce8706E830a202",
  auctionDeployBlock: 49_976_410n,
  defaultArtist: "0xC88b9Be50638361d4A1e2c52802fa2F78932170E",
  rpcFallback: "https://mainnet.base.org",
  explorer: "https://basescan.org",
  label: "Base",
};

function isZero(a: string) {
  return !a || /^0x0{40}$/i.test(a);
}

/**
 * Active deployment.
 * Default: **mainnet** when addresses are set.
 * Override: VITE_NETWORK=sepolia for dogfood.
 */
export function activeDeployment(): AuctionDeployment {
  const want = (import.meta.env.VITE_NETWORK as string | undefined)?.toLowerCase();
  if (want === "sepolia" || want === "testnet") {
    return sepoliaDeployment;
  }
  if (want === "mainnet" || want === "base" || !want) {
    if (isZero(mainnetDeployment.collection) || isZero(mainnetDeployment.auction)) {
      console.warn(
        "[bushi-collection] mainnet addresses empty — falling back to Sepolia"
      );
      return sepoliaDeployment;
    }
    return mainnetDeployment;
  }
  return sepoliaDeployment;
}
