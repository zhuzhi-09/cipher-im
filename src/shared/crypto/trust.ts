/**
 * 安全码信任状态机（纯函数，UI 和单测共用）
 *
 * 三态：
 *   unverified  未核对 —— 从没点过「标记已验证」
 *   verified    已验证 —— 记录的安全码和当前公钥算出来的一致
 *   changed     已变更 —— 记录过，但现在算出来的不一样（对端换了密钥/设备冒名）
 *
 * 注意「已变更」不是不可恢复：重新核对、确认是新密钥之后可以再标为已验证。
 */
export type TrustState = 'verified' | 'changed' | 'unverified';

export interface TrustRecord {
  safety: string; // 上次核对时记录的安全码
  state: 'verified' | 'changed';
  at: number;
}

export function trustState(currentSafety: string, entry?: TrustRecord | null): TrustState {
  if (!entry) return 'unverified';
  if (entry.state === 'changed') return 'changed';
  return entry.safety === currentSafety ? 'verified' : 'changed';
}

/** 记录一次核对结果 */
export function markVerified(currentSafety: string, now = Date.now()): TrustRecord {
  return { safety: currentSafety, state: 'verified', at: now };
}
