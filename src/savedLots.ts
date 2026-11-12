/** Settled lots. Fetched on demand. No node. Add a line after each later lot settles. */
export const SAVED_LOTS: { id: bigint; file: string }[] = [
  { id: 1n, file: "history/lot-1.json" },
];

export type SavedBid = {
  bidder: string;
  amount: string;
  endTime: string;
  blockNumber: string;
  txHash: string;
  timestamp: number;
};

export type SavedLot = {
  id: string;
  name: string;
  image: string;
  tokenURI: string;
  description?: string;
  endedAt?: number;
  finalAmount?: string;
  attributes?: { trait_type?: string; value?: string | number }[];
  bids: SavedBid[];
};

export function savedFile(id: bigint): string | null {
  return SAVED_LOTS.find((s) => s.id === id)?.file ?? null;
}

export async function fetchSavedLot(id: bigint): Promise<SavedLot> {
  const file = savedFile(id);
  if (!file) throw new Error("saved history missing");
  const res = await fetch(`${import.meta.env.BASE_URL}${file}`);
  if (!res.ok) throw new Error("saved history missing");
  return res.json();
}
