/**
 * 插件入口端到端测试：用最小假 ctx 走真实 apply() 装配路径
 * （config 解析 → SQLite 落盘 → 网关监听 → bootstrap/login/me → dispose 清理），
 * 验证 lib/index.js 的装配与清理逻辑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { apply } from '../lib/index.js';

function startTarget() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pong: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>mock dsh</html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function httpJson(port, pathName, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathName, method, headers, agent: false },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('plugin entry: apply() wires config → db → gateway; dispose cleans up', async (t) => {
  const target = await startTarget();
  const targetPort = target.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-entry-'));
  const dbPath = path.join(tmpDir, 'mt.db');

  const ctx = {
    webServer: { port: targetPort, register() {} }, // /mt 路由挂载占位
    logger: { info() {}, warn() {} },
    _dispose: null,
    on(event, handler) { if (event === 'dispose') this._dispose = handler; },
    get() { return undefined; }, // 无 sessions/sessionProjections（metering 关闭分支）
  };

  const port = 39123 + Math.floor(Math.random() * 500);
  apply(ctx, { gateway: { port, host: '127.0.0.1' }, db: { path: dbPath } });
  await new Promise((r) => setTimeout(r, 150)); // 等网关 listen

  t.after(async () => {
    if (ctx._dispose) ctx._dispose();
    await new Promise((resolve) => target.close(resolve));
  });

  // 未初始化 → bootstrapRequired
  const me0 = await httpJson(port, '/api/auth/me');
  assert.equal(me0.body.bootstrapRequired, true);

  // bootstrap → 201 + cookie
  const boot = await httpJson(port, '/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'longenough-password' } });
  assert.equal(boot.status, 201);
  assert.equal(boot.body.user.role, 'system');
  const cookie = `mt_session=${/mt_session=([^;]+)/.exec(boot.headers['set-cookie'][0])[1]}`;

  // 已登录代理 → 目标收到请求
  const ping = await httpJson(port, '/api/ping', { method: 'POST', body: {}, cookie });
  assert.equal(ping.status, 200);
  assert.equal(ping.body.pong, true);

  // 未登录 /api → 401
  const denied = await httpJson(port, '/api/ping', { method: 'POST', body: {} });
  assert.equal(denied.status, 401);

  // DB 落盘成功
  assert.ok(fs.existsSync(dbPath));

  // dispose 清理：网关端口应关闭
  ctx._dispose();
  await new Promise((r) => setTimeout(r, 100));
  const closed = await httpJson(port, '/api/auth/me').then(() => false).catch(() => true);
  assert.equal(closed, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
