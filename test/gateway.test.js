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
