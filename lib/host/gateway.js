/**
 * 认证反代网关（M1）。
 *
 * DSH web 本体保持 loopback 绑定（127.0.0.1:<dsPort>），本网关是唯一的对外
 * 入口：浏览器访问网关端口 → 网关做 登录/会话校验/策略 → HTTP 与 WebSocket
 * 全量代理到 DSH（loopback Host 天然通过 DSH 的 /api 信任栅栏）。
 *
 * 访问策略（v1）：
 *  - `/api/auth/*`（login/logout/me/bootstrap）：网关自行处理，无需登录
 *  - `POST /api/*`：必须携带有效会话 Cookie，否则 401
 *  - `GET /api/events.mux|host` 的 WebSocket upgrade：必须已登录，否则拒绝握手
 *  - 其余（前端静态资源 /assets、/plugins 等 GET）：放行（登录页依赖 shell 加载）
 *
 * 后续里程碑：RBAC 端点级策略、会话归属前缀强制、配额同步检查均在此层叠加。
 */

import http from 'node:http';

const AUTH_PREFIX = '/api/auth/';
const MAX_BODY_BYTES = 1024 * 1024; // auth 端点请求体上限 1 MiB

/** 收集请求体并解析 JSON（超限/非 JSON 抛错）。 */
function readJsonBody(req) {
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

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Set-Cookie 序列化（v1：HttpOnly + SameSite，Secure 可配）。 */
function cookieHeader(cfg, token, { clear = false } = {}) {
  const parts = [`${cfg.cookie.name}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', `SameSite=${cfg.cookie.sameSite || 'Lax'}`];
  if (cfg.cookie.secure) parts.push('Secure');
  if (clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push(`Max-Age=${cfg.cookie.maxAgeDays * 24 * 60 * 60}`);
  }
  return parts.join('; ');
}

/**
 * 创建网关。
 * @param {object} opts
 * @param {object} opts.cfg           resolveConfig 结果（gateway/cookie 节）
 * @param {{hostname: string, port: number}} opts.target  DSH 目标地址
 * @param {ReturnType<import('./auth-service.js').createAuthService>} opts.authService
 * @param {{info?: Function, warn?: Function}} [opts.logger]
 */
export function createGateway({ cfg, target, authService, logger = console }) {
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      logger.warn?.(`[dsh-multi-tenant] gateway request error: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'internal error' } });
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));

  /** 在途上游请求（含 WS upgrade），close 时统一销毁，避免 keep-alive 句柄滞留 */
  const upstreams = new Set();

  function track(req) {
    upstreams.add(req);
    const release = () => upstreams.delete(req);
    req.on('close', release);
    req.on('error', release);
  }

  const pathname = (req) => new URL(req.url, 'http://gateway').pathname;

  // -------------------------------------------------------------------------
  // 认证端点
  // -------------------------------------------------------------------------
  async function handleAuth(req, res) {
    const path = pathname(req);
    const method = req.method ?? 'GET';

    if (path === `${AUTH_PREFIX}me`) {
      const result = authService.me(req.headers.cookie);
      if (result.ok) return sendJson(res, 200, result);
      return sendJson(res, 401, result);
    }

    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } });

    if (path === `${AUTH_PREFIX}login`) {
      const body = await readJsonBody(req).catch(() => ({}));
      const ip = clientIp(req);
      const result = authService.login({ username: body.username, password: body.password, ip, userAgent: req.headers['user-agent'] ?? null });
      if (result.ok) {
        return sendJson(res, 200, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(cfg, result.token) });
      }
      const status = result.error.code === 'rate-limited' ? 429
        : result.error.code === 'account-disabled' || result.error.code === 'account-locked' ? 423
        : 401;
      return sendJson(res, status, result);
    }

    if (path === `${AUTH_PREFIX}logout`) {
      authService.logout(req.headers.cookie);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader(cfg, '', { clear: true }) });
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

  // -------------------------------------------------------------------------
  // HTTP 请求：认证判定 + 代理
  // -------------------------------------------------------------------------
  async function handleHttp(req, res) {
    const path = pathname(req);
    if (path === AUTH_PREFIX || path.startsWith(AUTH_PREFIX)) {
      return handleAuth(req, res);
    }
    // POST /api/* 必须已登录（GET /api/events.* 由 upgrade 路径处理）
    if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')
      && (path === '/api' || path.startsWith('/api/'))) {
      if (!authService.authenticateByCookie(req.headers.cookie)) {
        return sendJson(res, 401, { ok: false, error: { code: 'unauthenticated', message: 'login required' } });
      }
    }
    return proxyHttp(req, res);
  }

  function proxyHttp(req, res) {
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${target.hostname}:${target.port}`,
      },
    };
    const upstream = http.request(options, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    track(upstream);
    upstream.on('error', (error) => {
      logger.warn?.(`[dsh-multi-tenant] upstream error: ${error.message}`);
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'bad-gateway', message: 'upstream unavailable' } });
      else res.destroy();
    });
    req.pipe(upstream);
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade：校验会话后转发
  // -------------------------------------------------------------------------
  function handleUpgrade(req, socket, head) {
    const path = pathname(req);
    const isApiEvents = path === '/api/events.mux' || path === '/api/events.host';
    if (isApiEvents && !authService.authenticateByCookie(req.headers.cookie)) {
      rejectUpgrade(socket, 401, 'login required');
      return;
    }
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: 'GET',
      headers: {
        ...req.headers,
        host: `${target.hostname}:${target.port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
      },
    };
    const upstream = http.request(options);
    track(upstream);
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      // 把目标端的 101 响应（含 sec-websocket-accept 等）写回浏览器
      socket.write(`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}\r\n${serializeHeaders(upRes.headers)}\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      // 对称销毁：任一端关闭/出错，立即销毁另一端，避免半开 socket 滞留
      const teardown = (victim) => () => { try { victim.destroy(); } catch { /* ignore */ } };
      socket.on('error', teardown(upSocket));
      socket.on('close', teardown(upSocket));
      upSocket.on('error', teardown(socket));
      upSocket.on('close', teardown(socket));
    });
    upstream.on('error', (error) => {
      logger.warn?.(`[dsh-multi-tenant] upstream upgrade error: ${error.message}`);
      rejectUpgrade(socket, 502, 'bad gateway');
    });
    upstream.end();
  }

  return {
    server,
    /** @returns {Promise<void>} */
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    /** @returns {Promise<void>} */
    close() {
      for (const req of upstreams) {
        try { req.destroy(); } catch { /* ignore */ }
      }
      upstreams.clear();
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
    /** 实际监听地址（测试用） */
    address() {
      return server.address();
    },
  };
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`);
  socket.end();
}

function serializeHeaders(headers) {
  if (!headers) return '';
  const lines = [];
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
