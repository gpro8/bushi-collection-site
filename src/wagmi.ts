import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN, RPC_URL } from "./config";

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [CHAIN.id]: http(RPC_URL),
  },
});
