import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  formatEther,
  http,
  parseAbiItem,
  type Address,
  type Hex,
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

/** Deterministic soft avatar color from address */
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

async function fetchLots(): Promise<LotInfo[]> {
  const logs = await client.getLogs({
    address: AUCTION_ADDRESS,
    event: createdEvent,
    fromBlock: 0n,
    toBlock: "latest",
  });
  const map = new Map<string, LotInfo>();
  for (const log of logs) {
    const id = log.args.auctionId as bigint;
    map.set(id.toString(), {
      id,
      tokenURI: (log.args.tokenURI as string) || "",
    });
  }
  return [...map.values()].sort((a, b) => Number(a.id - b.id));
}

async function fetchBids(auctionId: bigint): Promise<BidRow[]> {
  const logs = await client.getLogs({
    address: AUCTION_ADDRESS,
    event: bidEvent,
    args: { auctionId },
    fromBlock: 0n,
    toBlock: "latest",
  });

  const rows: BidRow[] = logs.map((log) => ({
    bidder: log.args.bidder as Address,
    amount: log.args.amount as bigint,
    endTime: log.args.endTime as bigint,
    blockNumber: log.blockNumber ?? 0n,
    txHash: log.transactionHash!,
  }));

  // Newest first (Nouns-style)
  rows.reverse();

  // Batch timestamps (cap concurrent)
  const uniqueBlocks = [...new Set(rows.map((r) => r.blockNumber.toString()))];
  const tsMap = new Map<string, number>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      try {
        const b = await client.getBlock({ blockNumber: BigInt(bn) });
        tsMap.set(bn, Number(b.timestamp));
      } catch {
        /* ignore */
      }
    })
  );

  return rows.map((r) => ({
    ...r,
    timestamp: tsMap.get(r.blockNumber.toString()),
  }));
}

async function resolveLotMeta(tokenURI: string): Promise<{
  name?: string;
  image?: string;
}> {
  if (!tokenURI) return {};
  try {
    const res = await fetch(arweaveToHttp(tokenURI));
    const t = await res.text();
    if (t.trimStart().startsWith("{")) {
      const j = JSON.parse(t) as { name?: string; image?: string };
      return {
        name: j.name,
        image: j.image ? arweaveToHttp(j.image) : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return {};
}

type Props = {
  currentAuctionId: bigint;
  open: boolean;
  onClose: () => void;
};

export function BidHistoryModal({ currentAuctionId, open, onClose }: Props) {
  const [lots, setLots] = useState<LotInfo[]>([]);
  const [viewId, setViewId] = useState<bigint>(currentAuctionId);
  const [bids, setBids] = useState<BidRow[]>([]);
  const [meta, setMeta] = useState<{ name?: string; image?: string }>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) setViewId(currentAuctionId);
  }, [open, currentAuctionId]);

  const load = useCallback(async (id: bigint) => {
    setLoading(true);
    setErr(null);
    try {
      const [lotList, bidList] = await Promise.all([fetchLots(), fetchBids(id)]);
      setLots(lotList);
      setBids(bidList);
      const lot = lotList.find((l) => l.id === id);
      const m = await resolveLotMeta(lot?.tokenURI || "");
      setMeta(m);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "履歴の取得に失敗しました");
      setBids([]);
    } finally {
      setLoading(false);
    }
  }, []);

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
  const title =
    meta.name || (viewId > 0n ? `Bushi #${viewId.toString()}` : "Bid history");

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
              <img src={meta.image} alt="" className="modal-thumb" />
            ) : (
              <div className="modal-thumb placeholder">武</div>
            )}
            <div>
              <div className="modal-kicker">Bushi #{viewId.toString()}</div>
              <div className="modal-title">{title}</div>
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
          <button type="button" className="modal-x" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <h3 className="modal-section">入札履歴</h3>

        {loading && <p className="modal-empty">読み込み中…</p>}
        {err && <p className="modal-empty err">{err}</p>}
        {!loading && !err && bids.length === 0 && (
          <p className="modal-empty">まだ入札がありません</p>
        )}

        {!loading && bids.length > 0 && (
          <ul className="bid-hist-list">
            {bids.map((b, i) => (
              <li key={`${b.txHash}-${i}`}>
                <span className="bid-av" style={avatarStyle(b.bidder)} aria-hidden />
                <span className="bid-who">{shortAddr(b.bidder)}</span>
                <span className="bid-amt">Ξ {formatEther(b.amount)}</span>
                <span className="bid-when">{fmtLocal(b.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="modal-foot-note">時刻はお使いの端末のローカルタイムゾーンです</p>
      </div>
    </div>
  );
}
