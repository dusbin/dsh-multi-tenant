import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, createStore } from '../lib/host/db.js';
import { createAuthService } from '../lib/host/auth-service.js';
import { resolveConfig } from '../lib/host/config.js';

function setup(overrides = {}) {
  const db = openMemoryDatabase();
  const store = createStore(db);
  const cfg = resolveConfig({ db: { path: ':memory:' }, ...overrides });
  const svc = createAuthService(store, cfg);
  return { db, store, cfg, svc };
}

function cookieHeader(name, token) {
  return `${name}=${token}`;
}

test('bootstrap creates platform admin and auto-login', () => {
  const { svc } = setup();
  assert.equal(svc.bootstrapRequired(), true);

  const bad = svc.bootstrap({ username: 'admin', password: 'short' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid-input');

  const result = svc.bootstrap({ username: 'admin', password: 'longenough-password' });
  assert.equal(result.ok, true);
  assert.equal(result.user.role, 'system');
  assert.equal(result.user.tenantId, null);
  assert.ok(result.token);

  const again = svc.bootstrap({ username: 'other', password: 'longenough-password' });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'already-initialized');
  assert.equal(svc.bootstrapRequired(), false);
});

test('login success, me, logout lifecycle', () => {
  const { svc } = setup();
  const boot = svc.bootstrap({ username: 'admin', password: 'longenough-password' });
  const cookie = cookieHeader(svc.cookieName, boot.token);

  // me with cookie → user
  const me = svc.me(cookie);
  assert.equal(me.ok, true);
  assert.equal(me.user.username, 'admin');

  // me without cookie → unauthenticated
  const me2 = svc.me(null);
  assert.equal(me2.ok, false);
  assert.equal(me2.error.code, 'unauthenticated');

  // login with correct password → new session
  const login = svc.login({ username: 'admin', password: 'longenough-password' });
  assert.equal(login.ok, true);
  const cookie2 = cookieHeader(svc.cookieName, login.token);

  // 两个会话并存
  assert.equal(svc.me(cookie).ok, true);
  assert.equal(svc.me(cookie2).ok, true);

  // logout 只删当前会话
  svc.logout(cookie);
  assert.equal(svc.me(cookie).ok, false);
  assert.equal(svc.me(cookie2).ok, true);
});

test('login failures: wrong password, disabled account, rate limit', () => {
  const { svc } = setup();
  svc.bootstrap({ username: 'admin', password: 'longenough-password' });

  const wrong = svc.login({ username: 'admin', password: 'totally-wrong' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'invalid-credentials');

  // 触发限流（maxFailedAttempts=5 默认；前面已 1 次）
  for (let i = 0; i < 4; i += 1) {
    svc.login({ username: 'admin', password: 'totally-wrong' });
  }
  const limited = svc.login({ username: 'admin', password: 'longenough-password' });
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, 'rate-limited');

  // 禁用账号
  const { store } = setup();
  const cfg = resolveConfig({});
  const svc2 = createAuthService(store, cfg);
  svc2.bootstrap({ username: 'admin', password: 'longenough-password' });
  const user = store.getUserByUsername('admin');
  store.setUserStatus(user.id, 'disabled');
  const disabled = svc2.login({ username: 'admin', password: 'longenough-password' });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.code, 'account-disabled');
});

test('authenticateByCookie rejects unknown tokens and inactive users', () => {
  const { store, svc } = setup();
  const boot = svc.bootstrap({ username: 'admin', password: 'longenough-password' });
  const cookie = cookieHeader(svc.cookieName, boot.token);

  const unknown = svc.authenticateByCookie(cookieHeader(svc.cookieName, 'not-a-real-token'));
  assert.equal(unknown, null);

  // 有效 token → 命中
  assert.ok(svc.authenticateByCookie(cookie));

  // 账号被禁用 → 会话立即失效
  store.setUserStatus(boot.user.id, 'disabled');
  assert.equal(svc.authenticateByCookie(cookie), null);
});
