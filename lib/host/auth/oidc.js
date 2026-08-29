/**
 * OIDC / SSO 登录策略（M6）：Authorization Code + PKCE。
 *
 * 流程：
 *  1. GET /api/auth/oidc/start?redirect=<path> → 生成授权 URL（含 state + PKCE
 *     code_verifier/code_challenge），state 存入内存（TTL）
 *  2. 用户在 IdP 完成登录 → 302 回 /api/auth/oidc/callback?code=&state=
 *  3. 校验 state → 用 PKCE code_verifier 换令牌（openid-client 校验
 *     ID token 签名/iss/aud/exp）→ 提取声明 → 按 oidc_sub 关联/自动建号
 *  4. 签发本地会话 → 回调端点 Set-Cookie + 302 回原目标
 *
 * 依赖注入（可测试）：clientFactory 返回 { authorizationUrl, callback }。
 * 默认工厂动态 import `openid-client`（仅 oidc.enabled 时加载）。
 */

import { randomBytes, createHash } from 'node:crypto';

/** 生成 base64url 随机串 */
function randomB64Url(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../config.js').resolveConfig>} deps.cfg
 * @param {ReturnType<import('../db.js').createStore>} deps.store
 * @param {{info?: Function, warn?: Function}} [deps.logger]
 * @param {(oidcCfg, redirectUri) => Promise<{authorizationUrl: Function, callback: Function}>} [deps.clientFactory]
 */
export function createOidcStrategy({ cfg, store, logger = console, clientFactory }) {
  const oidc = cfg.auth?.oidc ?? {};
  const enabled = !!oidc.enabled && !!oidc.issuerUrl && !!oidc.clientId;

  /** state → { codeVerifier, redirectTo, exp }（内存；单进程） */
  const pending = new Map();

  let clientPromise = null;
  const defaultClientFactory = async (redirectUri) => {
    const { Issuer } = await import('openid-client');
    const issuer = await Issuer.discover(oidc.issuerUrl);
    return new issuer.Client({
      client_id: oidc.clientId,
      client_secret: oidc.clientSecret || undefined,
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
  };
  const makeClient = clientFactory || defaultClientFactory;

  function redirectUri(baseUrl) {
    const base = (oidc.publicBaseUrl || baseUrl || '').replace(/\/+$/, '');
    const path = oidc.redirectPath || '/api/auth/oidc/callback';
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  function pruneExpired(now = Date.now()) {
    for (const [state, entry] of pending) {
      if (entry.exp <= now) pending.delete(state);
    }
  }

  /**
   * 生成授权 URL。
   * @param {string} [redirectTo]  登录成功后回跳路径（默认 '/'）
   * @param {string} [baseUrl]     请求来源基址（用于 redirect_uri）
   * @returns {Promise<{url: string}>}
   */
  async function start({ redirectTo = '/', baseUrl = '' } = {}) {
    const client = await makeClient(redirectUri(baseUrl));
    const state = randomB64Url(24);
    const codeVerifier = randomB64Url(32);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    pending.set(state, { codeVerifier, redirectTo, exp: Date.now() + (oidc.stateTtlMs || 600000) });
    const url = client.authorizationUrl({
      scope: oidc.scopes || 'openid profile email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { url };
  }

  /**
   * 处理回调。
   * @returns {Promise<{ok: true, user: object, token: string, redirectTo: string}
   *                   | {ok: false, error: {code, message}}>}
   */
  async function handleCallback({ code, state, baseUrl = '', ip = null }) {
    pruneExpired();
    const entry = pending.get(state);
    if (!entry) {
      return { ok: false, error: { code: 'oidc-invalid-state', message: 'invalid or expired OIDC state' } };
    }
    pending.delete(state);
    if (typeof code !== 'string' || !code) {
      return { ok: false, error: { code: 'oidc-invalid-state', message: 'missing authorization code' } };
    }
    const client = await makeClient(redirectUri(baseUrl));
    let tokens;
    try {
      tokens = await client.callback(redirectUri(baseUrl), { code, state }, { code_verifier: entry.codeVerifier, state });
    } catch (error) {
      logger.warn?.(`[dsh-multi-tenant] oidc token exchange failed: ${error.message}`);
      return { ok: false, error: { code: 'oidc-exchange-failed', message: 'token exchange failed' } };
    }
    const claims = typeof tokens.claims === 'function' ? tokens.claims() : tokens;
    const mapping = oidc.claimsMapping || { subject: 'sub', username: 'preferred_username', email: 'email' };
    const claim = (name) => {
      if (!name) return null;
      const v = claims[name];
      if (v === undefined || v === null) return null;
      return Array.isArray(v) ? v[0] : String(v);
    };
    const subject = claim(mapping.subject || 'sub');
    if (!subject) {
      return { ok: false, error: { code: 'oidc-invalid-claims', message: 'missing subject claim' } };
    }

    // 本地账号：按 oidc_sub 关联
    let user = store.listUsers().find((u) => u.oidc_sub === subject) ?? null;
    if (!user) {
      if (!oidc.autoProvision) {
        return { ok: false, error: { code: 'oidc-no-account', message: 'no local account for SSO user' } };
      }
      const username = claim(mapping.username || 'preferred_username') || `sso_${subject.slice(0, 12)}`;
      const email = claim(mapping.email || 'email');
      const tenantId = oidc.defaultTenantId === null || oidc.defaultTenantId === undefined ? null : Number(oidc.defaultTenantId);
      const role = ['system', 'admin', 'auditor', 'user'].includes(oidc.defaultRole) ? oidc.defaultRole : 'user';
      const id = store.createUser({ tenantId, username, email: email ?? null, oidcSub: subject, role });
      user = store.getUserById(id);
      store.writeAudit({ actorUserId: user.id, tenantId: user.tenant_id, action: 'auth.oidc-provision', result: 'success', detail: { sub: subject } });
    }
    if (user.status === 'disabled') {
      return { ok: false, error: { code: 'account-disabled', message: 'account is disabled' } };
    }
    if (user.status === 'locked') {
      return { ok: false, error: { code: 'account-locked', message: 'account is locked' } };
    }
    // 会话签发由 auth-service.issueSession 完成（回调端点调用）
    return { ok: true, user, redirectTo: entry.redirectTo || '/' };
  }

  return { enabled, start, handleCallback, pendingCount: () => pending.size };
}
