/** JST (Asia/Tokyo) display helpers — chain stores UTC unix */

export function fmtJst(unixSec: number | bigint): string {
  const ms = Number(unixSec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST`;
}

/** Convert a datetime-local value interpreted as JST → unix seconds UTC */
export function jstLocalInputToUnix(localValue: string): number | null {
  // localValue: "YYYY-MM-DDTHH:mm"
  if (!localValue || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(localValue)) {
    return null;
  }
  const [date, time] = localValue.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  // JST = UTC+9 fixed (no DST)
  const utcMs = Date.UTC(y, m - 1, d, hh - 9, mm, 0);
  if (!Number.isFinite(utcMs)) return null;
  return Math.floor(utcMs / 1000);
}

export function fmtCountdown(sec: number): string {
  if (sec <= 0) return "0";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}日 ${h}時間 ${m}分`;
  if (h > 0) return `${h}時間 ${m}分 ${s}秒`;
  return `${m}分 ${s}秒`;
}
