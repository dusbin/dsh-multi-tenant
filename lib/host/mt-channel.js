/**
 * /mt 管理通道：多租户管理 API（M2）。
 *
 * 通道形态：注册在 DSH webserver 上的 `/mt` prefix 路由（不走 /api 的
 * Typert 单座位 interceptor，也不受 settings 写路径 loopback 钉扎影响）。
 * 客户端经 `ctx.connection.rpc.call('/mt', endpoint, payload)` 调用：
 *   POST /mt/<endpoint>  body {type:'client-request', rpcId, method, payload}
 *   响应 body {type:'server-response', rpcId, result: {ok, value|error}}
 *
 * 认证：请求到达时（经网关代理或本机直连），从 Cookie 头重新校验会话
 * （纵深防御；网关层另有第一道登录检查）。权限按 RBAC 端点级强制。
 *
 * 端点（M2）：
 *   me                      当前用户 + 租户信息          [任意已登录]
 *   auth.changePassword     修改本人密码                 [任意已登录]
 *   tenant.list / create / setStatus / delete   租户管理  [system]
 *   user.list               用户列表（租户内）           [admin+]
 *   user.create / setStatus / setRole / setPassword / delete [admin+，租户内]
 * 端点（M3）：
 *   usage.summary / usage.sessions   用量统计            [auditor+ 租户内，user 仅本人]
 *   quota.view / quota.set / quota.clear                 [view: 任意；set/clear: admin+]
 */

import { hashPassword, validatePasswordStrength, validateUsername, verifyPassword } from './crypto.js';
import { assignableRoles, canAccessTenant, canManageUser, hasRole, isSystem, validateRole } from './rbac.js';
import { periodStart as quotaPeriodStart } from './quota.js';
/** RPC 业务错误码（对应 RpcResult.error.code） */
export const MT_ERRORS = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  INVALID_INPUT: 'invalid-input',
  CONFLICT: 'conflict',
  INTERNAL: 'internal',
};

function deny(error) {
  return { ok: false, error: { code: error.code, message: error.message } };
}

function okValue(value) {
  return { ok: true, value };
}

function userView(user) {
  return {
    id: user.id,
    tenantId: user.tenant_id ?? null,
    username: user.username,
    email: user.email ?? null,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at ?? null,
    lastLoginIp: user.last_login_ip ?? null,
  };
}

/**
 * 创建 /mt 通道。
 * @param {object} deps
 * @param {ReturnType<import('./db.js').createStore>} deps.store
 * @param {ReturnType<import('./auth-service.js').createAuthService>} deps.authService
 * @param {ReturnType<import('./quota.js').createQuotaService>} [deps.quotaService]
 */
export function createMtChannel({ store, authService, quotaService }) {
  /**
   * 纯逻辑分发：认证已在路由层完成（auth = {user}）。
   * @param {string} endpoint  如 'user.list'
   * @param {unknown} payload
   * @param {object} auth      {user}
   * @returns {{ok: boolean, value?: unknown, error?: {code, message}}}
   */
  function dispatch(endpoint, payload, auth) {
    if (!auth || !auth.user) return deny({ code: MT_ERRORS.UNAUTHENTICATED, message: 'not authenticated' });
    const { user } = auth;
    const p = (payload && typeof payload === 'object') ? payload : {};

    // ---- 作用域辅助（M3）----
    // 用量查询作用域：system 任意；auditor/admin 本租户；user 强制本人
    const resolveTenantScope = (tenantId) => {
      if (user.role === 'system') return tenantId === undefined || tenantId === null ? undefined : Number(tenantId);
      const own = user.tenant_id ?? user.tenantId;
      if (tenantId === undefined || tenantId === null) return own;
      return Number(tenantId) === own ? own : false;
    };
    const resolveUserScope = (userId) => {
      if (userId === undefined || userId === null) {
        return user.role === 'user' ? user.id : undefined;
      }
      const targetId = Number(userId);
      if (user.role === 'system') return targetId;
      if (user.role === 'user') return targetId === user.id ? targetId : false;
      const target = store.getUserById(targetId);
      if (!target) return false;
      return canAccessTenant(user, target.tenant_id) ? targetId : false;
    };
    const periodRange = (period) => {
      const d = new Date();
      if (period === 'day') { d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: undefined }; }
      if (period === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: undefined }; }
      return { from: undefined, to: undefined };
    };
    const rowToUsage = (row) => ({
      requestCount: row.request_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      totalTokens: row.total_tokens,
    });
    // 审计作用域：system 任意；auditor/admin 本租户（不可指定他租户）
    const resolveAuditTenant = (tenantId) => {
      if (user.role === 'system') return tenantId === undefined || tenantId === null ? null : Number(tenantId);
      const own = user.tenant_id ?? user.tenantId;
      if (tenantId === undefined || tenantId === null) return own;
      return Number(tenantId) === own ? own : false;
    };
    const safeParseJson = (text) => {
      try { return JSON.parse(text || '{}'); } catch { return {}; }
    };

    try {
      switch (endpoint) {
        // ---------------- me ----------------
        case 'me': {
          const userTenantId = user.tenant_id ?? user.tenantId;
          const tenant = userTenantId !== null && userTenantId !== undefined ? store.getTenant(userTenantId) : null;
          return okValue({ user: userView(user), tenant: tenant ? { id: tenant.id, name: tenant.name, status: tenant.status } : null });
        }

        // ---------------- auth.changePassword ----------------
        case 'auth.changePassword': {
          const { oldPassword, newPassword } = p;
          if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
            return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'oldPassword and newPassword required' });
          }
          const stored = store.getUserById(user.id);
          if (!stored || !verifyPassword(oldPassword, stored.password_hash)) {
            return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'current password is incorrect' });
          }
          const passError = validatePasswordStrength(newPassword);
          if (passError) return deny({ code: MT_ERRORS.INVALID_INPUT, message: passError });
          store.setUserPasswordHash(user.id, hashPassword(newPassword));
          store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id ?? user.tenantId, action: 'auth.change-password', result: 'success' });
          return okValue({ changed: true });
        }

        // ---------------- tenant.*（system）----------------
        case 'tenant.list': {
          if (!isSystem(user)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'platform admin required' });
          const tenants = store.listTenants();
          return okValue({ tenants: tenants.map((t) => ({ id: t.id, name: t.name, status: t.status, createdAt: t.created_at })) });
        }

        case 'tenant.create': {
          if (!isSystem(user)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'platform admin required' });
          const name = typeof p.name === 'string' ? p.name.trim() : '';
          if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}$/.test(name)) {
            return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'invalid tenant name (1-64 chars, letters/digits/_/-/CJK)' });
          }
          if (store.getTenantByName(name)) return deny({ code: MT_ERRORS.CONFLICT, message: 'tenant name already exists' });
          const id = store.createTenant({ name });
          store.writeAudit({ actorUserId: user.id, action: 'tenant.create', targetType: 'tenant', targetId: String(id), detail: { name }, result: 'success' });
          return okValue({ tenant: { id, name, status: 'active' } });
        }

        case 'tenant.setStatus': {
          if (!isSystem(user)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'platform admin required' });
          const tenant = store.getTenant(Number(p.tenantId));
          if (!tenant) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'tenant not found' });
          if (p.status !== 'active' && p.status !== 'disabled') {
            return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'status must be active|disabled' });
          }
          store.setTenantStatus(tenant.id, p.status);
          store.writeAudit({ actorUserId: user.id, action: 'tenant.setStatus', targetType: 'tenant', targetId: String(tenant.id), detail: { status: p.status }, result: 'success' });
          return okValue({ tenant: { id: tenant.id, name: tenant.name, status: p.status } });
        }

        // ---------------- user.list（admin+，租户内）----------------
        case 'user.list': {
          if (!hasRole(user, 'admin')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'admin required' });
          const targetTenant = p.tenantId === undefined || p.tenantId === null ? (user.tenant_id ?? user.tenantId) : Number(p.tenantId);
          if (!canAccessTenant(user, targetTenant)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'tenant out of scope' });
          const users = store.listUsers(targetTenant);
          return okValue({ users: users.map(userView) });
        }

        // ---------------- user.create（admin+，租户内）----------------
        case 'user.create': {
          if (!hasRole(user, 'admin')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'admin required' });
          const targetTenant = p.tenantId === undefined || p.tenantId === null ? (user.tenant_id ?? user.tenantId) : Number(p.tenantId);
          if (!canAccessTenant(user, targetTenant)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'tenant out of scope' });
          const tenant = store.getTenant(targetTenant);
          if (!tenant) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'tenant not found' });
          if (tenant.status !== 'active') return deny({ code: MT_ERRORS.CONFLICT, message: 'tenant is disabled' });
          const username = typeof p.username === 'string' ? p.username.trim() : '';
          const nameError = validateUsername(username);
          if (nameError) return deny({ code: MT_ERRORS.INVALID_INPUT, message: nameError });
          const passError = validatePasswordStrength(p.password ?? '');
          if (passError) return deny({ code: MT_ERRORS.INVALID_INPUT, message: passError });
          const role = p.role ?? 'user';
          const roleError = validateRole(role);
          if (roleError) return deny({ code: MT_ERRORS.INVALID_INPUT, message: roleError });
          if (!assignableRoles(user).includes(role)) {
            return deny({ code: MT_ERRORS.FORBIDDEN, message: `cannot assign role ${role}` });
          }
          if (store.getUserByUsername(username)) return deny({ code: MT_ERRORS.CONFLICT, message: 'username already exists' });
          if (p.email !== undefined && p.email !== null && p.email !== '') {
            const email = String(p.email).trim();
            if (store.getUserByEmail(email)) return deny({ code: MT_ERRORS.CONFLICT, message: 'email already exists' });
          }
          const id = store.createUser({
            tenantId: targetTenant,
            username,
            email: p.email ? String(p.email).trim() : null,
            passwordHash: hashPassword(String(p.password)),
            role,
          });
          store.writeAudit({ actorUserId: user.id, tenantId: targetTenant, action: 'user.create', targetType: 'user', targetId: String(id), detail: { username, role }, result: 'success' });
          return okValue({ user: userView(store.getUserById(id)) });
        }

        // ---------------- user.setStatus / setRole / setPassword / delete ----------------
        case 'user.setStatus': {
          const target = store.getUserById(Number(p.userId));
          if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
          if (!canManageUser(user, target)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission to manage this user' });
          if (p.status !== 'active' && p.status !== 'disabled' && p.status !== 'locked') {
            return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'status must be active|disabled|locked' });
          }
          store.setUserStatus(target.id, p.status);
          if (p.status === 'disabled' || p.status === 'locked') {
            store.deleteUserSessions(target.id); // 即时失效其会话
          } else if (p.status === 'active') {
            store.clearAttempts(`u:${target.username}`); // 解锁/恢复时清空失败计数
          }
          store.writeAudit({ actorUserId: user.id, tenantId: target.tenant_id, action: 'user.setStatus', targetType: 'user', targetId: String(target.id), detail: { status: p.status }, result: 'success' });
          return okValue({ user: userView(store.getUserById(target.id)) });
        }

        case 'user.setRole': {
          const target = store.getUserById(Number(p.userId));
          if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
          if (!canManageUser(user, target)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission to manage this user' });
          const role = p.role;
          const roleError = validateRole(role);
          if (roleError) return deny({ code: MT_ERRORS.INVALID_INPUT, message: roleError });
          if (!assignableRoles(user).includes(role)) {
            return deny({ code: MT_ERRORS.FORBIDDEN, message: `cannot assign role ${role}` });
          }
          store.setUserRole(target.id, role);
          store.writeAudit({ actorUserId: user.id, tenantId: target.tenant_id, action: 'user.setRole', targetType: 'user', targetId: String(target.id), detail: { role }, result: 'success' });
          return okValue({ user: userView(store.getUserById(target.id)) });
        }

        case 'user.setPassword': {
          const target = store.getUserById(Number(p.userId));
          if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
          if (!canManageUser(user, target)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission to manage this user' });
          const passError = validatePasswordStrength(p.password ?? '');
          if (passError) return deny({ code: MT_ERRORS.INVALID_INPUT, message: passError });
          store.setUserPasswordHash(target.id, hashPassword(String(p.password)));
          store.deleteUserSessions(target.id); // 重置后强制重新登录
          store.writeAudit({ actorUserId: user.id, tenantId: target.tenant_id, action: 'user.setPassword', targetType: 'user', targetId: String(target.id), result: 'success' });
          return okValue({ user: userView(store.getUserById(target.id)) });
        }

        case 'user.delete': {
          const target = store.getUserById(Number(p.userId));
          if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
          if (target.id === user.id) return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'cannot delete yourself' });
          if (!canManageUser(user, target)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission to manage this user' });
          store.deleteUserSessions(target.id);
          store.deleteUser(target.id);
          store.writeAudit({ actorUserId: user.id, tenantId: target.tenant_id, action: 'user.delete', targetType: 'user', targetId: String(target.id), detail: { username: target.username }, result: 'success' });
          return okValue({ deleted: target.id });
        }

        // ---------------- usage.*（M3：auditor+ 租户内只读；user 仅本人）----------------
        case 'usage.summary': {
          if (!hasRole(user, 'auditor')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'auditor+ required' });
          // 作用域：system 可指定任意租户/用户；其他角色仅本租户（user 强制本人）
          const targetTenant = resolveTenantScope(p.tenantId);
          const targetUser = resolveUserScope(p.userId);
          if (targetTenant === false || targetUser === false) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
          const { from, to } = periodRange(p.period);
          const totals = store.aggregateUsage({ from, to, tenantId: targetTenant, userId: targetUser });
          const byUser = targetUser === undefined ? store.aggregateUsageByUser({ from, to, tenantId: targetTenant }) : [];
          return okValue({ totals: rowToUsage(totals), byUser: byUser.map((r) => ({ userId: r.user_id, tenantId: r.tenant_id, ...rowToUsage(r) })) });
        }

        case 'usage.sessions': {
          if (!hasRole(user, 'auditor')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'auditor+ required' });
          const targetTenant = resolveTenantScope(p.tenantId);
          const targetUser = resolveUserScope(p.userId);
          if (targetTenant === false || targetUser === false) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
          const { from, to } = periodRange(p.period);
          const sessions = store.listUsageSessions({ from, to, tenantId: targetTenant, userId: targetUser, limit: Number(p.limit) || 200 });
          return okValue({ sessions: sessions.map((s) => ({
            sessionId: s.session_id, userId: s.user_id, tenantId: s.tenant_id,
            firstTs: s.first_ts, lastTs: s.last_ts, requestCount: s.request_count, model: s.model ?? null,
            ...rowToUsage(s),
          })) });
        }

        // ---------------- quota.*（M3）----------------
        case 'quota.view': {
          if (!quotaService) return deny({ code: MT_ERRORS.INTERNAL, message: 'quota service unavailable' });
          if (p.userId !== undefined && p.userId !== null) {
            // 看他人：admin+ 且可管理/同租户
            if (!hasRole(user, 'admin')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'admin+ required to view others' });
            const target = store.getUserById(Number(p.userId));
            if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
            if (!canAccessTenant(user, target.tenant_id)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
            return okValue(quotaService.view(target));
          }
          if (p.tenantId !== undefined && p.tenantId !== null) {
            // 看指定租户：admin+ 本租户（system 任意）
            const targetTenant = Number(p.tenantId);
            if (!canAccessTenant(user, targetTenant)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
            const limits = store.listQuotas({ scope: 'tenant', targetId: targetTenant });
            const now = Date.now();
            const view = limits.map((q) => {
              const start = quotaPeriodStart(q.period, now);
              const usage = store.getQuotaUsage('tenant', targetTenant, q.period, start);
              return { scope: 'tenant', targetId: targetTenant, period: q.period, tokenLimit: q.token_limit, spent: usage ? usage.spent_tokens : 0 };
            });
            return okValue({ limits: view });
          }
          // 本人：适用限额（user/tenant/platform 叠加）
          return okValue(quotaService.view(user));
        }

        case 'quota.set': {
          if (!quotaService) return deny({ code: MT_ERRORS.INTERNAL, message: 'quota service unavailable' });
          if (!hasRole(user, 'admin')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'admin+ required' });
          const { scope, tokenLimit, period } = p;
          const targetId = Number(p.targetId);
          if (!['platform', 'tenant', 'user'].includes(scope)) return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'invalid scope' });
          if (!['daily', 'monthly', 'total'].includes(period)) return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'invalid period' });
          if (!Number.isInteger(tokenLimit) || tokenLimit < 0) return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'tokenLimit must be a non-negative integer' });
          if (scope === 'platform' && !isSystem(user)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'platform admin required' });
          if (scope === 'tenant') {
            if (!canAccessTenant(user, targetId)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
          }
          if (scope === 'user') {
            const target = store.getUserById(targetId);
            if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
            if (!canManageUser(user, target) && target.id !== user.id) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission' });
          }
          if (tokenLimit === 0) {
            store.deleteQuota({ scope, targetId, period });
            store.writeAudit({ actorUserId: user.id, tenantId: scope === 'tenant' ? targetId : (user.tenant_id ?? user.tenantId), action: 'quota.clear', targetType: scope, targetId: String(targetId), detail: { period }, result: 'success' });
            return okValue({ cleared: { scope, targetId, period } });
          }
          store.upsertQuota({ scope, targetId, tokenLimit, period });
          store.writeAudit({ actorUserId: user.id, tenantId: scope === 'tenant' ? targetId : (user.tenant_id ?? user.tenantId), action: 'quota.set', targetType: scope, targetId: String(targetId), detail: { period, tokenLimit }, result: 'success' });
          return okValue({ quota: { scope, targetId, period, tokenLimit } });
        }

        case 'quota.clear': {
          if (!hasRole(user, 'admin')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'admin+ required' });
          const { scope, period } = p;
          const targetId = Number(p.targetId);
          if (!['platform', 'tenant', 'user'].includes(scope)) return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'invalid scope' });
          if (!['daily', 'monthly', 'total'].includes(period)) return deny({ code: MT_ERRORS.INVALID_INPUT, message: 'invalid period' });
          if (scope === 'platform' && !isSystem(user)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'platform admin required' });
          if (scope === 'tenant' && !canAccessTenant(user, targetId)) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
          if (scope === 'user') {
            const target = store.getUserById(targetId);
            if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
            if (!canManageUser(user, target) && target.id !== user.id) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission' });
          }
          store.deleteQuota({ scope, targetId, period });
          store.writeAudit({ actorUserId: user.id, tenantId: scope === 'tenant' ? targetId : (user.tenant_id ?? user.tenantId), action: 'quota.clear', targetType: scope, targetId: String(targetId), detail: { period }, result: 'success' });
          return okValue({ cleared: { scope, targetId, period } });
        }

        // ---------------- audit.*（M4：auditor+ 只读，租户内）----------------
        case 'audit.list': {
          if (!hasRole(user, 'auditor')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'auditor+ required' });
          const tenantId = resolveAuditTenant(p.tenantId);
          if (tenantId === false) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
          const entries = store.listAudit({
            limit: Math.min(Number(p.limit) || 200, 1000),
            offset: Number(p.offset) || 0,
            tenantId,
            action: p.action ?? null,
            userId: p.userId === undefined || p.userId === null ? null : Number(p.userId),
            result: p.result ?? null,
          });
          const total = store.countAudit({ tenantId, action: p.action ?? null, userId: p.userId === undefined || p.userId === null ? null : Number(p.userId), result: p.result ?? null });
          return okValue({
            total,
            entries: entries.map((a) => ({
              id: a.id, ts: a.ts, actorUserId: a.actor_user_id, tenantId: a.tenant_id,
              action: a.action, targetType: a.target_type, targetId: a.target_id,
              detail: safeParseJson(a.detail), result: a.result, ip: a.ip,
            })),
          });
        }

        case 'audit.export': {
          if (!hasRole(user, 'auditor')) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'auditor+ required' });
          const tenantId = resolveAuditTenant(p.tenantId);
          if (tenantId === false) return deny({ code: MT_ERRORS.FORBIDDEN, message: 'out of scope' });
          const entries = store.listAudit({ limit: Math.min(Number(p.limit) || 5000, 10000), tenantId, action: p.action ?? null, result: p.result ?? null });
          const esc = (v) => {
            if (v === null || v === undefined) return '';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          };
          const header = ['ts', 'actor_user_id', 'tenant_id', 'action', 'target_type', 'target_id', 'detail', 'result', 'ip'];
          const rows = entries.map((a) => [a.ts, a.actor_user_id, a.tenant_id, a.action, a.target_type, a.target_id, a.detail, a.result, a.ip].map(esc).join(','));
          const csv = [header.join(','), ...rows].join('\n');
          store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id ?? user.tenantId, action: 'audit.export', result: 'success', ip: null });
          return okValue({ csv, filename: `audit-${Date.now()}.csv` });
        }

        // ---------------- user.revokeSessions（M4：强制下线）----------------
        case 'user.revokeSessions': {
          const target = store.getUserById(Number(p.userId));
          if (!target) return deny({ code: MT_ERRORS.NOT_FOUND, message: 'user not found' });
          if (!canManageUser(user, target) && target.id !== user.id) {
            return deny({ code: MT_ERRORS.FORBIDDEN, message: 'no permission to manage this user' });
          }
          store.deleteUserSessions(target.id);
          store.writeAudit({ actorUserId: user.id, tenantId: target.tenant_id, action: 'user.revoke-sessions', targetType: 'user', targetId: String(target.id), result: 'success' });
          return okValue({ revoked: true });
        }

        default:
          return deny({ code: MT_ERRORS.NOT_FOUND, message: `unknown endpoint ${endpoint}` });
      }
    } catch (error) {
      return deny({ code: MT_ERRORS.INTERNAL, message: error.message });
    }
  }

  return { dispatch };
}

const MT_MAX_BODY_BYTES = 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MT_MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 把 /mt 通道挂到 DSH webserver 的 prefix 路由。
 * 请求格式与 dsh-client-connection 的 rpc.call 一致：
 *   POST /mt/<endpoint>  {type:'client-request', rpcId, method, payload}
 *   → {type:'server-response', rpcId, result: {ok, value|error}}
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{store, authService, mtChannel}} deps
 */
export function wireMtRoute(ctx, { store, authService, mtChannel }) {
  ctx.webServer.register({
    kind: 'prefix',
    path: '/mt',
    handler: async (req, res) => {
      try {
        if ((req.method ?? 'GET') !== 'POST') {
          return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } });
        }
        const envelope = await readJsonBody(req);
        const rpcId = envelope.rpcId ?? null;
        const method = typeof envelope.method === 'string' ? envelope.method : null;
        if (!method) {
          return sendJson(res, 400, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'invalid-request', message: 'method required' } } });
        }
        const auth = authService.authenticateByCookie(req.headers.cookie);
        const result = mtChannel.dispatch(method, envelope.payload, auth);
        return sendJson(res, 200, { type: 'server-response', rpcId, result });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: error.message } });
      }
    },
  });
}
