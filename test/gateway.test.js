/**
 * 网关集成测试：起一个模拟 DSH 的目标 HTTP+WS 服务，验证
 *  - 静态资源放行 / POST /api 未登录 401
 *  - bootstrap / login / me / logout 端点（含 Set-Cookie）
 *  - 已登录请求代理到目标（body/状态/头透传）
 *  - WebSocket upgrade：未登录拒绝、已登录转发可用
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createAuthService } from '../lib/host/auth-service.js';
import { createGateway } from '../lib/host/gateway.js';
import { resolveConfig } from '../lib/host/config.js';

// ---------------------------------------------------------------------------
// 最小 WebSocket echo（服务端/测试客户端共用帧编解码）
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 解析客户端帧（含 mask）。返回 null 表示数据不完整。 */
function parseClientFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  if (mask) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, consumed: offset + len };
}

function serverFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function clientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------
function startTarget() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>DSH target</body></html>');
      return;
    }
    if (req.method === 'POST' && req.url === '/api/echo') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: JSON.parse(body || '{}'), host: req.headers.host }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session.prompt') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const env = JSON.parse(body || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { accepted: true } } }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/api/events.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.end();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseClientFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode === 0x1) socket.write(serverFrame(0x1, frame.payload));
      }
    });
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function listenGateway(gateway) {
  return new Promise((resolve, reject) => {
    gateway.listen(0, '127.0.0.1').then(() => resolve(gateway.address().port)).catch(reject);
  });
}

function httpJson(port, path, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: safeJson(data) }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function extractCookieToken(setCookieHeader) {
  const value = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const match = /mt_session=([^;]+)/.exec(value || '');
  return match ? match[1] : null;
}

/** 最小 WS 测试客户端：连接 + 发文本帧 + 等待 echo。 */
function wsTestClient(port, path, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
    };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port, path, headers, agent: false });
    req.on('upgrade', (res, socket) => {
      if (res.statusCode !== 101) {
        socket.destroy();
        reject(new Error(`upgrade rejected: ${res.statusCode}`));
        return;
      }
      let buffer = Buffer.alloc(0);
      const waiter = { text: null };
      const done = new Promise((ok, fail) => {
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          for (;;) {
            const frame = parseClientFrame(buffer);
            if (!frame) break;
            buffer = buffer.subarray(frame.consumed);
            if (frame.opcode === 0x1 && !waiter.text) {
              waiter.text = frame.payload.toString('utf8');
              ok(waiter.text);
            }
          }
        });
        socket.on('error', fail);
        socket.on('close', () => fail(new Error('socket closed before echo')));
      });
      resolve({
        sendText(text) { socket.write(clientFrame(0x1, Buffer.from(text, 'utf8'))); },
        waitEcho() { return done; },
        close() { socket.end(); },
      });
    });
    req.on('error', reject);
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------
test('gateway: static pass-through, /api gating, auth flow, proxy, WS', async (t) => {
  const target = await startTarget();
  const targetPort = target.address().port;

  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ gateway: { port: 0 } });
  const authService = createAuthService(store, cfg);
  const gateway = createGateway({ cfg, target: { hostname: '127.0.0.1', port: targetPort }, authService, logger: { warn() {}, info() {} } });
  const port = await listenGateway(gateway);

  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => target.close(resolve));
    db.close();
  });

  // 1) 静态资源未登录放行
  const staticRes = await httpJson(port, '/');
  assert.equal(staticRes.status, 200);
  assert.match(staticRes.body.raw, /DSH target/);

  // 2) 未登录 POST /api → 401
  const denied = await httpJson(port, '/api/echo', { method: 'POST', body: { hello: 'world' } });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'unauthenticated');

  // 3) me（未初始化）→ bootstrapRequired
  const me0 = await httpJson(port, '/api/auth/me');
  assert.equal(me0.status, 200);
  assert.equal(me0.body.bootstrapRequired, true);

  // 4) bootstrap 平台管理员 → 201 + Set-Cookie
  const boot = await httpJson(port, '/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'longenough-password' } });
  assert.equal(boot.status, 201);
  assert.equal(boot.body.user.role, 'system');
  const cookie = `mt_session=${extractCookieToken(boot.headers['set-cookie'])}`;
  assert.ok(cookie);

  // 5) me（已登录）→ user
  const me1 = await httpJson(port, '/api/auth/me', { cookie });
  assert.equal(me1.status, 200);
  assert.equal(me1.body.user.username, 'admin');

  // 6) 错误密码 → 401 invalid-credentials
  const badLogin = await httpJson(port, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope-nope-nope' } });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.body.error.code, 'invalid-credentials');

  // 7) 登录 → 200 + 新 cookie；已登录请求被代理到目标
  const login = await httpJson(port, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'longenough-password' } });
  assert.equal(login.status, 200);
  const cookie2 = `mt_session=${extractCookieToken(login.headers['set-cookie'])}`;
  const echo = await httpJson(port, '/api/echo', { method: 'POST', body: { hello: 'world' }, cookie: cookie2 });
  assert.equal(echo.status, 200);
  assert.equal(echo.body.echoed.hello, 'world');
  assert.equal(echo.body.host, `127.0.0.1:${targetPort}`); // Host 被改写为 loopback

  // 8) 登出 → 会话失效
  const logout = await httpJson(port, '/api/auth/logout', { method: 'POST', cookie: cookie2 });
  assert.equal(logout.status, 200);
  const afterLogout = await httpJson(port, '/api/echo', { method: 'POST', body: {}, cookie: cookie2 });
  assert.equal(afterLogout.status, 401);

  // 9) WS：未登录被拒（网关回 401 或直接断连）
  await assert.rejects(wsTestClient(port, '/api/events.mux'), /upgrade rejected|expected upgrade|socket closed/);

  // 10) WS：已登录转发到目标并 echo
  const ws = await wsTestClient(port, '/api/events.mux', { cookie });
  ws.sendText('ping-from-browser');
  const echoed = await ws.waitEcho();
  assert.equal(echoed, 'ping-from-browser');
  ws.close();
});

// ---------------------------------------------------------------------------
// M3：配额门禁（session.prompt 前置检查）
// ---------------------------------------------------------------------------
test('gateway: quota exhaustion blocks session.prompt with envelope error', async (t) => {
  const target = await startTarget();
  const targetPort = target.address().port;

  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ gateway: { port: 0 } });
  const authService = createAuthService(store, cfg);
  const { createQuotaService } = await import('../lib/host/quota.js');
  const quotaService = createQuotaService(store);
  const gateway = createGateway({ cfg, target: { hostname: '127.0.0.1', port: targetPort }, authService, quotaService, logger: { warn() {}, info() {} } });
  const port = await listenGateway(gateway);

  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => target.close(resolve));
    db.close();
  });

  // bootstrap + 设置用户月配额 100
  const boot = await httpJson(port, '/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'longenough-password' } });
  const cookie = `mt_session=${extractCookieToken(boot.headers['set-cookie'])}`;
  const user = store.getUserById(boot.body.user.id);
  store.upsertQuota({ scope: 'user', targetId: user.id, tokenLimit: 100, period: 'monthly' });

  // 未超限：session.prompt 被代理（目标回 200）
  const okPrompt = await httpJson(port, '/api/session.prompt', {
    method: 'POST',
    cookie,
    body: { type: 'client-request', rpcId: 'q1', method: 'session.prompt', payload: { sessionId: `u-${user.id}-t-sys-s-abc`, text: 'hi' } },
  });
  assert.equal(okPrompt.status, 200);
  assert.equal(okPrompt.body.result.ok, true); // 目标 echo 了 ok:true

  // 配额用满
  quotaService.addUsage(user, 100);

  // 超限：网关拦截，返回信封业务错误（HTTP 200 + quota-exhausted）
  const blocked = await httpJson(port, '/api/session.prompt', {
    method: 'POST',
    cookie,
    body: { type: 'client-request', rpcId: 'q2', method: 'session.prompt', payload: { sessionId: `u-${user.id}-t-sys-s-abc`, text: 'hi' } },
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.type, 'server-response');
  assert.equal(blocked.body.result.ok, false);
  assert.equal(blocked.body.result.error.code, 'quota-exhausted');
});

// ---------------------------------------------------------------------------
// M6：OIDC 端点（start 返回授权 URL；callback 换令牌 + Set-Cookie + 302）
// ---------------------------------------------------------------------------
test('gateway: oidc start/callback flow', async (t) => {
  const target = await startTarget();
  const targetPort = target.address().port;
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ gateway: { port: 0 } });
  const authService = createAuthService(store, cfg);

  // 假 OIDC 策略：start 生成 URL；callback 返回已建号用户
  const oidcStrategy = {
    enabled: true,
    start: async ({ redirectTo, baseUrl }) => ({
      url: `https://idp.example.com/authorize?state=abc&redirect=${encodeURIComponent(redirectTo)}&base=${encodeURIComponent(baseUrl)}`,
    }),
    handleCallback: async ({ code, state }) => {
      if (state !== 'abc') return { ok: false, error: { code: 'oidc-invalid-state', message: 'bad state' } };
      const uid = store.createUser({ username: 'sso.user', oidcSub: 'sub-1', role: 'user' });
      return { ok: true, user: store.getUserById(uid), redirectTo: '/' };
    },
  };
  const gateway = createGateway({ cfg, target: { hostname: '127.0.0.1', port: targetPort }, authService, oidcStrategy, logger: { warn() {}, info() {} } });
  const port = await listenGateway(gateway);
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => target.close(resolve));
    db.close();
  });

  // start → 授权 URL
  const start = await httpJson(port, '/api/auth/oidc/start?redirect=%2Fconsole');
  assert.equal(start.status, 200);
  assert.equal(start.body.ok, true);
  assert.match(start.body.url, /^https:\/\/idp\.example\.com\/authorize/);

  // callback → 302 + Set-Cookie（浏览器导航流程）
  const cb = await httpJson(port, '/api/auth/oidc/callback?code=c1&state=abc');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/');
  const cookie = /mt_session=([^;]+)/.exec(cb.headers['set-cookie'][0]);
  assert.ok(cookie);
  // 会话已建立
  const me = await httpJson(port, '/api/auth/me', { cookie: `mt_session=${cookie[1]}` });
  assert.equal(me.body.user.username, 'sso.user');

  // 非法 state → 302 到 /?mt_error=
  const bad = await httpJson(port, '/api/auth/oidc/callback?code=c2&state=forged');
  assert.equal(bad.status, 302);
  assert.match(bad.headers.location, /mt_error=oidc-invalid-state/);

  // 未启用时 404
  const gw2cfg = resolveConfig({ gateway: { port: 0 } });
  const gw2 = createGateway({ cfg: gw2cfg, target: { hostname: '127.0.0.1', port: targetPort }, authService, logger: { warn() {}, info() {} } });
  const port2 = await listenGateway(gw2);
  const noOidc = await httpJson(port2, '/api/auth/oidc/start');
  assert.equal(noOidc.status, 404);
  await gw2.close();
});

// ---------------------------------------------------------------------------
// M7：安全响应头
// ---------------------------------------------------------------------------
test('gateway: security headers on responses', async (t) => {
  const target = await startTarget();
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ gateway: { port: 0 } });
  const authService = createAuthService(store, cfg);
  const gateway = createGateway({ cfg, target: { hostname: '127.0.0.1', port: target.address().port }, authService, logger: { warn() {}, info() {} } });
  const port = await listenGateway(gateway);
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => target.close(resolve));
    db.close();
  });

  // 代理响应（DSH 前端）：有 nosniff/XFO/referrer，但无 CSP（DSH 前端依赖 eval 求值 !!js，CSP 会拦）
  const proxied = await httpJson(port, '/');
  assert.equal(proxied.headers['x-content-type-options'], 'nosniff');
  assert.equal(proxied.headers['x-frame-options'], 'DENY');
  assert.equal(proxied.headers['referrer-policy'], 'no-referrer');
  assert.equal(proxied.headers['content-security-policy'], undefined);
  // 网关直答 JSON（auth 端点）：仍带完整安全头（含 CSP）
  const me = await httpJson(port, '/api/auth/me');
  assert.equal(me.headers['x-content-type-options'], 'nosniff');
  assert.match(me.headers['content-security-policy'], /default-src 'self'/);
});

// ---------------------------------------------------------------------------
// DSH 侧认证路由（直连 DSH 端口也可登录）
// ---------------------------------------------------------------------------
test('wireAuthRoutes: /api/auth works on DSH webserver side', async (t) => {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({});
  const authService = createAuthService(store, cfg);
  const { createAuthRouter, wireAuthRoutes } = await import('../lib/host/auth-router.js');
  const router = createAuthRouter({ cfg, authService, logger: { warn() {}, info() {} } });
  let captured = null;
  const fakeCtx = {
    webServer: { register(route) { captured = route; } },
    logger: { warn() {}, info() {} },
  };
  wireAuthRoutes(fakeCtx, router);
  assert.equal(captured.kind, 'prefix');
  assert.equal(captured.path, '/api/auth');

  // 用真实 http server 跑捕获的路由
  const server = http.createServer((req, res) => captured.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // me（未初始化）→ bootstrapRequired
  const me = await httpJson(port, '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.bootstrapRequired, true);

  // bootstrap → 201 + cookie
  const boot = await httpJson(port, '/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'longenough-password' } });
  assert.equal(boot.status, 201);
  const cookie = `mt_session=${extractCookieToken(boot.headers['set-cookie'])}`;

  // 已登录 me
  const me2 = await httpJson(port, '/api/auth/me', { cookie });
  assert.equal(me2.body.user.username, 'admin');

  // 登出 → 失效
  await httpJson(port, '/api/auth/logout', { method: 'POST', cookie });
  const me3 = await httpJson(port, '/api/auth/me', { cookie });
  assert.equal(me3.status, 401);
  db.close();
});

// ---------------------------------------------------------------------------
// 逃生通道：/api/auth/recovery（环回受限）
// ---------------------------------------------------------------------------
test('recovery endpoint: works when no active sysadmin, loopback-only', async (t) => {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({});
  const authService = createAuthService(store, cfg);
  const { createAuthRouter, wireAuthRoutes } = await import('../lib/host/auth-router.js');
  const router = createAuthRouter({ cfg, authService, logger: { warn() {}, info() {} } });
  let captured = null;
  const fakeCtx = { webServer: { register(r) { captured = r; } }, logger: { warn() {}, info() {} } };
  wireAuthRoutes(fakeCtx, router);
  const server = http.createServer((req, res) => captured.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // 先 bootstrap 管理员，再禁用 → recoveryRequired
  await httpJson(port, '/api/auth/bootstrap', { method: 'POST', body: { username: 'root', password: 'longenough-password' } });
  const root = store.getUserByUsername('root');
  store.setUserStatus(root.id, 'disabled');
  const tid = store.createTenant({ name: 't' });
  store.createUser({ tenantId: tid, username: 'bob', role: 'user' });

  const me = await httpJson(port, '/api/auth/me');
  assert.equal(me.body.recoveryRequired, true);

  // recovery（环回）→ 201 + cookie
  const rec = await httpJson(port, '/api/auth/recovery', { method: 'POST', body: { username: 'root2', password: 'longenough-password' } });
  assert.equal(rec.status, 201);
  const cookie = `mt_session=${extractCookieToken(rec.headers['set-cookie'])}`;
  const me2 = await httpJson(port, '/api/auth/me', { cookie });
  assert.equal(me2.body.user.username, 'root2');
  assert.equal(me2.body.recoveryRequired, false);

  // 已有可用管理员 → recovery 409
  const again = await httpJson(port, '/api/auth/recovery', { method: 'POST', body: { username: 'root3', password: 'longenough-password' } });
  assert.equal(again.status, 409);
  db.close();
});

// ---------------------------------------------------------------------------
// 租户可见性：session.list / workspace.list 响应过滤
// ---------------------------------------------------------------------------
test('gateway: list endpoints filtered by tenant visibility', async (t) => {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ gateway: { port: 0 } });
  const authService = createAuthService(store, cfg);

  // 先建租户与用户（拿真实 id），再构造 mock 响应
  const t10 = store.createTenant({ name: 't10' });
  const t20 = store.createTenant({ name: 't20' });
  const aliceId = store.createUser({ tenantId: t10, username: 'alice', role: 'admin' });
  const bobId = store.createUser({ tenantId: t10, username: 'bob', role: 'user' });
  const daveId = store.createUser({ tenantId: t20, username: 'dave', role: 'admin' });
  const aliceSid = `u-${aliceId}-t-${t10}-s-a`;
  const daveSid = `u-${daveId}-t-${t20}-s-b`;
  const bobSid = `u-${bobId}-t-${t10}-s-c`;

  // mock 目标：session.list 返回混合租户会话（用真实租户/用户 id）
  const target = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/session.list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response', rpcId: 'l', result: { ok: true, value: { items: [
          { sessionId: aliceSid, updatedAt: 1 },
          { sessionId: daveSid, updatedAt: 2 },
          { sessionId: bobSid, updatedAt: 3 },
        ] } },
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/workspace.list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response', rpcId: 'w', result: { ok: true, value: { items: [
          { workspaceId: 'w1', title: 'x', sessionIds: [aliceSid] },
          { workspaceId: 'w2', title: 'y', sessionIds: [daveSid] },
        ], archivedSessionIds: [] } },
      }));
      return;
    }
    res.writeHead(404); res.end('nf');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ cfg, target: { hostname: '127.0.0.1', port: target.address().port }, authService, logger: { warn() {}, info() {} } });
  const port = await listenGateway(gateway);
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => target.close(resolve));
    db.close();
  });

  const { hashSessionToken } = await import('../lib/host/crypto.js');
  // bootstrap 平台管理员（要求库为空——在用户创建之后会 409，故先清空：此处直接构造 root）
  // 简化：直接用 createUser 造一个 system 用户（不依赖 bootstrap 的 HTTP 路径）
  const rootId = store.createUser({ username: 'root', passwordHash: 'x', role: 'system' });
  const root = store.getUserById(rootId);
  const issueCookie = (uid) => {
    const token = `t-${uid}-${Math.random().toString(36).slice(2)}`;
    store.createSession({ userId: uid, tokenHash: hashSessionToken(token), expiresAt: Date.now() + 10000 });
    return `mt_session=${token}`;
  };
  const login = (uid) => Promise.resolve(issueCookie(uid));
  const rootCookie = issueCookie(root.id);

  const aliceCookie = await login(aliceId);
  const bobCookie = await login(bobId);
  const daveCookie = await login(daveId);

  const list = async (cookie) => {
    const r = await httpJson(port, '/api/session.list', {
      method: 'POST', cookie,
      body: { type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} },
    });
    return (r.body.result.value.items || []).map((i) => i.sessionId);
  };
  const ws = async (cookie) => {
    const r = await httpJson(port, '/api/workspace.list', {
      method: 'POST', cookie,
      body: { type: 'client-request', rpcId: 'x', method: 'workspace.list', payload: {} },
    });
    return (r.body.result.value.items || []).map((w) => w.workspaceId);
  };

  // 平台管理员：全部
  assert.deepEqual((await list(rootCookie)).sort(), [aliceSid, bobSid, daveSid]);
  // 租户管理员 alice(t10)：仅本租户
  assert.deepEqual((await list(aliceCookie)).sort(), [aliceSid, bobSid]);
  // 使用者 bob(t10)：仅本人
  assert.deepEqual(await list(bobCookie), [bobSid]);
  // 他租户管理员 dave(t20)：仅 t20
  assert.deepEqual(await list(daveCookie), [daveSid]);
  // workspace：alice 只看到 w1，dave 只看到 w2，平台管理员两者
  assert.deepEqual(await ws(aliceCookie), ['w1']);
  assert.deepEqual(await ws(daveCookie), ['w2']);
  assert.deepEqual((await ws(rootCookie)).sort(), ['w1', 'w2']);
});

// ---------------------------------------------------------------------------
// WS 下行帧过滤（租户可见性）
// ---------------------------------------------------------------------------
test('gateway: WS downlink drops invisible workspace/session frames', async (t) => {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ gateway: { port: 0 } });
  const authService = createAuthService(store, cfg);

  // 先建租户/用户（拿真实 id），再构造帧
  const t10 = store.createTenant({ name: 't10' });
  const t20 = store.createTenant({ name: 't20' });
  const aliceId = store.createUser({ tenantId: t10, username: 'alice', role: 'admin' });
  const daveId = store.createUser({ tenantId: t20, username: 'dave', role: 'admin' });
  const aliceSid = `u-${aliceId}-t-${t10}-s-a`;
  const daveSid = `u-${daveId}-t-${t20}-s-b`;
  const newSid = `u-${daveId}-t-${t20}-s-new`;

  // mock 目标：WS 升级后立即推送 3 帧（可见工作区 / 他租户工作区 / 他租户 session-added）
  // 立即推送会与 101 同段到达 → 覆盖网关 upHead 过滤路径
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const target = http.createServer((q, s) => { s.writeHead(200); s.end('ok'); });
  target.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frames = [
      { type: 'host/workspace-changed', workspace: { workspaceId: 'w1', sessionIds: [aliceSid] } },
      { type: 'host/workspace-changed', workspace: { workspaceId: 'w2', sessionIds: [daveSid] } },
      { type: 'host/session-added', sessionId: newSid, blank: true },
    ];
    for (const f of frames) {
      const env = { type: 'server-request', rpcId: 'r', method: f.type, payload: f };
      socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(env), 'utf8')));
    }
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ cfg, target: { hostname: '127.0.0.1', port: target.address().port }, authService, logger: { warn() {}, info() {} } });
  const port = await listenGateway(gateway);
  t.after(async () => {
    await gateway.close();
    await new Promise((resolve) => target.close(resolve));
    db.close();
  });
  const { hashSessionToken } = await import('../lib/host/crypto.js');

  // t10 租户管理员 alice 的会话
  const token = `t-alice-${Math.random().toString(36).slice(2)}`;
  store.createSession({ userId: aliceId, tokenHash: hashSessionToken(token), expiresAt: Date.now() + 10000 });

  // 收集帧的 WS 客户端（处理 head 中与 101 同段的字节）
  const collect = (cookie) => new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/events.host', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13', cookie }, agent: false });
    req.on('upgrade', (res, socket, head) => {
      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const types = [];
      const drain = () => {
        for (;;) {
          const f = parseClientFrame(buffer);
          if (!f) break;
          buffer = buffer.subarray(f.consumed);
          if (f.opcode === 0x1) {
            try { types.push(JSON.parse(f.payload.toString('utf8')).payload.type); } catch { types.push('non-json'); }
          }
        }
      };
      drain(); // 立即处理 head 中与 101 同段的帧
      socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); resolve(types); }, 500);
    });
    req.on('error', reject);
    req.end();
  });

  const ws = await collect(`mt_session=${token}`);
  // 3 帧中只应收到可见工作区 w1；w2 与他租户 session-added 被网关丢弃
  assert.deepEqual(ws, ['host/workspace-changed']);
});
