/**
 * 认证服务：登录/登出/当前用户/bootstrap 平台管理员/防爆破。
 *
 * 会话模型（v1）：
 *  - 登录成功 → 签发随机令牌（明文仅 Set-Cookie），DB 存 SHA-256 摘要
 *  - HttpOnly Cookie（网关设置）；过期/登出/账号禁用即时失效
 *  - 防爆破：按 `u:<username>` 与 `ip:<ip>` 两个维度计数失败尝试，
 *    窗口内超过阈值则拒绝（429）
 */

import { hashPassword, hashSessionToken, newSessionToken, validatePasswordStrength, validateUsername, verifyPassword } from './crypto.js';

export const AUTH_ERRORS = {
  INVALID_CREDENTIALS: 'invalid-credentials',
  ACCOUNT_DISABLED: 'account-disabled',
  ACCOUNT_LOCKED: 'account-locked',
  RATE_LIMITED: 'rate-limited',
  UNAUTHENTICATED: 'unauthenticated',
  BOOTSTRAP_REQUIRED: 'bootstrap-required',
  BOOTSTRAP_DISABLED: 'bootstrap-disabled',
  ALREADY_INITIALIZED: 'already-initialized',
  INVALID_INPUT: 'invalid-input',
};

/**
 * @param {ReturnType<import('./db.js').createStore>} store
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {{authenticate: Function, enabled: boolean}} [ldapStrategy]  LDAP 策略（可选）
 */
export function createAuthService(store, cfg, ldapStrategy = null, oidcStrategy = null) {
  const cookieName = cfg.cookie.name;
  const maxAgeMs = cfg.cookie.maxAgeDays * 24 * 60 * 60 * 1000;

  /** 把 user 行映射为对外暴露的用户信息（不含密钥字段） */
  function publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      email: user.email ?? null,
      role: user.role,
      status: user.status,
      tenantId: user.tenant_id ?? null,
    };
  }

  /** 是否处于"未初始化"（无任何用户）状态 */
  function bootstrapRequired() {
    return cfg.auth.bootstrap.enabled && store.countUsers() === 0;
  }

  function isRateLimited(username, ip) {
    const windowMs = cfg.auth.local.lockWindowMs;
    const max = cfg.auth.local.maxFailedAttempts;
    const since = Date.now() - windowMs;
    const attempts = Math.max(
      store.countRecentAttempts(`u:${username}`, since),
      ip ? store.countRecentAttempts(`ip:${ip}`, since) : 0,
    );
    return attempts >= max;
  }

  function recordFailure(username, ip) {
    store.recordAttempt(`u:${username}`);
    if (ip) store.recordAttempt(`ip:${ip}`);
  }

  function clearFailures(username, ip) {
    store.clearAttempts(`u:${username}`);
    if (ip) store.clearAttempts(`ip:${ip}`);
  }

  /**
   * 连续失败达到阈值后自动锁定账号（管理员可解锁）。
   * @returns {boolean} 本次是否触发锁定
   */
  function maybeLockAccount(username) {
    if (!cfg.auth.local.autoLock) return false;
    const since = Date.now() - cfg.auth.local.lockWindowMs;
    if (store.countRecentAttempts(`u:${username}`, since) >= cfg.auth.local.maxFailedAttempts) {
      const user = store.getUserByUsername(username);
      if (user && user.status === 'active') {
        store.setUserStatus(user.id, 'locked');
        store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id, action: 'auth.lock', detail: { reason: 'too many failed attempts' }, result: 'success' });
        return true;
      }
    }
    return false;
  }

  /** 已启用的登录方式（登录页渲染按钮） */
  function authMethods() {
    const methods = [];
    if (cfg.auth.local.enabled) methods.push('local');
    if (ldapStrategy && ldapStrategy.enabled) methods.push('ldap');
    if (oidcStrategy && oidcStrategy.enabled) methods.push('oidc');
    return methods;
  }

  /**
   * 为已认证用户签发本地会话（登录 / LDAP / OIDC 共用）。
   * @returns {{ok: true, user: object, token: string}}
   */
  function issueSession(user, { method = 'auto', ip = null, userAgent = null } = {}) {
    if (method !== 'ldap' && method !== 'oidc') {
      try { clearFailures(user.username, ip); } catch { /* ignore */ }
    }
    store.touchUserLogin(user.id, ip);
    const token = newSessionToken();
    store.createSession({ userId: user.id, tokenHash: hashSessionToken(token), expiresAt: Date.now() + maxAgeMs, ip, userAgent });
    store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id, action: 'auth.login', detail: { method }, result: 'success', ip });
    return { ok: true, user: publicUser(user), token };
  }

  /**
   * 登录（本地 / LDAP / OIDC 由网关回调）。
   * method: 'local' | 'ldap' | 省略（自动：有本地账号走本地，否则尝试 LDAP）。
   */
  function login({ username, password, method = null, ip = null, userAgent = null }) {
    if (typeof username !== 'string' || typeof password !== 'string') {
      return { ok: false, error: { code: AUTH_ERRORS.INVALID_INPUT, message: 'username and password required' } };
    }
    const auditDenied = (code, detail = {}) => {
      try {
        const actor = store.getUserByUsername(username);
        store.writeAudit({ actorUserId: actor ? actor.id : null, tenantId: actor ? actor.tenant_id : null, action: 'auth.login', detail: { reason: code, ...detail, method: method || 'auto' }, result: 'denied', ip });
      } catch {
        /* audit best-effort */
      }
    };
    const handleLdap = async () => {
      if (!ldapStrategy || !ldapStrategy.enabled) {
        return { ok: false, error: { code: AUTH_ERRORS.INVALID_CREDENTIALS, message: 'invalid username or password' } };
      }
      const localProbe = store.getUserByUsername(username);
      if (localProbe && localProbe.status === 'disabled') {
        auditDenied('account-disabled', { userId: localProbe.id });
        return { ok: false, error: { code: AUTH_ERRORS.ACCOUNT_DISABLED, message: 'account is disabled' } };
      }
      if (localProbe && localProbe.status === 'locked') {
        auditDenied('account-locked', { userId: localProbe.id });
        return { ok: false, error: { code: AUTH_ERRORS.ACCOUNT_LOCKED, message: 'account is locked' } };
      }
      if (isRateLimited(username, ip)) {
        auditDenied('rate-limited', { method: 'ldap' });
        return { ok: false, error: { code: AUTH_ERRORS.RATE_LIMITED, message: 'too many failed attempts, try again later' } };
      }
      const result = await ldapStrategy.authenticate({ username, password });
      if (!result.ok) {
        recordFailure(username, ip);
        const code = result.error.code === 'account-disabled' ? AUTH_ERRORS.ACCOUNT_DISABLED
          : result.error.code === 'account-locked' ? AUTH_ERRORS.ACCOUNT_LOCKED
          : result.error.code === 'ldap-unavailable' ? 'ldap-unavailable'
          : AUTH_ERRORS.INVALID_CREDENTIALS;
        auditDenied(result.error.code, { userId: result.user ? result.user.id : undefined, username });
        if (code === AUTH_ERRORS.INVALID_CREDENTIALS && maybeLockAccount(username)) {
          auditDenied('account-locked', { autoLocked: true });
          return { ok: false, error: { code: AUTH_ERRORS.ACCOUNT_LOCKED, message: 'account locked after repeated failures' } };
        }
        return { ok: false, error: { code, message: result.error.message } };
      }
      return issueSession(result.user, { method: 'ldap', ip, userAgent });
    };

    if (method === 'ldap') return handleLdap();

    if (!cfg.auth.local.enabled) {
      return handleLdap();
    }
    const localUser = store.getUserByUsername(username) ?? (username.includes('@') ? store.getUserByEmail(username) : undefined);
    if (method === 'local' || (localUser && localUser.password_hash)) {
      // ---- 本地路径 ----
      if (!localUser || !localUser.password_hash) {
        recordFailure(username, ip);
        auditDenied('invalid-credentials');
        return { ok: false, error: { code: AUTH_ERRORS.INVALID_CREDENTIALS, message: 'invalid username or password' } };
      }
      // 账号状态（禁用/锁定）是持久事实，先于限流判断
      if (localUser.status === 'disabled') {
        auditDenied('account-disabled', { userId: localUser.id });
        return { ok: false, error: { code: AUTH_ERRORS.ACCOUNT_DISABLED, message: 'account is disabled' } };
      }
      if (localUser.status === 'locked') {
        auditDenied('account-locked', { userId: localUser.id });
        return { ok: false, error: { code: AUTH_ERRORS.ACCOUNT_LOCKED, message: 'account is locked' } };
      }
      if (isRateLimited(username, ip)) {
        auditDenied('rate-limited');
        return { ok: false, error: { code: AUTH_ERRORS.RATE_LIMITED, message: 'too many failed attempts, try again later' } };
      }
      if (!verifyPassword(password, localUser.password_hash)) {
        recordFailure(username, ip);
        auditDenied('invalid-credentials', { userId: localUser.id });
        if (maybeLockAccount(username)) {
          auditDenied('account-locked', { userId: localUser.id, autoLocked: true });
          return { ok: false, error: { code: AUTH_ERRORS.ACCOUNT_LOCKED, message: 'account locked after repeated failures' } };
        }
        return { ok: false, error: { code: AUTH_ERRORS.INVALID_CREDENTIALS, message: 'invalid username or password' } };
      }
      return issueSession(localUser, { method: method || 'auto', ip, userAgent });
    }
    // 无本地账号 + LDAP 开启 → 尝试 LDAP
    return handleLdap();
  }

  /**
   * 依据 Cookie 头中的会话令牌识别当前用户。
   * @param {string | null | undefined} cookieHeader
   * @returns {{user: object, session: object} | null}
   */
  function authenticateByCookie(cookieHeader) {
    const token = parseCookie(cookieHeader, cookieName);
    if (!token) return null;
    const now = Date.now();
    store.deleteExpiredSessions(now);
    const session = store.getSessionByTokenHash(hashSessionToken(token));
    if (!session || session.expires_at <= now) return null;
    const user = store.getUserById(session.user_id);
    if (!user || user.status !== 'active') return null;
    return { user, session };
  }

  /** 登出：删除会话（幂等）。@returns {{ok: true}} */
  function logout(cookieHeader) {
    const token = parseCookie(cookieHeader, cookieName);
    if (token) {
      const session = store.getSessionByTokenHash(hashSessionToken(token));
      if (session) {
        store.writeAudit({ actorUserId: session.user_id, action: 'auth.logout', result: 'success' });
      }
      store.deleteSessionByTokenHash(hashSessionToken(token));
    }
    return { ok: true };
  }

  /**
   * 首启 bootstrap：无任何用户时创建平台管理员（role=system，无租户）。
   * @returns {{ok: true, user: object, token: string} | {ok: false, error: {code, message}}}
   */
  function bootstrap({ username, password, ip = null, userAgent = null }) {
    if (!cfg.auth.bootstrap.enabled) {
      return { ok: false, error: { code: AUTH_ERRORS.BOOTSTRAP_DISABLED, message: 'bootstrap is disabled' } };
    }
    if (store.countUsers() > 0) {
      return { ok: false, error: { code: AUTH_ERRORS.ALREADY_INITIALIZED, message: 'system already initialized' } };
    }
    const nameError = validateUsername(username);
    if (nameError) return { ok: false, error: { code: AUTH_ERRORS.INVALID_INPUT, message: nameError } };
    const passError = validatePasswordStrength(password);
    if (passError) return { ok: false, error: { code: AUTH_ERRORS.INVALID_INPUT, message: passError } };
    const id = store.createUser({ username, passwordHash: hashPassword(password), role: 'system' });
    const user = store.getUserById(id);
    const token = newSessionToken();
    store.createSession({ userId: id, tokenHash: hashSessionToken(token), expiresAt: Date.now() + maxAgeMs, ip, userAgent });
    store.writeAudit({ actorUserId: id, action: 'auth.bootstrap', result: 'success', ip });
    return { ok: true, user: publicUser(user), token };
  }

  /** 当前用户信息（me）。 */
  function me(cookieHeader) {
    if (bootstrapRequired()) {
      return { ok: true, user: null, bootstrapRequired: true, methods: authMethods() };
    }
    const auth = authenticateByCookie(cookieHeader);
    if (!auth) {
      return { ok: false, error: { code: AUTH_ERRORS.UNAUTHENTICATED, message: 'not authenticated' } };
    }
    return { ok: true, user: publicUser(auth.user), bootstrapRequired: false, methods: authMethods() };
  }

  return { login, logout, me, bootstrap, authenticateByCookie, bootstrapRequired, authMethods, issueSession, cookieName };
}

/** 解析 Cookie 头中的指定名（大小写不敏感）。 */
export function parseCookie(header, name) {
  if (!header) return null;
  const target = name.toLowerCase();
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    if (key === target) {
      const value = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}
