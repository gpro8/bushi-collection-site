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
import { fmtJst, jstLocalInputToUnix } from "./timeJst";

type Props = {
  canCreate: boolean;
  onCreated?: () => void;
};

const DURATION_PRESETS: { label: string; seconds: number }[] = [
  { label: "既定 (3日)", seconds: 0 },
  { label: "5分 (テスト)", seconds: 300 },
  { label: "1時間", seconds: 3600 },
  { label: "3日", seconds: 3 * 24 * 3600 },
];

type StartMode = "now" | "hours" | "jst";

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
  const [startMode, setStartMode] = useState<StartMode>("now");
  const [startHours, setStartHours] = useState("1");
  const [startJst, setStartJst] = useState("");
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

  const previewStartUnix = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    if (startMode === "now") return now;
    if (startMode === "hours") {
      const h = Number(startHours);
      if (!Number.isFinite(h) || h < 0) return null;
      return now + Math.floor(h * 3600);
    }
    return jstLocalInputToUnix(startJst);
  }, [startMode, startHours, startJst]);

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

      let startAt = 0n;
      if (startMode === "now") {
        startAt = 0n;
      } else if (startMode === "hours") {
        const h = Number(startHours);
        if (!Number.isFinite(h) || h <= 0) {
          setMsg("開始までの時間を正しく入力してください");
          return;
        }
        startAt = BigInt(Math.floor(Date.now() / 1000) + Math.floor(h * 3600));
      } else {
        const u = jstLocalInputToUnix(startJst);
        if (u == null) {
          setMsg("開始日時 (JST) を入力してください");
          return;
        }
        if (u <= Math.floor(Date.now() / 1000)) {
          setMsg("開始日時は現在より後にしてください");
          return;
        }
        startAt = BigInt(u);
      }

      const reserve = parseEther(reserveEth || "0");
      const minInc = parseEther(minIncEth || "0");
      writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "createAuction",
        args: [uri, startAt, BigInt(durationSec), reserve, minInc],
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
            オーナーのみ。開始時刻を今すぐ / N時間後 / JST日時で予約できます。
            チェーンは UTC unix · 表示は JST。期間 0 = 既定 3日。増分 0 = 0.01 ETH。
            予約後は開始時刻になると<strong>自動で入札可能</strong>（あなたがオンライン不要）。
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

          <fieldset className="field start-mode">
            <legend>開始タイミング</legend>
            <label className="radio">
              <input
                type="radio"
                checked={startMode === "now"}
                onChange={() => setStartMode("now")}
              />
              今すぐ
            </label>
            <label className="radio">
              <input
                type="radio"
                checked={startMode === "hours"}
                onChange={() => setStartMode("hours")}
              />
              N 時間後
            </label>
            {startMode === "hours" && (
              <input
                type="number"
                min={0.1}
                step={0.5}
                value={startHours}
                onChange={(e) => setStartHours(e.target.value)}
                placeholder="例: 24"
                style={{ maxWidth: "8rem" }}
              />
            )}
            <label className="radio">
              <input
                type="radio"
                checked={startMode === "jst"}
                onChange={() => setStartMode("jst")}
              />
              JST 日時
            </label>
            {startMode === "jst" && (
              <input
                type="datetime-local"
                value={startJst}
                onChange={(e) => setStartJst(e.target.value)}
              />
            )}
            {previewStartUnix != null && (
              <p className="admin-preview">
                開始予定: <strong>{fmtJst(previewStartUnix)}</strong>
              </p>
            )}
          </fieldset>

          <label className="field">
            <span>入札期間（開始後）</span>
            <select
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
            >
              {DURATION_PRESETS.map((p) => (
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
