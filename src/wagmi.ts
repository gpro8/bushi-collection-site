import { http, fallback, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import type { Chain } from "viem";
import { CHAIN, RPC_URLS } from "./config";

/** Single active chain (Sepolia or Base) from deployments. */
const chain = CHAIN as Chain;

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [chain.id]: fallback(
      RPC_URLS.map((u) => http(u, { timeout: 12_000, retryCount: 0 })),
      { rank: false, retryCount: 0 }
    ),
  },
});
