import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from "wagmi";
import { parseEther } from "viem";
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  CHAIN,
  EXPLORER,
} from "./config";

type Props = {
  /** Current lot settled or never started → can create */
  canCreate: boolean;
  onCreated?: () => void;
};

const PRESETS: { label: string; seconds: number }[] = [
  { label: "既定 (3日)", seconds: 0 },
  { label: "5分 (テスト)", seconds: 300 },
  { label: "1時間", seconds: 3600 },
  { label: "3日", seconds: 3 * 24 * 3600 },
];

export function AdminCreateAuction({ canCreate, onCreated }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  const { data: owner } = useReadContract({
    address: AUCTION_ADDRESS,
    abi: AUCTION_ABI,
    functionName: "owner",
    chainId: CHAIN.id,
  });

  const isOwner = useMemo(() => {
    if (!address || !owner) return false;
    return String(owner).toLowerCase() === address.toLowerCase();
  }, [address, owner]);

  const [open, setOpen] = useState(false);
  const [tokenURI, setTokenURI] = useState("");
  const [durationSec, setDurationSec] = useState(0);
  const [reserveEth, setReserveEth] = useState("0");
  const [minIncEth, setMinIncEth] = useState("0");
  const [msg, setMsg] = useState<string | null>(null);

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    if (isSuccess) {
      setMsg("createAuction 確認済み");
      setTokenURI("");
      onCreated?.();
      reset();
    }
  }, [isSuccess, onCreated, reset]);

  if (!isConnected || !isOwner) return null;

  const onSubmit = async () => {
    try {
      setMsg(null);
      if (chainId !== CHAIN.id) {
        switchChain?.({ chainId: CHAIN.id });
        setMsg("Base Sepolia に切り替えて再実行してください");
        return;
      }
      if (!canCreate) {
        setMsg("アクティブなオークションがあります。settle 後に作成できます。");
        return;
      }
      const uri = tokenURI.trim();
      if (!uri) {
        setMsg("tokenURI を入力してください (ar://… または https://…)");
        return;
      }
      const reserve = parseEther(reserveEth || "0");
      const minInc = parseEther(minIncEth || "0");
      writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "createAuction",
        args: [uri, BigInt(durationSec), reserve, minInc],
        chainId: CHAIN.id,
      } as any);
      setMsg("createAuction 送信中…");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "エラー");
    }
  };

  return (
    <section className="admin">
      <button
        type="button"
        className="admin-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        🛠 Admin · createAuction {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="admin-body">
          <p className="admin-hint">
            オーナーのみ表示。URI は最終メタデータ（JSON）を推奨。期間 0 =
            コントラクト既定（3日）。最小入札増分 0 = 既定 0.01 ETH。
          </p>
          {!canCreate && (
            <p className="status err">
              進行中のロットがあります — settle 完了後に新規作成できます。
            </p>
          )}
          <label className="field">
            <span>tokenURI</span>
            <input
              value={tokenURI}
              onChange={(e) => setTokenURI(e.target.value)}
              placeholder="ar://… or ipfs://… or https://…"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>期間</span>
            <select
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
            >
              {PRESETS.map((p) => (
                <option key={p.label} value={p.seconds}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="field-row">
            <label className="field">
              <span>reserve (ETH)</span>
              <input
                value={reserveEth}
                onChange={(e) => setReserveEth(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label className="field">
              <span>min increment (ETH, 0=default)</span>
              <input
                value={minIncEth}
                onChange={(e) => setMinIncEth(e.target.value)}
                inputMode="decimal"
              />
            </label>
          </div>
          <button
            className="btn primary wide"
            disabled={!canCreate || isPending || confirming}
            onClick={onSubmit}
          >
            {isPending || confirming ? "処理中…" : "オークションを作成"}
          </button>
          {msg && <p className="status">{msg}</p>}
          {txHash && (
            <p className="status">
              <a
                href={`${EXPLORER}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                Tx {txHash.slice(0, 12)}…
              </a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
