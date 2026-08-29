/**
 * 会话归属：SessionId 前缀编码（M2，D1 租户隔离 + 按用户隔离）。
 *
 * 规范格式：`u-<userId>-t-<tenantId|sys>-s-<uuid>`。
 *  - 会话创建时由网关强制改写（客户端无法伪造他人前缀）
 *  - 会话作用域请求校验前缀 == 当前登录用户（越权即 403 + 审计）
 *  - 后续里程碑（M3 计量）按前缀归集用量
 */

import { randomUUID } from 'node:crypto';

/** 生成归属前缀：`u-<uid>-t-<tid>-s-`（兼容原始行 tenant_id 与视图 tenantId） */
export function sessionIdPrefix(user) {
  const tid = user.tenant_id ?? user.tenantId;
  return `u-${user.id}-t-${tid ?? 'sys'}-s-`;
}

/** 生成完整 SessionId */
export function newOwnedSessionId(user) {
  return `${sessionIdPrefix(user)}${randomUUID()}`;
}

/** 解析前缀 → {uid, tid} | null */
export function parseSessionPrefix(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const m = /^u-(\d+)-t-([a-z0-9]+)-s-/.exec(sessionId);
  if (!m) return null;
  return { uid: Number(m[1]), tid: m[2] === 'sys' ? null : Number(m[2]) };
}

/** 该 SessionId 是否属于当前用户（前缀精确匹配） */
export function ownsSession(user, sessionId) {
  if (typeof sessionId !== 'string') return false;
  return sessionId.startsWith(sessionIdPrefix(user));
}

/** 检查 payload 中的 sessionId 归属；method==='session.create' 时强制改写。 */
export function enforceSessionOwnership(user, method, payload) {
  if (!payload || typeof payload !== 'object') return { ok: true, payload };
  const sid = payload.sessionId;
  if (method === 'session.create') {
    // 创建：若客户端带 id 则强制前缀；未带则注入（可让宿主沿用或忽略，见下）
    if (sid === undefined || sid === null || sid === '') {
      return { ok: true, payload: { ...payload, sessionId: newOwnedSessionId(user) } };
    }
    if (ownsSession(user, sid)) return { ok: true, payload };
    return { ok: true, payload: { ...payload, sessionId: newOwnedSessionId(user) } };
  }
  // 其他会话作用域方法：校验前缀
  if (sid !== undefined && sid !== null) {
    if (typeof sid !== 'string' || !ownsSession(user, sid)) {
      return { ok: false, reason: 'session ownership mismatch' };
    }
  }
  return { ok: true, payload };
}
