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

/** Base public RPC: max ~2000 blocks per eth_getLogs + strict rate limits */
const LOG_CHUNK = 1999n;
const AUCTION_DEPLOY_BLOCK = 44_524_924n;
const CHUNK_DELAY_MS = 120;

const bidEvent = parseAbiItem(
  "event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)"
);
const createdEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, string tokenURI, uint256 startTime, uint256 endTime, uint256 reservePrice, uint256 minBidIncrement, address proceedsTo)"
);

const client = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL, {
    // avoid hammering public endpoint
    retryCount: 2,
    retryDelay: 400,
  }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function cacheGet<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota */
  }
}

/** One chunk with gentle retry on rate limit */
async function getLogsOnce(params: {
  event: typeof bidEvent | typeof createdEvent;
  args?: { auctionId?: bigint };
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<Log[]> {
  const { event, args, fromBlock, toBlock } = params;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await client.getLogs({
        address: AUCTION_ADDRESS,
        event,
        args: args as any,
        fromBlock,
        toBlock,
      })) as Log[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/rate limit|429|timeout/i.test(msg) && attempt < 3) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  return [];
}

/**
 * Scan newest → oldest in 2k-block windows (sequential).
 * Stops early after `emptyStop` empty chunks once we already have logs,
 * or when we hit deploy block.
 */
async function scanLogsBackward(params: {
  event: typeof bidEvent | typeof createdEvent;
  args?: { auctionId?: bigint };
  emptyStop?: number;
  onProgress?: (n: number) => void;
}): Promise<Log[]> {
  const latest = await client.getBlockNumber();
  const floor = AUCTION_DEPLOY_BLOCK;
  const emptyStop = params.emptyStop ?? 8;
  const all: Log[] = [];
  let emptyRun = 0;
  let to = latest;
  let chunks = 0;

  while (to >= floor) {
    const from = to > floor + LOG_CHUNK ? to - LOG_CHUNK : floor;
    const chunk = await getLogsOnce({
      event: params.event,
      args: params.args,
      fromBlock: from,
      toBlock: to,
    });
    chunks++;
    params.onProgress?.(chunks);

    if (chunk.length === 0) {
      emptyRun++;
      if (all.length > 0 && emptyRun >= emptyStop) break;
    } else {
      emptyRun = 0;
      // prepend older logs so final order is chronological then we reverse
      all.push(...chunk);
    }

    if (from === floor) break;
    to = from - 1n;
    await sleep(CHUNK_DELAY_MS);
  }

  return all;
}

type LotCache = { id: string; tokenURI: string }[];

async function fetchLots(): Promise<LotInfo[]> {
  const cached = cacheGet<LotCache>("bushi-lots-v1");
  if (cached?.length) {
    return cached.map((l) => ({ id: BigInt(l.id), tokenURI: l.tokenURI }));
  }

  const logs = await scanLogsBackward({
    event: createdEvent,
    emptyStop: 12,
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
  const lots = [...map.values()].sort((a, b) => Number(a.id - b.id));
  cacheSet(
    "bushi-lots-v1",
    lots.map((l) => ({ id: l.id.toString(), tokenURI: l.tokenURI }))
  );
  return lots;
}

type BidCache = {
  bidder: string;
  amount: string;
  endTime: string;
  blockNumber: string;
  txHash: string;
  timestamp?: number;
}[];

async function fetchBids(auctionId: bigint): Promise<BidRow[]> {
  const key = `bushi-bids-v1-${auctionId.toString()}`;
  const cached = cacheGet<BidCache>(key);
  if (cached?.length) {
    return cached.map((b) => ({
      bidder: b.bidder as Address,
      amount: BigInt(b.amount),
      endTime: BigInt(b.endTime),
      blockNumber: BigInt(b.blockNumber),
      txHash: b.txHash as Hex,
      timestamp: b.timestamp,
    }));
  }

  const logs = await scanLogsBackward({
    event: bidEvent,
    args: { auctionId },
    // bids for one lot are clustered; stop sooner after gap
    emptyStop: 6,
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

  // Sort newest first by block
  rows.sort((a, b) => Number(b.blockNumber - a.blockNumber));

  // Timestamps — few unique blocks typically
  const uniqueBlocks = [...new Set(rows.map((r) => r.blockNumber.toString()))];
  const tsMap = new Map<string, number>();
  for (const bn of uniqueBlocks) {
    try {
      const b = await client.getBlock({ blockNumber: BigInt(bn) });
      tsMap.set(bn, Number(b.timestamp));
      await sleep(40);
    } catch {
      /* ignore */
    }
  }

  const withTs = rows.map((r) => ({
    ...r,
    timestamp: tsMap.get(r.blockNumber.toString()),
  }));

  cacheSet(
    key,
    withTs.map((b) => ({
      bidder: b.bidder,
      amount: b.amount.toString(),
      endTime: b.endTime.toString(),
      blockNumber: b.blockNumber.toString(),
      txHash: b.txHash,
      timestamp: b.timestamp,
    }))
  );

  return withTs;
}

function ipfsToHttp(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    return `https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`;
  }
  return arweaveToHttp(uri);
}

async function resolveLotMeta(tokenURI: string): Promise<{
  name?: string;
  image?: string;
}> {
  if (!tokenURI) return {};
  try {
    const res = await fetch(ipfsToHttp(tokenURI));
    if (!res.ok) return {};
    const t = await res.text();
    if (t.trimStart().startsWith("{")) {
      const j = JSON.parse(t) as { name?: string; image?: string };
      return {
        name: j.name,
        image: j.image ? ipfsToHttp(j.image) : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return {};
}

type Props = {
  currentAuctionId: bigint;
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
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (open) setViewId(currentAuctionId);
  }, [open, currentAuctionId]);

  const load = useCallback(
    async (id: bigint) => {
      setLoading(true);
      setErr(null);
      setHint("履歴を読み込み中…");
      try {
        // Meta first (fast) — parent for current lot
        if (id === currentAuctionId) {
          setMeta({
            name: currentTitle,
            image: currentImage,
          });
        } else {
          setMeta({});
        }

        // Bids for this lot (main ask)
        const bidList = await fetchBids(id);
        setBids(bidList);
        setHint(null);

        // Lots for ‹ › — may use cache; don't block bids display
        let lotList: LotInfo[] = [];
        try {
          lotList = await fetchLots();
        } catch {
          lotList = [];
        }
        if (
          id === currentAuctionId &&
          currentTokenURI &&
          !lotList.some((l) => l.id === id)
        ) {
          lotList = [...lotList, { id, tokenURI: currentTokenURI }].sort(
            (a, b) => Number(a.id - b.id)
          );
        }
        setLots(lotList);

        // Enrich meta for other lots
        if (id !== currentAuctionId) {
          const lot = lotList.find((l) => l.id === id);
          const m = await resolveLotMeta(lot?.tokenURI || "");
          setMeta(m);
        } else if (!currentImage || !currentTitle) {
          const lot = lotList.find((l) => l.id === id);
          const m = await resolveLotMeta(
            currentTokenURI || lot?.tokenURI || ""
          );
          setMeta({
            name: currentTitle || m.name,
            image: currentImage || m.image,
          });
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "履歴の取得に失敗しました");
        setBids([]);
        setHint(null);
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
                  (e.target as HTMLImageElement).src = "";
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

        {loading && (
          <p className="modal-empty">{hint || "読み込み中…"}</p>
        )}
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
