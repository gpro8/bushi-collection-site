import type { Address } from "viem";
import collectionAbi from "./abi/BushiCollection.json";
import auctionAbi from "./abi/BushiCollectionAuction.json";
import { activeDeployment } from "./deployments";

const d = activeDeployment();

export const CHAIN = d.chain;
export const COLLECTION_ADDRESS = d.collection as Address;
export const AUCTION_ADDRESS = d.auction as Address;
/** Log scan floor for bid history / lot list */
export const AUCTION_DEPLOY_BLOCK = d.auctionDeployBlock;
export const NETWORK_LABEL = d.label;

export const COLLECTION_ABI = collectionAbi as readonly unknown[];
export const AUCTION_ABI = auctionAbi as readonly unknown[];

/** Public RPC — override with VITE_RPC_URL (Alchemy recommended on mainnet) */
export const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) || d.rpcFallback;

export const EXPLORER = d.explorer;

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
