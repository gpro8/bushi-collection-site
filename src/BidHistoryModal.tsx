import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  formatEther,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { AUCTION_ADDRESS, CHAIN, RPC_URL, arweaveToHttp } from "./config";

export type BidRow = {
  bidder: Address;
  amount: bigint;
  endTime: bigint;
  blockNumber: bigint;
  txHash: Hex;
  timestamp?: number;
};

export type LotInfo = {
  id: bigint;
  tokenURI: string;
};

/** Base public RPC: max ~2000 blocks per eth_getLogs */
const LOG_CHUNK = 1999n;
/** BushiCollectionAuction deploy on Base Sepolia (84532) */
const AUCTION_DEPLOY_BLOCK = 44_524_924n;

const bidEvent = parseAbiItem(
  "event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)"
);
const createdEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, string tokenURI, uint256 startTime, uint256 endTime, uint256 reservePrice, uint256 minBidIncrement, address proceedsTo)"
);

const client = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

function shortAddr(a?: string) {
  if (!a || a === "0x0000000000000000000000000000000000000000") return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function avatarStyle(addr: string) {
  let h = 0;
  for (let i = 2; i < Math.min(addr.length, 10); i++) {
    h = (h * 31 + addr.charCodeAt(i)) % 360;
  }
  return {
    background: `linear-gradient(135deg, hsl(${h} 45% 38%), hsl(${(h + 40) % 360} 50% 22%))`,
  };
}

function fmtLocal(ts?: number) {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** Walk [from..to] in ≤2000-block windows (Base Sepolia public RPC limit). */
async function getLogsChunked(params: {
  event: typeof bidEvent | typeof createdEvent;
  args?: { auctionId?: bigint };
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<Log[]> {
  const { event, args, fromBlock, toBlock } = params;
  if (toBlock < fromBlock) return [];

  const ranges: { start: bigint; end: bigint }[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    let end = start + LOG_CHUNK;
    if (end > toBlock) end = toBlock;
    ranges.push({ start, end });
    start = end + 1n;
  }

  const all: Log[] = [];
  const concurrency = 10;
  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
    const parts = await Promise.all(
      batch.map(({ start: s, end: e }) =>
        client.getLogs({
          address: AUCTION_ADDRESS,
          event,
          args: args as any,
          fromBlock: s,
          toBlock: e,
        })
      )
    );
    for (const p of parts) all.push(...(p as Log[]));
  }
  return all;
}

async function fetchLots(): Promise<LotInfo[]> {
  const latest = await client.getBlockNumber();
  const from = AUCTION_DEPLOY_BLOCK < latest ? AUCTION_DEPLOY_BLOCK : 0n;
  const logs = await getLogsChunked({
    event: createdEvent,
    fromBlock: from,
    toBlock: latest,
  });
  const map = new Map<string, LotInfo>();
  for (const log of logs) {
    const args = (log as any).args || {};
    const id = args.auctionId as bigint;
    if (id == null) continue;
    map.set(id.toString(), {
      id,
      tokenURI: (args.tokenURI as string) || "",
    });
  }
  return [...map.values()].sort((a, b) => Number(a.id - b.id));
}

async function fetchBids(auctionId: bigint): Promise<BidRow[]> {
  const latest = await client.getBlockNumber();
  const from = AUCTION_DEPLOY_BLOCK < latest ? AUCTION_DEPLOY_BLOCK : 0n;
  const logs = await getLogsChunked({
    event: bidEvent,
    args: { auctionId },
    fromBlock: from,
    toBlock: latest,
  });

  const rows: BidRow[] = logs.map((log) => {
    const args = (log as any).args || {};
    return {
      bidder: args.bidder as Address,
      amount: args.amount as bigint,
      endTime: args.endTime as bigint,
      blockNumber: log.blockNumber ?? 0n,
      txHash: log.transactionHash as Hex,
    };
  });

  // Newest first
  rows.reverse();

  const uniqueBlocks = [...new Set(rows.map((r) => r.blockNumber.toString()))];
  const tsMap = new Map<string, number>();
  // sequential small batches to avoid RPC flood
  for (let i = 0; i < uniqueBlocks.length; i += 8) {
    const batch = uniqueBlocks.slice(i, i + 8);
    await Promise.all(
      batch.map(async (bn) => {
        try {
          const b = await client.getBlock({ blockNumber: BigInt(bn) });
          tsMap.set(bn, Number(b.timestamp));
        } catch {
          /* ignore */
        }
      })
    );
  }

  return rows.map((r) => ({
    ...r,
    timestamp: tsMap.get(r.blockNumber.toString()),
  }));
}

function ipfsToHttp(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice(7);
    // Prefer Pinata gateway first (common for Bushi metadata), then public
    return `https://gateway.pinata.cloud/ipfs/${path}`;
  }
  return arweaveToHttp(uri);
}

async function resolveLotMeta(tokenURI: string): Promise<{
  name?: string;
  image?: string;
}> {
  if (!tokenURI) return {};
  try {
    const url = ipfsToHttp(tokenURI);
    const res = await fetch(url);
    if (!res.ok) return {};
    const t = await res.text();
    if (t.trimStart().startsWith("{")) {
      const j = JSON.parse(t) as { name?: string; image?: string };
      const img = j.image ? ipfsToHttp(j.image) : undefined;
      return { name: j.name, image: img };
    }
  } catch {
    /* ignore */
  }
  return {};
}

type Props = {
  currentAuctionId: bigint;
  /** Fallback when logs lag — current lot URI / display from parent */
  currentTokenURI?: string;
  currentTitle?: string;
  currentImage?: string;
  open: boolean;
  onClose: () => void;
};

export function BidHistoryModal({
  currentAuctionId,
  currentTokenURI,
  currentTitle,
  currentImage,
  open,
  onClose,
}: Props) {
  const [lots, setLots] = useState<LotInfo[]>([]);
  const [viewId, setViewId] = useState<bigint>(currentAuctionId);
  const [bids, setBids] = useState<BidRow[]>([]);
  const [meta, setMeta] = useState<{ name?: string; image?: string }>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) setViewId(currentAuctionId);
  }, [open, currentAuctionId]);

  const load = useCallback(
    async (id: bigint) => {
      setLoading(true);
      setErr(null);
      try {
        const [lotList, bidList] = await Promise.all([
          fetchLots(),
          fetchBids(id),
        ]);
        // Ensure current lot appears even if a chunk missed it
        if (
          id === currentAuctionId &&
          currentTokenURI &&
          !lotList.some((l) => l.id === id)
        ) {
          lotList.push({ id, tokenURI: currentTokenURI });
          lotList.sort((a, b) => Number(a.id - b.id));
        }
        setLots(lotList);
        setBids(bidList);

        const lot = lotList.find((l) => l.id === id);
        let uri = lot?.tokenURI || "";
        if (id === currentAuctionId && currentTokenURI) {
          uri = currentTokenURI;
        }
        let m = await resolveLotMeta(uri);
        // Parent already resolved image/title for live lot
        if (id === currentAuctionId) {
          m = {
            name: m.name || currentTitle,
            image: m.image || currentImage,
          };
        }
        setMeta(m);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "履歴の取得に失敗しました");
        setBids([]);
      } finally {
        setLoading(false);
      }
    },
    [currentAuctionId, currentTokenURI, currentTitle, currentImage]
  );

  useEffect(() => {
    if (!open || viewId <= 0n) return;
    load(viewId);
  }, [open, viewId, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const idx = lots.findIndex((l) => l.id === viewId);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < lots.length - 1;

  const lotLabel = `Bushi #${viewId.toString()}`;
  // Prefer metadata title; avoid duplicating "Bushi #N" twice
  const displayTitle =
    meta.name && meta.name.trim() && meta.name.trim() !== lotLabel
      ? meta.name.trim()
      : null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="入札履歴"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <button
            type="button"
            className="modal-nav"
            disabled={!hasPrev}
            onClick={() => hasPrev && setViewId(lots[idx - 1].id)}
            aria-label="前のロット"
          >
            ‹
          </button>
          <div className="modal-lot">
            {meta.image ? (
              <img
                src={meta.image}
                alt=""
                className="modal-thumb"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div className="modal-thumb placeholder">武</div>
            )}
            <div>
              <div className="modal-kicker">{lotLabel}</div>
              {displayTitle && (
                <div className="modal-title" title={displayTitle}>
                  {displayTitle}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className="modal-nav"
            disabled={!hasNext}
            onClick={() => hasNext && setViewId(lots[idx + 1].id)}
            aria-label="次のロット"
          >
            ›
          </button>
          <button
            type="button"
            className="modal-x"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <h3 className="modal-section">入札履歴</h3>

        {loading && <p className="modal-empty">読み込み中…</p>}
        {err && <p className="modal-empty err">{err}</p>}
        {!loading && !err && bids.length === 0 && (
          <p className="modal-empty">まだ入札がありません</p>
        )}

        {!loading && !err && bids.length > 0 && (
          <ul className="bid-hist-list">
            {bids.map((b, i) => (
              <li key={`${b.txHash}-${i}`}>
                <span
                  className="bid-av"
                  style={avatarStyle(b.bidder)}
                  aria-hidden
                />
                <span className="bid-who">{shortAddr(b.bidder)}</span>
                <span className="bid-amt">Ξ {formatEther(b.amount)}</span>
                <span className="bid-when">{fmtLocal(b.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="modal-foot-note">
          時刻はお使いの端末のローカルタイムゾーンです
        </p>
      </div>
    </div>
  );
}
