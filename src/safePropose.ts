import {
  encodeFunctionData,
  hashTypedData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

const SAFE_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const EIP712_SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function txServiceBase(chainId: number): string | null {
  if (chainId === 8453) return "https://safe-transaction-base.safe.global";
  if (chainId === 84532) return "https://safe-transaction-base-sepolia.safe.global";
  return null;
}

export function safeQueueUrl(chainId: number, safe: Address): string {
  const prefix = chainId === 84532 ? "base-sep" : "base";
  return `https://app.safe.global/transactions/queue?safe=${prefix}:${safe}`;
}

export async function readSafeOwners(
  client: PublicClient,
  safe: Address
): Promise<Address[] | null> {
  try {
    const owners = await client.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: "getOwners",
    });
    return owners as Address[];
  } catch {
    return null;
  }
}

export async function readSafeThreshold(
  client: PublicClient,
  safe: Address
): Promise<number> {
  try {
    const t = await client.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: "getThreshold",
    });
    return Number(t);
  } catch {
    return 0;
  }
}

async function nextSafeNonce(
  chainId: number,
  safe: Address,
  client: PublicClient
): Promise<bigint> {
  const onChain = (await client.readContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: "nonce",
  })) as bigint;
  const host = txServiceBase(chainId);
  if (!host) return onChain;
  try {
    const url = `${host}/api/v1/safes/${safe}/multisig-transactions/?executed=false&ordering=nonce&limit=20`;
    const res = await fetch(url);
    if (!res.ok) return onChain;
    const body = (await res.json()) as { results?: { nonce?: number }[] };
    let next = onChain;
    for (const row of body.results || []) {
      if (typeof row.nonce === "number" && BigInt(row.nonce) >= next) {
        next = BigInt(row.nonce) + 1n;
      }
    }
    return next;
  } catch {
    return onChain;
  }
}

export type ProposeResult = {
  safeTxHash: Hex;
  nonce: bigint;
  queueUrl: string;
};

export async function proposeSafeCall(opts: {
  chainId: number;
  safe: Address;
  to: Address;
  data: Hex;
  publicClient: PublicClient;
  walletClient: WalletClient;
  sender: Address;
  origin?: string;
}): Promise<ProposeResult> {
  const host = txServiceBase(opts.chainId);
  if (!host) throw new Error("このチェーンの Safe Transaction Service がありません");
  if (!opts.walletClient.account) throw new Error("ウォレット未接続");

  const nonce = await nextSafeNonce(opts.chainId, opts.safe, opts.publicClient);
  const message = {
    to: opts.to,
    value: 0n,
    data: opts.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  };

  const domain = {
    chainId: opts.chainId,
    verifyingContract: opts.safe,
  } as const;

  const safeTxHash = hashTypedData({
    domain,
    types: EIP712_SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message,
  });

  const signature = await opts.walletClient.signTypedData({
    account: opts.walletClient.account,
    domain,
    types: EIP712_SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message,
  });

  const payload = {
    to: opts.to,
    value: "0",
    data: opts.data,
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: Number(nonce),
    contractTransactionHash: safeTxHash,
    sender: opts.sender,
    signature,
    origin: opts.origin || "Bushi Collection admin",
  };

  const url = `${host}/api/v1/safes/${opts.safe}/multisig-transactions/`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Safe 提案に失敗 (${res.status}): ${text.slice(0, 240)}`);
  }

  return {
    safeTxHash,
    nonce,
    queueUrl: safeQueueUrl(opts.chainId, opts.safe),
  };
}

export function encodeAuctionCall(
  abi: readonly unknown[],
  functionName: "createAuction" | "setDefaultArtist",
  args: readonly unknown[]
): Hex {
  return encodeFunctionData({
    abi: abi as any,
    functionName,
    args: args as any,
  });
}
