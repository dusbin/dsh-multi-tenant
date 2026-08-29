/**
 * 认证端点路由（/api/auth/*）：网关与 DSH webserver 侧共享。
 *
 * 同一套端点逻辑被两处挂载：
 *  - 网关（createGateway）：作为对外入口的直答端点
 *  - DSH webserver（wireAuthRoutes）：让直连 DSH 端口的开发者模式也能登录
 *    （两处共用同一 auth-service 与 cookie，会话互通）
 */

export const AUTH_PREFIX = '/api/auth/';
export const MAX_BODY_BYTES = 1024 * 1024;

/** 统一安全响应头（M7 硬化） */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;",
};

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

/** Set-Cookie 序列化（HttpOnly + SameSite；Secure 可配）。 */
export function cookieHeader(cfg, token, { clear = false } = {}) {
  const parts = [`${cfg.cookie.name}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', `SameSite=${cfg.cookie.sameSite || 'Lax'}`];
  if (cfg.cookie.secure) parts.push('Secure');
  if (clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push(`Max-Age=${cfg.cookie.maxAgeDays * 24 * 60 * 60}`);
  }
  return parts.join('; ');
}

/** 收集请求体并解析 JSON（超限/非 JSON 抛错）。 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

/** 环回来源判定（逃生通道仅允许本机）。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function requestBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

/**
 * 创建认证端点处理器。
 * @param {object} deps
 * @param {ReturnType<import('./config.js').resolveConfig>} deps.cfg
 * @param {ReturnType<import('./auth-service.js').createAuthService>} deps.authService
 * @param {{start: Function, handleCallback: Function, enabled: boolean}} [deps.oidcStrategy]
 * @param {(entry: object) => void} [deps.audit]
 * @param {{info?: Function, warn?: Function}} [deps.logger]
 */
export function createAuthRouter({ cfg, authService, oidcStrategy, audit, logger = console }) {
  const pathname = (req) => new URL(req.url, 'http://auth').pathname;

  async function handleOidc(req, res) {
    if (!oidcStrategy || !oidcStrategy.enabled) {
      return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'oidc is not enabled' } });
    }
    const url = new URL(req.url, 'http://auth');
    const path = pathname(req);
    if (path === `${AUTH_PREFIX}oidc/start`) {
      try {
        const redirectTo = url.searchParams.get('redirect') || '/';
        const { url: authUrl } = await oidcStrategy.start({ redirectTo, baseUrl: requestBaseUrl(req) });
        return sendJson(res, 200, { ok: true, url: authUrl });
      } catch (error) {
        logger.warn?.(`[dsh-multi-tenant] oidc start failed: ${error.message}`);
        return sendJson(res, 502, { ok: false, error: { code: 'oidc-unavailable', message: 'unable to start SSO' } });
      }
    }
    if (path === `${AUTH_PREFIX}oidc/callback`) {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const result = await oidcStrategy.handleCallback({
        code,
        state,
        baseUrl: requestBaseUrl(req),
        ip: clientIp(req),
      });
      if (!result.ok) {
        audit?.({ action: 'auth.oidc-callback', detail: { error: result.error.code }, result: 'denied', ip: clientIp(req) });
        res.writeHead(302, { location: `/?mt_error=${encodeURIComponent(result.error.code)}` });
        res.end();
        return;
      }
      const session = authService.issueSession(result.user, { method: 'oidc', ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null });
      res.writeHead(302, {
        location: result.redirectTo || '/',
        'set-cookie': cookieHeader(cfg, session.token),
      });
      res.end();
      return;
    }
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown oidc endpoint' } });
  }

  /**
   * 处理 /api/auth/* 请求。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const path = pathname(req);
    const method = req.method ?? 'GET';

    if (path === `${AUTH_PREFIX}me`) {
      const result = authService.me(req.headers.cookie);
      if (result.ok) return sendJson(res, 200, result);
      return sendJson(res, 401, result);
    }

    if (path.startsWith(`${AUTH_PREFIX}oidc/`)) {
      return handleOidc(req, res);
    }

    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } });

    if (path === `${AUTH_PREFIX}login`) {
      const body = await readJsonBody(req).catch(() => ({}));
      const ip = clientIp(req);
      // login 可能为异步（LDAP 路径）——await 兼容同步/异步
      const result = await authService.login({ username: body.username, password: body.password, method: body.method, ip, userAgent: req.headers['user-agent'] ?? null });
      if (result.ok) {
        return sendJson(res, 200, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(cfg, result.token) });
      }
      const status = result.error.code === 'rate-limited' ? 429
        : result.error.code === 'account-disabled' || result.error.code === 'account-locked' ? 423
        : result.error.code === 'ldap-unavailable' ? 503
        : 401;
      return sendJson(res, status, result);
    }

    if (path === `${AUTH_PREFIX}logout`) {
      authService.logout(req.headers.cookie);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader(cfg, '', { clear: true }) });
    }

    if (path === `${AUTH_PREFIX}recovery`) {
      // 逃生通道：仅环回来源（本机/网关本地），且无可用平台管理员时可用
      if (!isLoopback(req)) {
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'recovery is loopback-only' } });
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const ip = clientIp(req);
      const result = authService.recovery({ username: body.username, password: body.password, ip, userAgent: req.headers['user-agent'] ?? null });
      if (result.ok) {
        return sendJson(res, 201, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(cfg, result.token) });
      }
      const status = result.error.code === 'recovery-not-needed' ? 409 : 400;
      return sendJson(res, status, result);
    }

    if (path === `${AUTH_PREFIX}bootstrap`) {
      const body = await readJsonBody(req).catch(() => ({}));
      const ip = clientIp(req);
      const result = authService.bootstrap({ username: body.username, password: body.password, ip, userAgent: req.headers['user-agent'] ?? null });
      if (result.ok) {
        return sendJson(res, 201, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(cfg, result.token) });
      }
      const status = result.error.code === 'already-initialized' ? 409 : 400;
      return sendJson(res, status, result);
    }

    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown auth endpoint' } });
  }

  return { handle };
}

/**
 * 把认证端点挂到 DSH webserver（直连 DSH 端口的开发者模式也可登录）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof createAuthRouter>} router
 */
export function wireAuthRoutes(ctx, router) {
  ctx.webServer.register({
    kind: 'prefix',
    path: AUTH_PREFIX.replace(/\/$/, ''), // '/api/auth'
    handler: (req, res) => {
      router.handle(req, res).catch((error) => {
        ctx.logger?.warn?.(`[dsh-multi-tenant] auth route error: ${error.message}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'internal error' } });
        else res.destroy();
      });
    },
  });
}
