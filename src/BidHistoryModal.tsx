import { useCallback, useEffect, useRef, useState } from "react";
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

const LOG_CHUNK = 1999n;
const AUCTION_DEPLOY_BLOCK = 44_978_073n;
const CHUNK_DELAY_MS = 100;
/** First open: keep scanning until this many newest bids (not a time window). */
const INITIAL_BID_TARGET = 5;
/** Safety: max 2000-block windows per scan call (~400k blocks). */
const MAX_CHUNKS_PER_SCAN = 250;

const bidEvent = parseAbiItem(
  "event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 endTime)"
);
const createdEvent = parseAbiItem(
  "event AuctionCreated(uint256 indexed auctionId, string tokenURI, uint256 startTime, uint256 endTime, uint256 reservePrice, uint256 minBidIncrement, address proceedsTo)"
);

const client = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL, { retryCount: 2, retryDelay: 500 }),
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

function ipfsToHttp(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    return `https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`;
  }
  return arweaveToHttp(uri);
}

async function getLogsOnce(params: {
  event: typeof bidEvent | typeof createdEvent;
  args?: { auctionId?: bigint };
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<Log[]> {
  const { event, args, fromBlock, toBlock } = params;
  for (let attempt = 0; attempt < 5; attempt++) {
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
      if (/rate limit|429|timeout|limit/i.test(msg) && attempt < 4) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  return [];
}

function logsToBids(logs: Log[]): BidRow[] {
  return logs.map((log) => {
    const args = (log as any).args || {};
    return {
      bidder: args.bidder as Address,
      amount: args.amount as bigint,
      endTime: args.endTime as bigint,
      blockNumber: log.blockNumber ?? 0n,
      txHash: log.transactionHash as Hex,
    };
  });
}

async function attachTimestamps(rows: BidRow[]): Promise<BidRow[]> {
  const need = rows.filter((r) => r.timestamp == null);
  const unique = [...new Set(need.map((r) => r.blockNumber.toString()))];
  const tsMap = new Map<string, number>();
  for (const bn of unique) {
    try {
      const b = await client.getBlock({ blockNumber: BigInt(bn) });
      tsMap.set(bn, Number(b.timestamp));
      await sleep(30);
    } catch {
      /* ignore */
    }
  }
  return rows.map((r) =>
    r.timestamp != null
      ? r
      : { ...r, timestamp: tsMap.get(r.blockNumber.toString()) }
  );
}

/** Merge + dedupe by txHash, newest first */
function mergeBids(prev: BidRow[], more: BidRow[]): BidRow[] {
  const map = new Map<string, BidRow>();
  for (const b of [...prev, ...more]) {
    map.set(b.txHash, b);
  }
  return [...map.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? 0
      : a.blockNumber > b.blockNumber
        ? -1
        : 1
  );
}

// —— Cursor scanner (newest → older), resumable ——
type ScanCursor = {
  nextTo: bigint; // next window ends here (inclusive); 0n = done
  floor: bigint;
};

function freshCursor(latest: bigint): ScanCursor {
  return {
    nextTo: latest,
    floor: AUCTION_DEPLOY_BLOCK,
  };
}

/** Fetch windows newest→older until `minBids` collected or history exhausted. */
async function scanBidsPage(
  auctionId: bigint,
  cursor: ScanCursor,
  minBids: number,
  maxChunks = MAX_CHUNKS_PER_SCAN
): Promise<{ bids: BidRow[]; cursor: ScanCursor; done: boolean }> {
  if (cursor.nextTo < cursor.floor) {
    return { bids: [], cursor, done: true };
  }

  const found: BidRow[] = [];
  let to = cursor.nextTo;
  let chunks = 0;

  while (
    to >= cursor.floor &&
    chunks < maxChunks &&
    found.length < minBids
  ) {
    const from = to > cursor.floor + LOG_CHUNK ? to - LOG_CHUNK : cursor.floor;
    const logs = await getLogsOnce({
      event: bidEvent,
      args: { auctionId },
      fromBlock: from,
      toBlock: to,
    });
    chunks++;
    found.push(...logsToBids(logs));
    if (from === cursor.floor) {
      to = cursor.floor - 1n;
      break;
    }
    to = from - 1n;
    await sleep(CHUNK_DELAY_MS);
  }

  const done = to < cursor.floor;
  // Newest-first for UI; timestamps only for what we show
  found.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? 0
      : a.blockNumber > b.blockNumber
        ? -1
        : 1
  );
  const withTs = await attachTimestamps(found);
  return {
    bids: withTs,
    cursor: { ...cursor, nextTo: to },
    done,
  };
}

async function fetchLotsOnce(): Promise<LotInfo[]> {
  const latest = await client.getBlockNumber();
  let to = latest;
  const floor = AUCTION_DEPLOY_BLOCK;
  const map = new Map<string, LotInfo>();
  let empty = 0;
  // Enough windows for lot list; stop after gap once we have some
  while (to >= floor && empty < 10) {
    const from = to > floor + LOG_CHUNK ? to - LOG_CHUNK : floor;
    const logs = await getLogsOnce({
      event: createdEvent,
      fromBlock: from,
      toBlock: to,
    });
    if (logs.length === 0) empty++;
    else {
      empty = 0;
      for (const log of logs) {
        const args = (log as any).args || {};
        const id = args.auctionId as bigint;
        if (id == null) continue;
        map.set(id.toString(), {
          id,
          tokenURI: (args.tokenURI as string) || "",
        });
      }
    }
    if (from === floor) break;
    to = from - 1n;
    await sleep(CHUNK_DELAY_MS);
  }
  return [...map.values()].sort((a, b) => Number(a.id - b.id));
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const cursorRef = useRef<ScanCursor | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const loadGen = useRef(0);

  // Reset view when opened
  useEffect(() => {
    if (open) setViewId(currentAuctionId);
  }, [open, currentAuctionId]);

  const startFreshScan = useCallback(
    async (id: bigint) => {
      const gen = ++loadGen.current;
      setLoading(true);
      setLoadingMore(false);
      setErr(null);
      setBids([]);
      setDone(false);
      cursorRef.current = null;

      if (id === currentAuctionId) {
        setMeta({ name: currentTitle, image: currentImage });
      } else {
        setMeta({});
      }

      try {
        const latest = await client.getBlockNumber();
        if (gen !== loadGen.current) return;
        let cursor = freshCursor(latest);
        // Keep scanning until ≥5 newest bids (or full history) — not a time window
        const page = await scanBidsPage(id, cursor, INITIAL_BID_TARGET);
        if (gen !== loadGen.current) return;
        cursorRef.current = page.cursor;
        setBids(mergeBids([], page.bids));
        setDone(page.done);
        setLoading(false);

        // Lots in background (for ‹ › only)
        fetchLotsOnce()
          .then((lotList) => {
            if (gen !== loadGen.current) return;
            let list = lotList;
            if (
              id === currentAuctionId &&
              currentTokenURI &&
              !list.some((l) => l.id === id)
            ) {
              list = [...list, { id, tokenURI: currentTokenURI }].sort(
                (a, b) => Number(a.id - b.id)
              );
            }
            setLots(list);
            if (id !== currentAuctionId) {
              const lot = list.find((l) => l.id === id);
              resolveLotMeta(lot?.tokenURI || "").then((m) => {
                if (gen === loadGen.current) setMeta(m);
              });
            } else if (!currentImage || !currentTitle) {
              resolveLotMeta(currentTokenURI || "").then((m) => {
                if (gen !== loadGen.current) return;
                setMeta({
                  name: currentTitle || m.name,
                  image: currentImage || m.image,
                });
              });
            }
          })
          .catch(() => {
            /* non-fatal */
          });
      } catch (e) {
        if (gen !== loadGen.current) return;
        setErr(e instanceof Error ? e.message : "履歴の取得に失敗しました");
        setLoading(false);
      }
    },
    [currentAuctionId, currentTokenURI, currentTitle, currentImage]
  );

  // Every open + every lot change → full fresh reload (no sticky cache)
  useEffect(() => {
    if (!open || viewId <= 0n) return;
    startFreshScan(viewId);
    return () => {
      loadGen.current++; // cancel in-flight
    };
  }, [open, viewId, startFreshScan]);

  const loadOlder = useCallback(async () => {
    if (done || loading || loadingMore) return;
    const cursor = cursorRef.current;
    if (!cursor || cursor.nextTo < cursor.floor) {
      setDone(true);
      return;
    }
    const gen = loadGen.current;
    setLoadingMore(true);
    try {
      const page = await scanBidsPage(viewId, cursor, INITIAL_BID_TARGET);
      if (gen !== loadGen.current) return;
      cursorRef.current = page.cursor;
      setBids((prev) => mergeBids(prev, page.bids));
      setDone(page.done);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setErr(e instanceof Error ? e.message : "追加読み込みに失敗");
    } finally {
      if (gen === loadGen.current) setLoadingMore(false);
    }
  }, [done, loading, loadingMore, viewId]);

  // Infinite scroll inside list
  useEffect(() => {
    const el = listRef.current;
    if (!el || !open) return;
    const onScroll = () => {
      const remain = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remain < 48) loadOlder();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [open, loadOlder, bids.length]);

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
              <img src={meta.image} alt="" className="modal-thumb" />
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

        <div className="modal-section-row">
          <h3 className="modal-section">入札履歴</h3>
          <span className="modal-count">
            {bids.length > 0 ? `${bids.length} 件` : ""}
          </span>
        </div>

        {loading && bids.length === 0 && (
          <p className="modal-empty">
            履歴を読み込み中…（最新の入札を検索しています）
          </p>
        )}
        {err && <p className="modal-empty err">{err}</p>}
        {!loading && !err && bids.length === 0 && (
          <p className="modal-empty">まだ入札がありません</p>
        )}

        {bids.length > 0 && (
          <ul className="bid-hist-list" ref={listRef}>
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
            <li className="bid-hist-footer">
              {loadingMore && <span>さらに読み込み中…</span>}
              {!loadingMore && !done && (
                <button type="button" className="linkish" onClick={loadOlder}>
                  古い履歴を読み込む
                </button>
              )}
              {!loadingMore && done && (
                <span className="muted">すべての履歴を表示しています</span>
              )}
            </li>
          </ul>
        )}

        <p className="modal-foot-note">
          開くたびに最新を取得 · スクロールで過去分を追加 · ローカル時刻
        </p>
      </div>
    </div>
  );
}
