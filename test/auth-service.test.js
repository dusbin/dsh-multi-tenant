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
  // autoLock 关闭：本用例只验证纯限流；锁定行为见 auto-lock 用例
  const { svc } = setup({ auth: { local: { autoLock: false } } });
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

test('login failures are audited (denied)', () => {
  const { db, store, svc } = setup();
  svc.bootstrap({ username: 'admin', password: 'longenough-password' });
  const wrong = svc.login({ username: 'admin', password: 'wrong-password', ip: '10.0.0.1' });
  assert.equal(wrong.ok, false);
  const denied = store.listAudit({ action: 'auth.login', result: 'denied' });
  assert.equal(denied.length, 1);
  assert.equal(denied[0].detail, JSON.stringify({ reason: 'invalid-credentials', userId: 1, method: 'auto' }));
  // 成功登录也审计
  svc.login({ username: 'admin', password: 'longenough-password' });
  const ok = store.listAudit({ action: 'auth.login', result: 'success' });
  assert.equal(ok.length, 1);
  db.close();
});

test('auto-lock: repeated failures lock the account beyond the window', () => {
  const { db, store, svc } = setup({ auth: { local: { maxFailedAttempts: 3, lockWindowMs: 1000, autoLock: true } } });
  svc.bootstrap({ username: 'admin', password: 'longenough-password' });
  // 3 次失败 → 锁定
  for (let i = 0; i < 3; i += 1) {
    const r = svc.login({ username: 'admin', password: 'totally-wrong' });
    assert.equal(r.ok, false);
  }
  assert.equal(store.getUserByUsername('admin').status, 'locked');
  const lockAudit = store.listAudit({ action: 'auth.lock' });
  assert.equal(lockAudit.length, 1);
  // 窗口过后，正确密码也因锁定被拒
  const afterWindow = svc.login({ username: 'admin', password: 'longenough-password', method: 'local' });
  assert.equal(afterWindow.ok, false);
  assert.equal(afterWindow.error.code, 'account-locked');
  // 管理员解锁（清空失败计数）后可登录
  const admin = store.getUserByUsername('admin');
  store.setUserStatus(admin.id, 'active');
  store.clearAttempts('u:admin'); // 对应 mt user.setStatus→active 的清计数行为
  const ok = svc.login({ username: 'admin', password: 'longenough-password', method: 'local' });
  assert.equal(ok.ok, true);
  db.close();
});

test('recovery: creates platform admin when none active; blocked otherwise', () => {
  const { db, store, svc } = setup();
  // 建租户用户（非 system）→ recoveryRequired
  const tid = store.createTenant({ name: 't' });
  store.createUser({ tenantId: tid, username: 'bob', role: 'user' });
  assert.equal(svc.recoveryRequired(), true);
  // me（未登录）报 recoveryRequired
  const me = svc.me(null);
  assert.equal(me.recoveryRequired, true);
  assert.equal(me.user, null);
  // recovery 重建管理员
  const r = svc.recovery({ username: 'root2', password: 'longenough-password' });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'system');
  assert.equal(svc.recoveryRequired(), false);
  // 已有可用管理员 → recovery 拒绝
  const again = svc.recovery({ username: 'root3', password: 'longenough-password' });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'recovery-not-needed');
  // 已登录用户 me 正常（不受 recoveryRequired 影响）
  const authed = svc.me(`mt_session=${r.token}`);
  assert.equal(authed.ok, true);
  assert.equal(authed.user.username, 'root2');
  assert.equal(authed.recoveryRequired, false);
  db.close();
});

test('recovery: disabled system admin triggers recovery; login still denied', () => {
  const { db, store, svc } = setup();
  const boot = svc.bootstrap({ username: 'root', password: 'longenough-password' });
  const tid = store.createTenant({ name: 't' });
  store.createUser({ tenantId: tid, username: 'bob', role: 'user' });
  assert.equal(svc.recoveryRequired(), false);
  store.setUserStatus(boot.user.id, 'disabled'); // 禁用唯一平台管理员
  assert.equal(svc.recoveryRequired(), true);
  const r = svc.recovery({ username: 'root2', password: 'longenough-password' });
  assert.equal(r.ok, true);
  db.close();
});
