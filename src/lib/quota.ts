/** Free 账号上游用 9999-12-31 表示永不过期，不能当成真实日期展示 */
const PERMANENT_EXPIRY_MS = Date.UTC(2100, 0, 1);

export function isPermanentExpiry(ts: number | null | undefined): boolean {
  return ts == null || !Number.isFinite(ts) || ts <= 0 || ts >= PERMANENT_EXPIRY_MS;
}

export interface QuotaLike {
  total?: number | null;
  used?: number | null;
  remaining?: number | null;
  percentage?: number | null;
}

/** 是否有真实额度数据（Free 账号可能是 0/0，不能据此算出 100% 剩余） */
export function hasQuotaData(q: QuotaLike | null | undefined): boolean {
  if (!q) return false;
  return (q.total ?? 0) > 0 || (q.used ?? 0) > 0 || (q.remaining ?? 0) > 0;
}

/** 剩余比例；上游 percentage 是「已用比例」 */
export function remainingPercent(q: QuotaLike | null | undefined): number | null {
  if (!q) return null;
  if ((q.total ?? 0) > 0 && q.remaining != null) {
    return clamp((q.remaining / q.total!) * 100);
  }
  if (typeof q.percentage === "number" && hasQuotaData(q)) {
    const used = q.percentage <= 1 ? q.percentage : q.percentage / 100;
    return clamp((1 - used) * 100);
  }
  return null;
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}
