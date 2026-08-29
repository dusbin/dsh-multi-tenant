/**
 * 租户可见性（V2 增补）：工作区与会话列表按角色/租户过滤。
 *
 * 规则（用户要求）：
 *  - 平台管理员（system）：查看所有工作区和会话/任务
 *  - 租户管理员 / 审计员：仅本租户（`t-<tid>` 前缀匹配）
 *  - 使用者：仅本人（`u-<uid>-t-<tid>-s-` 精确前缀）
 *  - 无归属前缀的会话（插件安装前遗留）：仅平台管理员可见
 *
 * 实现位置：网关对列表类 /api 端点（session.list / session.search /
 * workspace.list）的响应做前缀过滤——列表是侧栏可见性的唯一真源。
 *
 * 已知边界：events.mux 下行 WS 帧不在本层过滤（客户端只渲染列表内的会话，
 * 且网关已拦截对他人会话的 open/attach）；如需帧级过滤需 WS 消息层解析。
 */

import { parseSessionPrefix } from './ownership.js';

/** 会话是否对当前用户可见 */
export function sessionVisible(sessionId, user) {
  if (!user) return false;
  if (user.role === 'system') return true; // 平台管理员：全部
  const attr = parseSessionPrefix(sessionId);
  if (!attr) return false; // 无归属 → 仅平台管理员可见
  const userTid = user.tenant_id ?? user.tenantId ?? null;
  if (attr.tid !== userTid) return false; // 他租户
  if (user.role === 'user') return attr.uid === user.id; // 使用者仅本人
  return true; // 租户管理员 / 审计员：本租户全部
}

/** 过滤一个工作区行：裁剪 sessionIds，无可见会话则整个隐藏 */
export function filterWorkspaceRow(row, user) {
  if (user.role === 'system') return row;
  if (!Array.isArray(row?.sessionIds)) return null;
  const visible = row.sessionIds.filter((sid) => sessionVisible(sid, user));
  if (visible.length === 0) return null;
  return { ...row, sessionIds: visible };
}

/**
 * 按端点过滤列表响应值。返回过滤后的值；无法识别形状时返回原值。
 * 支持：
 *  - session.list   → { items: SessionSummary[] }
 *  - session.search → { items: SessionSearchItem[] }
 *  - workspace.list → { workspaces: WorkspaceView[] } | WorkspaceView[]
 */
export function filterListValue(endpoint, value, user) {
  if (user.role === 'system') return value; // 平台管理员不过滤
  if (!value || typeof value !== 'object') return value;

  if (endpoint === 'session.list' || endpoint === 'session.search') {
    if (Array.isArray(value.items)) {
      return { ...value, items: value.items.filter((it) => it && sessionVisible(it.sessionId, user)) };
    }
    return value;
  }

  if (endpoint === 'workspace.list') {
    // 真实响应形状：{ items: WorkspaceView[], archivedSessionIds: SessionId[] }
    if (Array.isArray(value.items)) {
      const filtered = value.items.map((w) => filterWorkspaceRow(w, user)).filter(Boolean);
      const archived = Array.isArray(value.archivedSessionIds)
        ? value.archivedSessionIds.filter((sid) => sessionVisible(sid, user))
        : value.archivedSessionIds;
      return { ...value, items: filtered, archivedSessionIds: archived };
    }
    // 兼容其他形状
    if (Array.isArray(value.workspaces)) {
      const filtered = value.workspaces.map((w) => filterWorkspaceRow(w, user)).filter(Boolean);
      return { ...value, workspaces: filtered };
    }
    if (Array.isArray(value)) {
      return value.map((w) => filterWorkspaceRow(w, user)).filter(Boolean);
    }
    return value;
  }

  return value;
}

/**
 * WS 下行帧过滤（host/events.mux 与 host/events.host）：
 * 只把当前用户可见的帧转发给浏览器，否则丢弃。
 *  - 带 sessionId 的帧（mux 会话帧 / host/session-*）→ 按会话归属
 *  - host/workspace-changed → 按工作区可见会话裁剪（全不可见则丢弃）
 *  - host/workspace-removed / workspace-order-changed → 非平台管理员丢弃（无归属信息）
 *  - host/archived-sessions-changed → 裁剪 archivedSessionIds
 * 返回 null 表示丢弃该帧。
 */
export function filterDownlinkPayload(payload, user) {
  if (!user || user.role === 'system') return payload; // 平台管理员：全部
  if (!payload || typeof payload !== 'object') return payload;
  const type = payload.type;

  if (typeof payload.sessionId === 'string') {
    return sessionVisible(payload.sessionId, user) ? payload : null;
  }
  if (type === 'host/workspace-changed' && payload.workspace) {
    const row = filterWorkspaceRow(payload.workspace, user);
    return row ? { ...payload, workspace: row } : null;
  }
  if (type === 'host/workspace-removed' || type === 'host/workspace-order-changed') {
    return null; // 无会话归属信息 → 非平台管理员不可见
  }
  if (type === 'host/archived-sessions-changed' && Array.isArray(payload.archivedSessionIds)) {
    return { ...payload, archivedSessionIds: payload.archivedSessionIds.filter((sid) => sessionVisible(sid, user)) };
  }
  return payload;
}
