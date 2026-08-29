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
import { enforceSessionOwnership, ownsSession } from './ownership.js';
import { filterListValue, filterDownlinkPayload } from './visibility.js';
import { parseServerWsFrame, encodeServerWsFrame } from './ws-frames.js';
import { isSystem } from './rbac.js';
import {
  AUTH_PREFIX,
  SECURITY_HEADERS,
  sendJson,
  cookieHeader,
  readJsonBody,
  clientIp,
  createAuthRouter,
} from './auth-router.js';

/** 代理给 DSH 前端的响应头：不含 CSP（DSH 前端依赖 new Function/eval 求值 !!js 配置表达式，CSP 会拦截导致空白页）。 */
const SPA_SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/**
 * 浏览器信任头规范化：把 Origin 改写为与转发 Host 一致的 loopback 源、剥离
 * Referer。DSH 侧 /api 信任栅栏（isTrustedApiRequest）在请求带 Origin 时要求
 * `Origin.host === Host`；浏览器真实 Origin 是网关端口（如 127.0.0.1:3090），
 * 而网关把 Host 改写为 DSH 的 loopback 端口，两者不一致会把所有特权方法
 * （settings、credentials、host.pickDirectory 等）打成 403，并拒绝
 * events.mux/host 的 WebSocket 握手。改写后 DSH 视角下代理请求与回环同源。
 */
function makeNormalizeTrustHeaders(target) {
  const targetOrigin = `http://${target.hostname}:${target.port}`;
  return function normalizeTrustHeaders(headers) {
    if (typeof headers.origin === 'string') headers.origin = targetOrigin;
    delete headers.referer;
    return headers;
  };
}

/**
 * 创建网关。
 * @param {object} opts
 * @param {object} opts.cfg           resolveConfig 结果（gateway/cookie 节）
 * @param {{hostname: string, port: number}} opts.target  DSH 目标地址
 * @param {ReturnType<import('./auth-service.js').createAuthService>} opts.authService
 * @param {{check: Function}} [opts.quotaService]  配额门禁（session.prompt/subagent.prompt 前置检查）
 * @param {{start: Function, handleCallback: Function, enabled: boolean}} [opts.oidcStrategy]  OIDC/SSO 策略
 * @param {(entry: object) => void} [opts.audit]  越权/拒绝事件审计钩子
 * @param {{info?: Function, warn?: Function}} [opts.logger]
 */
export function createGateway({ cfg, target, authService, quotaService, oidcStrategy, audit, logger = console }) {
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
  const authRouter = createAuthRouter({ cfg, authService, oidcStrategy, audit, logger });

  /** Origin/Referer 规范化（DSH 侧信任栅栏要求代理请求与回环同源） */
  const normalizeTrustHeaders = makeNormalizeTrustHeaders(target);

  /** 租户可见性过滤的列表端点（响应按会话前缀裁剪） */
  const LIST_ENDPOINTS = new Set(['session.list', 'session.search', 'workspace.list']);

  /**
   * 配置/凭据面特权方法：经网关（Origin 规范化后）本可放行，但按方案约定
   * 仅平台管理员（system）可用——settings.*（含 !!js 求值）、credentials.*
   * （API 密钥）、llm.discoverModels（携带草稿凭据并让宿主外发请求）、
   * agentPreset.*（单数命名，宿主侧专用；聊天 UI 用的是 agentPresets.* 复数
   * 服务，不在特权集内、不受此门禁影响）。host.pickDirectory/host.openPath
   * 是工作区创建流程必需（原生对话框），对所有已登录用户放行。
   */
  const CONFIG_PLANE_METHODS = new Set([
    'settings.describe',
    'settings.openDocument',
    'settings.update',
    'settings.replace',
    'settings.mutate',
    'credentials.describe',
    'credentials.set',
    'credentials.unset',
    'llm.discoverModels',
    'agentPreset.read',
    'agentPreset.copy',
    'agentPreset.openDocument',
    'agentPreset.remove',
  ]);

  // -------------------------------------------------------------------------
  // 认证端点（共享 auth-router）
  // -------------------------------------------------------------------------
  const handleAuth = (req, res) => authRouter.handle(req, res);

  // -------------------------------------------------------------------------
  // 访问策略
  // -------------------------------------------------------------------------
  /**
   * 公开路径（无需登录）：
   *  - /api/auth/* 认证端点（登录页依赖）
   *  - GET/HEAD 静态资源（SPA、/assets、/plugins、favicon）
   * 其余一切路径（含 /api、/mt、任意方法）都必须登录。
   */
  function isPublicPath(method, path) {
    if (path === AUTH_PREFIX || path.startsWith(AUTH_PREFIX)) return true;
    if (method === 'GET' || method === 'HEAD') {
      if (path === '/' || path.startsWith('/assets/') || path.startsWith('/plugins/') || path.startsWith('/favicon')) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // HTTP 请求：认证判定 + 归属强制 + 代理
  // -------------------------------------------------------------------------
  async function handleHttp(req, res) {
    const path = pathname(req);
    if (path === AUTH_PREFIX || path.startsWith(AUTH_PREFIX)) {
      return handleAuth(req, res);
    }
    const method = req.method ?? 'GET';
    if (!isPublicPath(method, path)) {
      const auth = authService.authenticateByCookie(req.headers.cookie);
      if (!auth) {
        return sendJson(res, 401, { ok: false, error: { code: 'unauthenticated', message: 'login required' } });
      }
      // 会话归属强制：GET 查询串或 POST 信封中的 sessionId 必须属于当前用户
      const url = new URL(req.url, 'http://gateway');
      const querySid = url.searchParams.get('sessionId');
      if (querySid && !ownsSession(auth.user, querySid)) {
        audit?.({
          actorUserId: auth.user.id,
          tenantId: auth.user.tenantId,
          action: 'session.denied',
          targetType: 'session',
          targetId: querySid,
          result: 'denied',
          ip: clientIp(req),
        });
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'session ownership mismatch' } });
      }
      if (method === 'POST' && (path === '/api' || path.startsWith('/api/'))) {
        return handleApiPost(req, res, auth);
      }
    }
    return proxyHttp(req, res);
  }

  /**
   * POST /api/*：缓冲信封 → 强制会话归属前缀（session.create 改写 /
   * 会话作用域校验）→ 转发。解析失败或超大 body 时原样透传。
   */
  async function handleApiPost(req, res, auth) {
    const body = await readBody(req, 300 * 1024 * 1024).catch(() => null);
    if (body === null) return proxyHttp(req, res); // 非 JSON/超限：透传
    let envelope = null;
    try {
      envelope = JSON.parse(body.toString('utf8'));
    } catch {
      return proxyRaw(req, res, body); // 非 JSON：原样转发
    }
    const method = typeof envelope?.method === 'string' ? envelope.method : null;
    const payload = envelope?.payload;
    if (method) {
      // 配置/凭据面特权方法：仅平台管理员（host.* 原生对话框除外，见 CONFIG_PLANE_METHODS）
      if (CONFIG_PLANE_METHODS.has(method) && !isSystem(auth.user)) {
        audit?.({
          actorUserId: auth.user.id,
          tenantId: auth.user.tenantId,
          action: 'privileged.denied',
          targetType: 'method',
          targetId: method,
          result: 'denied',
          ip: clientIp(req),
        });
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'privileged method requires platform admin' } });
      }
      const result = enforceSessionOwnership(auth.user, method, payload);
      if (!result.ok) {
        audit?.({
          actorUserId: auth.user.id,
          tenantId: auth.user.tenantId,
          action: 'session.denied',
          targetType: 'session',
          targetId: payload?.sessionId,
          result: 'denied',
          ip: clientIp(req),
        });
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: result.reason } });
      }
      if (result.payload !== payload) {
        envelope.payload = result.payload;
        return proxyRaw(req, res, Buffer.from(JSON.stringify(envelope), 'utf8'));
      }
      // 列表端点：响应按租户可见性过滤（V2）
      if (LIST_ENDPOINTS.has(method)) {
        return proxyFiltered(req, res, body, auth.user, method);
      }
      // 配额门禁：耗 token 的请求在放行前检查（M3）
      if (quotaService && (method === 'session.prompt' || method === 'subagent.prompt')) {
        const quota = quotaService.check(auth.user);
        if (!quota.allowed) {
          audit?.({
            actorUserId: auth.user.id,
            tenantId: auth.user.tenantId,
            action: 'quota.denied',
            targetType: 'session',
            targetId: payload?.sessionId,
            detail: { reason: quota.reason },
            result: 'denied',
            ip: clientIp(req),
          });
          const rpcId = envelope.rpcId ?? null;
          return sendJson(res, 200, {
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'quota-exhausted', message: quota.reason, details: {} } },
          });
        }
      }
    }
    return proxyRaw(req, res, body);
  }

  /** 收集请求体（上限 maxBytes）。 */
  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /** 以已缓冲 body 转发（保持原 header；体已缓冲 → 用 content-length，剔除 chunked 帧）。 */
  function proxyRaw(req, res, body) {
    const headers = normalizeTrustHeaders({
      ...req.headers,
      host: `${target.hostname}:${target.port}`,
      'content-length': String(body.length),
    });
    delete headers['transfer-encoding'];
    delete headers.connection;
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers,
    };
    const upstream = http.request(options, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, ...SPA_SAFE_HEADERS });
      upRes.pipe(res);
    });
    track(upstream);
    upstream.on('error', (error) => {
      logger.warn?.(`[dsh-multi-tenant] upstream error: ${error.message}`);
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'bad-gateway', message: 'upstream unavailable' } });
      else res.destroy();
    });
    upstream.end(body);
  }

  /**
   * 列表端点代理：缓冲上游响应 → 按角色/租户过滤（可见性）→ 原样返回。
   * 解析失败/超限时退化为透传（保可用性）。
   */
  function proxyFiltered(req, res, body, user, method) {
    const headers = normalizeTrustHeaders({
      ...req.headers,
      host: `${target.hostname}:${target.port}`,
      'content-length': String(body.length),
    });
    delete headers['transfer-encoding'];
    delete headers.connection;
    const options = { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers };
    const upstream = http.request(options, (upRes) => {
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) {
          // 超限：放弃过滤，原样透传（含已收部分）
          res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, ...SPA_SAFE_HEADERS });
          res.write(Buffer.concat(chunks));
          upRes.pipe(res);
          return;
        }
        chunks.push(chunk);
      });
      upRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        try {
          const envelope = JSON.parse(raw.toString('utf8'));
          if (envelope && envelope.result && envelope.result.ok && envelope.result.value) {
            envelope.result.value = filterListValue(method, envelope.result.value, user);
            const payload = JSON.stringify(envelope);
            const respHeaders = { ...upRes.headers, ...SPA_SAFE_HEADERS, 'content-length': String(Buffer.byteLength(payload)) };
            delete respHeaders['transfer-encoding'];
            delete respHeaders.connection;
            res.writeHead(upRes.statusCode ?? 200, respHeaders);
            res.end(payload);
            return;
          }
        } catch {
          /* 解析失败 → 透传原始响应 */
        }
        res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, ...SPA_SAFE_HEADERS });
        res.end(raw);
      });
      upRes.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'bad-gateway', message: 'upstream unavailable' } });
        else res.destroy();
      });
    });
    track(upstream);
    upstream.on('error', (error) => {
      logger.warn?.(`[dsh-multi-tenant] upstream error: ${error.message}`);
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: { code: 'bad-gateway', message: 'upstream unavailable' } });
      else res.destroy();
    });
    upstream.end(body);
  }

  function proxyHttp(req, res) {
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: normalizeTrustHeaders({
        ...req.headers,
        host: `${target.hostname}:${target.port}`,
      }),
    };
    const upstream = http.request(options, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, ...SPA_SAFE_HEADERS });
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

  /**
   * 下行 WS 帧过滤泵：解析帧边界，对完整文本帧做负载可见性过滤，
   * 丢弃不可见帧；其余（分片/控制/二进制/非 JSON）原字节透传。
   * initial 为与 101 同段到达的 upHead 字节，同样过过滤。
   */
  function pumpDownlink(source, dest, user, initial = Buffer.alloc(0)) {
    let buffer = initial.length ? Buffer.from(initial) : Buffer.alloc(0);
    const processBuffer = () => {
      for (;;) {
        const frame = parseServerWsFrame(buffer);
        if (!frame) break;
        const raw = buffer.subarray(0, frame.consumed);
        buffer = buffer.subarray(frame.consumed);
        let out = raw;
        if (frame.opcode === 0x1 && frame.fin) {
          try {
            const parsed = JSON.parse(frame.payload.toString('utf8'));
            const filtered = filterDownlinkPayload(parsed && parsed.payload, user);
            if (filtered === null) continue; // 丢弃
            if (filtered !== (parsed && parsed.payload)) {
              out = encodeServerWsFrame(0x1, Buffer.from(JSON.stringify({ ...parsed, payload: filtered }), 'utf8'));
            }
          } catch {
            /* 非 JSON 文本：原样 */
          }
        }
        const ok = dest.write(out);
        if (!ok) source.pause();
      }
    };
    processBuffer();
    source.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });
    dest.on('drain', () => source.resume());
    source.on('end', () => dest.end());
    source.on('error', () => dest.destroy());
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade：校验会话后转发
  // -------------------------------------------------------------------------
  function handleUpgrade(req, socket, head) {
    const path = pathname(req);
    const isApiEvents = path === '/api/events.mux' || path === '/api/events.host';
    const auth = authService.authenticateByCookie(req.headers.cookie);
    if (isApiEvents && !auth) {
      rejectUpgrade(socket, 401, 'login required');
      return;
    }
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: 'GET',
      headers: normalizeTrustHeaders({
        ...req.headers,
        host: `${target.hostname}:${target.port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
      }),
    };
    const upstream = http.request(options);
    track(upstream);
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      // 把目标端的 101 响应（含 sec-websocket-accept 等）写回浏览器
      socket.write(`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}\r\n${serializeHeaders(upRes.headers)}\r\n`);
      // 下行帧按租户可见性过滤（host/workspace-*、session-*、mux 会话帧）；
      // upHead（与 101 同段到达的帧）也须经过滤，不能直写客户端
      pumpDownlink(upSocket, socket, auth ? auth.user : null, upHead);
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
