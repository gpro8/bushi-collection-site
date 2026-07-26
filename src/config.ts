import type { Address } from "viem";
import { baseSepolia } from "viem/chains";
import collectionAbi from "./abi/BushiCollection.json";
import auctionAbi from "./abi/BushiCollectionAuction.json";

/** Base Sepolia (84532) — Phase 2 target */
export const CHAIN = baseSepolia;

export const COLLECTION_ADDRESS =
  "0x4BE9e05b953849f13C0e27A257A8D89b4D221318" as Address;
export const AUCTION_ADDRESS =
  "0xCbf8d57F2fc99566b859a2243045E70092054e17" as Address;

export const COLLECTION_ABI = collectionAbi as readonly unknown[];
export const AUCTION_ABI = auctionAbi as readonly unknown[];

/** Public RPC — override with VITE_RPC_URL for Alchemy */
export const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ||
  "https://sepolia.base.org";

export const EXPLORER = "https://sepolia.basescan.org";

export function arweaveToHttp(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ar://")) {
    return `https://arweave.net/${uri.slice(5)}`;
  }
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  }
  return uri;
}
