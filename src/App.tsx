import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from "wagmi";
import { formatEther, parseEther, type Address } from "viem";
import { AdminCreateAuction } from "./AdminCreateAuction";
import { BidHistoryModal } from "./BidHistoryModal";
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  CHAIN,
  COLLECTION_ABI,
  COLLECTION_ADDRESS,
  EXPLORER,
  arweaveToHttp,
} from "./config";
import { fmtCountdown, fmtJst } from "./timeJst";
import { initTheme, toggleTheme, type ThemeMode } from "./theme";

type AuctionState = {
  id: bigint;
  tokenURI: string;
  startTime: bigint;
  endTime: bigint;
  reservePrice: bigint;
  minBidIncrement: bigint;
  highestBidder: Address;
  highestBid: bigint;
  proceedsTo: Address;
  settled: boolean;
  live: boolean;
};

function shortAddr(a?: string) {
  if (!a || a === "0x0000000000000000000000000000000000000000") return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function useNowSec() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

type NftAttr = { trait_type?: string; value?: string | number; display_type?: string };

type NftMeta = {
  name?: string;
  description?: string;
  image?: string;
  attributes?: NftAttr[];
};

const HAS_JA = /[\u3040-\u30ff\u3400-\u9fff]/;

/** Prefer JP block only in collapsed view; EN behind もっと見る. */
function splitDescription(desc: string): { preview: string; hasMore: boolean } {
  const t = desc.trim();
  if (!t) return { preview: "", hasMore: false };

  const blocks = t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length >= 2 && HAS_JA.test(blocks[0])) {
    // JP first paragraph only
    return { preview: blocks[0], hasMore: true };
  }

  // Mixed single block: keep lines until first mostly-English line after JA
  const lines = t.split("\n");
  const jaLines: string[] = [];
  let sawJa = false;
  for (const line of lines) {
    const l = line.trim();
    if (!l) {
      if (sawJa && jaLines.length) break;
      continue;
    }
    if (HAS_JA.test(l)) {
      sawJa = true;
      jaLines.push(l);
    } else if (sawJa) {
      break; // hit English after Japanese
    } else {
      jaLines.push(l);
    }
  }
  if (sawJa && jaLines.length && jaLines.join("\n").length < t.length) {
    return { preview: jaLines.join("\n"), hasMore: true };
  }

  // Short enough already
  if (t.length <= 140) return { preview: t, hasMore: false };
  return { preview: `${t.slice(0, 140).trim()}…`, hasMore: true };
}

async function loadMetadata(tokenURI: string): Promise<{ meta: NftMeta; imageUrl: string }> {
  if (!tokenURI) return { meta: {}, imageUrl: "" };
  const http = arweaveToHttp(tokenURI);
  try {
    const res = await fetch(http);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    // JSON metadata (OpenSea-style)
    if (
      ct.includes("json") ||
      tokenURI.includes("metadata") ||
      text.trimStart().startsWith("{")
    ) {
      const j = JSON.parse(text) as NftMeta;
      const img = j.image || (j as { image_url?: string }).image_url;
      return {
        meta: j,
        imageUrl: typeof img === "string" ? arweaveToHttp(img) : "",
      };
    }
    if (ct.startsWith("image/")) return { meta: {}, imageUrl: http };
  } catch {
    /* fall through */
  }
  return { meta: {}, imageUrl: http };
}

export default function App() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [theme, setTheme] = useState<ThemeMode>(() => initTheme("dark"));

  const { data: stateRaw, refetch: refetchState, isError: stateErr, error: stateError } =
    useReadContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "auctionState",
      chainId: CHAIN.id,
      query: { refetchInterval: 8_000 },
    });

  const { data: totalMinted } = useReadContract({
    address: COLLECTION_ADDRESS,
    abi: COLLECTION_ABI,
    functionName: "totalMinted",
    chainId: CHAIN.id,
    query: { refetchInterval: 15_000 },
  });

  const { data: pending } = useReadContract({
    address: AUCTION_ADDRESS,
    abi: AUCTION_ABI,
    functionName: "pendingReturns",
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const { data: minMsgValue } = useReadContract({
    address: AUCTION_ADDRESS,
    abi: AUCTION_ABI,
    functionName: "minMsgValueToBid",
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address && !!stateRaw, refetchInterval: 8_000 },
  });

  const state: AuctionState | null = useMemo(() => {
    if (!stateRaw || !Array.isArray(stateRaw)) return null;
    const [
      id,
      tokenURI,
      startTime,
      endTime,
      reservePrice,
      minBidIncrement,
      highestBidder,
      highestBid,
      proceedsTo,
      settled,
      live,
    ] = stateRaw as [
      bigint,
      string,
      bigint,
      bigint,
      bigint,
      bigint,
      Address,
      bigint,
      Address,
      boolean,
      boolean,
    ];
    return {
      id,
      tokenURI,
      startTime,
      endTime,
      reservePrice,
      minBidIncrement,
      highestBidder,
      highestBid,
      proceedsTo,
      settled,
      live,
    };
  }, [stateRaw]);

  const endSec = state ? Number(state.endTime) : 0;
  const startSec = state ? Number(state.startTime) : 0;
  const nowSec = useNowSec();
  const isScheduled =
    !!state &&
    !state.settled &&
    startSec > 0 &&
    nowSec < startSec;
  const isEnded =
    !!state &&
    !state.settled &&
    startSec > 0 &&
    nowSec >= endSec;
  const countdownTarget = isScheduled ? startSec : endSec;
  const countdownLeft = Math.max(0, countdownTarget - nowSec);
  const countdownLabel = state?.settled
    ? "Settled"
    : countdownTarget <= 0
      ? "—"
      : countdownLeft === 0
        ? isScheduled
          ? "まもなく開始"
          : "終了"
        : fmtCountdown(countdownLeft);

  const [artUrl, setArtUrl] = useState("");
  const [meta, setMeta] = useState<NftMeta>({});
  const [descOpen, setDescOpen] = useState(false);
  const [artBroken, setArtBroken] = useState(false);
  const [bidHistoryOpen, setBidHistoryOpen] = useState(false);
  const [bidInput, setBidInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!state?.tokenURI) {
        setArtUrl("");
        setMeta({});
        return;
      }
      setArtBroken(false);
      const { meta: m, imageUrl } = await loadMetadata(state.tokenURI);
      if (!cancel) {
        setMeta(m);
        setArtUrl(imageUrl);
        setDescOpen(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [state?.tokenURI]);

  const minNextBid = useMemo(() => {
    if (!state) return 0n;
    // Full standing min (for display of "最低合計")
    const full =
      state.highestBid === 0n
        ? state.reservePrice > 0n
          ? state.reservePrice
          : state.minBidIncrement
        : state.highestBid + state.minBidIncrement;
    return full;
  }, [state]);

  /** ETH to send this tx (uses on-chain credit when available) */
  const minSend = useMemo(() => {
    if (minMsgValue != null && typeof minMsgValue === "bigint") {
      if (minMsgValue > 10n ** 30n) return minNextBid; // max = inactive
      return minMsgValue;
    }
    const credit = (pending as bigint | undefined) ?? 0n;
    if (!state) return 0n;
    const isHigh =
      address &&
      state.highestBidder &&
      address.toLowerCase() === state.highestBidder.toLowerCase() &&
      state.highestBid > 0n;
    if (isHigh) return state.minBidIncrement;
    if (credit >= minNextBid) return 0n;
    return minNextBid > credit ? minNextBid - credit : 0n;
  }, [minMsgValue, pending, state, address, minNextBid]);

  useEffect(() => {
    if (minSend >= 0n) {
      setBidInput(formatEther(minSend));
    }
  }, [minSend]);

  const { writeContract, data: txHash, isPending: writing, reset: resetWrite } =
    useWriteContract();
  const { isLoading: confirming, isSuccess: confirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (confirmed) {
      setStatus("トランザクション確認済み");
      refetchState();
      resetWrite();
    }
  }, [confirmed, refetchState, resetWrite]);

  const ensureChain = useCallback(async () => {
    if (chainId !== CHAIN.id) {
      switchChain?.({ chainId: CHAIN.id });
      throw new Error("Base Sepolia に切り替えてください");
    }
  }, [chainId, switchChain]);

  const onBid = async () => {
    try {
      setStatus(null);
      await ensureChain();
      if (!state?.live) {
        setStatus("現在入札できません（終了または未開始）");
        return;
      }
      const value = parseEther(bidInput || "0");
      if (value < minSend) {
        setStatus(
          `今回送る ETH の最低は ${formatEther(minSend)}（預託込みで合計 ${formatEther(minNextBid)}）`
        );
        return;
      }
      writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "bid",
        args: [],
        value,
        chainId: CHAIN.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      setStatus("入札を送信中…");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "入札エラー");
    }
  };

  const onSettle = async () => {
    try {
      setStatus(null);
      await ensureChain();
      writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "settle",
        chainId: CHAIN.id,
      });
      setStatus("settle 送信中…");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "settle エラー");
    }
  };

  const onWithdraw = async () => {
    try {
      setStatus(null);
      await ensureChain();
      writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "withdraw",
        chainId: CHAIN.id,
      });
      setStatus("出金送信中…");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "出金エラー");
    }
  };

  const title =
    meta.name?.trim() ||
    (state && state.id > 0n ? `Bushi #${state.id.toString()}` : "Bushi Collection");
  const lotLabel =
    state && state.id > 0n ? `Bushi Collection · #${state.id.toString()}` : null;
  const attrs = (meta.attributes || []).filter(
    (a) => a && (a.trait_type || a.value !== undefined)
  );
  const desc = (meta.description || "").trim();
  const { preview: descPreview, hasMore: descHasMore } = useMemo(
    () => splitDescription(desc),
    [desc]
  );
  const descShown = descOpen ? desc : descPreview;
  const canSettle = isEnded;
  const showBid = state?.live === true;
  const pendingAmt = (pending as bigint | undefined) ?? 0n;
  // New lot only when none active (never started or already settled)
  const canCreateAuction =
    !state || state.startTime === 0n || state.settled === true;

  const TraitsGrid = attrs.length > 0 && (
    <div className="traits" aria-label="プロパティ">
      {attrs.map((a, i) => (
        <div className="trait" key={`${a.trait_type}-${i}`}>
          <span className="trait-type">{a.trait_type || "Trait"}</span>
          <span className="trait-value">{String(a.value ?? "—")}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo">武</span>
          <div>
            <div className="brand-name">Bushi Collection</div>
            <div className="brand-sub">Base Sepolia · English Auction</div>
          </div>
        </div>
        <nav className="nav">
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((t) => toggleTheme(t))}
            aria-label={theme === "dark" ? "陽モード" : "陰モード"}
            title={theme === "dark" ? "陽" : "陰"}
          >
            {theme === "dark" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                <circle cx="12" cy="12" r="3.6" />
                <path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6.1 6.1l1.3 1.3M16.6 16.6l1.3 1.3M6.1 17.9l1.3-1.3M16.6 7.4l1.3-1.3" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                <path d="M18.5 14.2A7.2 7.2 0 0 1 9.8 5.5 6.6 6.6 0 1 0 18.5 14.2Z" />
              </svg>
            )}
            <span className="theme-yin-yang" aria-hidden>
              {theme === "dark" ? "陽" : "陰"}
            </span>
          </button>
          <a
            href={`${EXPLORER}/address/${COLLECTION_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
          >
            Collection
          </a>
          <a
            href={`${EXPLORER}/address/${AUCTION_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
          >
            Auction
          </a>
          {!isConnected ? (
            <button
              className="btn primary"
              disabled={connecting}
              onClick={() => connect({ connector: connectors[0] })}
            >
              {connecting ? "…" : "接続する"}
            </button>
          ) : (
            <button className="btn ghost" onClick={() => disconnect()}>
              {shortAddr(address)}
            </button>
          )}
        </nav>
      </header>

      <main className="hero">
        <section className="art-panel">
          {artUrl && !artBroken ? (
            <img
              src={artUrl}
              alt={title}
              className="art"
              onError={() => setArtBroken(true)}
            />
          ) : (
            <div className="art placeholder">
              <div className="ph-mark">武</div>
              <p>
                {state?.tokenURI
                  ? "メタデータ画像を読み込み中 / プレースホルダ"
                  : "オークション待機中"}
              </p>
              {state?.tokenURI && (
                <a href={arweaveToHttp(state.tokenURI)} target="_blank" rel="noreferrer">
                  URI を開く
                </a>
              )}
            </div>
          )}
        </section>

        {/* Mobile: properties under artwork */}
        {attrs.length > 0 && (
          <details className="props-acc props-mobile">
            <summary>プロパティ</summary>
            {TraitsGrid}
          </details>
        )}

        <section className="side">
          <p className="eyebrow">
            {state?.live
              ? "ライブオークション"
              : state?.settled
                ? "落札済み"
                : isScheduled
                  ? "開始予定"
                  : isEnded
                    ? "終了 — settle 待ち"
                    : state && state.startTime > 0n
                      ? "終了 — settle 待ち"
                      : "準備中"}
          </p>
          {lotLabel && <p className="lot-label">{lotLabel}</p>}
          <h1>{title}</h1>

          {state && state.startTime > 0n && (
            <div className="time-jst-block">
              <div>
                <span className="time-jst-label">開始</span>{" "}
                <strong>{fmtJst(state.startTime)}</strong>
              </div>
              <div>
                <span className="time-jst-label">終了</span>{" "}
                <strong>{fmtJst(state.endTime)}</strong>
              </div>
            </div>
          )}

          {desc && (
            <div className="meta-desc">
              <p className="meta-desc-text">{descShown}</p>
              {descHasMore && (
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setDescOpen((v) => !v)}
                >
                  {descOpen ? "閉じる" : "もっと見る"}
                </button>
              )}
            </div>
          )}

          <div className="stat-block">
            <div className="stat-label">現在の入札額</div>
            <div className="stat-value">
              Ξ {state ? formatEther(state.highestBid) : "—"}
            </div>
            <div className="stat-meta">
              最高入札者 {shortAddr(state?.highestBidder)}
            </div>
            {state && state.id > 0n && (
              <button
                type="button"
                className="bid-history-btn"
                onClick={() => setBidHistoryOpen(true)}
              >
                <span className="bid-history-ico" aria-hidden>
                  ≡
                </span>
                入札履歴
              </button>
            )}
          </div>

          <div className="stat-block">
            <div className="stat-label">
              {state?.settled
                ? "ステータス"
                : isScheduled
                  ? "オークション開始まで"
                  : state?.live
                    ? "オークション終了まで"
                    : isEnded
                      ? "ステータス"
                      : "カウントダウン"}
            </div>
            <div className="stat-value countdown">
              {state?.settled
                ? "Settled"
                : isEnded
                  ? "終了 · settle 待ち"
                  : countdownLabel}
            </div>
          </div>

          {isScheduled && (
            <p className="schedule-note">
              開始時刻になると自動で入札可能になります（運営の操作不要）。
              初回入札でオンチェーン記録を残そう。
            </p>
          )}

          {showBid && (
            <div className="bid-row">
              <div className="bid-head">
                <span className="bid-label">入札（送金額）</span>
                <span className="bid-hint">
                  今回最低 {formatEther(minSend)} ETH
                  {pendingAmt > 0n && (
                    <> · 預託 {formatEther(pendingAmt)} ETH を加算</>
                  )}
                  {state && state.minBidIncrement > 0n && (
                    <> · 刻み {formatEther(state.minBidIncrement)}</>
                  )}
                </span>
              </div>
              {pendingAmt > 0n && (
                <p className="bid-credit-note">
                  預託 {formatEther(pendingAmt)} + 送金 → 合計入札{" "}
                  {formatEther(minNextBid)} ETH 以上でトップに。
                  入札すると預託は新しい入札に使われます（引き出さず戦えます）。
                </p>
              )}
              <div className="bid-input-wrap">
                <span className="eth">Ξ</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={bidInput}
                  onChange={(e) => setBidInput(e.target.value)}
                  aria-label="入札額 ETH"
                  placeholder={formatEther(minSend)}
                />
              </div>
              <button
                className="btn primary wide"
                disabled={!isConnected || writing || confirming}
                onClick={onBid}
              >
                {writing || confirming
                  ? "処理中…"
                  : pendingAmt > 0n
                    ? "追加入札する"
                    : "入札する"}
              </button>
            </div>
          )}

          {/* Desktop: properties accordion in side rail */}
          {attrs.length > 0 && (
            <details className="props-acc props-desktop">
              <summary>プロパティ</summary>
              {TraitsGrid}
            </details>
          )}

          {canSettle && (
            <button
              className="btn accent wide"
              disabled={!isConnected || writing || confirming}
              onClick={onSettle}
            >
              settle（ミント実行）
            </button>
          )}

          {pendingAmt > 0n && (
            <button
              className="btn ghost wide"
              disabled={!isConnected || writing}
              onClick={onWithdraw}
            >
              預託を引き出す · {formatEther(pendingAmt)} ETH
            </button>
          )}

          {chainId && chainId !== CHAIN.id && isConnected && (
            <button
              className="btn warn wide"
              onClick={() => switchChain?.({ chainId: CHAIN.id })}
            >
              Base Sepolia に切替
            </button>
          )}

          {status && <p className="status">{status}</p>}
          {stateErr && (
            <p className="status err">
              読み込みエラー: {String(stateError?.message || stateErr)}
            </p>
          )}
          {txHash && (
            <p className="status">
              <a href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">
                Tx {txHash.slice(0, 10)}…
              </a>
            </p>
          )}

          <dl className="details">
            <div>
              <dt>minted</dt>
              <dd>{totalMinted != null ? String(totalMinted) : "—"} / 12</dd>
            </div>
            <div>
              <dt>reserve</dt>
              <dd>{state ? formatEther(state.reservePrice) : "—"} ETH</dd>
            </div>
            <div>
              <dt>proceeds</dt>
              <dd>{shortAddr(state?.proceedsTo)}</dd>
            </div>
          </dl>
        </section>
      </main>

      <AdminCreateAuction
        canCreate={canCreateAuction}
        onCreated={() => {
          refetchState();
        }}
      />

      <BidHistoryModal
        currentAuctionId={state?.id ?? 0n}
        currentTokenURI={state?.tokenURI}
        currentTitle={meta.name || title}
        currentImage={artUrl || undefined}
        open={bidHistoryOpen}
        onClose={() => setBidHistoryOpen(false)}
      />

      <section className="about">
        <h2>これはなに？</h2>
        <p>
          <strong>Bushi Collection</strong> は Base 上の English
          オークションです。1点ずつ出品され、最高入札者が settle 後に NFT
          を受け取ります。売上はアーティストへ 100%（ロット作成時に固定）。
        </p>
        <details>
          <summary>まとめ</summary>
          <ul>
            <li>入札は誰でも可能（Gi 不要）</li>
            <li>標準期間 3 日 · 終了間際は <strong>+6 分加算</strong>（アンチスナイプ）</li>
            <li>更新入札で前の入札者の ETH は<strong>預託</strong>に · 差分だけの追加入札 or 引出</li>
            <li>終了後、誰でも <code>settle</code> 可能 → ミント + 支払い</li>
          </ul>
        </details>
      </section>

      <footer className="foot">
        <span>Proof of Gi · BushiDAO</span>
        <span>Chain ID {CHAIN.id}</span>
      </footer>
    </div>
  );
}
