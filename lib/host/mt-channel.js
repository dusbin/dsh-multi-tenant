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
 */

import { hashPassword, validatePasswordStrength, validateUsername, verifyPassword } from './crypto.js';
import { assignableRoles, canAccessTenant, canManageUser, hasRole, isSystem, validateRole } from './rbac.js';

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
 */
export function createMtChannel({ store, authService }) {
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
