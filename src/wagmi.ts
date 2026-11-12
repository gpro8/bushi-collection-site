import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Chain } from "viem";
import { CHAIN, RPC_URLS } from "./config";

/** Single active chain (Sepolia or Base) from deployments. */
const chain = CHAIN as Chain;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [chain.id]: http(RPC_URLS[0], { timeout: 12_000, retryCount: 0 }),
  },
});
